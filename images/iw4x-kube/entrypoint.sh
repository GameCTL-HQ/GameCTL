#!/bin/bash
# iw4x-kube entrypoint — validate, prepare the Wine prefix, launch. No downloads.
set -uo pipefail

DATA_DIR="${DATA_DIR:-/iw4x}"
GAME_PORT="${GAME_PORT:-28960}"
GAME_PARAMS="${GAME_PARAMS:-}"
IW4X_BINARY="${IW4X_BINARY:-iw4x.exe}"
USE_XVFB="${USE_XVFB:-1}"
IW4X_BOTS="${IW4X_BOTS:-0}"
# scr_* gameplay dvars set in server.cfg are stamped over by the gametype's own
# defaults when it initialises at boot — verified on a live server: server.cfg
# says scr_game_spectatetype 2, the server comes up reporting 1. Curiously it
# then survives map loads, map_restart AND gametype changes, so this is a
# once-at-startup clobber, not a per-round reset. Applying it after the server
# is up is therefore enough to make it stick.
IW4X_SPECTATE="${IW4X_SPECTATE:-}"
# Bot Warfare's script stamps its own bots_manage_fill/bots_skill when it
# initialises, overriding whatever server.cfg said — verified live: the config
# reads 12, the running server reports 8. Same treatment as spectate: apply
# after the server is up, where nothing overwrites it afterwards.
IW4X_BOT_FILL="${IW4X_BOT_FILL:-}"
IW4X_BOT_SKILL="${IW4X_BOT_SKILL:-}"
# Where GameCTL's manage screen persists the map rotation.
IW4X_ROTATION_FILE="${IW4X_ROTATION_FILE:-${DATA_DIR:-/iw4x}/players/gamectl-rotation.cfg}"
# How often to re-assert the operator's gameplay settings, in seconds; 0 = once
# and never again. Something in the Bot Warfare stack re-stamps
# bots_manage_fill after startup — not the fill_mode 2/3 branch (mode reads 0
# here), and not on a timer we could find by reading the GSC — so the only
# reliable way to keep the configured number is to keep saying it.
IW4X_ENFORCE_INTERVAL="${IW4X_ENFORCE_INTERVAL:-120}"
RCON_PASSWORD="${RCON_PASSWORD:-}"

log()  { echo "iw4x-kube: $*"; }
warn() { echo "iw4x-kube: WARNING $*" >&2; }
# Fatal errors exit non-zero on purpose. A server that cannot start must show
# up as CrashLoopBackOff with a reason, never as a Running pod that sleeps.
die()  { echo "iw4x-kube: FATAL $*" >&2; exit 1; }

log "data dir: ${DATA_DIR}"
cd "${DATA_DIR}" 2>/dev/null || die "cannot enter ${DATA_DIR} — is the volume mounted?"

# --- Validation -------------------------------------------------------------
# Everything here is operator-supplied. Each check names the missing thing and
# what to do about it, because "wine: cannot find L\"Z:\\\\iw4x\\\\iw4x.exe\""
# is not an actionable error message.
if [ ! -f "${DATA_DIR}/${IW4X_BINARY}" ]; then
  die "${IW4X_BINARY} not found in ${DATA_DIR}.
      This image does not download IW4x — install IW4x into your own MW2 copy
      (the official launcher at https://iw4x.io writes iw4x.exe + iw4x.dll into
      the game folder), then copy that whole folder onto this volume.
      Override the filename with IW4X_BINARY if yours differs."
fi

if [ ! -f "${DATA_DIR}/main/iw_00.iwd" ]; then
  die "main/iw_00.iwd not found in ${DATA_DIR}.
      The base Call of Duty: Modern Warfare 2 (2009) game files are missing.
      Copy your own legally owned install here: main/ zone/ and the localized
      zone directory (e.g. zone/english)."
fi

if [ ! -d "${DATA_DIR}/zone" ]; then
  die "zone/ not found in ${DATA_DIR}.
      MW2's fastfiles are missing — copy the full game directory, not just main/."
fi

# fs_game pointing at a folder that isn't there is the quietest failure in this
# whole stack: IW4x starts fine, the mod simply never loads, and the only
# symptom is that its dvars don't exist. Bot Warfare in particular installs to
# mods/mp_bots while half the internet says mods/bots. Say something.
fsgame="$(printf '%s' "${GAME_PARAMS}" | sed -n 's/.*fs_game[= ]\([^ ]*\).*/\1/p')"
if [ -n "${fsgame}" ]; then
  if [ -d "${DATA_DIR}/${fsgame}" ] && [ -n "$(ls -A "${DATA_DIR}/${fsgame}" 2>/dev/null)" ]; then
    log "mod: ${fsgame}"
  else
    warn "fs_game is set to '${fsgame}' but ${DATA_DIR}/${fsgame} is missing or empty —
      the mod will NOT load and its dvars will not exist. Bot Warfare installs to
      mods/mp_bots (not mods/bots): extract the release so you get
      ${DATA_DIR}/mods/mp_bots/z_svr_bots.iwd plus scriptdata/waypoints/."
  fi
