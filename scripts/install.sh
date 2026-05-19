#!/usr/bin/env bash
#
# GameCTL installer — deploys GameCTL into the cluster your current kubectl
# context points at, and wires up how you'll reach the web UI.
#
# It does NOT create any application secrets: GameCTL provisions its own
# admin credentials on first run (see the bootstrap-token step it prints at
# the end). This script only handles deployment + UI networking.
#
# Game servers that GameCTL later deploys are exposed as MetalLB
# LoadBalancer Services (raw TCP/UDP) — that is separate from how the UI
# itself is reached. See the README.
#
# Usage:
#   ./scripts/install.sh
#   GAMECTL_IMAGE=ghcr.io/me/gamectl:v1 GAMECTL_HOST=games.lan ./scripts/install.sh
#
# Honoured environment variables (skip the matching prompt when set):
#   GAMECTL_IMAGE      container image the cluster can pull (required)
#   GAMECTL_NAMESPACE  target namespace            (default: gamectl)
#   GAMECTL_HOST       UI hostname for Ingress mode
#   GAMECTL_INGRESS_CLASS  ingress class           (default: detected/traefik)
#   GAMECTL_EXPOSE     ingress | loadbalancer | nodeport (default: auto)
#   GAMECTL_MANIFEST   path or URL to the manifest (default: bundled/raw)
#   GAMECTL_STORAGE_LOCATIONS  pre-seed Storage Locations (same store the
#       Storage GUI writes; merged-by-name, never overwrites GUI edits). e.g.
#       name=1TBSSD,server=10.0.0.100,path=/mnt/1TBSSD  (';'-sep multiple)
#   GAMECTL_ASSUME_YES set to 1 for non-interactive (fails if input needed)
#
set -euo pipefail

# --- Config / defaults -------------------------------------------------------
NS="${GAMECTL_NAMESPACE:-gamectl}"
IMAGE="${GAMECTL_IMAGE:-}"
HOST="${GAMECTL_HOST:-}"
INGRESS_CLASS="${GAMECTL_INGRESS_CLASS:-}"
EXPOSE="${GAMECTL_EXPOSE:-auto}"
ASSUME_YES="${GAMECTL_ASSUME_YES:-0}"
# Where to fetch the manifest from when not run inside a checkout.
RAW_URL_DEFAULT="https://raw.githubusercontent.com/GameCTL-HQ/GameCTL/main/k8s/deploy-gamectl.yaml"
MANIFEST="${GAMECTL_MANIFEST:-}"

PLACEHOLDER_IMAGE="ghcr.io/gamectl-hq/gamectl:latest"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_blue=$'\033[1;34m'; c_grn=$'\033[1;32m'; c_yel=$'\033[1;33m'
c_red=$'\033[1;31m'; c_rst=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_blue" "$c_rst" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn"  "$c_rst" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel"  "$c_rst" "$*" >&2; }
die()  { printf '%sfail%s %s\n' "$c_red"  "$c_rst" "$*" >&2; exit 1; }

ask() { # ask <prompt> <default> -> echoes answer
  local prompt="$1" def="${2:-}" ans
  if [ "$ASSUME_YES" = "1" ]; then
    [ -n "$def" ] || die "non-interactive mode but no value/default for: $prompt"
    printf '%s\n' "$def"; return
  fi
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " ans </dev/tty || true
  else                   read -r -p "$prompt: " ans </dev/tty || true; fi
  printf '%s\n' "${ans:-$def}"
}

# ask_required: a value the user MUST supply — no default, no assumption.
# Used for things we must never guess, like the ingress hostname.
#   ask_required <prompt> <preset-from-env> <what-env-var-to-set>
ask_required() {
  local prompt="$1" preset="${2:-}" envname="${3:-}" ans=""
  if [ -n "$preset" ]; then printf '%s\n' "$preset"; return; fi
  if [ "$ASSUME_YES" = "1" ]; then
    die "non-interactive mode: ${prompt} is required — set ${envname}"
  fi
  while [ -z "$ans" ]; do read -r -p "$prompt: " ans </dev/tty || true; done
  printf '%s\n' "$ans"
}

