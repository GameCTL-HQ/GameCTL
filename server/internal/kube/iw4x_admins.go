package kube

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// Bot Warfare menu admins for IW4X.
//
// The mod's in-game menu (Action Slot 2) is gated by doHostCheck(): a player
// qualifies via ishost() — which nobody is on a dedicated server — or by
// appearing in the bots_main_GUIDs dvar. So "admin" here means exactly that
// list, and there is no other admin concept in IW4x to manage.
//
// The list lives in its own cfg file that the generated server.cfg execs last,
// rather than in server.cfg itself. That's deliberate: server.cfg is rewritten
// from the wizard on every boot, so a panel edit stored there would silently
// vanish on the next restart. This file is seeded once and owned by the panel
// thereafter.
const iw4xAdminsPath = "/iw4x/players/gamectl-admins.cfg"

// IW4XAdmin is one entry in the list. Label is a human note stored as a
// comment, since the dvar itself holds nothing but GUIDs.
type IW4XAdmin struct {
	GUID  string `json:"guid"`
	Label string `json:"label,omitempty"`
}

var (
	adminsDvarRe = regexp.MustCompile(`(?m)^\s*set\s+bots_main_GUIDs\s+"([^"]*)"`)
	adminLabelRe = regexp.MustCompile(`(?m)^\s*//\s*label\s+(\S+)\s+(.*)$`)
)

// IW4XAdmins reads the current list off the volume.
func (c *Cluster) IW4XAdmins(ctx context.Context, ns, server string) ([]IW4XAdmin, error) {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return nil, err
	}
	out, _, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "cat " + iw4xAdminsPath + " 2>/dev/null || true"}, "")
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", iw4xAdminsPath, err)
	}

	labels := map[string]string{}
	for _, m := range adminLabelRe.FindAllStringSubmatch(out, -1) {
		labels[m[1]] = strings.TrimSpace(m[2])
	}

	var admins []IW4XAdmin
	if m := adminsDvarRe.FindStringSubmatch(out); len(m) == 2 {
		for _, g := range strings.Split(m[1], ",") {
			if g = strings.TrimSpace(g); g != "" {
				admins = append(admins, IW4XAdmin{GUID: g, Label: labels[g]})
			}
		}
	}
	return admins, nil
}

// IW4XSetAdmins replaces the list, writing the file and applying the dvar live.
//
// Applying live matters more than it looks: doHostCheck() runs when a player
// CONNECTS, so setting the dvar now means anyone who reconnects is covered
// without a server restart. Callers should still tell the operator that much.
func (c *Cluster) IW4XSetAdmins(ctx context.Context, ns, server string, admins []IW4XAdmin) error {
	seen := map[string]bool{}
	var guids []string
	var lines []string
	lines = append(lines, "// GameCTL-managed — Bot Warfare menu admins. Edit from the manage screen.")

	for _, a := range admins {
		g := strings.TrimSpace(a.GUID)
		// Quotes and commas would break out of the dvar assignment or split
		// one GUID into two; neither belongs in an identifier anyway.
		if g == "" || seen[g] || strings.ContainsAny(g, `",`) {
			continue
		}
		seen[g] = true
		guids = append(guids, g)
		if l := strings.TrimSpace(a.Label); l != "" {
			l = strings.ReplaceAll(l, "\n", " ")
			lines = append(lines, fmt.Sprintf("// label %s %s", g, l))
		}
	}
	lines = append(lines, fmt.Sprintf(`set bots_main_GUIDs "%s"`, strings.Join(guids, ",")))
	body := strings.Join(lines, "\n") + "\n"

	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return err
	}
	if _, stderr, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "mkdir -p $(dirname " + iw4xAdminsPath + ") && cat > " + iw4xAdminsPath}, body); err != nil {
		return fmt.Errorf("write %s: %w (%s)", iw4xAdminsPath, err, strings.TrimSpace(stderr))
	}

	// Best-effort live apply: a failure here means the file is still correct
	// and the next restart picks it up, so it must not fail the whole call.
	_, _ = c.RunRCON(ctx, ns, server, fmt.Sprintf("bots_main_GUIDs %s", strings.Join(guids, ",")))
	return nil
}
