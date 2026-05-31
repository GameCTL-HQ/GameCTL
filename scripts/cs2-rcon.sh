#!/usr/bin/env bash
# cs2-rcon.sh — send RCON command(s) to the live cs2 pod's service IP.
# Used so we can apply cfg/plugin reloads without making the operator
# type `exec ...` or `css_plugins reload ...` in their game console.
#
# Usage:
#   scripts/cs2-rcon.sh 'exec custom_deathmatch.cfg' 'css_plugins reload "GameCtl DM Rounds"'
set -euo pipefail

NS=${CS2_NS:-gamectl}
SVC=${CS2_SVC:-cs2}

POD=$(kubectl get po -n "$NS" -l app="$SVC" -o jsonpath='{.items[0].metadata.name}')
SVC_IP=$(kubectl get svc -n "$NS" "$SVC" -o jsonpath='{.spec.clusterIP}')
PORT=$(kubectl get svc -n "$NS" "$SVC" -o jsonpath='{.spec.ports[?(@.name=="game-tcp")].port}')
RCON_PW=$(kubectl exec -n "$NS" "$POD" -c cs2 -- printenv RCON_PASSWORD)

if [ $# -eq 0 ]; then
  echo "usage: $0 <rcon-cmd> [<rcon-cmd> ...]" >&2
  exit 2
fi

# Encode all commands as a single JSON array env var for the python pod.
CMDS_JSON=$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "$@")

kubectl run -n "$NS" --rm -i --restart=Never --image=python:3.12-alpine "rcon-$$-$RANDOM" --env="CMDS_JSON=$CMDS_JSON" --env="HOST=$SVC_IP" --env="PORT=$PORT" --env="PW=$RCON_PW" -- python -c '
import socket, struct, os, json, time
cmds = json.loads(os.environ["CMDS_JSON"])
for attempt in range(3):
    try:
        s = socket.create_connection((os.environ["HOST"], int(os.environ["PORT"])), timeout=5)
        break
    except Exception as e:
        print(f"connect attempt {attempt}: {e}")
        time.sleep(2)
else:
    raise SystemExit(1)
def pkt(rid, t, body):
    body = body.encode() + b"\x00\x00"
    return struct.pack("<iii", len(body)+8, rid, t) + body
s.sendall(pkt(1, 3, os.environ["PW"]))
sz = struct.unpack("<i", s.recv(4))[0]; s.recv(sz)
for q in cmds:
    s.sendall(pkt(2, 2, q))
    sz = struct.unpack("<i", s.recv(4))[0]
    resp = s.recv(sz).decode("utf-8", "replace").strip()
    print(">> " + q); print(resp); print()
' 2>&1 | tail -40