fi

# Bot Warfare ships an unbounded A* search that trips IW4x's script watchdog
# and freezes the server frame (up to 25s at round start). Patch the operator's
# installed copy — idempotent, backed up, and a no-op when the mod is absent.
if [ "${IW4X_PATCH_BOTS:-1}" = "1" ]; then
  /opt/iw4x-kube/patch-botwarfare.sh || true
fi

# DLC is genuinely optional. Note its absence and move on; the server runs the
# base maps. (The image this replaces treated a missing DLC .iwd as fatal.)
if ls "${DATA_DIR}"/main/iw_dlc*.iwd >/dev/null 2>&1; then
  log "DLC map packs detected"
else
  log "no DLC map packs — base MW2 maps only (this is fine)"
fi

# --- Layout -----------------------------------------------------------------
mkdir -p "${DATA_DIR}/players" "${DATA_DIR}/userraw" || die "cannot write to ${DATA_DIR} — check volume ownership (expects uid/gid 1000)"

# server.cfg belongs to whoever deployed us. GameCTL's init container writes
# players/server.cfg; running standalone without one is legal, and IW4x falls
# back to its own defaults.
if [ -f "${DATA_DIR}/players/server.cfg" ]; then
  log "using players/server.cfg"
else
  warn "no players/server.cfg — the server will start with engine defaults (no hostname, no rcon password)"
fi

# playlists.info ships in the image; seeded only when absent so an operator's
# edited copy is never clobbered.
if [ ! -f "${DATA_DIR}/userraw/playlists.info" ]; then
  cp /opt/iw4x-kube/playlists.info "${DATA_DIR}/userraw/playlists.info" \
    && log "seeded userraw/playlists.info from the image"
fi

if [ ! -f "${DATA_DIR}/userraw/bots.txt" ]; then
  cp /opt/iw4x-kube/bots.txt "${DATA_DIR}/userraw/bots.txt" \
    && log "seeded userraw/bots.txt from the image"
fi

# --- Wine -------------------------------------------------------------------
# IW4x is 32-bit: the prefix MUST be win32. It lives on the data volume so the
# ~200MB prefix and any registry state survive a pod restart.
export WINEARCH=win32
export WINEPREFIX="${DATA_DIR}/WINE32"
export HOME="${DATA_DIR}"
# Mono/Gecko prompts are interactive dialogs; a headless server must never wait
# on one, and IW4x needs neither.
export WINEDLLOVERRIDES="mscoree,mshtml="

if [ ! -d "${WINEPREFIX}/drive_c/windows" ]; then
  log "creating the Wine prefix (first boot only, this takes a moment)"
  wineboot --init >/dev/null 2>&1
  wineserver -w
  log "Wine prefix ready at ${WINEPREFIX}"
else
  log "Wine prefix found"
fi

# --- Shutdown ---------------------------------------------------------------
# Kubernetes sends SIGTERM and then SIGKILLs after the grace period. Wine
# ignores a TERM to the wrapper, so forward it and let wineserver bring the
# game down cleanly — otherwise every redeploy is an unclean shutdown.
child=""
shutdown() {
  log "SIGTERM received — stopping the server"
  [ -n "${child}" ] && kill -TERM "${child}" 2>/dev/null
  wineserver -k 2>/dev/null
  wait "${child}" 2>/dev/null
  exit 0
}
trap shutdown TERM INT

# --- Bots -------------------------------------------------------------------
# IW4x's built-in bots have NO auto-fill dvar: `spawnBot <n>` is a console
# command, and it only works once the map is live. (The bots_manage_* dvars in
# circulation belong to the Bot Warfare mod, which is a separate install — set
# them without that mod and nothing at all happens.) So we wait for the server
# to answer a status query, then ask it over local RCON.
#
# Bash's /dev/udp keeps this dependency-free — no netcat in the image.
#
# Readiness is a single-byte `read`, NOT `head -c <n>`: head blocks until it has
# n bytes, and a status reply is one short datagram, so head would sit there
# until `timeout` killed it — discarding the reply it had already received. The
# probe then looks like a dead server forever. (Cost me one silent no-op.)
udp_fire() {  # fire-and-forget datagram; $1 = payload
  exec 3<>"/dev/udp/127.0.0.1/${GAME_PORT}" 2>/dev/null || return 1
  printf '%b' "$1" >&3
  exec 3<&- 2>/dev/null; exec 3>&- 2>/dev/null
  return 0
}

