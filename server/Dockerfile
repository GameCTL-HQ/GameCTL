# --- Stage 1: build the React UI ---
FROM node:20-alpine AS ui
WORKDIR /ui
COPY kubeUI/package.json kubeUI/package-lock.json ./
RUN npm ci
COPY kubeUI/ ./
RUN npm run build

# --- Stage 2: build the Go binary with the UI embedded ---
FROM golang:1.26-alpine AS go
WORKDIR /src

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
# Drop the placeholder dist and replace with the real UI build before `go build`
# (so //go:embed picks up the real index.html / assets / brand / yaml).
RUN rm -rf ./internal/ui/dist
COPY --from=ui /ui/dist ./internal/ui/dist

# Stamped into the binary so the self-update check knows what it's running.
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -trimpath \
    -o /out/gamectl \
    ./cmd/gamectl

# --- Stage 3: distroless runtime ---
FROM gcr.io/distroless/static:nonroot
COPY --from=go /out/gamectl /gamectl
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/gamectl"]
CMD ["serve"]
