// Package tasks holds an in-memory store of long-running operations
// (currently: kube applies). The HTTP layer exposes the store via
// /api/tasks so the UI can show progress for any user-initiated work
// without the user having to babysit the originating request.
//
// In-memory only on purpose — for a homelab tool a process restart
// dropping task history is fine, and it keeps the failure modes
// trivial. If persistence ever matters, the natural upgrade is a
// JSON-on-disk store or a ConfigMap per task in-cluster.
package tasks

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Status is the high-level status of a task or a phase within one.
type Status string

const (
	StatusPending   Status = "pending"
	StatusRunning   Status = "running"
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
	StatusCancelled Status = "cancelled"
)

// Phase is one step within a task — e.g. "ensure NFS path /mnt/…",
// "apply Namespace/gamectl-minecraft", "apply Deployment/minecraft".
// The UI renders these as a checklist with status icons.
type Phase struct {
	Name       string     `json:"name"`
	Status     Status     `json:"status"`
	StartedAt  time.Time  `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Detail     string     `json:"detail,omitempty"`
	Error      string     `json:"error,omitempty"`
}

// Task groups phases under one logical operation. Title and subject
// are free-text the UI uses for display (e.g. "Apply Minecraft" /
// "gamectl-minecraft/minecraft").
type Task struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`               // "apply" | "delete" | …
	Title      string     `json:"title"`              // human-readable
	Subject    string     `json:"subject,omitempty"`  // e.g. "gamectl-minecraft/minecraft"
	GameID     string     `json:"gameId,omitempty"`   // for filtering on the Manage page
	StartedBy  string     `json:"startedBy,omitempty"` // username, if available
	Status     Status     `json:"status"`
	StartedAt  time.Time  `json:"startedAt"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Error      string     `json:"error,omitempty"`
	Phases     []Phase    `json:"phases"`
}

// Store is a goroutine-safe map of Tasks, keyed by ID. Old tasks are
// trimmed by Cap so memory doesn't grow unbounded if someone leaves
// the tab open for a month.
type Store struct {
	mu    sync.RWMutex
	tasks map[string]*Task
	order []string // ID list, oldest → newest, for trimming + ordered listing
	cap   int
	// cancels holds the context.CancelFunc for tasks that are still
	// in-flight, so an operator can stop a running apply/delete from the
	// UI. Entries are removed when the task finishes.
	cancels map[string]context.CancelFunc
}

func NewStore(cap int) *Store {
	if cap <= 0 {
		cap = 100
	}
	return &Store{
		tasks:   make(map[string]*Task),
		order:   make([]string, 0, cap),
		cap:     cap,
		cancels: make(map[string]context.CancelFunc),
	}
}

// Cancel stops a running task by invoking its registered CancelFunc. The
// in-flight kube operation observes ctx.Done(), aborts, and the task
// settles into the "cancelled" state via Handle.Finish. Returns false if
// the task is unknown or already finished (nothing to cancel).
func (s *Store) Cancel(id string) bool {
	s.mu.Lock()
	t, ok := s.tasks[id]
	if !ok || (t.Status != StatusRunning && t.Status != StatusPending) {
		s.mu.Unlock()
		return false
	}
	cancel := s.cancels[id]
	s.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

// Create registers a fresh task in Pending state and returns it. The
// caller mutates it via the returned Handle, which marshals updates
// behind the store's mutex.
func (s *Store) Create(kind, title, subject, gameID, startedBy string) *Handle {
	t := &Task{
		ID:        uuid.NewString(),
		Kind:      kind,
		Title:     title,
		Subject:   subject,
		GameID:    gameID,
		StartedBy: startedBy,
		Status:    StatusPending,
		StartedAt: time.Now().UTC(),
		Phases:    []Phase{},
	}
	s.mu.Lock()
	s.tasks[t.ID] = t
	s.order = append(s.order, t.ID)
	if len(s.order) > s.cap {
		// Trim oldest. Don't worry about preserving a running one being
		// evicted — at cap=100 with normal homelab traffic, this only
		// drops genuinely-stale history.
		evict := s.order[0]
		s.order = s.order[1:]
		delete(s.tasks, evict)
	}
	s.mu.Unlock()
	return &Handle{store: s, id: t.ID}
}

// Get returns a deep-ish copy (slices are reallocated) so callers
// outside the store can't race with in-flight phase updates.
func (s *Store) Get(id string) (Task, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.tasks[id]
	if !ok {
		return Task{}, false
	}
	return cloneTask(t), true
}

// List returns tasks newest-first, optionally filtered by gameID
// (empty string = all games). Result is a snapshot.
func (s *Store) List(gameID string, limit int) []Task {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > len(s.order) {
		limit = len(s.order)
	}
	out := make([]Task, 0, limit)
	// Walk newest-first.
	for i := len(s.order) - 1; i >= 0 && len(out) < limit; i-- {
		t := s.tasks[s.order[i]]
		if gameID != "" && t.GameID != gameID {
			continue
		}
		out = append(out, cloneTask(t))
	}
	return out
}

func cloneTask(t *Task) Task {
	cp := *t
	cp.Phases = make([]Phase, len(t.Phases))
	copy(cp.Phases, t.Phases)
	return cp
}

// Handle is the writer half — a thin wrapper that takes the store
// mutex for each update. Pass this to long-running operations
// (kube.Apply, etc.) as a Reporter.
type Handle struct {
	store *Store
	id    string
}

func (h *Handle) ID() string { return h.id }

// RegisterCancel stores the CancelFunc for this task's in-flight context
// so Store.Cancel can stop it. Call once, right after creating the
// operation context in the worker goroutine.
func (h *Handle) RegisterCancel(cancel context.CancelFunc) {
	h.store.mu.Lock()
	h.store.cancels[h.id] = cancel
	h.store.mu.Unlock()
}

// Start moves the task into Running. Idempotent if already Running.
func (h *Handle) Start() {
	h.update(func(t *Task) {
		if t.Status == StatusPending {
			t.Status = StatusRunning
		}
	})
}

// BeginPhase appends a new phase in Running state. Returns the index
// for EndPhase / FailPhase. Convention: keep names short and
// user-readable; this is what shows up in the UI checklist.
func (h *Handle) BeginPhase(name, detail string) int {
	idx := -1
	h.update(func(t *Task) {
		if t.Status == StatusPending {
			t.Status = StatusRunning
		}
		t.Phases = append(t.Phases, Phase{
			Name:      name,
			Status:    StatusRunning,
			StartedAt: time.Now().UTC(),
			Detail:    detail,
		})
		idx = len(t.Phases) - 1
	})
	return idx
}

// EndPhase finalizes a phase at the given index — success if err is
// nil, failure otherwise. Out-of-range indices are silently ignored
// so an early-failure path doesn't have to track which phases it
// actually opened.
func (h *Handle) EndPhase(idx int, err error) {
	h.update(func(t *Task) {
		if idx < 0 || idx >= len(t.Phases) {
			return
		}
		p := &t.Phases[idx]
		now := time.Now().UTC()
		p.FinishedAt = &now
		if err != nil {
			p.Status = StatusFailed
			p.Error = err.Error()
		} else {
			p.Status = StatusSucceeded
		}
	})
}

// Finish closes out the whole task. err = nil → Succeeded; a
// context-cancellation error → Cancelled (so the UI can distinguish a
// user-requested stop from a genuine failure); any other error →
// Failed. Also drops the registered CancelFunc.
func (h *Handle) Finish(err error) {
	h.update(func(t *Task) {
		now := time.Now().UTC()
		t.FinishedAt = &now
		switch {
		case err == nil:
			t.Status = StatusSucceeded
		case errors.Is(err, context.Canceled):
			t.Status = StatusCancelled
			t.Error = "cancelled by user"
		default:
			t.Status = StatusFailed
			t.Error = err.Error()
		}
	})
	h.store.mu.Lock()
	delete(h.store.cancels, h.id)
	h.store.mu.Unlock()
}

func (h *Handle) update(fn func(*Task)) {
	h.store.mu.Lock()
	defer h.store.mu.Unlock()
	t, ok := h.store.tasks[h.id]
	if !ok {
		return
	}
	fn(t)
}

// Reporter is the interface we hand to kube.Apply so it can record
// progress without taking a hard dependency on this package's
// concrete types. *Handle implements it.
type Reporter interface {
	BeginPhase(name, detail string) int
	EndPhase(idx int, err error)
}

// NoopReporter satisfies Reporter without doing anything — useful
// for callers (tests, dry-runs) that don't care about progress.
type NoopReporter struct{}

func (NoopReporter) BeginPhase(name, detail string) int { return -1 }
func (NoopReporter) EndPhase(idx int, err error)        {}
