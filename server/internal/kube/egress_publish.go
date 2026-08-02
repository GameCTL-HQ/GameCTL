package kube

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/curve25519"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

// Egress publish: for games whose matchmaking backend records the SERVER'S
// outbound IP (Wreckfest 2 / PlayFab, classic master servers), an inbound
// tunnel is not enough — players are told to join the address the backend
// observed, which is the cluster's home WAN. In egress mode the game pod
// gets a WireGuard sidecar whose default route is ProxyCTL's droplet, so
// the backend records the droplet IP and joins land on the droplet's
// public ports, which ProxyCTL DNATs straight back to the pod's tunnel IP.
//
// Trust model (matches ProxyCTL's): the WireGuard PRIVATE key is generated
// here and lives only in a Secret in the game's own namespace, mounted by
// the sidecar. ProxyCTL receives the PUBLIC key on the entry — it never
// sees a private key, exactly like its self-keying wg-gw pods.
const (
	// PublishModeAnno marks a Deployment as needing egress publish; the
	// generator stamps it for games that require it ("egress").
	PublishModeAnno = "gamectl.io/publish-mode"
	// egressExcludeAnno optionally overrides the CIDRs that must BYPASS the
	// tunnel (cluster + LAN ranges), comma-separated.
	egressExcludeAnno = "gamectl.io/egress-exclude-cidrs"
	// egressHashAnno records the sidecar config hash on the pod template so
	// a changed tunnel config rolls the pod exactly once.
	egressHashAnno = "gamectl.io/egress-config-hash"

	egressContainerName = "egress-wg"
	egressInitName      = "egress-sysctl"

	// Same digest ProxyCTL pins for its gateways — one image cluster-wide.
	// First-party from-scratch image (GameCTL-HQ/WireGuard-Kube): Debian
	// official base + Debian wireguard-tools, host-kernel data plane.
	egressWGImage = "ghcr.io/gamectl-hq/wireguard-kube@sha256:baba2d49d8928f2d85e98ca58c27b4bbc208b62a00bf620bf95a15a8b245b785"

	// Cluster/LAN ranges that must keep using the pod's normal network:
	// pod CIDR, Service CIDR, and RFC1918 LAN space (kubelet probes, NFS,
	// node traffic). wg-quick's suppress_prefixlength rule makes any
	// main-table route more specific than /0 win over the tunnel.
	egressDefaultExcludes = "10.42.0.0/16,10.43.0.0/16,10.0.0.0/16,172.16.0.0/12"
)

// GenerateWGKeypair returns a fresh Curve25519 WireGuard keypair,
// base64-encoded. The private key is clamped per the X25519 spec.
func GenerateWGKeypair() (priv, pub string, err error) {
	var pk [32]byte
	if _, err := rand.Read(pk[:]); err != nil {
		return "", "", err
	}
	pk[0] &= 248
	pk[31] &= 127
	pk[31] |= 64
	pubBytes, err := curve25519.X25519(pk[:], curve25519.Basepoint)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(pk[:]),
		base64.StdEncoding.EncodeToString(pubBytes), nil
}

func egressSecretName(instance string) string { return instance + "-egress-wg" }

// EgressWGConfig is everything the sidecar's wg0.conf needs beyond the key.
type EgressWGConfig struct {
	TunnelIP      string // this entry's 10.8.0.x, allocated by ProxyCTL
	DropletPubKey string
	EndpointIP    string
	EndpointPort  int
	ExcludeCIDRs  string // comma-separated; empty = egressDefaultExcludes
}

func renderEgressWGConf(priv string, c EgressWGConfig) string {
	excl := c.ExcludeCIDRs
	if strings.TrimSpace(excl) == "" {
		excl = egressDefaultExcludes
	}
	cidrs := strings.ReplaceAll(excl, ",", " ")
	var b strings.Builder
	b.WriteString("[Interface]\n")
	fmt.Fprintf(&b, "Address = %s/32\n", c.TunnelIP)
	fmt.Fprintf(&b, "PrivateKey = %s\n", priv)
	// Cluster + LAN bypass: pin main-table routes for the excluded CIDRs at
	// the pod's original gateway; wg-quick's suppress_prefixlength 0 rule
	// consults them before falling through to the tunnel's catch-all.
	fmt.Fprintf(&b, "PostUp = GW=$(ip -4 route show default | awk '{print $3}' | head -1); for c in %s; do ip -4 route replace $c via $GW; done\n", cidrs)
	b.WriteString("\n[Peer]\n")
	fmt.Fprintf(&b, "PublicKey = %s\n", c.DropletPubKey)
	fmt.Fprintf(&b, "Endpoint = %s:%d\n", c.EndpointIP, c.EndpointPort)
	b.WriteString("AllowedIPs = 0.0.0.0/0\n")
	b.WriteString("PersistentKeepalive = 25\n")
	return b.String()
}

