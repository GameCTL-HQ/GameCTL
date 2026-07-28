package kube

import (
	"context"
	"fmt"
	"net/netip"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// MetalLBPool is the wire shape for /api/cluster/metallb/pools.
type MetalLBPool struct {
	Name       string   `json:"name"`
	Namespace  string   `json:"namespace"`
	Addresses  []string `json:"addresses"` // raw spec entries: "10.0.0.160-10.0.0.183", "10.0.0.250/32"
	AutoAssign bool     `json:"autoAssign"`
}

// StorageClassInfo is the wire shape for /api/cluster/storageclasses.
type StorageClassInfo struct {
	Name          string `json:"name"`
	Provisioner   string `json:"provisioner"`
	ReclaimPolicy string `json:"reclaimPolicy"`
	IsDefault     bool   `json:"isDefault"`
}

// ClusterInfo is the wire shape for /api/cluster/info — values read from the
// gamectl/cluster-info ConfigMap (or zero-values if it doesn't exist).
type ClusterInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// PortUse is one Service port already claimed somewhere in the cluster — the
// wire shape for /api/cluster/ports. `game`/`instance` are empty for anything
// GameCTL didn't deploy (Traefik, GitLab, …), which is still worth reporting:
// a node port or LB IP those hold collides just as hard.
type PortUse struct {
	Port      int    `json:"port"`
	Protocol  string `json:"protocol"` // TCP | UDP | SCTP
	NodePort  int    `json:"nodePort,omitempty"`
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
	PortName  string `json:"portName,omitempty"`
	Game      string `json:"game,omitempty"`     // `game` label, e.g. "cs2"
	Instance  string `json:"instance,omitempty"` // `gamectl.io/instance` label
	Type      string `json:"type"`               // ClusterIP | LoadBalancer | NodePort
	LBIP      string `json:"lbIP,omitempty"`     // assigned, else requested
}

// FreeIPsResult is the wire shape for /api/cluster/metallb/free-ips.
type FreeIPsResult struct {
	Pool    string   `json:"pool"`
	Free    []string `json:"free"`
	UsedIn  []string `json:"used"`        // IPs taken by current LoadBalancer Services
	Reserved int     `json:"reservedCount"` // size of the pool
}

var metallbPoolGVR = schema.GroupVersionResource{
	Group:    "metallb.io",
	Version:  "v1beta1",
	Resource: "ipaddresspools",
}

// MetalLBPools lists all MetalLB IPAddressPool CRs in the cluster.
func (c *Cluster) MetalLBPools(ctx context.Context) ([]MetalLBPool, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	list, err := b.dynamic.Resource(metallbPoolGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			// CRD not installed
			return []MetalLBPool{}, nil
		}
		return nil, err
	}
	out := make([]MetalLBPool, 0, len(list.Items))
	for _, item := range list.Items {
		spec, _ := item.Object["spec"].(map[string]any)
		var addrs []string
		if a, ok := spec["addresses"].([]any); ok {
			for _, x := range a {
				if s, ok := x.(string); ok {
					addrs = append(addrs, s)
				}
			}
		}
		// MetalLB defaults autoAssign to true when unset.
		auto := true
		if v, ok := spec["autoAssign"].(bool); ok {
			auto = v
		}
		out = append(out, MetalLBPool{
			Name:       item.GetName(),
			Namespace:  item.GetNamespace(),
			Addresses:  addrs,
			AutoAssign: auto,
		})
	}
	return out, nil
}

// LoadBalancerIPsInUse returns the set of IPs currently bound to a Service of
// type LoadBalancer anywhere in the cluster (either assigned by MetalLB or
// requested via spec.loadBalancerIP). Used by FreeIPs.
func (c *Cluster) LoadBalancerIPsInUse(ctx context.Context) (map[string]bool, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	svcs, err := b.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	used := make(map[string]bool)
	for _, s := range svcs.Items {
		if string(s.Spec.Type) != "LoadBalancer" {
			continue
		}
		if s.Spec.LoadBalancerIP != "" {
			used[s.Spec.LoadBalancerIP] = true
		}
		for _, ing := range s.Status.LoadBalancer.Ingress {
			if ing.IP != "" {
				used[ing.IP] = true
			}
		}
	}
	return used, nil
}

