FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/promosite .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/promosite /promosite
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/promosite"]