// EnsureEgressKeys loads the instance's egress keypair Secret, generating
// it on first publish. Returns the public key. The keypair is stable across
// republishes so the ProxyCTL entry / droplet peer never churns.
func (c *Cluster) EnsureEgressKeys(ctx context.Context, ns, name string) (pub string, err error) {
	b := c.snap()
	if b == nil {
		return "", ErrNotConfigured
	}
	secName := egressSecretName(name)
	sec, err := b.clientset.CoreV1().Secrets(ns).Get(ctx, secName, metav1.GetOptions{})
	if err == nil {
		if p := strings.TrimSpace(string(sec.Data["publickey"])); p != "" && len(sec.Data["privatekey"]) > 0 {
			return p, nil
		}
	} else if !apierrors.IsNotFound(err) {
		return "", err
	}
	priv, pub, err := GenerateWGKeypair()
	if err != nil {
		return "", err
	}
	if err := c.WriteSecret(ctx, ns, secName, map[string][]byte{
		"privatekey": []byte(priv),
		"publickey":  []byte(pub),
	}); err != nil {
		return "", err
	}
	return pub, nil
}

// EnsureEgressSidecar renders the sidecar's wg0.conf into the keys Secret
// and patches the game Deployment to run the WireGuard sidecar. Idempotent:
// an unchanged config leaves the Deployment untouched; a changed one rolls
// the pod once via the config-hash annotation.
func (c *Cluster) EnsureEgressSidecar(ctx context.Context, ns, name string, cfg EgressWGConfig) (changed bool, err error) {
	b := c.snap()
	if b == nil {
		return false, ErrNotConfigured
	}
	secName := egressSecretName(name)
	sec, err := b.clientset.CoreV1().Secrets(ns).Get(ctx, secName, metav1.GetOptions{})
	if err != nil {
		return false, fmt.Errorf("egress keys Secret %s/%s: %w (publish generates it)", ns, secName, err)
	}
	priv := strings.TrimSpace(string(sec.Data["privatekey"]))
	if priv == "" {
		return false, fmt.Errorf("egress keys Secret %s/%s has no private key", ns, secName)
	}
	conf := renderEgressWGConf(priv, cfg)
	if string(sec.Data["wg0.conf"]) != conf {
		sec.Data["wg0.conf"] = []byte(conf)
		if _, err := b.clientset.CoreV1().Secrets(ns).Update(ctx, sec, metav1.UpdateOptions{}); err != nil {
			return false, err
		}
	}
	// Hash the non-secret shape of the config: rolls the pod when the
	// tunnel endpoint/IP/routes change, not when nothing did.
	sum := sha256.Sum256([]byte(renderEgressWGConf("<key>", cfg)))
	hash := hex.EncodeToString(sum[:])[:16]

	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, err
	}
	tpl := &dep.Spec.Template
	if tpl.Annotations == nil {
		tpl.Annotations = map[string]string{}
	}
	hasSidecar := false
	imageCurrent := true
	for i := range tpl.Spec.Containers {
		if tpl.Spec.Containers[i].Name == egressContainerName {
			hasSidecar = true
			if tpl.Spec.Containers[i].Image != egressWGImage {
				// Reconcile image bumps (e.g. a new pinned digest shipped in
				// a GameCTL update) on the next publish touch.
				tpl.Spec.Containers[i].Image = egressWGImage
				imageCurrent = false
			}
			break
		}
	}
	if hasSidecar && imageCurrent && tpl.Annotations[egressHashAnno] == hash {
		return false, nil
	}
	tpl.Annotations[egressHashAnno] = hash

	privileged := true
	if !hasSidecar {
		hostPathFile := corev1.HostPathDirectory
		tpl.Spec.Volumes = append(tpl.Spec.Volumes,
			corev1.Volume{Name: "egress-wg-conf", VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: secName,
					Items:      []corev1.KeyToPath{{Key: "wg0.conf", Path: "wg0.conf"}},
				},
			}},
			corev1.Volume{Name: "egress-wg-config", VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			}},
			corev1.Volume{Name: "egress-modules", VolumeSource: corev1.VolumeSource{
				HostPath: &corev1.HostPathVolumeSource{Path: "/lib/modules", Type: &hostPathFile},
			}},
		)
		// wg-quick's full-tunnel policy routing needs src_valid_mark (and a
		// loose rp_filter) in the POD's netns — a privileged init, exactly
		// like ProxyCTL's own gateway pods.
		tpl.Spec.InitContainers = append(tpl.Spec.InitContainers, corev1.Container{
			Name:    egressInitName,
			Image:   "busybox:1.36",
			Command: []string{"sh", "-c", "sysctl -w net.ipv4.conf.all.src_valid_mark=1 && sysctl -w net.ipv4.conf.all.rp_filter=2"},
			SecurityContext: &corev1.SecurityContext{Privileged: &privileged},
		})
		tpl.Spec.Containers = append(tpl.Spec.Containers, corev1.Container{
			Name:  egressContainerName,
			Image: egressWGImage,
			Env: []corev1.EnvVar{
				{Name: "PUID", Value: "1000"},
				{Name: "PGID", Value: "1000"},
				{Name: "TZ", Value: "UTC"},
			},
			SecurityContext: &corev1.SecurityContext{
				Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN"}},
			},
			VolumeMounts: []corev1.VolumeMount{
				{Name: "egress-wg-config", MountPath: "/config"},
				{Name: "egress-wg-conf", MountPath: "/config/wg_confs", ReadOnly: true},
				{Name: "egress-modules", MountPath: "/lib/modules", ReadOnly: true},
			},
			ReadinessProbe: &corev1.Probe{
				ProbeHandler: corev1.ProbeHandler{
					Exec: &corev1.ExecAction{Command: []string{"sh", "-c", "wg show wg0 >/dev/null"}},
				},
				InitialDelaySeconds: 12,
				PeriodSeconds:       15,
			},
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("10m"),
					corev1.ResourceMemory: resource.MustParse("32Mi"),
				},
				Limits: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("200m"),
					corev1.ResourceMemory: resource.MustParse("128Mi"),
				},
			},
		})
	}
	_, err = b.clientset.AppsV1().Deployments(ns).Update(ctx, dep, metav1.UpdateOptions{})
	return err == nil, err
}

