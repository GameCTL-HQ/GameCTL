package httpapi

import (
	"net/http"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
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