# confirm_invasive: for irreversible / cluster-wide actions (e.g. installing
# MetalLB). NEVER auto-confirmed — non-interactive mode always declines.
confirm_invasive() {
  [ "$ASSUME_YES" = "1" ] && return 1
  local ans; read -r -p "$1 [y/N]: " ans </dev/tty || true
  [[ "${ans:-}" =~ ^[Yy]$ ]]
}

# confirm_proceed: for the expected, non-destructive step (the kubectl apply
# this script exists to do). Auto-yes in non-interactive mode.
confirm_proceed() {
  [ "$ASSUME_YES" = "1" ] && return 0
  local ans; read -r -p "$1 [Y/n]: " ans </dev/tty || true
  [[ -z "${ans:-}" || "${ans:-}" =~ ^[Yy]$ ]]
}

# --- Prerequisites -----------------------------------------------------------
say "Checking prerequisites"
command -v kubectl >/dev/null 2>&1 || die "kubectl not found in PATH"
kubectl version --client --output=yaml >/dev/null 2>&1 || true
if ! kubectl cluster-info >/dev/null 2>&1; then
  die "kubectl can't reach a cluster. Check your kubeconfig / current-context:
       kubectl config current-context"
fi
ctx="$(kubectl config current-context 2>/dev/null || echo '?')"
ok "Cluster reachable — current context: ${ctx}"

# --- Resolve the manifest ----------------------------------------------------
TMP_MANIFEST="$(mktemp)"
trap 'rm -f "$TMP_MANIFEST"' EXIT
if [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ]; then
  cp "$MANIFEST" "$TMP_MANIFEST"; say "Using manifest: $MANIFEST"
elif [ -f "$SCRIPT_DIR/../k8s/deploy-gamectl.yaml" ]; then
  cp "$SCRIPT_DIR/../k8s/deploy-gamectl.yaml" "$TMP_MANIFEST"
  say "Using bundled manifest from checkout"
else
  url="${MANIFEST:-$RAW_URL_DEFAULT}"
  command -v curl >/dev/null 2>&1 || die "curl needed to fetch the manifest"
  say "Fetching manifest: $url"
  curl -fsSL "$url" -o "$TMP_MANIFEST" || die "failed to download manifest"
fi

# --- Image -------------------------------------------------------------------
# Default to the published image (PLACEHOLDER_IMAGE is rewritten to the real
# public GHCR image in the public release), so `curl … | bash` is zero-config.
# Only nag if it still carries the generic OWNER placeholder, i.e. this is an
# unpublished checkout where no real image exists yet.
: "${IMAGE:=$PLACEHOLDER_IMAGE}"
if printf '%s' "$IMAGE" | grep -q 'OWNER/gamectl'; then
  warn "No real image available (unpublished checkout). Set GAMECTL_IMAGE to a"
  warn "registry your cluster can pull — your own build, or the public GHCR"
  warn "image from a tagged release."
  IMAGE="$(ask "Container image" "$IMAGE")"
fi

# --- Detect cluster networking ----------------------------------------------
say "Detecting cluster networking"
HAS_METALLB=0
if kubectl get crd ipaddresspools.metallb.io >/dev/null 2>&1 \
   || kubectl get ns metallb-system >/dev/null 2>&1; then
  HAS_METALLB=1; ok "MetalLB detected"
else
  warn "MetalLB not detected"
fi

INGRESS_CLASSES="$(kubectl get ingressclass -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
HAS_INGRESS=0
[ -n "$INGRESS_CLASSES" ] && { HAS_INGRESS=1; ok "Ingress controller(s): $INGRESS_CLASSES"; } \
                          || warn "No IngressClass found"

