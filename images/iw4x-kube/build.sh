#!/usr/bin/env bash
# Build (and optionally push) the iw4x-kube image.
#
#   ./build.sh                    build + push to the local registry as :dev
#   ./build.sh --tag v1           build + push :v1
#   ./build.sh --no-push          build only
#   REGISTRY=ghcr.io/gamectl-hq ./build.sh --tag latest
#
# Defaults to the homelab registry the cluster already pulls from. Publishing to
# ghcr.io/gamectl-hq (the wizard's default image) needs `docker login ghcr.io`
# with a write:packages token first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${REGISTRY:-registry.example.com:5000}"
NAME="iw4x-kube"
TAG="dev"
DO_PUSH=1

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --no-push) DO_PUSH=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

IMAGE="${REGISTRY}/${NAME}:${TAG}"
echo ">> building ${IMAGE}"
docker build -t "${IMAGE}" "${HERE}"

if [ "${DO_PUSH}" -eq 1 ]; then
  echo ">> pushing ${IMAGE}"
  docker push "${IMAGE}"
  echo ">> done — set the wizard's Container image field to: ${IMAGE}"
else
  echo ">> built (not pushed): ${IMAGE}"
fi
