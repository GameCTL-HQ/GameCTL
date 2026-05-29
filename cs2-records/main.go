// cs2-records — standalone read-only site that visualizes the surf
// records JSON the GameCtlSurfHUD plugin writes on the cs2 server.
//
// Runs as its own k8s Deployment in the gamectl namespace, mounts the
// cs2-pvc read-only so it sees /home/steam/cs2/gamectl_surf_records.json
// without a network round-trip. Pretty dark-theme HTML pages: a home
// page with global leaderboards, per-map pages with top-50, and
// per-player profile pages.
//
// Auth: none — meant to live behind ProxyCTL.
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"
)

//go:embed templates/*.html
var tplFS embed.FS

var (
	tpl *template.Template
)

// recordEntry mirrors the GameCtlSurfHUD plugin's on-disk schema.
type recordEntry struct {
	Name       string `json:"name"`
	TimeMs     int64  `json:"time_ms"`
	FinishedAt string `json:"finished_at"`
}

type recordsFile struct {
	Version int                               `json:"version"`
	Records map[string]map[string]recordEntry `json:"records"` // map → steamid64 → entry
}

// cached read of the records file. Re-read every CACHE_TTL.
var (
	cacheMu     sync.RWMutex
	cachedFile  *recordsFile
	cachedAt    time.Time
	cacheTTL    = 30 * time.Second
	recordsPath = envOr("GAMECTL_RECORDS_PATH", "/data/gamectl_surf_records.json")

	// Attempts log — append-only JSONL written by the plugin on every
	// finish (PB or not). Cached separately so the page render isn't
	// blocked by a re-parse of a growing file.
	attemptsPath  = envOr("GAMECTL_ATTEMPTS_PATH", "/data/gamectl_surf_attempts.jsonl")
	attemptsMu    sync.RWMutex
	attemptsCache []attempt
	attemptsAt    time.Time
)

// attempt mirrors one JSONL row written by the plugin's AppendAttempt.
type attempt struct {
	Map        string `json:"map"`
	SteamID64  string `json:"sid"`
	Name       string `json:"name"`
	TimeMs     int64  `json:"time_ms"`
	PB         bool   `json:"pb"`
	FinishedAt string `json:"finished_at"`
}

// loadAttempts streams the JSONL log. Unparseable lines are skipped — the
// file is append-only so a torn write at most loses the trailing entry.
// Returns newest-first.
func loadAttempts() []attempt {
	attemptsMu.RLock()
	if attemptsCache != nil && time.Since(attemptsAt) < cacheTTL {
		out := attemptsCache
		attemptsMu.RUnlock()
		return out
	}
	attemptsMu.RUnlock()

	attemptsMu.Lock()
	defer attemptsMu.Unlock()
	if attemptsCache != nil && time.Since(attemptsAt) < cacheTTL {
		return attemptsCache
	}
	f, err := os.Open(attemptsPath)
	if err != nil {
		attemptsCache = []attempt{}
		attemptsAt = time.Now()
		return attemptsCache
	}
	defer f.Close()
	out := []attempt{}
	scan := bufio.NewScanner(f)
	// Generous buffer — names/maps stay small but be defensive.
	scan.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scan.Scan() {
		line := scan.Bytes()
		if len(line) == 0 {
			continue
		}
		var a attempt
		if err := json.Unmarshal(line, &a); err == nil {
			out = append(out, a)
		}
	}
	// Newest first.
	sort.Slice(out, func(i, j int) bool { return out[i].FinishedAt > out[j].FinishedAt })
	attemptsCache = out
	attemptsAt = time.Now()
	return out
}

func envOr(k, dflt string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return dflt
}

func loadRecords() *recordsFile {
	cacheMu.RLock()
	if cachedFile != nil && time.Since(cachedAt) < cacheTTL {
		f := cachedFile
		cacheMu.RUnlock()
		return f
	}
	cacheMu.RUnlock()

	cacheMu.Lock()
	defer cacheMu.Unlock()
	// double-check under write lock
	if cachedFile != nil && time.Since(cachedAt) < cacheTTL {
		return cachedFile
	}
	raw, err := os.ReadFile(recordsPath)
	if err != nil {
		// File may not exist yet (no records). Return empty.
		cachedFile = &recordsFile{Records: map[string]map[string]recordEntry{}}
		cachedAt = time.Now()
		return cachedFile
	}
	var f recordsFile
	if err := json.Unmarshal(raw, &f); err != nil {
		slog.Warn("parse records failed", "err", err)
		cachedFile = &recordsFile{Records: map[string]map[string]recordEntry{}}
	} else {
		cachedFile = &f
	}
	if cachedFile.Records == nil {
		cachedFile.Records = map[string]map[string]recordEntry{}
	}
	cachedAt = time.Now()
	return cachedFile
}

// ── view models ──────────────────────────────────────────────────────────

type playerRow struct {
	SteamID64  string
	Name       string
	TimeMs     int64
	TimeFmt    string
	FinishedAt string
	AgeFmt     string
}

type mapRow struct {
	Map        string
	RecordCount int
	WR         *playerRow // top record (nil if no records)
}