# --- Optional: install MetalLB (explicit opt-in only) ------------------------
# MetalLB powers game-server LoadBalancers AND is the no-DNS option for the
# UI. Installing it is cluster-wide infra and needs an unused IP range only
# you know — so this is strictly opt-in and never silent.
if [ "$HAS_METALLB" -eq 0 ]; then
  echo
  warn "MetalLB is absent. GameCTL needs it to expose GAME SERVERS (and it's"
  warn "the easiest way to expose this UI without DNS)."
  if confirm_invasive "Install MetalLB now and create a dedicated 'gamectl' pool?"; then
    echo "MetalLB hands out real IPs on your LAN. Enter a range that is NOT"
    echo "used by DHCP, other pools, or real hosts (e.g. 10.0.0.240-10.0.0.250)."
    RANGE="$(ask "Unused IP range for the 'gamectl' MetalLB pool" "")"
    [ -n "$RANGE" ] || die "no IP range provided; aborting MetalLB install"
    say "Installing MetalLB (native manifest)"
    kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.8/config/manifests/metallb-native.yaml
    say "Waiting for MetalLB controller to be ready"
    kubectl -n metallb-system rollout status deploy/controller --timeout=120s
    say "Creating IPAddressPool 'gamectl' + L2Advertisement"
    kubectl apply -f - <<EOF
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: gamectl
  namespace: metallb-system
spec:
  addresses:
    - ${RANGE}
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: gamectl
  namespace: metallb-system
spec:
  ipAddressPools:
    - gamectl
EOF
    HAS_METALLB=1
    ok "MetalLB installed with pool 'gamectl' (${RANGE})"
  else
    warn "Skipping MetalLB. Game-server LoadBalancers will stay <pending>"
    warn "until you install MetalLB later."
  fi
fi

# --- Choose UI exposure ------------------------------------------------------
# Whether to ALSO put an Ingress in front (works regardless of Service type).
ALSO_INGRESS=0

if [ "$EXPOSE" = "auto" ]; then
  # Sensible default: a hostname/Ingress is the natural "web app" path and
  # avoids MetalLB pool-exhaustion surprises, so prefer it when available.
  if   [ "$HAS_INGRESS"  -eq 1 ]; then default_expose="ingress"
  elif [ "$HAS_METALLB"  -eq 1 ]; then default_expose="loadbalancer"
  else default_expose="nodeport"; fi

  if [ "$ASSUME_YES" = "1" ]; then
    EXPOSE="$default_expose"
  else
    echo
    echo "How should the GameCTL ${c_blue}web UI${c_rst} be reached?"
    echo "  1) Ingress      — via a hostname through your ingress controller"
    [ "$HAS_INGRESS" -eq 1 ] && echo "                    (detected: ${INGRESS_CLASSES})" \
                             || echo "                    (no ingress controller detected — needs one)"
    echo "  2) LoadBalancer — MetalLB assigns an IP, no DNS needed"
    [ "$HAS_METALLB" -eq 1 ] && echo "                    (MetalLB detected; needs a FREE IP in a pool)" \
                             || echo "                    (no MetalLB detected)"
    echo "  3) NodePort     — no LB/Ingress; reach via kubectl port-forward"
    case "$default_expose" in ingress) d=1;; loadbalancer) d=2;; *) d=3;; esac
    pick="$(ask "Choose 1-3" "$d")"
    case "$pick" in
      1) EXPOSE="ingress" ;;
      2) EXPOSE="loadbalancer" ;;
      3) EXPOSE="nodeport" ;;
      *) die "invalid choice: $pick" ;;
    esac
    # Offer an Ingress IN ADDITION when the primary isn't already Ingress.
    if [ "$EXPOSE" != "ingress" ] && [ "$HAS_INGRESS" -eq 1 ]; then
      confirm_invasive "Also create an Ingress (hostname) in addition?" && ALSO_INGRESS=1
    fi
  fi
fi
say "UI exposure mode: ${EXPOSE}$( [ "$ALSO_INGRESS" -eq 1 ] && echo ' + Ingress' )"

