# gamectl server (Go)

Single-binary Go backend with the React UI embedded via `//go:embed`. Serves the UI at `/` and the API under `/api/*` on one port.

## Run locally

Runs with production auth and kubeconfig from `~/.kube/config`. With no
`GAMECTL_JWT_SECRET`/users file set, it enters **first-run setup mode** — a
one-time bootstrap token is printed in the logs; open the UI to create the
admin.

```bash
make run
```

That's:

```bash
GAMECTL_KUBECONFIG=$HOME/.kube/config \
GAMECTL_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
go run ./cmd/gamectl serve
```

Smoke test (health is public; `/token` requires an admin created via the
first-run setup flow or a provisioned `GAMECTL_USERS_FILE`):

```bash
curl localhost:8080/health
# {"ok":true}

TOKEN=$(curl -s -X POST localhost:8080/token \
  -d "username=$USER&password=$PASS" | jq -r .access_token)

curl -H "Authorization: Bearer $TOKEN" localhost:8080/whoami
# {"user":"<your-user>"}
```

## Configuration

| Env var | Required? | Description |
|---|---|---|
| `GAMECTL_LISTEN` | no | Listen address. Default `:8080`. |
| `GAMECTL_JWT_SECRET` | prod | HMAC secret for signing JWTs. Min 32 bytes. Absent together with the users file → first-run setup mode. |
| `GAMECTL_USERS_FILE` | prod | Path to JSON file with user records (see below). |
| `GAMECTL_KUBECONFIG` | no | Path to kubeconfig. Falls back to in-cluster, then `~/.kube/config`. |
| `GAMECTL_ALLOWED_ORIGINS` | no | Comma-separated CORS origins. |
| `GAMECTL_UI_DIR` | no | If set, serve UI from disk path instead of embedded FS (Phase 5). |

## Production user file

`GAMECTL_USERS_FILE` should point to JSON with this shape:

```json
[
  { "username": "admin", "password_hash": "$2a$12$..." }
]
```

Generate hashes with the bundled subcommand:

```bash
go run ./cmd/gamectl hash-password
# enter password, prints bcrypt hash
```

In production this file is mounted from a Kubernetes Secret. See Phase 6 for the cutover manifests.

## Subcommands

| Command | Purpose |
|---|---|
| `gamectl serve` | Run the HTTP server (default if no args). |
| `gamectl hash-password` | Read a password from stdin, print a bcrypt hash. |
| `gamectl version` | Print version stub. |

## Build a container image

```bash
make image      # builds registry.example.com:5000/gamectl:dev
make push       # builds + pushes
```

The image is `gcr.io/distroless/static:nonroot` plus the static Go binary — ~15 MB.

## Layout

```
server/
├── cmd/gamectl/         entrypoint + subcommand dispatch
└── internal/
    ├── config/          env-var driven config
    ├── auth/            bcrypt + JWT + middleware + hash-password subcommand
    ├── httpapi/         chi router, handlers, CORS, error JSON helpers
    └── kube/            client-go construction (clientset, dynamic, RESTMapper)
```
