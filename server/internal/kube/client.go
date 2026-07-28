package kube

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

// clientBundle holds the live clients plus a description of where the config came from.
// It is replaced atomically when Reload is called, so handlers reading via Cluster.bundle
// either see the old bundle or the new one — never a torn write.
type clientBundle struct {
	clientset *kubernetes.Clientset
	dynamic   dynamic.Interface
	mapper    meta.RESTMapper
	restCfg   *rest.Config // kept for pod exec (remotecommand needs the raw config)
	source    string
}

// Cluster is a hot-reloadable bundle of Kubernetes clients.
//
// Construction (New) loads the initial config from one of:
//  1. in-cluster service account
//  2. the kubeconfigPath argument (if non-empty)
//  3. the default loading rules (KUBECONFIG env, ~/.kube/config)
//
// Reload re-creates the bundle from new kubeconfig bytes (typically supplied
// by the /kube/kubeconfig endpoint) and atomically swaps it in.
type Cluster struct {
	bundle   atomic.Pointer[clientBundle]
	cfgPath  string     // path to persist uploads to; empty means upload not supported
	reloadMu sync.Mutex // serializes Reload calls
}

// New constructs a Cluster, smoke-testing the connection with a discovery call.
// kubeconfigPath, if non-empty, is also remembered as the upload target for Reload.
func New(kubeconfigPath string) (*Cluster, error) {
	c := &Cluster{cfgPath: kubeconfigPath}
	b, err := buildBundle(kubeconfigPath)
	if err != nil {
		return nil, err
	}
	c.bundle.Store(b)
	return c, nil
}

// Source returns a string describing where the current config came from.
func (c *Cluster) Source() string {
	if b := c.bundle.Load(); b != nil {
		return b.source
	}
	return "unconfigured"
}

// CfgPath returns the path that uploaded kubeconfigs are written to, or "" if not configured.
func (c *Cluster) CfgPath() string { return c.cfgPath }

// snap returns the current bundle, or nil if the cluster is unconfigured.
func (c *Cluster) snap() *clientBundle { return c.bundle.Load() }

// Connected reports whether a usable Kubernetes client is wired up (either
// an in-cluster ServiceAccount or a loaded kubeconfig). The UI uses this to
// skip the kubeconfig-upload screen when it isn't needed.
func (c *Cluster) Connected() bool { return c.snap() != nil }

// Reload writes the new kubeconfig bytes atomically to c.cfgPath, then re-creates
// the client bundle from that path and swaps it in. Returns an error if the bytes
// don't parse as a valid kubeconfig, if the file write fails, or if the new clients
// can't reach the API server.
//
// Reload is safe to call concurrently with handler reads but is serialized against
// other Reload calls.
func (c *Cluster) Reload(newCfg []byte) error {
	if c.cfgPath == "" {
		return errors.New("kubeconfig storage not configured (set GAMECTL_KUBECONFIG)")
	}

	// Validate before touching disk.
	if _, err := clientcmd.Load(newCfg); err != nil {
		return fmt.Errorf("invalid kubeconfig: %w", err)
	}

	c.reloadMu.Lock()
	defer c.reloadMu.Unlock()

	dir := filepath.Dir(c.cfgPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create kubeconfig dir: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".kubeconfig-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := tmp.Write(newCfg); err != nil {
		tmp.Close()
		cleanup()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		cleanup()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpName, c.cfgPath); err != nil {
		cleanup()
		return fmt.Errorf("rename to %s: %w", c.cfgPath, err)
	}

	b, err := buildBundle(c.cfgPath)
	if err != nil {
		// File is already on disk; if the new clients don't work, leave the file in place
		// (so a future restart will at least try to use it) but keep serving with the old bundle.
		return fmt.Errorf("build clients from new kubeconfig: %w", err)
	}
	c.bundle.Store(b)
	return nil
}

// --- internal ---

func buildBundle(kubeconfigPath string) (*clientBundle, error) {
	cfg, source, err := loadConfig(kubeconfigPath)
	if err != nil {
		return nil, err
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("clientset: %w", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("dynamic client: %w", err)
	}
	disc := memory.NewMemCacheClient(cs.Discovery())
	mapper := restmapper.NewDeferredDiscoveryRESTMapper(disc)

	if _, err := cs.Discovery().ServerVersion(); err != nil {
		return nil, fmt.Errorf("api server unreachable (%s): %w", source, err)
	}
	return &clientBundle{
		clientset: cs,
		dynamic:   dyn,
		mapper:    mapper,
		restCfg:   cfg,
		source:    source,
	}, nil
}

func loadConfig(kubeconfigPath string) (*rest.Config, string, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, "in-cluster", nil
	}
	if kubeconfigPath != "" {
		cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfigPath)
		if err != nil {
			return nil, "", fmt.Errorf("kubeconfig %q: %w", kubeconfigPath, err)
		}
		return cfg, "kubeconfig:" + kubeconfigPath, nil
	}
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	cfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{}).ClientConfig()
	if err != nil {
		return nil, "", fmt.Errorf("default kubeconfig: %w", err)
	}
	return cfg, "kubeconfig:default", nil
}