# Collect Ingress details if Ingress is the primary OR an add-on.
if [ "$EXPOSE" = "ingress" ] || [ "$ALSO_INGRESS" -eq 1 ]; then
  # No default — the operator must state the hostname they will point at
  # the ingress controller. We never assume a DNS name.
  HOST="$(ask_required "Hostname you will reach the UI on (must resolve to your ingress controller, e.g. gamectl.example.com)" "$HOST" GAMECTL_HOST)"
  if [ -z "$INGRESS_CLASS" ]; then
    first_class="$(printf '%s' "$INGRESS_CLASSES" | awk '{print $1}')"
    INGRESS_CLASS="$(ask "Ingress class" "${first_class:-traefik}")"
  fi
fi

# --- MetalLB IP helpers ------------------------------------------------------
_ip2int() { local a b c d; IFS=. read -r a b c d <<<"$1"; echo $(( (a<<24)+(b<<16)+(c<<8)+d )); }
_int2ip() { local n=$1; echo "$(((n>>24)&255)).$(((n>>16)&255)).$(((n>>8)&255)).$((n&255))"; }

# expand_addr: print every IPv4 in a MetalLB address token (a-b range,
# single IP, or CIDR). Bounded to 4096 addrs so a wide CIDR can't hang.
expand_addr() {
  local tok="$1" s e i base pre bi mask net bc
  if [[ "$tok" == */* ]]; then
    base="${tok%/*}"; pre="${tok#*/}"
    [ "$pre" -ge 20 ] 2>/dev/null || { warn "pool entry ${tok}: CIDR too wide to list — auto-assign only"; return; }
    bi="$(_ip2int "$base")"; mask=$(( (0xffffffff << (32-pre)) & 0xffffffff ))
    net=$(( bi & mask )); bc=$(( net | (~mask & 0xffffffff) ))
    for ((i=net; i<=bc; i++)); do _int2ip "$i"; done
  elif [[ "$tok" == *-* ]]; then
    s="$(_ip2int "${tok%-*}")"; e="$(_ip2int "${tok#*-}")"
    [ $(( e - s )) -le 4096 ] || { warn "pool range ${tok} too large to list"; return; }
    for ((i=s; i<=e; i++)); do _int2ip "$i"; done
  elif [[ "$tok" =~ ^[0-9.]+$ ]]; then
    echo "$tok"
  fi
}

# For LoadBalancer: pick a pool (name-based, auto if single), list FREE IPs,
# let the user take one or press Enter to let MetalLB auto-assign from it.
LB_IP=""; LB_POOL=""
if [ "$EXPOSE" = "loadbalancer" ] && [ "$HAS_METALLB" -eq 1 ]; then
  pool_lines="$(kubectl get ipaddresspools.metallb.io -A \
    -o jsonpath='{range .items[*]}{.metadata.name}|{.spec.addresses[*]}{"\n"}{end}' 2>/dev/null || true)"
  pool_names="$(printf '%s\n' "$pool_lines" | sed '/^$/d' | cut -d'|' -f1)"
  n_pools="$(printf '%s\n' "$pool_names" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [ "${n_pools:-0}" -eq 0 ]; then
    warn "No MetalLB IPAddressPools found — the Service may stay <pending>."
    LB_IP="$(ask "Pin a specific IP for the UI (blank = let MetalLB decide)" "")"
  else
    if [ "$n_pools" -eq 1 ]; then
      LB_POOL="$(printf '%s\n' "$pool_names" | sed '/^$/d' | head -1)"
      say "Using the only MetalLB pool: ${LB_POOL}"
    else
      echo "MetalLB pools: $(printf '%s ' $pool_names)"
      LB_POOL="$(ask "Pool to use" "$(printf '%s\n' "$pool_names" | sed '/^$/d' | head -1)")"
    fi

    addrs="$(printf '%s\n' "$pool_lines" | awk -F'|' -v p="$LB_POOL" '$1==p{print $2}')"
    used="$(kubectl get svc -A -o jsonpath='{range .items[*]}{.status.loadBalancer.ingress[0].ip}{"\n"}{end}' 2>/dev/null | sed '/^$/d')"
    free=""
    for tok in $addrs; do
      while read -r ip; do
        [ -z "$ip" ] && continue
        printf '%s\n' "$used" | grep -qxF "$ip" || free="${free}${ip}\n"
      done < <(expand_addr "$tok")
    done
    free="$(printf '%b' "$free" | sed '/^$/d')"
    if [ -n "$free" ]; then
      echo "Free IPs in '${LB_POOL}': $(printf '%s\n' "$free" | head -10 | tr '\n' ' ')$([ "$(printf '%s\n' "$free" | wc -l)" -gt 10 ] && echo '…')"
    else
      warn "Pool '${LB_POOL}' has no free IPs — auto-assign will stay <pending> until one frees."
    fi
    LB_IP="$(ask "Specific IP from '${LB_POOL}' (Enter = let MetalLB auto-assign from it)" "")"
  fi
fi

# --- Substitute manifest values ---------------------------------------------
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
sed -i.bak "s#image: ${PLACEHOLDER_IMAGE}#image: $(esc "$IMAGE")#" "$TMP_MANIFEST"
# Optional pre-seed of Storage Locations (same store the GUI writes). When
# GAMECTL_STORAGE_LOCATIONS is set, substitute it in; otherwise the
# __STORAGE_SEED__ placeholder stays and the server treats it as no-op.
if [ -n "${GAMECTL_STORAGE_LOCATIONS:-}" ]; then
  sed -i.bak "s|__STORAGE_SEED__|$(esc "$GAMECTL_STORAGE_LOCATIONS")|" "$TMP_MANIFEST"
  say "Pre-seeding storage locations: ${GAMECTL_STORAGE_LOCATIONS}"
fi
if [ "$NS" != "gamectl" ]; then
  sed -i.bak "s/namespace: gamectl/namespace: $(esc "$NS")/g; s/name: gamectl$/name: $(esc "$NS")/g" "$TMP_MANIFEST"
  warn "Custom namespace renaming is best-effort; review the manifest if it's unusual."
fi
rm -f "$TMP_MANIFEST.bak"

# Service type: LoadBalancer / NodePort / ClusterIP(+Ingress).
case "$EXPOSE" in
  loadbalancer) svc_type="LoadBalancer" ;;
  nodeport)     svc_type="NodePort" ;;
  *)            svc_type="ClusterIP" ;;