// PortsInUse lists every port already claimed by a Service anywhere in the
// cluster, so the deploy wizard can tell the operator "27015/TCP is already
// CS2's RCON" *before* generating a manifest that silently collides.
//
// A port number on its own is not a conflict: two ClusterIP Services can both
// publish 27015 because each has its own ClusterIP. What actually collides is
// (a) the same port+protocol on the same LoadBalancer IP, and (b) the same
// nodePort, which is cluster-global. The UI decides severity from these
// fields, so this returns the raw inventory rather than a verdict.
func (c *Cluster) PortsInUse(ctx context.Context) ([]PortUse, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	svcs, err := b.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]PortUse, 0, len(svcs.Items)*2)
	for _, s := range svcs.Items {
		// The LB IP a Service occupies: the assigned one wins, the requested
		// one is the fallback (it's what a not-yet-assigned Service will take).
		lbIP := s.Spec.LoadBalancerIP
		for _, ing := range s.Status.LoadBalancer.Ingress {
			if ing.IP != "" {
				lbIP = ing.IP
				break
			}
		}
		for _, p := range s.Spec.Ports {
			proto := string(p.Protocol)
			if proto == "" {
				proto = "TCP" // Kubernetes' own default
			}
			out = append(out, PortUse{
				Port:      int(p.Port),
				Protocol:  proto,
				NodePort:  int(p.NodePort),
				Namespace: s.Namespace,
				Service:   s.Name,
				PortName:  p.Name,
				Game:      s.Labels["game"],
				Instance:  s.Labels["gamectl.io/instance"],
				Type:      string(s.Spec.Type),
				LBIP:      lbIP,
			})
		}
	}
	return out, nil
}

// FreeIPs expands a pool's address spec into individual IPs and subtracts
// the ones currently in use. Caps at 4096 returned IPs to avoid blowing up
// the response for accidentally huge pools.
func FreeIPs(pool MetalLBPool, used map[string]bool) (FreeIPsResult, error) {
	const maxIPs = 4096
	all, err := expandPoolAddresses(pool.Addresses, maxIPs)
	if err != nil {
		return FreeIPsResult{}, err
	}
	free := make([]string, 0, len(all))
	usedList := make([]string, 0)
	for _, ip := range all {
		if used[ip] {
			usedList = append(usedList, ip)
		} else {
			free = append(free, ip)
		}
	}
	return FreeIPsResult{
		Pool:     pool.Name,
		Free:     free,
		UsedIn:   usedList,
		Reserved: len(all),
	}, nil
}

// expandPoolAddresses turns ["10.0.0.160-10.0.0.183", "10.0.0.250/32"]
// into a flat list of individual IP strings.
func expandPoolAddresses(addrs []string, cap int) ([]string, error) {
	var out []string
	for _, entry := range addrs {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		switch {
		case strings.Contains(entry, "-"):
			parts := strings.SplitN(entry, "-", 2)
			start, err := netip.ParseAddr(strings.TrimSpace(parts[0]))
			if err != nil {
				return nil, fmt.Errorf("bad range start %q: %w", parts[0], err)
			}
			end, err := netip.ParseAddr(strings.TrimSpace(parts[1]))
			if err != nil {
				return nil, fmt.Errorf("bad range end %q: %w", parts[1], err)
			}
			for ip := start; ip.Compare(end) <= 0; ip = ip.Next() {
				if len(out) >= cap {
					return out, nil
				}
				out = append(out, ip.String())
			}
		case strings.Contains(entry, "/"):
			prefix, err := netip.ParsePrefix(entry)
			if err != nil {
				return nil, fmt.Errorf("bad CIDR %q: %w", entry, err)
			}
			// /32 fast path
			if prefix.Bits() == prefix.Addr().BitLen() {
				out = append(out, prefix.Addr().String())
				continue
			}
			for ip := prefix.Addr(); prefix.Contains(ip); ip = ip.Next() {
				if len(out) >= cap {
					return out, nil
				}
				out = append(out, ip.String())
			}
		default:
			// Single address
			ip, err := netip.ParseAddr(entry)
			if err != nil {
				return nil, fmt.Errorf("bad address %q: %w", entry, err)
			}
			out = append(out, ip.String())
		}
	}
	return out, nil
}

// StorageClasses lists StorageClasses in the cluster, marking the default one.
func (c *Cluster) StorageClasses(ctx context.Context) ([]StorageClassInfo, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	list, err := b.clientset.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]StorageClassInfo, 0, len(list.Items))
	for _, sc := range list.Items {
		out = append(out, StorageClassInfo{
			Name:          sc.Name,
			Provisioner:   sc.Provisioner,
			ReclaimPolicy: string(*sc.ReclaimPolicy),
			IsDefault:     sc.Annotations["storageclass.kubernetes.io/is-default-class"] == "true",
		})
	}
	return out, nil
}

// Info reads the gamectl/cluster-info ConfigMap and returns its data fields.
// Returns zero-value if the ConfigMap doesn't exist (not an error).
func (c *Cluster) Info(ctx context.Context) (ClusterInfo, error) {
	b := c.snap()
	if b == nil {
		return ClusterInfo{}, ErrNotConfigured
	}
	cm, err := b.clientset.CoreV1().ConfigMaps("gamectl").Get(ctx, "cluster-info", metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return ClusterInfo{}, nil
		}
		return ClusterInfo{}, err
	}
	return ClusterInfo{
		Name:        cm.Data["name"],
		Description: cm.Data["description"],
	}, nil
}