udp_read() {  # $1 = command; echoes the reply (may be several datagrams)
  local out=""
  exec 3<>"/dev/udp/127.0.0.1/${GAME_PORT}" 2>/dev/null || return 1
  printf '%b' "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} $1" >&3
  # -N with a timeout returns what arrived; a dvar echo is one short datagram.
  IFS= read -r -t 3 -N 512 -u 3 out 2>/dev/null
  exec 3<&- 2>/dev/null; exec 3>&- 2>/dev/null
  printf '%s' "${out}"
}

# The value of a dvar, colour codes stripped, empty if unset/unknown.
dvar_get() {
  udp_read "$1" | sed -n 's/.*is: "\([^"]*\)".*/\1/p' | sed 's/\^[0-9]//g'
}

udp_answers() {  # 0 = the server replied to a status query
  local c rc=1
  exec 3<>"/dev/udp/127.0.0.1/${GAME_PORT}" 2>/dev/null || return 1
  printf '%b' '\xff\xff\xff\xffgetstatus\n' >&3
  IFS= read -r -t 3 -N 1 -u 3 c && rc=0
  exec 3<&- 2>/dev/null; exec 3>&- 2>/dev/null
  return "${rc}"
}

spawn_bots_when_ready() {
  local tries=0
  # ~2.5 min of grace: a cold Wine start plus fastfile load is slow, and
  # spawning into a map that isn't up yet silently does nothing.
  while [ "${tries}" -lt 50 ]; do
    sleep 5
    tries=$((tries + 1))
    if udp_answers; then
      if [ -z "${RCON_PASSWORD}" ]; then
        warn "IW4X_BOTS=${IW4X_BOTS} but RCON_PASSWORD is unset — cannot spawn bots (spawnBot is only reachable over RCON)"
        return 0
      fi
      # The map is up but players spawn a moment later; giving it a beat avoids
      # a spawnBot that lands during the map load and quietly does nothing.
      sleep 5
      udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} spawnBot ${IW4X_BOTS}"
      log "requested ${IW4X_BOTS} bots via spawnBot"
      return 0
    fi
  done
  warn "server never answered a status query — bots not spawned"
}

# Drive the map rotation by keeping sv_mapRotationCurrent stocked.
#
# Three mechanisms were tried on this build; only this one holds:
#
#   sv_mapRotation in server.cfg   — reads back EMPTY at runtime. IW4x parses
#                                    it once, at the first match end, behind a
#                                    static guard, and by then it is gone.
#   addMap / addGametype           — appends to an in-memory queue that the
#                                    engine CONSUMES and never refills. Works
#                                    for a pass or two, then map_rotate does
#                                    nothing at all.
#   sv_mapRotationCurrent          — re-parsed FRESH on every rotation, applies
#                                    both gametype and map, then self-clears.
#
# So: whenever the engine has cleared it, write the next entry from the
# operator's preset. The engine keeps deciding WHEN to rotate (match end);
# this only decides WHAT comes next, which is the part it gets wrong.
rotation_entries() {
  [ -f "${IW4X_ROTATION_FILE}" ] || return 0
  sed -n 's/^[[:space:]]*set[[:space:]]\+sv_mapRotation[[:space:]]\+"\(.*\)".*/\1/p' "${IW4X_ROTATION_FILE}" \
    | head -1 \
    | tr ' ' '\n' \
    | paste -d' ' - - \
    | paste -d' ' - - \
    | sed '/^[[:space:]]*$/d'
}

drive_rotation() {
  local entries idx=0 total cur pick
  entries="$(rotation_entries)"
  [ -n "${entries}" ] || { log "no rotation preset — map stays put"; return 0; }
  total="$(printf '%s\n' "${entries}" | wc -l)"
  log "rotation driver: ${total} entr(y|ies) from $(basename "${IW4X_ROTATION_FILE}")"

  local hold
  # Create the dvar up front: on this engine a bare "<dvar> <value>" only
  # assigns to dvars that already exist, so the first hold written by the UI
  # would silently vanish if nothing had registered it yet.
  udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} set gamectl_rotation_hold 0"
  while sleep 20; do
    # A manual map/mode change from GameCTL sets gamectl_rotation_hold to a
    # number of seconds. While it is counting down we stop stocking AND clear
    # anything already queued — otherwise the next match end would immediately
    # overwrite the operator's choice with the next preset entry, which is
    # exactly what made "change map and mode" look broken.
    hold="$(dvar_get gamectl_rotation_hold)"
    case "${hold}" in
      ''|*[!0-9]*) hold=0 ;;
    esac
    if [ "${hold}" -gt 0 ]; then
      udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} sv_mapRotationCurrent \"\""
      udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} set gamectl_rotation_hold $(( hold > 20 ? hold - 20 : 0 ))"
      [ "${hold}" -le 20 ] && log "rotation hold expired — resuming the preset"
      continue
    fi

    cur="$(dvar_get sv_mapRotationCurrent)"
    [ -n "${cur}" ] && continue

    idx=$(( idx % total + 1 ))
    pick="$(printf '%s\n' "${entries}" | sed -n "${idx}p")"
    [ -n "${pick}" ] || continue
    udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} sv_mapRotationCurrent \"${pick}\""
    log "rotation: queued ${pick} (${idx}/${total})"
  done
}