esac
sed -i.bak "s/^  type: ClusterIP/  type: ${svc_type}/" "$TMP_MANIFEST"
rm -f "$TMP_MANIFEST.bak"

# Keep the Ingress doc only when Ingress is primary or an explicit add-on;
# otherwise strip that whole YAML document.
if [ "$EXPOSE" = "ingress" ] || [ "$ALSO_INGRESS" -eq 1 ]; then
  sed -i.bak "s/host: replace-me.invalid/host: $(esc "$HOST")/g; \
              s/ingressClassName: traefik/ingressClassName: $(esc "$INGRESS_CLASS")/" "$TMP_MANIFEST"
  rm -f "$TMP_MANIFEST.bak"
else
  awk 'BEGIN{RS="\n---\n"} !/kind: Ingress/{printf "%s%s", sep, $0; sep="\n---\n"}' \
    "$TMP_MANIFEST" > "$TMP_MANIFEST.noing" && mv "$TMP_MANIFEST.noing" "$TMP_MANIFEST"
fi

# --- Apply -------------------------------------------------------------------
echo
say "About to apply GameCTL (namespace: ${NS}, image: ${IMAGE}, expose: ${EXPOSE}$( [ "$ALSO_INGRESS" -eq 1 ] && echo '+ingress' ))"
confirm_proceed "Proceed with kubectl apply?" || die "aborted by user"
kubectl apply -f "$TMP_MANIFEST"

if [ "$EXPOSE" = "loadbalancer" ]; then
  if [ -n "$LB_IP" ]; then
    say "Requesting specific MetalLB IP ${LB_IP} for the UI Service"
    kubectl -n "$NS" annotate svc gamectl "metallb.universe.tf/loadBalancerIPs=${LB_IP}" --overwrite >/dev/null
  elif [ -n "$LB_POOL" ]; then
    say "Binding the UI Service to MetalLB pool '${LB_POOL}' (auto-assign)"
    kubectl -n "$NS" annotate svc gamectl "metallb.universe.tf/address-pool=${LB_POOL}" --overwrite >/dev/null
  fi
