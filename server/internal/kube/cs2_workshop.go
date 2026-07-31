package kube

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// CS2 workshop pre-download support. The kus image's
// `subscribed_file_ids.txt` is meant to keep the server subscribed to a list
// of workshop maps, but the actual download is on-demand — the server only
// fetches a map when something asks for it (host_workshop_map / a player
// joins a map already loaded). On a stock deploy without a Steam Web API
// key, on-demand fetches fail silently and `!rtv` to an undownloaded map
// just sits there.
//
// This file exposes the operator-facing surface to fix that: see what's
// downloaded, trigger a download cycle for the missing ones. Each cycle
// step is a `host_workshop_map <id>` RCON call which kicks current players
// (a level change), so the panel makes that clear and warns about NFS
// usage before kicking it off.

const (
	cs2InstallDir   = "/home/steam/cs2"
	cs2SubsListPath = cs2InstallDir + "/game/csgo/subscribed_file_ids.txt"
	// The cs2 binary keeps downloaded workshop content here.
	cs2WorkshopDir = cs2InstallDir + "/game/bin/linuxsteamrt64/steamapps/workshop/content/730"
)

// CS2WorkshopMap is one row in the workshop status table.
type CS2WorkshopMap struct {
	ID         string `json:"id"`
	Downloaded bool   `json:"downloaded"`
	SizeMB     int    `json:"sizeMB,omitempty"`
}

// CS2WorkshopStatus is the wire shape for GET /cs2/workshop — the live
// download state plus a summary so the UI can show "12 of 125 maps cached".
type CS2WorkshopStatus struct {
	Maps        []CS2WorkshopMap `json:"maps"`
	Total       int              `json:"total"`
	Have        int              `json:"have"`
	Missing     int              `json:"missing"`
	TotalMB     int              `json:"totalMB"`
	Running     bool             `json:"running"`               // a background download is in progress
	RunningID   string           `json:"runningId,omitempty"`   // the id currently being fetched
	RunDone     int              `json:"runDone,omitempty"`     // how many ids the run has finished
	RunTotal    int              `json:"runTotal,omitempty"`    // how many ids the run started with
	AutoPreload bool             `json:"autoPreload"`           // gamectl.io/preload-workshop-maps annotation is on
	// SteamAPIKeySet reports whether the deployment has a non-empty API_KEY.
	// When true and AutoPreload is also true, the reconciler intentionally
	// skips the host_workshop_map cycle because the cs2 binary downloads
	// subscribed maps in the background via Steam's subscription API.
	SteamAPIKeySet bool `json:"steamApiKeySet"`
	// SidecarEnabled reports whether the workshop-downloader sidecar's
	// background download loop is opted-in for this deployment. The sidecar
	// checks for /home/steam/cs2/.gamectl-wsdl-enabled on the PVC; when
	// absent it idles. Toggled by CS2WorkshopSidecarSetEnabled — exposed in
	// the manage screen so operators can flip it on after install instead
	// of having every fresh deploy mass-download the full workshop set.
	SidecarEnabled bool `json:"sidecarEnabled"`
}

// downloadRunState tracks a single per-server background download cycle.
// One run per server at a time — a second POST is a no-op until the first
// drains, so the operator can\'t accidentally fire off two competing cycles.
type downloadRunState struct {
	running   bool
	current   string
	done      int
	total     int
	cancel    context.CancelFunc
}

var (
	workshopRunsMu sync.Mutex
	workshopRuns   = map[string]*downloadRunState{} // key: ns/server
)

