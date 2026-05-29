package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

// CS2 surf records — read-only window into the JSON the GameCtlSurfHUD
// plugin writes to /home/steam/cs2/gamectl_surf_records.json on every new
// PB. GameCTL surfaces the same data on the manage screen so an operator
// can see leaderboards without joining the server or running !top in chat.

const cs2SurfRecordsPath = "/home/steam/cs2/gamectl_surf_records.json"

// CS2SurfRecord is one row in the per-map leaderboard.
type CS2SurfRecord struct {
	SteamID64  string `json:"steamId64"`
	Name       string `json:"name"`
	TimeMs     int64  `json:"timeMs"`
	FinishedAt string `json:"finishedAt"`
}

// CS2SurfMapBoard groups records for a single map, sorted fastest-first.
type CS2SurfMapBoard struct {
	Map     string          `json:"map"`
	Records []CS2SurfRecord `json:"records"`
}

// CS2SurfRecords is the wire shape for GET /cs2/surf-records.
type CS2SurfRecords struct {
	Maps  []CS2SurfMapBoard `json:"maps"`
	Total int               `json:"total"` // total records across all maps
}

// internal: matches the plugin's RecordsFile / RecordEntry on disk.
type surfRecordsOnDisk struct {
	Version int                                  `json:"version"`
	Records map[string]map[string]surfRecordRaw  `json:"records"`
}
type surfRecordRaw struct {
	Name       string `json:"name"`
	TimeMs     int64  `json:"time_ms"`
	FinishedAt string `json:"finished_at"`
}

// CS2GetSurfRecords reads the records JSON off the running pod and
// returns it shaped for the leaderboard UI.
func (c *Cluster) CS2GetSurfRecords(ctx context.Context, ns, server string) (*CS2SurfRecords, error) {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return nil, err
	}
	// `cat` returns empty + exit 1 if the file doesn't exist — treat as
	// "no records yet" rather than an error so the panel still renders.
	raw, _, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "if [ -s " + cs2SurfRecordsPath + " ]; then cat " + cs2SurfRecordsPath + "; fi"}, "")
	if err != nil {
		return nil, fmt.Errorf("read surf records: %w", err)
	}
	out := &CS2SurfRecords{Maps: []CS2SurfMapBoard{}}
	if raw == "" {
		return out, nil
	}
	var on surfRecordsOnDisk
	if err := json.Unmarshal([]byte(raw), &on); err != nil {
		return nil, fmt.Errorf("parse surf records: %w", err)
	}
	for mapName, sidDict := range on.Records {
		board := CS2SurfMapBoard{Map: mapName, Records: make([]CS2SurfRecord, 0, len(sidDict))}
		for sid, r := range sidDict {
			board.Records = append(board.Records, CS2SurfRecord{
				SteamID64: sid, Name: r.Name, TimeMs: r.TimeMs, FinishedAt: r.FinishedAt,
			})
		}
		sort.Slice(board.Records, func(i, j int) bool {
			return board.Records[i].TimeMs < board.Records[j].TimeMs
		})
		out.Maps = append(out.Maps, board)
		out.Total += len(board.Records)
	}
	// Stable, alphabetic-by-map ordering for the UI.
	sort.Slice(out.Maps, func(i, j int) bool { return out.Maps[i].Map < out.Maps[j].Map })
	return out, nil
}