fi

say "Waiting for rollout"
kubectl -n "$NS" rollout status deploy/gamectl --timeout=120s || \
  warn "Rollout not complete yet — check: kubectl -n $NS get pods"

# --- Resolve the actual UI URL ----------------------------------------------
UI_URL=""; LB_PENDING=0
if [ "$EXPOSE" = "loadbalancer" ]; then
  say "Waiting for MetalLB to assign an external IP (up to 30s)"
  for _ in $(seq 1 15); do
    ip="$(kubectl -n "$NS" get svc gamectl -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    [ -n "$ip" ] && { UI_URL="http://${ip}:8080/"; break; }
    sleep 2
  done
  [ -z "$UI_URL" ] && LB_PENDING=1
elif [ "$EXPOSE" = "nodeport" ]; then
  np="$(kubectl -n "$NS" get svc gamectl -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)"
  nodeip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"
  [ -n "$np" ] && [ -n "$nodeip" ] && UI_URL="http://${nodeip}:${np}/"
fi

# --- Next steps: hand off to first-run setup ---------------------------------
echo
ok "GameCTL deployed."
echo
# Pull the one-time bootstrap token straight out of the pod log so the
# operator never has to grep raw JSON. Retry briefly — the line is emitted
# at startup, just after the rollout completes.
TOKEN=""
for _ in $(seq 1 10); do
  TOKEN="$(kubectl -n "$NS" logs deploy/gamectl 2>/dev/null \
            | grep -i 'BOOTSTRAP TOKEN' \
            | grep -oE '"token":"[A-Za-z0-9]+"' | tail -1 | cut -d'"' -f4)"
  [ -n "$TOKEN" ] && break
  sleep 2
done

bar="==============================================================="
echo "${c_blue}${bar}${c_rst}"
echo "${c_blue}  Finish setup — GameCTL writes its own gamectl-auth Secret${c_rst}"
echo "${c_blue}  (in the gamectl namespace). No manual kubectl secrets needed.${c_rst}"
echo "${c_blue}${bar}${c_rst}"
echo
if [ -n "$TOKEN" ]; then
  echo "  ${c_grn}Your Bootstrap Token is:${c_rst}  ${c_yel}${TOKEN}${c_rst}"
else
  echo "  ${c_yel}No bootstrap token in the log${c_rst} — setup is likely already"
  echo "  completed for this instance. Just log in with your admin account."
  echo "  (Fresh install? Re-check: kubectl -n ${NS} logs deploy/gamectl | grep -i 'BOOTSTRAP TOKEN')"
fi
echo
echo "  1) Open the UI:"
if [ "$EXPOSE" = "ingress" ]; then
  echo "       ${c_grn}http://${HOST}/${c_rst}   (point DNS/hosts for ${HOST} at your ingress controller)"
elif [ "$EXPOSE" = "loadbalancer" ] && [ "$LB_PENDING" -eq 1 ]; then
  warn "MetalLB has not assigned an IP — every pool address is likely in use."
  echo "       • free an IP / widen a pool, then: kubectl -n ${NS} get svc gamectl -w"
  echo "       • or re-run install.sh and choose Ingress or NodePort"
  echo "       • immediate access: kubectl -n ${NS} port-forward svc/gamectl 8080:8080  → http://127.0.0.1:8080/"
else
  [ -n "$UI_URL" ] && echo "       ${c_grn}${UI_URL}${c_rst}"
  echo "       Always works: kubectl -n ${NS} port-forward svc/gamectl 8080:8080  → http://127.0.0.1:8080/"
fi
if [ "$ALSO_INGRESS" -eq 1 ]; then
  echo "       Also via Ingress: ${c_grn}http://${HOST}/${c_rst} (needs DNS → ingress controller)"
fi
echo "  2) Enter the token above + choose your admin username/password. Done."
echo "${c_blue}${bar}${c_rst}"