// RemoveEgressSidecar strips the sidecar (container, init, volumes,
// annotation) from the Deployment and deletes the keys Secret. Missing
// pieces are not errors — unpublish must be re-runnable.
func (c *Cluster) RemoveEgressSidecar(ctx context.Context, ns, name string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		tpl := &dep.Spec.Template
		changed := false
		var cts []corev1.Container
		for _, ct := range tpl.Spec.Containers {
			if ct.Name == egressContainerName {
				changed = true
				continue
			}
			cts = append(cts, ct)
		}
		tpl.Spec.Containers = cts
		var inits []corev1.Container
		for _, ct := range tpl.Spec.InitContainers {
			if ct.Name == egressInitName {
				changed = true
				continue
			}
			inits = append(inits, ct)
		}
		tpl.Spec.InitContainers = inits
		var vols []corev1.Volume
		for _, v := range tpl.Spec.Volumes {
			if strings.HasPrefix(v.Name, "egress-") {
				changed = true
				continue
			}
			vols = append(vols, v)
		}
		tpl.Spec.Volumes = vols
		if _, ok := tpl.Annotations[egressHashAnno]; ok {
			delete(tpl.Annotations, egressHashAnno)
			changed = true
		}
		if changed {
			if _, err := b.clientset.AppsV1().Deployments(ns).Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
				return err
			}
		}
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	err = b.clientset.CoreV1().Secrets(ns).Delete(ctx, egressSecretName(name), metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// InstancePublishMode reads the Deployment's publish-mode annotation
// ("egress" for games whose backend advertises the server's egress IP) and
// the optional exclude-CIDRs override.
func (c *Cluster) InstancePublishMode(ctx context.Context, ns, name string) (mode, excludeCIDRs string, err error) {
	b := c.snap()
	if b == nil {
		return "", "", ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", "", err
	}
	return dep.Annotations[PublishModeAnno], dep.Annotations[egressExcludeAnno], nil
}