type playerProfile struct {
	SteamID64 string
	Name      string
	Maps      []playerMapEntry
	TotalMs   int64
	TotalFmt  string
}

type playerMapEntry struct {
	Map     string
	TimeMs  int64
	TimeFmt string
	Rank    int
	OutOf   int
	AgeFmt  string
}

func fmtTime(ms int64) string {
	if ms <= 0 {
		return "—"
	}
	d := time.Duration(ms) * time.Millisecond
	m := int(d.Minutes())
	s := int(d.Seconds()) % 60
	c := int(d.Milliseconds()%1000) / 10
	return fmt.Sprintf("%02d:%02d.%02d", m, s, c)
}

func fmtAge(iso string) string {
	if iso == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		// try without timezone
		if t2, err2 := time.Parse("2006-01-02T15:04:05.0000000Z", iso); err2 == nil {
			t = t2
		} else {
			return ""
		}
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func mapList(f *recordsFile) []mapRow {
	out := make([]mapRow, 0, len(f.Records))
	for mapName, sidDict := range f.Records {
		row := mapRow{Map: mapName, RecordCount: len(sidDict)}
		var best *recordEntry
		var bestSid string
		for sid, e := range sidDict {
			e2 := e
			if best == nil || e2.TimeMs < best.TimeMs {
				best = &e2
				bestSid = sid
			}
		}
		if best != nil {
			row.WR = &playerRow{
				SteamID64:  bestSid,
				Name:       best.Name,
				TimeMs:     best.TimeMs,
				TimeFmt:    fmtTime(best.TimeMs),
				FinishedAt: best.FinishedAt,
				AgeFmt:     fmtAge(best.FinishedAt),
			}
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Map < out[j].Map })
	return out
}

func mapBoard(f *recordsFile, mapName string, limit int) (rows []playerRow) {
	sidDict, ok := f.Records[mapName]
	if !ok {
		return
	}
	for sid, e := range sidDict {
		rows = append(rows, playerRow{
			SteamID64:  sid,
			Name:       e.Name,
			TimeMs:     e.TimeMs,
			TimeFmt:    fmtTime(e.TimeMs),
			FinishedAt: e.FinishedAt,
			AgeFmt:     fmtAge(e.FinishedAt),
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].TimeMs < rows[j].TimeMs })
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	return
}

// playersList: aggregate across all maps. Sort by total records held → most
// active player first.
type playerSummary struct {
	SteamID64   string
	Name        string
	MapsRanked  int
	WRCount     int
	TotalMs     int64
	TotalFmt    string
}

func playersList(f *recordsFile) []playerSummary {
	type acc struct {
		name    string
		maps    int
		wrs     int
		totalMs int64
	}
	by := map[string]*acc{}
	for mapName, sidDict := range f.Records {
		// find WR for this map
		var wrSid string
		var wrTime int64 = 1<<62
		for sid, e := range sidDict {
			if e.TimeMs < wrTime {
				wrTime = e.TimeMs
				wrSid = sid
			}
		}
		for sid, e := range sidDict {
			a, ok := by[sid]
			if !ok {
				a = &acc{}
				by[sid] = a
			}
			a.name = e.Name // last name wins (most recent finish)
			a.maps++
			a.totalMs += e.TimeMs
			if sid == wrSid {
				a.wrs++
			}
		}
		_ = mapName
	}
	out := make([]playerSummary, 0, len(by))
	for sid, a := range by {
		out = append(out, playerSummary{
			SteamID64: sid, Name: a.name, MapsRanked: a.maps, WRCount: a.wrs,
			TotalMs: a.totalMs, TotalFmt: fmtTime(a.totalMs),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].WRCount != out[j].WRCount {
			return out[i].WRCount > out[j].WRCount
		}
		if out[i].MapsRanked != out[j].MapsRanked {
			return out[i].MapsRanked > out[j].MapsRanked
		}
		return out[i].TotalMs < out[j].TotalMs
	})
	return out
}

func playerProfileOf(f *recordsFile, sid string) *playerProfile {
	prof := &playerProfile{SteamID64: sid, Maps: []playerMapEntry{}}
	for mapName, sidDict := range f.Records {
		e, ok := sidDict[sid]
		if !ok {
			continue
		}
		prof.Name = e.Name
		// compute rank
		var sorted []recordEntry
		for _, v := range sidDict {
			sorted = append(sorted, v)
		}
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].TimeMs < sorted[j].TimeMs })
		rank := 0
		for i := range sorted {
			if sorted[i].TimeMs == e.TimeMs && sorted[i].Name == e.Name {
				rank = i + 1
				break
			}
		}
		prof.Maps = append(prof.Maps, playerMapEntry{
			Map: mapName, TimeMs: e.TimeMs, TimeFmt: fmtTime(e.TimeMs),
			Rank: rank, OutOf: len(sidDict), AgeFmt: fmtAge(e.FinishedAt),
		})
		prof.TotalMs += e.TimeMs
	}
	sort.Slice(prof.Maps, func(i, j int) bool { return prof.Maps[i].Map < prof.Maps[j].Map })
	prof.TotalFmt = fmtTime(prof.TotalMs)
	return prof
}

