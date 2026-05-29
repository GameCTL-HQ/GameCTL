# cs2-records — multi-stage build. Static binary in a distroless runtime.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/cs2-records .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/cs2-records /cs2-records
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/cs2-records"]
