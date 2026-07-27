# k8s/

Cluster manifest for GameCTL. After the FastAPI→Go migration this directory has shrunk to one file:

| File | Purpose |
|---|---|
| [`deploy-gamectl.yaml`](deploy-gamectl.yaml) | Namespace, ServiceAccount, ClusterRole, ClusterRoleBinding, Deployment, Service, Ingress — everything the cluster needs in one shot. |
| [`PUSH_AND_DEPLOY.md`](PUSH_AND_DEPLOY.md) | Build / push / deploy runbook for the homelab cluster. |

The pre-migration two-Deployment approach (Python `game-api` + nginx `game-ui`, with NFS-mounted kubeconfig) lived in `deploy-api-ui.yaml` and `rbac-serviceaccount.yaml`. Both were deleted at cutover; commit `d0e05bd` preserves them in git history if you ever need to revive that setup.

Apply with:

```bash
kubectl apply -f k8s/deploy-gamectl.yaml
```

See [PUSH_AND_DEPLOY.md](PUSH_AND_DEPLOY.md) for the full workflow.
