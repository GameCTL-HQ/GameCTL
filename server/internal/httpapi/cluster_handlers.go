package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/proxyctl"
)

// listMetalLBPools handles GET /api/cluster/metallb/pools.
// Returns [{name, namespace, addresses[], autoAssign}, ...]. Empty list
// if MetalLB CRDs aren't installed; not an error.
func listMetalLBPools(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		pools, err := c.MetalLBPools(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, pools)
	}
}

// listMetalLBFreeIPs handles GET /api/cluster/metallb/free-ips?pool=<name>.
// Returns {pool, free[], used[], reservedCount}.
//
// "Free" = address-pool entries expanded into individual IPs, minus any IP
// currently bound to a Service of type LoadBalancer anywhere in the cluster.
func listMetalLBFreeIPs(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		poolName := r.URL.Query().Get("pool")
		if poolName == "" {
			writeError(w, http.StatusBadRequest, "pool query parameter required")
			return
		}

		pools, err := c.MetalLBPools(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		var target *kube.MetalLBPool
		for i := range pools {
			if pools[i].Name == poolName {
				target = &pools[i]
				break
			}
		}
		if target == nil {
			writeError(w, http.StatusNotFound, "pool not found: "+poolName)
			return
		}

		used, err := c.LoadBalancerIPsInUse(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}

		result, err := kube.FreeIPs(*target, used)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

// listPortsInUse handles GET /api/cluster/ports.
// Returns {ports: [{port, protocol, nodePort, namespace, service, game,
// instance, type, lbIP}, ...]} — every Service port claimed anywhere in the
// cluster. The deploy wizard uses it to warn before an operator picks a port
// another server already owns (e.g. CS2's RCON on 27015/TCP).
func listPortsInUse(c *kube.Cluster, hub *proxyctlHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ports, err := c.PortsInUse(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		ports = append(ports, proxyctlPortsInUse(r.Context(), hub)...)
		writeJSON(w, http.StatusOK, map[string]any{"ports": ports})
	}
}

// proxyctlPortsInUse lists the PUBLIC ports ProxyCTL already routes.
//
// These are a separate allocation from Service ports, and a much stricter
// one: ProxyCTL routes one public port to exactly one target, so a number
// another entry already publishes cannot be shared at all. Without them in
// the inventory the wizard recommends ports that are free in-cluster but
// taken publicly, publishing then remaps to something else, and the number
// deployed from GameCTL permanently disagrees with the number players use.
//
// Best-effort: an unlinked or unreachable ProxyCTL contributes no rows rather
// than failing the whole inventory, since the Service ports still stand alone.
func proxyctlPortsInUse(ctx context.Context, hub *proxyctlHub) []kube.PortUse {
	if hub == nil {
		return nil
	}
	client, _, err := hub.get(ctx)
	if err != nil || client == nil {
		return nil
	}
	rows, err := client.Entries(ctx)
	if err != nil {
		return nil
	}
	return entryPortsInUse(rows)
}

// entryPortsInUse maps ProxyCTL entries onto the port inventory. Split out
// from the fetch so the collision rules are testable without a live ProxyCTL.
func entryPortsInUse(rows []proxyctl.EntryRow) []kube.PortUse {
	var out []kube.PortUse
	for _, row := range rows {
		e := row.Entry
		if !e.Enabled {
			continue // a disabled entry does not hold its port
		}
		for _, p := range e.Ports {
			// ProxyCTL's "both" occupies TCP and UDP alike; expand it so a
			// single-protocol pick still collides with it.
			protos := []string{strings.ToUpper(p.Proto)}
			if strings.EqualFold(p.Proto, "both") {
				protos = []string{"TCP", "UDP"}
			}
			for _, proto := range protos {
				out = append(out, kube.PortUse{
					Port:     p.Port,
					Protocol: proto,
					Service:  e.Name,
					PortName: e.Subdomain,
					Instance: e.Name,
					Type:     "ProxyCTL",
					Source:   "proxyctl",
				})
			}
		}
	}
	return out
}

// listStorageClasses handles GET /api/cluster/storageclasses.
func listStorageClasses(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		out, err := c.StorageClasses(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// clusterInfo handles GET /api/cluster/info — reads the gamectl/cluster-info
// ConfigMap. Returns zero-value (name="", description="") if the CM doesn't
// exist, so the UI can fall back to a default display.
func clusterInfo(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		info, err := c.Info(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, info)
	}
}

// metricsServerStatus handles GET /api/cluster/metrics-server.
func metricsServerStatus(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		out, err := c.MetricsServerStatus(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// NOTE: GameCTL used to expose POST /api/cluster/metrics-server/install,
// which applied an embedded metrics-server manifest from inside the pod.
// That could only ever work for an operator who had granted GameCTL
// cluster-admin-ish rights — under the shipped RBAC it was guaranteed to
// 403. The UI now shows the operator the kubectl command instead
// (kube.MetricsServerInstallCommand), so GameCTL's namespace-confined
// ServiceAccount stays as-is.
