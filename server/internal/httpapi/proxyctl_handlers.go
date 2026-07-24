package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/proxyctl"

	corev1 "k8s.io/api/core/v1"
)

// proxyctlHub lazily builds (and caches) the logged-in ProxyCTL client from
// the stored link Secret, invalidating it whenever the link changes so a
// re-link takes effect immediately. The cached client keeps the bearer JWT
// warm across requests instead of re-logging-in (bcrypt on ProxyCTL's side)
// per call.
type proxyctlHub struct {
	cluster *kube.Cluster

	mu     sync.Mutex
	client *proxyctl.Client
	key    string // url|username|password the cached client was built from
}

func newProxyctlHub(cluster *kube.Cluster) *proxyctlHub {
	return &proxyctlHub{cluster: cluster}
}

// get returns a client for the stored link, or (nil, nil, nil) when no link
// is configured.
func (h *proxyctlHub) get(ctx context.Context) (*proxyctl.Client, *kube.ProxyCTLLink, error) {
	link, err := h.cluster.ProxyCTLLink(ctx)
	if err != nil || link == nil {
		return nil, nil, err
	}
	key := link.URL + "|" + link.Username + "|" + link.Password
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.client == nil || h.key != key {
		h.client = proxyctl.New(link.URL, link.Username, link.Password)
		h.key = key
	}
	return h.client, link, nil
}

func (h *proxyctlHub) invalidate() {
	h.mu.Lock()
	h.client, h.key = nil, ""
	h.mu.Unlock()
}

// proxyctlStatus reports whether a ProxyCTL install is reachable and
// whether a link (credentials) is stored. The wizard uses `detected` to
// show/hide the exposure choice; the publish panel uses `linked`.
func proxyctlStatus(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, hub.cluster) {
			return
		}
		link, err := hub.cluster.ProxyCTLLink(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		url := proxyctl.DefaultBaseURL
		username := ""
		if link != nil {
			if strings.TrimSpace(link.URL) != "" {
				url = link.URL
			}
			username = link.Username
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"detected": proxyctl.Detect(r.Context(), url),
			"url":      url,
			"linked":   link != nil,
			"username": username,
		})
	}
}

// setProxyctlLink verifies the supplied credentials against ProxyCTL's
// /api/token (save & test in one step) and persists them.
func setProxyctlLink(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, hub.cluster) {
			return
		}
		var req kube.ProxyCTLLink
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if strings.TrimSpace(req.Username) == "" || req.Password == "" {
			writeError(w, http.StatusBadRequest, "username and password are required")
			return
		}
		client := proxyctl.New(req.URL, req.Username, req.Password)
		if err := client.Login(r.Context()); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		if err := hub.cluster.SetProxyCTLLink(r.Context(), req); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		hub.invalidate()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "url": client.BaseURL()})
	}
}

func deleteProxyctlLink(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, hub.cluster) {
			return
		}
		if err := hub.cluster.DeleteProxyCTLLink(r.Context()); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		hub.invalidate()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// servicePorts derives ProxyCTL PortSpecs from a Service's ports, merging a
