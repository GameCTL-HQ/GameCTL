# iw4x-kube — a Wine runtime for IW4x dedicated servers.
#
# Deliberately NOT a downloader. The operator supplies the whole game directory
# (their own MW2 files with IW4x installed into them); this image contributes
# Wine, a persistent prefix, file validation, and a clean launch. That split is
# the entire reason it exists: the community image it replaces
# (ich777/iw4x-server) fetched IW4x from dss0.cc, which has since lapsed into a
# domain-parking page, and demanded a DLC .iwd it fetched from a personal
# OneDrive link that no longer resolves. Both failures ended in `sleep
# infinity`, so the pod reported Running and Ready forever while doing nothing.
#
# Rules this image holds to:
#   - Never download game content at runtime. Missing files are the operator's
#     to fix, and we say exactly which ones.
#   - Never sleep on failure. Exit non-zero so Kubernetes shows CrashLoopBackOff
#     and the reason is in `kubectl logs`.
#   - No opinion about the DLC. Base-game-only installs are normal.
#   - Config belongs to whoever deploys us (GameCTL writes players/server.cfg).
FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="iw4x-kube" \
      org.opencontainers.image.description="IW4x (Call of Duty: MW2) dedicated server under Wine — operator supplies the game files" \
      org.opencontainers.image.source="https://github.com/GameCTL-HQ/GameCTL" \
      org.opencontainers.image.licenses="MIT"

# IW4x is a 32-bit Windows binary, so Wine needs the i386 architecture and the
# wine32 packages — a win32 prefix cannot be created without them.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      wine wine32:i386 wine64 \
      xvfb xauth \
      zip unzip \
      procps \
      ca-certificates \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# uid/gid 1000 matches GameCTL's NFS convention (exports are chowned 1000:1000)
# and the fsGroup its generators set. Wine writes to HOME, which we point at the
# data volume so the prefix persists with the game rather than in the container.
RUN groupadd -g 1000 iw4x && useradd -u 1000 -g 1000 -m -s /bin/bash iw4x

# The stock IW4x playlist definitions, vendored rather than fetched at runtime.
COPY playlists.info /opt/iw4x-kube/playlists.info
# Bot names. IW4x's LoadBotNames() reads userraw/bots.txt (verified against a
# live server: with only main/bots.txt present the names fall back to bot0,
# bot1, …; with userraw/bots.txt they load). Without it the roster ends up
# scraping odd strings through Wine's Z: mapping — /dev/console, /dev/random.
COPY bots.txt /opt/iw4x-kube/bots.txt
COPY entrypoint.sh /opt/iw4x-kube/entrypoint.sh
# Patches the operator's own Bot Warfare install (see the script's header for
# the measurements that justify it).
COPY patch-botwarfare.sh /opt/iw4x-kube/patch-botwarfare.sh
RUN chmod +x /opt/iw4x-kube/entrypoint.sh /opt/iw4x-kube/patch-botwarfare.sh

ENV DATA_DIR=/iw4x \
    GAME_PORT=28960 \
    GAME_PARAMS="" \
    IW4X_BINARY=iw4x.exe \
    USE_XVFB=1 \
    IW4X_PATCH_BOTS=1 \
    IW4X_SPECTATE="" \
    IW4X_BOT_FILL="" \
    IW4X_BOT_SKILL="" \
    IW4X_ENFORCE_INTERVAL=120 \
    WINEDEBUG=-all

# Metadata only — the Service does the actual routing.
EXPOSE 28960/udp 28960/tcp

USER 1000:1000
WORKDIR /iw4x
ENTRYPOINT ["/opt/iw4x-kube/entrypoint.sh"]