// CS2WorkshopGetStatus reads the subscribed-ids list + the workshop content
// dir off the running pod and returns one row per id with its download
// state and size on disk.
func (c *Cluster) CS2WorkshopGetStatus(ctx context.Context, ns, server string) (*CS2WorkshopStatus, error) {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return nil, err
	}
	// 1. Subscribed IDs from the install-dir copy (this is the one the cs2
	//    binary actually reads at boot; the overlay copy seeds it).
	raw, _, err := c.podExec(ctx, ns, pod, container, []string{"cat", cs2SubsListPath}, "")
	if err != nil {
		return nil, fmt.Errorf("read subscribed_file_ids.txt: %w", err)
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		s := strings.TrimSpace(line)
		if s == "" || seen[s] {
			continue
		}
		// numeric workshop ids only
		if _, err := strconv.ParseInt(s, 10, 64); err != nil {
			continue
		}
		seen[s] = true
		ids = append(ids, s)
	}
	sort.Strings(ids)

	// 2. List the workshop content dir to know what's downloaded + sizes.
	//    `du -sk <id>/...` returns kilobytes per id; an absent id is omitted.
	sizeByID := map[string]int{}
	// du can fail (dir missing entirely on a brand-new server) — just zeroes.
	if duOut, _, err := c.podExec(ctx, ns, pod, container, []string{"sh", "-c",
		"if [ -d " + cs2WorkshopDir + " ]; then cd " + cs2WorkshopDir + " && du -sk */ 2>/dev/null; fi"}, ""); err == nil {
		for _, line := range strings.Split(duOut, "\n") {
			f := strings.Fields(line)
			if len(f) != 2 {
				continue
			}
			id := strings.TrimSuffix(f[1], "/")
			kb, err := strconv.Atoi(f[0])
			if err != nil {
				continue
			}
			sizeByID[id] = kb / 1024 // MB
		}
	}

	out := &CS2WorkshopStatus{Total: len(ids), Maps: make([]CS2WorkshopMap, 0, len(ids))}
	for _, id := range ids {
		m := CS2WorkshopMap{ID: id}
		if sz, ok := sizeByID[id]; ok && sz > 0 {
			m.Downloaded = true
			m.SizeMB = sz
			out.Have++
			out.TotalMB += sz
		} else {
			out.Missing++
		}
		out.Maps = append(out.Maps, m)
	}

	workshopRunsMu.Lock()
	if r, ok := workshopRuns[ns+"/"+server]; ok && r != nil && r.running {
		out.Running = r.running
		out.RunningID = r.current
		out.RunDone = r.done
		out.RunTotal = r.total
	}
	workshopRunsMu.Unlock()

	// If no manual cycle is currently running, surface the sidecar's
	// in-flight download (if any) so the UI can highlight + sort-to-top
	// the map the workshop-downloader sidecar is fetching right now. The
	// sidecar writes the id to .gamectl-wsdl-current before each steamcmd
	// call and removes it after — see workshop-downloader args in
	// cs2Generator.js.
	//
	// Also check the gate sentinel in the same call so the UI knows
	// whether to show "Start background downloads" or "Stop".
	// `; :` keeps the script exit-zero even when .gamectl-wsdl-current is
	// absent (the common case — it only exists *during* a steamcmd call) —
	// otherwise podExec returns an error and we'd drop the "enabled" line
	// along with it.
	if probeOut, _, err := c.podExec(ctx, ns, pod, container, []string{"sh", "-c",
		"if [ -e " + cs2InstallDir + "/.gamectl-wsdl-enabled ]; then echo enabled; fi; " +
			"cat " + cs2InstallDir + "/.gamectl-wsdl-current 2>/dev/null; :"}, ""); err == nil {
		for _, line := range strings.Split(probeOut, "\n") {
			s := strings.TrimSpace(line)
			if s == "enabled" {
				out.SidecarEnabled = true
				continue
			}
			if s != "" && !out.Running {
				out.Running = true
				out.RunningID = s
			}
		}
	}

	// AutoPreload — the deployment-level annotation the wizard sets and the
	// reconciler watches. Surfacing it on this endpoint lets the panel show
	// a clear "auto" badge so the operator knows GameCTL will keep this set
	// drained without needing a manual click.
	if b := c.snap(); b != nil {
		if dep, err := b.clientset.AppsV1().Deployments(ns).Get(context.Background(), server, metav1.GetOptions{}); err == nil {
			if dep.Annotations[cs2PreloadAnnotation] == "true" {
				out.AutoPreload = true
			}
			if hasSteamAPIKey(*dep) {
				out.SteamAPIKeySet = true
			}
		}
	}
	return out, nil
}