// TCP+UDP pair on the same port number into proto "both". RCON ports are
// excluded: they exist on game Services only for GameCTL's own console
// (reached via ClusterIP) and must never ride a public tunnel — an exposed
// RCON port gets brute-force-scanned within hours.
func servicePorts(svc *corev1.Service) []proxyctl.PortSpec {
	protos := map[int]map[string]bool{}
	for _, p := range svc.Spec.Ports {
		if strings.Contains(strings.ToLower(p.Name), "rcon") {
			continue
		}
		proto := strings.ToLower(string(p.Protocol))
		if proto != "tcp" && proto != "udp" {
			continue
		}
		if protos[int(p.Port)] == nil {
			protos[int(p.Port)] = map[string]bool{}
		}
		protos[int(p.Port)][proto] = true
	}
	out := make([]proxyctl.PortSpec, 0, len(protos))
	for port, ps := range protos {
		proto := "both"
		if !ps["tcp"] {
			proto = "udp"
		} else if !ps["udp"] {
			proto = "tcp"
		}
		out = append(out, proxyctl.PortSpec{Port: port, Proto: proto})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// publishTarget is one bindable address of an instance — the game Service
// itself, or a companion like Minecraft's BlueMap Service or CS2's
// surf-records website. Role is the short label the UI shows on the
// selector ("game", "bluemap", "records").
//
// Kind picks the ProxyCTL plane: "game" targets become L4 Entries (droplet
// port → WireGuard tunnel), "web" targets become WebRoutes (Cloudflare
// Tunnel — TLS at the edge, no droplet port). HTTP companions like BlueMap
// and surf-records are web.
type publishTarget struct {
	Service   string              `json:"service"`
	Role      string              `json:"role"`
	Kind      string              `json:"kind"`
	ClusterIP string              `json:"clusterIP"`
	Type      string              `json:"type"`
	Ports     []proxyctl.PortSpec `json:"ports"`
	// EntryName is the ProxyCTL entry name this target creates/matches
	// ("<instance>" for the game, "<instance>-<role>" for companions).
	EntryName string             `json:"entryName"`
	Entry     *proxyctl.Entry    `json:"entry,omitempty"`
	Drift     *proxyctl.Drift    `json:"drift,omitempty"`
	WebRoute  *proxyctl.WebRoute `json:"webRoute,omitempty"`
}

// targetKind classifies a Service: "web" when every publishable port is TCP
// and at least one port name marks it as HTTP ("http", "web" — the shapes
// GameCTL's generators emit for BlueMap's `bluemap-web` and surf-records'
// `http`). Everything else is a raw "game" target.
func targetKind(svc *corev1.Service) string {
	http := false
	for _, p := range svc.Spec.Ports {
		n := strings.ToLower(p.Name)
		if strings.Contains(n, "rcon") {
			continue
		}
		if p.Protocol == corev1.ProtocolUDP {
			return "game"
		}
		if strings.Contains(n, "http") || strings.Contains(n, "web") {
			http = true
		}
	}
	if http {
		return "web"
	}
	return "game"
}

// targetRole derives the selector label from the Service name:
// "<name>[-service]" → "game"; "<name>-bluemap-service" → "bluemap";
// "<name>-records" → "records".
func targetRole(svcName, instance string) string {
	base := strings.TrimSuffix(svcName, "-service")
	if base == instance || svcName == instance {
		return "game"
	}
	if r := strings.TrimPrefix(base, instance+"-"); r != "" && r != base {
		return r
	}
	return base
}

// targetEntryName is the ProxyCTL entry name for a target.
func targetEntryName(svcName, instance string) string {
	if role := targetRole(svcName, instance); role != "game" {
		return instance + "-" + role
	}
	return instance
}

// buildTargets maps the instance's Services to publishTargets and matches
// each against ProxyCTL's L4 entry list (game targets) or WebRoute list
// (web targets). For entries the "<service>.<namespace>" Service label is
// authoritative; TargetIP==ClusterIP and Name fallbacks catch entries
// created by hand in ProxyCTL — an entry claimed by one target via its
// Service label is never re-matched to another.
func buildTargets(svcs []corev1.Service, rows []proxyctl.EntryRow, webRoutes []proxyctl.WebRoute, ns, name string) []publishTarget {
	out := make([]publishTarget, 0, len(svcs))
	claimed := map[string]bool{}
	for i := range rows {
		if s := rows[i].Entry.Service; s != "" {
			claimed[s] = true
		}
	}
	for i := range svcs {
		svc := &svcs[i]
		t := publishTarget{
			Service:   svc.Name,
			Role:      targetRole(svc.Name, name),
			Kind:      targetKind(svc),
			ClusterIP: svc.Spec.ClusterIP,
			Type:      string(svc.Spec.Type),
			Ports:     servicePorts(svc),
			EntryName: targetEntryName(svc.Name, name),
		}
		if t.Kind == "web" {
			for j := range webRoutes {
				if webRoutes[j].Namespace == ns && webRoutes[j].Service == svc.Name {
					t.WebRoute = &webRoutes[j]
					break
				}
			}
			out = append(out, t)
			continue
		}
		svcLabel := svc.Name + "." + ns
		for j := range rows {
			e := &rows[j].Entry
			match := e.Service == svcLabel ||
				(e.Service == "" && !claimed[svcLabel] &&
					((t.ClusterIP != "" && e.TargetIP == t.ClusterIP) || e.Name == t.EntryName))
			if match {
				t.Entry = e
				t.Drift = rows[j].Drift
				break
			}
		}
		out = append(out, t)
	}
	return out
}

// prepareEgressEntry upgrades an entry to egress mode when the instance's
// Deployment carries gamectl.io/publish-mode=egress (games whose backend
// records the server's egress IP — the inbound tunnel alone can't make
// those joinable). It ensures the instance's WireGuard keypair exists and
// stamps the entry with mode + the PUBLIC key; existing tunnel identity is
// carried over so the droplet peer never churns. Returns the exclude-CIDR
// override for the sidecar step.
func prepareEgressEntry(ctx context.Context, hub *proxyctlHub, ns, name string, e *proxyctl.Entry, existing *proxyctl.Entry) (isEgress bool, excludeCIDRs string, err error) {
	mode, excl, err := hub.cluster.InstancePublishMode(ctx, ns, name)
	if err != nil || mode != "egress" {
		return false, "", err
	}
	pub, err := hub.cluster.EnsureEgressKeys(ctx, ns, name)
	if err != nil {
		return true, "", err
	}
	e.Mode = "egress"
	e.GatewayPubKey = pub
	if existing != nil && existing.TunnelIP != "" {
		e.TunnelIP = existing.TunnelIP
	}
	return true, excl, nil
}

// ensureEgressSidecar injects/updates the game pod's WireGuard sidecar for
// a saved egress entry, using the droplet's public peer info. Returns a
// human note for the UI/task log.
func ensureEgressSidecar(ctx context.Context, hub *proxyctlHub, client *proxyctl.Client, ns, name string, saved proxyctl.Entry, excludeCIDRs string) (string, error) {
	if saved.TunnelIP == "" {
		return "", fmt.Errorf("ProxyCTL returned no tunnel IP for egress entry %q", saved.Name)
	}
	d, err := client.Droplet(ctx)
	if err != nil {
		return "", fmt.Errorf("droplet info: %w", err)
	}
	if !d.Configured || d.WGPublicKey == "" {
		return "", fmt.Errorf("ProxyCTL's droplet has no WireGuard identity yet — finish ProxyCTL's droplet setup first")
	}
	endpoint := d.WGEndpointIP
	if endpoint == "" {
		endpoint = d.IP
	}
	port := d.WGPort
	if port == 0 {
		port = 51820
	}
	changed, err := hub.cluster.EnsureEgressSidecar(ctx, ns, name, kube.EgressWGConfig{
		TunnelIP:      saved.TunnelIP,
		DropletPubKey: d.WGPublicKey,
		EndpointIP:    endpoint,
		EndpointPort:  port,
		ExcludeCIDRs:  excludeCIDRs,
	})
	if err != nil {
		return "", err
	}
	if changed {
		return "egress sidecar configured (tunnel " + saved.TunnelIP + ") — the game pod restarts once to pick it up", nil
	}
	return "egress sidecar already up to date (tunnel " + saved.TunnelIP + ")", nil
}

// Deploy-time publish intent: the wizard stamps these annotations on the
// primary Deployment when the operator picked a public domain in the
// Networking step. After a successful apply, publishAfterApply fulfills
// them — deploy + DNS association become one action.
const (
	publishHostAnno   = "gamectl.io/publish-host"
	publishDomainAnno = "gamectl.io/publish-domain"
)

// publishIntent extracts the wizard's publish request from a manifest batch.
func publishIntent(docs []map[string]any) (ns, name, host, domain string, ok bool) {
	for _, d := range docs {
		if k, _ := d["kind"].(string); k != "Deployment" {
			continue
		}
		meta, _ := d["metadata"].(map[string]any)
		if meta == nil {
			continue
		}
		annos, _ := meta["annotations"].(map[string]any)
		dom, _ := annos[publishDomainAnno].(string)
		if dom == "" {
			continue
		}
		name, _ = meta["name"].(string)
		ns, _ = meta["namespace"].(string)
		host, _ = annos[publishHostAnno].(string)
		if host == "" {
			host = name
		}
		return ns, name, strings.ToLower(strings.TrimSpace(host)), strings.ToLower(strings.TrimSpace(dom)), name != ""
	}
	return "", "", "", "", false
}

// phaseReporter is the slice of the tasks.Handle surface publishAfterApply
// needs (kept tiny so tests can fake it).
type phaseReporter interface {
	BeginPhase(name, detail string) int
	EndPhaseDetail(idx int, err error, detail string)
}

// publishAfterApply runs as an extra task phase after a successful deploy:
// it binds every publishable target of the just-applied instance to
// ProxyCTL — the game Service as an L4 entry "<host>.<domain>", companions
// as "<host>-<role>.<domain>" (web ones over the Cloudflare Tunnel) — then
// pushes one ProxyCTL Apply / tunnel reconcile. ClusterIPs exist as soon
// as the Services are applied, so this needs no pod readiness.
//
// Best-effort by design: the deploy itself already succeeded, so failures
// here mark the phase (visible in the task log + fixable from the server's
// Networking panel), never the task.
func publishAfterApply(ctx context.Context, hub *proxyctlHub, rep phaseReporter, docs []map[string]any) {
	ns, name, host, domain, ok := publishIntent(docs)
	if !ok {
		return
	}
	idx := rep.BeginPhase("Publish via ProxyCTL", host+"."+domain)
	client, _, err := hub.get(ctx)
	if err == nil && client == nil {
		rep.EndPhaseDetail(idx, nil, "skipped — ProxyCTL is not linked (connect it on the server's Networking panel, then Publish from there)")
		return
	}
	if err != nil {
		rep.EndPhaseDetail(idx, err, "could not load the ProxyCTL link")
		return
	}
	svcs, err := hub.cluster.InstanceServices(ctx, ns, name)
	if err != nil {
		rep.EndPhaseDetail(idx, err, "could not resolve the instance's Services")
		return
	}
	rows, err := client.Entries(ctx)
	if err != nil {
		rep.EndPhaseDetail(idx, err, "ProxyCTL unreachable")
		return
	}
	webRoutes, cfReady, _ := client.WebRoutes(ctx)
	targets := buildTargets(svcs, rows, webRoutes, ns, name)

	var did []string
	var firstErr error
	l4Changed, webChanged := false, false
	for i := range targets {
		t := &targets[i]
		if len(t.Ports) == 0 {
			continue
		}
		hostname := host + "." + domain
		if t.Role != "game" {
			hostname = host + "-" + t.Role + "." + domain
		}
		if t.Kind == "web" {
			if t.WebRoute != nil {
				continue // already bound (redeploy) — leave the operator's hostname alone
			}
			if !cfReady {
				did = append(did, t.Role+": skipped — ProxyCTL has no Cloudflare API token")
				continue
			}
			_, err := client.CreateWebRoute(ctx, proxyctl.WebRoute{
				Hostname: hostname, Namespace: ns, Service: t.Service,
				Port: t.Ports[0].Port, Enabled: true,
			})
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				did = append(did, t.Role+": "+err.Error())
				continue
			}
			webChanged = true
			did = append(did, "https://"+hostname)
			continue
		}
		if t.Entry != nil {
			continue
		}
		e := proxyctl.Entry{
			Name: t.EntryName, Subdomain: hostname, Ports: t.Ports,
			TargetIP: t.ClusterIP, Service: t.Service + "." + ns, Enabled: true,
		}
		var isEgress bool
		var egressExcl string
		if t.Role == "game" {
			var egErr error
			isEgress, egressExcl, egErr = prepareEgressEntry(ctx, hub, ns, name, &e, nil)
			if egErr != nil {
				if firstErr == nil {
					firstErr = egErr
				}
				did = append(did, t.Role+": egress: "+egErr.Error())
				continue
			}
		}
		saved, err := client.CreateEntry(ctx, e)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			did = append(did, t.Role+": "+err.Error())
			continue
		}
		l4Changed = true
		did = append(did, hostname)
		if isEgress {
			note, egErr := ensureEgressSidecar(ctx, hub, client, ns, name, saved, egressExcl)
			if egErr != nil {
				if firstErr == nil {
					firstErr = egErr
				}
				did = append(did, "egress: "+egErr.Error())
			} else {
				did = append(did, note)
			}
		}
	}
	if l4Changed {
		if busy, err := client.Apply(ctx); err != nil && firstErr == nil {
			firstErr = err
		} else if busy {
			did = append(did, "(a ProxyCTL apply was already running — re-apply from the Networking panel)")
		}
	}
	if webChanged {
		if err := client.TunnelSetup(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	detail := strings.Join(did, ", ")
	if detail == "" {
		detail = "nothing to publish (targets already bound or expose no ports)"
	}
	rep.EndPhaseDetail(idx, firstErr, detail)
}

// unpublishInstance removes every ProxyCTL binding of an instance — L4
// entries (including their Cloudflare A records) and Cloudflare-Tunnel web
// routes — then pushes ProxyCTL's apply / tunnel reconcile. Runs as a task
// phase BEFORE the cluster delete sweep, while the Services still exist to
// resolve the bindings. Best-effort: failures mark the phase, never the
// delete — a dangling entry is harmless (dead ClusterIP) and can still be
// removed in ProxyCTL by hand.
func unpublishInstance(ctx context.Context, hub *proxyctlHub, rep phaseReporter, ns, name string) {
	idx := rep.BeginPhase("Unpublish from ProxyCTL", ns+"/"+name)
	client, _, err := hub.get(ctx)
	if err == nil && client == nil {
		rep.EndPhaseDetail(idx, nil, "skipped — ProxyCTL is not linked")
		return
	}
	if err != nil {
		rep.EndPhaseDetail(idx, err, "could not load the ProxyCTL link")
		return
	}
	svcs, err := hub.cluster.InstanceServices(ctx, ns, name)
	if err != nil {
		// Deployment/Services already gone (or never existed) — nothing to
		// resolve, nothing to unpublish. Not an error.
		rep.EndPhaseDetail(idx, nil, "no Services found — nothing to unpublish")
		return
	}
	rows, err := client.Entries(ctx)
	if err != nil {
		rep.EndPhaseDetail(idx, err, "ProxyCTL unreachable — remove the entries in ProxyCTL by hand")
		return
	}
	webRoutes, _, _ := client.WebRoutes(ctx)
	targets := buildTargets(svcs, rows, webRoutes, ns, name)

	var did []string
	var firstErr error
	l4Changed, webChanged := false, false
	for i := range targets {
		t := &targets[i]
		if t.Entry != nil {
			// removeDNS=true: the server is going away, so its A record is
			// pure dangling state — ProxyCTL only deletes records it manages.
			dnsMsg, err := client.DeleteEntry(ctx, t.Entry.ID, true)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				did = append(did, t.Role+": "+err.Error())
				continue
			}
			if t.Entry.Mode == "egress" {
				// Instance is being deleted anyway, but strip the sidecar +
				// keys Secret so a same-name redeploy starts clean.
				if err := hub.cluster.RemoveEgressSidecar(ctx, ns, name); err != nil {
					did = append(did, "egress cleanup: "+err.Error())
				}
			}
			l4Changed = true
			msg := t.Entry.Subdomain
			if msg == "" {
				msg = t.EntryName
			}
			if dnsMsg != "" {
				msg += " (" + dnsMsg + ")"
			}
			did = append(did, msg)
		}
		if t.WebRoute != nil {
			if err := client.DeleteWebRoute(ctx, t.WebRoute.ID); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				did = append(did, t.Role+": "+err.Error())
				continue
			}
			webChanged = true
			did = append(did, t.WebRoute.Hostname)
		}
	}
	if l4Changed {
		if _, err := client.Apply(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if webChanged {
		if err := client.TunnelSetup(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	detail := strings.Join(did, ", ")
	if detail == "" {
		detail = "no ProxyCTL bindings for this instance"
	} else {
		detail = "removed: " + detail
	}
	rep.EndPhaseDetail(idx, firstErr, detail)
}

// proxyctlDomains proxies ProxyCTL's merged base-domain list — powers the
// wizard's "Public domain" dropdown. Empty list (not an error) when no
// link is configured, so the wizard field simply has nothing to offer.
func proxyctlDomains(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, hub.cluster) {
			return
		}
		client, _, err := hub.get(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if client == nil {
			writeJSON(w, http.StatusOK, map[string]any{"domains": []string{}})
			return
		}
		domains, err := client.Domains(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"domains": domains})
	}
}

// findTarget picks the requested target by Service name ("" = primary).
func findTarget(targets []publishTarget, svcName string) *publishTarget {
	if svcName == "" {
		if len(targets) > 0 {
			return &targets[0]
		}
		return nil
	}
	for i := range targets {
		if targets[i].Service == svcName {
			return &targets[i]
		}
	}
	return nil
}

// publishInfo powers the per-instance Networking panel: every bindable
// target (game Service + companions like BlueMap / surf-records) with its
// ClusterIP, ports, and matched ProxyCTL entry, and — when linked — the
// domain list and droplet state needed by the publish forms.
func publishInfo(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, hub.cluster) {
			return
		}
		ns, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")

		out := map[string]any{"linked": false}
		if mode, _, err := hub.cluster.InstancePublishMode(r.Context(), ns, name); err == nil && mode != "" {
			out["publishMode"] = mode
		}
		svcs, svcErr := hub.cluster.InstanceServices(r.Context(), ns, name)

		client, link, err := hub.get(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if client == nil {
			if svcErr == nil {
				out["targets"] = buildTargets(svcs, nil, nil, ns, name)
			}
			out["detected"] = proxyctl.Detect(r.Context(), proxyctl.DefaultBaseURL)
			out["url"] = proxyctl.DefaultBaseURL
			writeJSON(w, http.StatusOK, out)
			return
		}
		out["linked"] = true
		out["url"] = client.BaseURL()
		out["username"] = link.Username

		rows, err := client.Entries(r.Context())
		if err != nil {
			// Link stored but ProxyCTL unreachable/rejecting — surface it in
			// the panel rather than failing the whole card.
			if svcErr == nil {
				out["targets"] = buildTargets(svcs, nil, nil, ns, name)
			}
			out["linkError"] = err.Error()
			writeJSON(w, http.StatusOK, out)
			return
		}
		// Web routes power the Cloudflare-Tunnel side (BlueMap/records);
		// cfReady tells the UI whether ProxyCTL can actually apply them.
		webRoutes, cfReady, wrErr := client.WebRoutes(r.Context())
		if wrErr == nil {
			out["cfReady"] = cfReady
		}
		if svcErr == nil {
			out["targets"] = buildTargets(svcs, rows, webRoutes, ns, name)
		}
		if domains, err := client.Domains(r.Context()); err == nil {
			out["domains"] = domains
		}
		if d, err := client.Droplet(r.Context()); err == nil {
			out["droplet"] = d
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// proxyctlEntryUptime handles GET /proxyctl/entries/{id}/uptime — a thin
// passthrough to ProxyCTL's own external-reachability history for a
// published Proxy Entry, over the existing admin link. GameCTL never
// computes this itself; it only ever displays what ProxyCTL already
// checked (see the design note on proxyctl.Client.EntryUptime).
func proxyctlEntryUptime(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		client, _, err := hub.get(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if client == nil {
			writeJSON(w, http.StatusOK, map[string]any{"available": false})
			return
		}
		history, err := client.EntryUptime(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"available": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"available": len(history) > 0, "history": history})
	}
}

// proxyctlWebRouteUptime is proxyctlEntryUptime's counterpart for a
// published Web App route.
func proxyctlWebRouteUptime(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		client, _, err := hub.get(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if client == nil {
			writeJSON(w, http.StatusOK, map[string]any{"available": false})
			return
		}
		history, err := client.WebRouteUptime(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"available": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"available": len(history) > 0, "history": history})
	}
}

type publishReq struct {
	// Service selects which of the instance's targets to publish (the
	// Service name from publishInfo's targets). Empty = the primary
	// (game) Service, so single-Service instances need no selector.
	Service string `json:"service,omitempty"`
	// Subdomain is the full public name ("valheim.example.com"). The UI
	// composes it from its host + domain inputs.
	Subdomain string `json:"subdomain"`
	// Ports optionally overrides the Service-derived port list.
	Ports []proxyctl.PortSpec `json:"ports,omitempty"`
	// Enabled defaults to true on create; on update, nil keeps the current
	// value (so a plain re-publish/rebind doesn't re-enable a paused entry).
	Enabled *bool `json:"enabled,omitempty"`
}

// publishSet creates or updates the ProxyCTL entry for one target of the
// instance (target = that Service's live ClusterIP) and triggers Apply,
// which pushes droplet iptables + the WireGuard gateway and upserts DNS
// when ProxyCTL has a Cloudflare token.
func publishSet(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, hub.cluster) {
			return
		}
		ns, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")
		var req publishReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}

		client, _, err := hub.get(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if client == nil {
			writeError(w, http.StatusConflict, "ProxyCTL is not linked — connect it first")
			return
		}
		svcs, err := hub.cluster.InstanceServices(r.Context(), ns, name)
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		rows, err := client.Entries(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		webRoutes, cfReady, _ := client.WebRoutes(r.Context())
		target := findTarget(buildTargets(svcs, rows, webRoutes, ns, name), req.Service)
		if target == nil {
			writeError(w, http.StatusNotFound, fmt.Sprintf("Service %q is not one of this instance's targets", req.Service))
			return
		}

		// Web targets (BlueMap, surf-records, …) publish through ProxyCTL's
		// Cloudflare Tunnel: hostname → in-cluster Service, TLS at the edge.
		if target.Kind == "web" {
			if !cfReady {
				writeError(w, http.StatusConflict, "ProxyCTL has no Cloudflare API token — web routes need one (ProxyCTL → Setup → Cloudflare)")
				return
			}
			if len(target.Ports) == 0 {
				writeError(w, http.StatusBadRequest, "this Service exposes no publishable port")
				return
			}
			wr := proxyctl.WebRoute{
				Hostname:  strings.ToLower(strings.TrimSpace(req.Subdomain)),
				Namespace: ns,
				Service:   target.Service,
				Port:      target.Ports[0].Port,
				Enabled:   true,
			}
			if existing := target.WebRoute; existing != nil {
				wr.ID = existing.ID
				if wr.Hostname == "" {
					wr.Hostname = existing.Hostname
				}
				wr.Enabled = existing.Enabled
			}
			if req.Enabled != nil {
				wr.Enabled = *req.Enabled
			}
			var saved proxyctl.WebRoute
			if wr.ID != "" {
				saved, err = client.UpdateWebRoute(r.Context(), wr)
			} else {
				saved, err = client.CreateWebRoute(r.Context(), wr)
			}
			if err != nil {
				writeError(w, http.StatusBadGateway, err.Error())
				return
			}
			out := map[string]any{"webRoute": saved, "applied": true}
			if err := client.TunnelSetup(r.Context()); err != nil {
				out["applied"] = false
				out["applyError"] = err.Error()
			}
			writeJSON(w, http.StatusOK, out)
			return
		}

		ports := req.Ports
		if len(ports) == 0 {
			ports = target.Ports
		}
		if len(ports) == 0 {
			writeError(w, http.StatusBadRequest, "this Service exposes no publishable TCP/UDP ports")
			return
		}

		e := proxyctl.Entry{
			Name:     target.EntryName,
			Ports:    ports,
			TargetIP: target.ClusterIP,
			Service:  target.Service + "." + ns,
			Enabled:  true,
		}
		if req.Subdomain != "" {
			e.Subdomain = strings.ToLower(strings.TrimSpace(req.Subdomain))
		}
		existing := target.Entry
		if existing != nil {
			e.ID = existing.ID
			if e.Subdomain == "" {
				e.Subdomain = existing.Subdomain
			}
			e.Enabled = existing.Enabled
			// Never regress an entry's data plane on a plain re-publish.
			e.Mode = existing.Mode
			e.TunnelIP = existing.TunnelIP
			e.GatewayPubKey = existing.GatewayPubKey
		}
		if req.Enabled != nil {
			e.Enabled = *req.Enabled
		}

		var isEgress bool
		var egressExcl string
		if target.Role == "game" {
			isEgress, egressExcl, err = prepareEgressEntry(r.Context(), hub, ns, name, &e, existing)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "egress publish: "+err.Error())
				return
			}
		}

		var saved proxyctl.Entry
		if existing != nil {
			saved, err = client.UpdateEntry(r.Context(), e)
		} else {
			saved, err = client.CreateEntry(r.Context(), e)
		}
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}

		var egressNote string
		var egressErr error
		if isEgress {
			egressNote, egressErr = ensureEgressSidecar(r.Context(), hub, client, ns, name, saved, egressExcl)
		}

		applyBusy, applyErr := client.Apply(r.Context())
		out := map[string]any{"entry": saved, "applied": applyErr == nil && !applyBusy}
		if egressNote != "" {
			out["egress"] = egressNote
		}
		if egressErr != nil {
			out["egressError"] = egressErr.Error()
		}
		if applyBusy {
			out["applyNote"] = "a ProxyCTL apply was already running — re-apply from ProxyCTL (or re-publish) to push this change"
		}
		if applyErr != nil {
			out["applyError"] = applyErr.Error()
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// publishDelete removes one target's ProxyCTL entry (?service= selects it;
// empty = primary) and, with ?dns=1, its Cloudflare A record, then applies.
func publishDelete(hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, hub.cluster) {
			return
		}
		ns, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")
		client, _, err := hub.get(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if client == nil {
			writeError(w, http.StatusConflict, "ProxyCTL is not linked")
			return
		}
		rows, err := client.Entries(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		webRoutes, _, _ := client.WebRoutes(r.Context())
		var target *publishTarget
		if svcs, err := hub.cluster.InstanceServices(r.Context(), ns, name); err == nil {
			target = findTarget(buildTargets(svcs, rows, webRoutes, ns, name), r.URL.Query().Get("service"))
		}

		// Web targets: drop the route and reconcile the tunnel's ingress
		// rules (the proxied CNAME is managed by ProxyCTL's tunnel apply).
		if target != nil && target.Kind == "web" {
			if target.WebRoute == nil {
				writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "no web route for this target"})
				return
			}
			if err := client.DeleteWebRoute(r.Context(), target.WebRoute.ID); err != nil {
				writeError(w, http.StatusBadGateway, err.Error())
				return
			}
			out := map[string]any{"ok": true, "applied": true}
			if err := client.TunnelSetup(r.Context()); err != nil {
				out["applied"] = false
				out["applyError"] = err.Error()
			}
			writeJSON(w, http.StatusOK, out)
			return
		}

		if target == nil || target.Entry == nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "no ProxyCTL entry for this target"})
			return
		}
		dnsMsg, err := client.DeleteEntry(r.Context(), target.Entry.ID, r.URL.Query().Get("dns") == "1")
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		var egressCleanup string
		if target.Entry.Mode == "egress" {
			// The server keeps running unpublished — remove the sidecar (one
			// pod roll) so its egress returns to the cluster's own WAN.
			if err := hub.cluster.RemoveEgressSidecar(r.Context(), ns, name); err != nil {
				egressCleanup = err.Error()
			}
		}
		applyBusy, applyErr := client.Apply(r.Context())
		out := map[string]any{"ok": true, "dns": dnsMsg, "applied": applyErr == nil && !applyBusy}
		if egressCleanup != "" {
			out["egressCleanupError"] = egressCleanup
		}
		if applyErr != nil {
			out["applyError"] = applyErr.Error()
		}
		writeJSON(w, http.StatusOK, out)
	}
}
