# promosite

GameCTL's optional bundled "promotion site" — a tiny, single-binary HTTP
server that renders a public page of advertised servers from a
[GameCTL Stats API](../docs/STATS_API.md).

Deployed (and removed) from GameCTL's own admin UI (**Stats API** tab →
"Bundled promotion site"), which builds the Deployment/Service manifest and
applies it via the same server-side apply GameCTL already uses for game
manifests — see `server/internal/httpapi/promosite_handlers.go`. Not tied
to any one instance, not a per-game "companion" — one promosite per
GameCTL install, showing everything currently advertised.

## Config (env vars)

| Var | Required | Default | Meaning |
|---|---|---|---|
| `STATS_API_URL` | yes | — | Full URL of `GET .../api/stats/servers` |
| `STATS_API_TOKEN` | yes | — | The Stats API bearer token — held server-side only, never sent to the browser |
| `SITE_TITLE` | no | `Game Servers` | Page `<title>`/heading |
| `ACCENT_COLOR` | no | `#7c3aed` | CSS accent color |
| `LISTEN_ADDR` | no | `:8080` | |
| `CACHE_SECONDS` | no | `15` | How long a successful Stats API fetch is reused before re-polling |

## Why its own image, not bundled into the `gamectl` binary

Deploying it is independent of GameCTL's own version/lifecycle, and of the
Stats API being enabled at all (an operator could run one against a
different Stats API entirely). It's plain Go stdlib, zero dependencies —
`go build .` — so keeping it separate costs nothing and follows the same
precedent as extracting `cs2-records` out of the main GameCTL binary.

## Running it standalone (outside GameCTL)

```bash
STATS_API_URL=https://gamectl.example.com/api/stats/servers \
STATS_API_TOKEN=<token from the Stats API tab> \
SITE_TITLE="My Servers" \
go run .
```