# One pass of "make the server agree with the operator's configuration".
assert_settings() {
  [ -n "${IW4X_SPECTATE}" ] && udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} scr_game_spectatetype ${IW4X_SPECTATE}"
  [ -n "${IW4X_BOT_FILL}" ] && udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} bots_manage_fill ${IW4X_BOT_FILL}"
  [ -n "${IW4X_BOT_SKILL}" ] && udp_fire "\\xff\\xff\\xff\\xffrcon ${RCON_PASSWORD} bots_skill ${IW4X_BOT_SKILL}"
  return 0
}

apply_post_boot_settings() {
  local tries=0
  while [ "${tries}" -lt 50 ]; do
    sleep 5
    tries=$((tries + 1))
    udp_answers || continue
    if [ -z "${RCON_PASSWORD}" ]; then
      warn "post-boot settings need RCON_PASSWORD — skipping"
      return 0
    fi

    # Apply once now, then hold. The ladder of widening sleeps this replaced
    # was a mistake: the delays are CUMULATIVE, so it took ~15 minutes to
    # finish its last pass, leaving multi-minute gaps in which something in
    # the Bot Warfare stack could re-stamp bots_manage_fill unopposed.
    assert_settings

    drive_rotation &
    log "post-boot settings applied (spectate=${IW4X_SPECTATE:-–} fill=${IW4X_BOT_FILL:-–} skill=${IW4X_BOT_SKILL:-–})"

    # Keep asserting. NOTE this also overrides changes made from Bot Warfare's
    # in-game menu within one interval — set IW4X_ENFORCE_INTERVAL=0 if you
    # would rather tune bots from in-game and have that stick.
    if [ "${IW4X_ENFORCE_INTERVAL}" -gt 0 ] 2>/dev/null; then
      log "holding these settings every ${IW4X_ENFORCE_INTERVAL}s (IW4X_ENFORCE_INTERVAL=0 to stop)"
      # The runtime rotation is a QUEUE, not a loop: addMap/addGametype append
      # entries and the engine consumes them one per rotation, never refilling.
      # Measured: a 6-map preset plays through and then map_rotate does nothing
      # at all — the rotation "stops working" after one pass. So top it back up
      # periodically. Appending is the only primitive available (there is no
      # clear), which is exactly what makes topping-up safe.
      while sleep "${IW4X_ENFORCE_INTERVAL}"; do
        assert_settings
        cycles=$((cycles + 1))
        if [ "$((cycles % 5))" -eq 0 ]; then
          drive_rotation &
        fi
      done
    fi
    return 0
  done
  warn "server never answered — post-boot settings not applied"
}

if [ "${IW4X_BOTS}" -gt 0 ] 2>/dev/null; then
  spawn_bots_when_ready &
fi

if [ -n "${IW4X_SPECTATE}${IW4X_BOT_FILL}${IW4X_BOT_SKILL}" ]; then
  case "${IW4X_SPECTATE}" in
    0|1|2|'') apply_post_boot_settings & ;;
    *) warn "IW4X_SPECTATE='${IW4X_SPECTATE}' is not 0, 1 or 2 — ignoring the whole post-boot pass" ;;
  esac
fi

# --- Launch -----------------------------------------------------------------
# shellcheck disable=SC2206  # GAME_PARAMS is a deliberate word-split arg string
params=(${GAME_PARAMS})
log "launching: ${IW4X_BINARY} -dedicated +set net_port ${GAME_PORT} ${GAME_PARAMS}"

if [ "${USE_XVFB}" = "1" ] && command -v xvfb-run >/dev/null 2>&1; then
  # IW4x is a game binary: even -dedicated touches window/display init on some
  # builds. A virtual display costs a few MB and removes a whole class of
  # "works on my desktop" failure.
  xvfb-run -a --server-args="-screen 0 640x480x16" \
    wine "${IW4X_BINARY}" -dedicated +set net_port "${GAME_PORT}" "${params[@]}" &
else
  wine "${IW4X_BINARY}" -dedicated +set net_port "${GAME_PORT}" "${params[@]}" &
fi

child=$!
wait "${child}"
rc=$?
log "server exited with code ${rc}"
exit "${rc}"
