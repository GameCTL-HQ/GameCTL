#!/bin/bash
# patch-botwarfare.sh — stop Bot Warfare stalling the server frame.
#
# Bot Warfare's AStarSearch() runs an unbounded graph search in ONE script
# thread with no yield. IW4x's script VM kills any thread that runs too long
# ("script runtime error: potential infinite loop in script - killing thread")
# and the engine stalls the whole server frame while it happens. Measured on a
# live 8-bot server before this patch: 44 watchdog kills, 15 hitches totalling
# 80.3s, the worst a 25.6-SECOND freeze at round start when every bot paths at
# once. After: 6 kills, one 1.0s hitch. Bots keep playing normally — scores
# climb at the same rate, so the yield costs nothing observable.
#
# The fix inserts a `wait` every 40 expanded nodes, so each slice finishes
# inside the VM's budget and the path arrives a few frames later instead of the
# thread being killed and the bot standing still.
#
# We patch the operator's OWN installed copy in place rather than shipping a
# modified mod: Bot Warfare is someone else's work, and this image has no
# business redistributing it. Idempotent (marker-guarded), keeps a .orig
# backup, and never touches anything if the mod isn't installed.
#
#   PATCH=1  IW4X_PATCH_BOTS=1 (default) — apply
#            IW4X_PATCH_BOTS=0           — skip
set -uo pipefail

DATA_DIR="${DATA_DIR:-/iw4x}"
IWD=""
MARKER='[GameCTL] astar-yield'
log() { echo "iw4x-kube: $*"; }
warn() { echo "iw4x-kube: WARNING $*" >&2; }

# Find the mod wherever it was installed (mods/mp_bots is upstream's path).
for cand in "${DATA_DIR}"/mods/*/z_svr_bots.iwd; do
  [ -f "$cand" ] && IWD="$cand" && break
done
[ -n "$IWD" ] || { log "Bot Warfare not installed — nothing to patch"; exit 0; }

command -v unzip >/dev/null && command -v zip >/dev/null || {
  warn "zip/unzip missing — cannot patch Bot Warfare"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
GSC='maps/mp/bots/_bot_utility.gsc'

unzip -q -o "$IWD" "$GSC" -d "$WORK" 2>/dev/null || {
  warn "could not read $GSC from $IWD — leaving it alone"; exit 0; }

if grep -qF "$MARKER" "$WORK/$GSC"; then
  log "Bot Warfare already patched (astar-yield)"
  exit 0
fi

# The file uses CRLF; awk keeps the \r on the lines it copies through, and the
# lines we add end with \r too so the file stays consistent.
awk -v marker="$MARKER" '
  BEGIN { done = 0 }
  # Anchor on the A* main loop, which is the unbounded one.
  !done && /^\twhile \( open\.data\.size \)\r?$/ {
    print "\t// " marker ": yield so IW4x'"'"'s script VM does not kill this\r"
    print "\t// thread mid-search (\"potential infinite loop\"), which stalls the\r"
    print "\t// server frame. See images/iw4x-kube/patch-botwarfare.sh.\r"
    print "\tgamectl_astar_iters = 0;\r"
    print $0
    getline                     # the loop'"'"'s opening brace
    print $0
    print "\t\tgamectl_astar_iters++;\r"
    print "\t\t\r"
    print "\t\tif ( gamectl_astar_iters % 40 == 0 )\r"
    print "\t\t{\r"
    print "\t\t\twait 0.05;\r"
    print "\t\t}\r"
    print "\t\t\r"
    done = 1
    next
  }
  { print }
  END { if (!done) exit 3 }
' "$WORK/$GSC" > "$WORK/patched.gsc"

case $? in
  0) : ;;
  3) warn "AStarSearch loop not found — Bot Warfare version differs; leaving it unpatched"; exit 0 ;;
  *) warn "patching failed; leaving the mod unchanged"; exit 0 ;;
esac

grep -qF "$MARKER" "$WORK/patched.gsc" || { warn "patch produced no marker — aborting"; exit 0; }
mv "$WORK/patched.gsc" "$WORK/$GSC"

# Back up once, then update just that entry inside the archive.
[ -f "${IWD}.orig" ] || cp "$IWD" "${IWD}.orig"
( cd "$WORK" && zip -q "$IWD" "$GSC" ) || {
  warn "could not write back to $IWD — restoring"; cp "${IWD}.orig" "$IWD"; exit 0; }

if unzip -t "$IWD" >/dev/null 2>&1; then
  log "patched Bot Warfare: A* now yields (was freezing the server up to 25s at round start)"
else
  warn "archive failed verification after patching — restoring the original"
  cp "${IWD}.orig" "$IWD"
fi