// ── HTTP handlers ────────────────────────────────────────────────────────

func handleHome(w http.ResponseWriter, _ *http.Request) {
	f := loadRecords()
	maps := mapList(f)
	players := playersList(f)
	if len(players) > 10 {
		players = players[:10]
	}
	// "Recent finishes" — flatten all entries, sort by FinishedAt desc, take 10.
	type recent struct {
		Map     string
		Name    string
		SteamID string
		TimeFmt string
		AgeFmt  string
	}
	var recents []recent
	for mapName, sidDict := range f.Records {
		for sid, e := range sidDict {
			recents = append(recents, recent{
				Map: mapName, Name: e.Name, SteamID: sid,
				TimeFmt: fmtTime(e.TimeMs), AgeFmt: fmtAge(e.FinishedAt),
			})
		}
		_ = mapName
	}
	sort.Slice(recents, func(i, j int) bool {
		a := f.Records[recents[i].Map][recents[i].SteamID].FinishedAt
		b := f.Records[recents[j].Map][recents[j].SteamID].FinishedAt
		return a > b
	})
	if len(recents) > 10 {
		recents = recents[:10]
	}
	render(w, "home.html", map[string]any{
		"Title":           "Home",
		"Maps":            maps,
		"TopPlayers":      players,
		"Recents":         recents,
		"TotalMaps":       len(f.Records),
		"TotalRecords":    countRecords(f),
		"TotalPlayersAll": uniquePlayers(f),
	})
}

func countRecords(f *recordsFile) int {
	n := 0
	for _, d := range f.Records {
		n += len(d)
	}
	return n
}

func uniquePlayers(f *recordsFile) int {
	seen := map[string]bool{}
	for _, d := range f.Records {
		for sid := range d {
			seen[sid] = true
		}
	}
	return len(seen)
}

// attemptRow is the wire-shape served to the templates — same as `attempt`
// but with pre-formatted time and age strings so the templates stay
// declarative.
type attemptRow struct {
	Map       string
	SteamID64 string
	Name      string
	TimeFmt   string
	PB        bool
	AgeFmt    string
}

func attemptsForMap(mapName string, limit int) []attemptRow {
	all := loadAttempts()
	out := []attemptRow{}
	for _, a := range all {
		if a.Map != mapName {
			continue
		}
		out = append(out, attemptRow{
			Map: a.Map, SteamID64: a.SteamID64, Name: a.Name,
			TimeFmt: fmtTime(a.TimeMs), PB: a.PB, AgeFmt: fmtAge(a.FinishedAt),
		})
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func attemptsForPlayer(sid string, limit int) []attemptRow {
	all := loadAttempts()
	out := []attemptRow{}
	for _, a := range all {
		if a.SteamID64 != sid {
			continue
		}
		out = append(out, attemptRow{
			Map: a.Map, SteamID64: a.SteamID64, Name: a.Name,
			TimeFmt: fmtTime(a.TimeMs), PB: a.PB, AgeFmt: fmtAge(a.FinishedAt),
		})
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func handleMap(w http.ResponseWriter, r *http.Request) {
	mapName := r.PathValue("name")
	if mapName == "" {
		http.NotFound(w, r)
		return
	}
	f := loadRecords()
	rows := mapBoard(f, mapName, 50)
	render(w, "map.html", map[string]any{
		"Title":    mapName,
		"Map":      mapName,
		"Rows":     rows,
		"Count":    len(rows),
		"Attempts": attemptsForMap(mapName, 50),
	})
}

func handlePlayer(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	if _, err := strconv.ParseInt(sid, 10, 64); err != nil {
		http.NotFound(w, r)
		return
	}
	f := loadRecords()
	prof := playerProfileOf(f, sid)
	if prof.Name == "" {
		http.NotFound(w, r)
		return
	}
	render(w, "player.html", map[string]any{
		"Title":    prof.Name,
		"Profile":  prof,
		"Attempts": attemptsForPlayer(sid, 50),
	})
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

func render(w http.ResponseWriter, name string, data map[string]any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tpl.ExecuteTemplate(w, name, data); err != nil {
		slog.Error("render failed", "tpl", name, "err", err)
		http.Error(w, "render failed", 500)
	}
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	funcs := template.FuncMap{
		// inc1: 0-based index → 1-based ordinal. Used for #1/#2/#3 ranks.
		"inc1": func(i int) int { return i + 1 },
	}
	var err error
	tpl, err = template.New("").Funcs(funcs).ParseFS(tplFS, "templates/*.html")
	if err != nil {
		slog.Error("template parse failed", "err", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", handleHome)
	mux.HandleFunc("GET /maps/{name}", handleMap)
	mux.HandleFunc("GET /players/{sid}", handlePlayer)
	mux.HandleFunc("GET /healthz", handleHealth)

	addr := envOr("LISTEN_ADDR", ":8080")
	slog.Info("cs2-records starting", "addr", addr, "records", recordsPath)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("listen failed", "err", err)
		os.Exit(1)
	}
}