// CS2WorkshopDownload kicks off (or refuses to overlap) a background cycle
// that runs `steamcmd workshop_download_item 730 <id>` inside the
// workshop-downloader sidecar container for each missing id. Returns the
// number of ids the cycle will visit.
//
// Why steamcmd, not host_workshop_map: the kus image's CS2 binary does NOT
// trigger workshop downloads from host_workshop_map on this build (verified
// live). steamcmd in the sidecar reliably fetches a single id, writes into
// the shared PVC at /home/steam/cs2/game/bin/linuxsteamrt64/steamapps/
// workshop/content/730/<id>/<id>.vpk, and the main container picks it up.
//
// onlyMissing=true: download only ids that aren\'t already on disk.
// onlyMissing=false: include every subscribed id (forces a re-fetch).
//
// Per-server single-flight — a second call while one is running returns an
// error.
func (c *Cluster) CS2WorkshopDownload(ctx context.Context, ns, server string, onlyMissing bool) (int, error) {
	st, err := c.CS2WorkshopGetStatus(ctx, ns, server)
	if err != nil {
		return 0, err
	}
	var todo []string
	for _, m := range st.Maps {
		if onlyMissing && m.Downloaded {
			continue
		}
		todo = append(todo, m.ID)
	}
	if len(todo) == 0 {
		return 0, nil
	}

	key := ns + "/" + server
	workshopRunsMu.Lock()
	if r, ok := workshopRuns[key]; ok && r != nil && r.running {
		workshopRunsMu.Unlock()
		return 0, fmt.Errorf("a workshop download is already running (%d/%d done, currently fetching %s)", r.done, r.total, r.current)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	state := &downloadRunState{running: true, total: len(todo), cancel: cancel}
	workshopRuns[key] = state
	workshopRunsMu.Unlock()

	go c.runWorkshopDownload(runCtx, ns, server, todo, state)
	return len(todo), nil
}

// CS2WorkshopCancelDownload stops the in-flight download cycle, if any.
func (c *Cluster) CS2WorkshopCancelDownload(ns, server string) bool {
	workshopRunsMu.Lock()
	defer workshopRunsMu.Unlock()
	r, ok := workshopRuns[ns+"/"+server]
	if !ok || r == nil || !r.running || r.cancel == nil {
		return false
	}
	r.cancel()
	return true
}

// runWorkshopDownload is the per-server background cycle. For each id it
// pod-execs steamcmd inside the workshop-downloader sidecar — that
// container shares the PVC with cs2, has steamcmd at /steamcmd/steamcmd.sh
// and nothing else competing for resources, so downloads don't impact the
// running game. Players stay connected the entire time.
func (c *Cluster) runWorkshopDownload(ctx context.Context, ns, server string, ids []string, state *downloadRunState) {
	defer func() {
		workshopRunsMu.Lock()
		state.running = false
		state.current = ""
		workshopRunsMu.Unlock()
	}()

	pod, _, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return
	}
	const installDir = "/home/steam/cs2/game/bin/linuxsteamrt64"
	// The sidecar uses cm2network/steamcmd which ships steamcmd at this path.
	const steamcmd = "/home/steam/steamcmd/steamcmd.sh"
	for i, id := range ids {
		select {
		case <-ctx.Done():
			return
		default:
		}
		workshopRunsMu.Lock()
		state.current = id
		state.done = i
		workshopRunsMu.Unlock()

		// One-shot steamcmd in the sidecar. workshop_download_item is
		// synchronous — when it returns, the .vpk is on disk (or the call
		// failed, which we ignore and move on).
		_, _, _ = c.podExec(ctx, ns, pod, "workshop-downloader",
			[]string{steamcmd, "+force_install_dir", installDir,
				"+login", "anonymous",
				"+workshop_download_item", "730", id, "validate",
				"+quit"}, "")
	}
	workshopRunsMu.Lock()
	state.done = len(ids)
	workshopRunsMu.Unlock()
}

// CS2WorkshopSidecarSetEnabled flips the workshop-downloader sidecar's
// opt-in gate by touching or removing the .gamectl-wsdl-enabled sentinel
// file on the cs2 data PVC. The sidecar checks for that file at the top
// of each pass and idles when it is absent — so background mass-downloads
// stay off by default and the operator turns them on explicitly from the
// manage screen.
func (c *Cluster) CS2WorkshopSidecarSetEnabled(ctx context.Context, ns, server string, enabled bool) error {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return err
	}
	gate := cs2InstallDir + "/.gamectl-wsdl-enabled"
	cmd := "rm -f " + gate
	if enabled {
		cmd = "touch " + gate
	}
	if _, stderr, err := c.podExec(ctx, ns, pod, container, []string{"sh", "-c", cmd}, ""); err != nil {
		return fmt.Errorf("toggle sidecar gate: %w (%s)", err, strings.TrimSpace(stderr))
	}
	return nil
}
