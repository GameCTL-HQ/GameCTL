# iw4x-kube

A Wine runtime for **IW4x** (Call of Duty: Modern Warfare 2, 2009) dedicated
servers. Debian + 32-bit Wine, a persistent Wine prefix, file validation, clean
shutdown. **It downloads nothing.**

## Why it exists

The community image (`ich777/iw4x-server`) is abandoned upstream and both of
its download paths have rotted:

| | |
|---|---|
| `IW4X_DL_URL` | `https://dss0.cc/updater/iw4x_files.zip` — the domain lapsed and now serves a for-sale parking page, which `wget` dutifully saved as a 970-byte "zip" |
| `IW4X_DLC_URL` | a personal OneDrive share that no longer resolves |

Both failures ended in `sleep infinity`, so the pod reported **Running** and
**Ready** indefinitely while doing nothing at all. The DLC check was also
unconditional — no way to say "I don't own the DLC" — and the script expected
`iw4x.exe` from an IW4x layout that predates the current launcher.

This image inverts the model: the operator owns the game directory, the image
owns Wine.

## Contract

Mount your game directory at `/iw4x` (or set `DATA_DIR`). It must contain:

| Path | Notes |
|---|---|
| `iw4x.exe` | from installing IW4x into your MW2 copy client-side (the [official launcher](https://iw4x.io) writes `iw4x.exe` + `iw4x.dll`) |
| `main/iw_00.iwd` | your own legally owned MW2 files |
| `zone/`, `zone/<language>` | MW2 fastfiles |
| `main/iw_dlc*.iwd` | **optional** — absence is logged and ignored |

Created if missing: `players/`, `userraw/`, `userraw/playlists.info` (vendored
in the image), and the Wine prefix at `$DATA_DIR/WINE32`.

### Environment

| Var | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/iw4x` | game directory + Wine prefix parent |
| `GAME_PORT` | `28960` | passed as `+set net_port` |
| `GAME_PARAMS` | *(empty)* | appended verbatim to the launch line |
| `IW4X_BINARY` | `iw4x.exe` | which Windows binary to run |
| `USE_XVFB` | `1` | run under a virtual display |

Launch line: `wine $IW4X_BINARY -dedicated +set net_port $GAME_PORT $GAME_PARAMS`

`server.cfg` is **not** this image's business — GameCTL's init container writes
`players/server.cfg`. Running without one is legal; the engine uses its
defaults and the image says so.

## Design rules

1. **Never download game content at runtime.** Missing files are the
   operator's to fix, and we name them.
2. **Never sleep on failure.** Exit non-zero so Kubernetes shows
   `CrashLoopBackOff` and `kubectl logs` explains it. A container that cannot
   work must not look healthy.
3. **No opinion about the DLC.**
4. **The prefix lives on the volume**, so a restart doesn't rebuild it.
5. **Forward SIGTERM** to `wineserver` so redeploys shut down cleanly.

## Build

```bash
./build.sh                                   # → registry.example.com:5000/iw4x-kube:dev, pushed
./build.sh --tag v1 --no-push                # build only
REGISTRY=ghcr.io/gamectl-hq ./build.sh --tag latest   # needs docker login ghcr.io
```

The wizard defaults to `ghcr.io/gamectl-hq/iw4x-kube:latest`, matching every
other game. Until that's published, override the **Container image** field with
the local registry tag.

## Status

Validation paths, Wine prefix creation, playlists seeding and the xvfb launch
are verified. **A full game boot is not** — that needs MW2 files, which only
the operator has. See `docs/IW4X_PLAN.md`.
