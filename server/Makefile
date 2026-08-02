REGISTRY  ?= registry.example.com:5000
IMAGE     ?= $(REGISTRY)/gamectl:dev
# Ingress host injected at deploy time. The committed manifest ships the
# public-safe placeholder `replace-me.invalid` (install.sh substitutes it
# for end users); `make deploy` is the homelab path, so it substitutes the
# real host here. Override with `GAMECTL_HOST=foo make deploy`.
GAMECTL_HOST ?= gamectl.example.com
# Monitoring-history volume for `make deploy` (homelab path): the manifest
# ships a safe emptyDir (survives container crashes only); deploy swaps it
# for this NFS share so graphs also survive redeploys. Set
# GAMECTL_HISTORY_NFS_SERVER= (empty) to keep the emptyDir.
GAMECTL_HISTORY_NFS_SERVER ?= 10.0.0.100
GAMECTL_HISTORY_NFS_PATH   ?= /mnt/1TBSSD/GameCTL/.gamectl-history
# Commas can't appear literally inside $(if ...) arguments, hence COMMA.
COMMA := ,
HISTORY_NFS_SED = $(if $(GAMECTL_HISTORY_NFS_SERVER),-e 's|emptyDir: {} \# history-volume-default|nfs: { server: $(GAMECTL_HISTORY_NFS_SERVER)$(COMMA) path: $(GAMECTL_HISTORY_NFS_PATH) }|')
GO        := go
# Stamped into the binary (self-update check compares this to the latest
# GitHub release). Override with VERSION=... ; falls back to git describe.
VERSION   ?= $(shell git -C $(REPO_ROOT) describe --tags --always --dirty 2>/dev/null || echo dev)

# Resolve repo root (the dir above server/) for finding the kubeUI/ tree.
REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
UI_SRC    := $(REPO_ROOT)/kubeUI
UI_DIST   := $(UI_SRC)/dist
EMBED_DIST:= $(CURDIR)/internal/ui/dist

.PHONY: build build-ui build-go run run-disk-ui test image push deploy tidy hash clean

# `make build` is the full-binary build: UI + embed + Go.
build: build-ui build-go

build-ui:
	cd $(UI_SRC) && npm install --no-audit --no-fund && npm run build
	rm -rf $(EMBED_DIST)
	mkdir -p $(EMBED_DIST)
	cp -r $(UI_DIST)/. $(EMBED_DIST)/
	# Preserve the .gitkeep marker
	touch $(EMBED_DIST)/.gitkeep

build-go:
	CGO_ENABLED=0 $(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -trimpath -o ./bin/gamectl ./cmd/gamectl

# Run the embedded build (binary + UI all in one process).
run: build-go
	GAMECTL_KUBECONFIG=$$HOME/.kube/config \
	./bin/gamectl serve

# Run with the UI served from disk (no rebuild needed for frontend changes).
# Pair with `cd kubeUI && npm run dev` if you want the Vite HMR experience instead.
run-disk-ui: build-go
	GAMECTL_KUBECONFIG=$$HOME/.kube/config \
	GAMECTL_UI_DIR=$(UI_DIST) \
	./bin/gamectl serve

test:
	$(GO) test ./...

tidy:
	$(GO) mod tidy

image:
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE) -t $(REGISTRY)/gamectl:$(shell git -C $(REPO_ROOT) rev-parse --short HEAD) -f Dockerfile $(REPO_ROOT)

push: image
	docker push $(IMAGE)
	docker push $(REGISTRY)/gamectl:$(shell git -C $(REPO_ROOT) rev-parse --short HEAD)

# Build, push, apply, wait for rollout. Useful for "deploy what's on disk".
#
# Deploy the IMMUTABLE per-commit SHA tag, not :dev. The manifest ships
# imagePullPolicy: IfNotPresent (correct for pinned public releases), so a
# mutable :dev tag would be served stale from each node's cache forever. A
# unique SHA tag is always pulled and makes rollouts explicit.
deploy: push
	sed -e 's#image: ghcr.io/gamectl-hq/gamectl:latest#image: $(REGISTRY)/gamectl:$(shell git -C $(REPO_ROOT) rev-parse --short HEAD)#' \
	    -e 's#replace-me.invalid#$(GAMECTL_HOST)#g' \
	    $(HISTORY_NFS_SED) \
		$(REPO_ROOT)/k8s/deploy-gamectl.yaml | kubectl apply -f -
	kubectl rollout restart deployment/gamectl -n gamectl
	kubectl rollout status  deployment/gamectl -n gamectl --timeout=120s

# Generate a bcrypt hash for use in users.json. Reads password from stdin.
hash:
	$(GO) run ./cmd/gamectl hash-password

clean:
	rm -rf bin/ $(EMBED_DIST)
	mkdir -p $(EMBED_DIST)
	touch $(EMBED_DIST)/.gitkeep
