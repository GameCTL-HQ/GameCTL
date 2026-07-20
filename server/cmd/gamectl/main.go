package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/buildinfo"
	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/httpapi"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/tasks"
)

// version is stamped at build time via -ldflags "-X main.version=vX.Y.Z".
// Defaults to "dev" for local/un-tagged builds.
var version = "dev"

func main() {
	buildinfo.Version = version

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	subcommand := "serve"
	if len(os.Args) >= 2 {
		subcommand = os.Args[1]
	}

	switch subcommand {
	case "serve":
		serve()
	case "hash-password":
		auth.HashPasswordCmd()
	case "version":
		println("gamectl " + version)
	default:
		slog.Error("unknown subcommand", "arg", subcommand)
		os.Exit(2)
	}
}

func serve() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(1)
	}

	authn, err := auth.New(cfg)
	if err != nil {
		slog.Error("auth init failed", "err", err)
		os.Exit(1)
	}

	if authn.NeedsSetup() {
		slog.Warn("################################################################")
		slog.Warn("##  FIRST-RUN ADMIN SETUP REQUIRED                            ##")
		slog.Warn("##  Open the GameCTL UI and enter this one-time token to      ##")
		slog.Warn("##  create the admin account:                                 ##")
		slog.Warn("##                                                            ##")
		slog.Warn("BOOTSTRAP TOKEN", "token", authn.BootstrapToken())
		slog.Warn("##                                                            ##")
		slog.Warn("##  The token is regenerated on every restart until setup     ##")
		slog.Warn("##  completes. It is never exposed over the API.              ##")
		slog.Warn("################################################################")
	}

	cluster, err := kube.New(cfg.KubeconfigPath)
	if err != nil {
		// Non-fatal during Phase 1: kube endpoints will return 503 until configured.
		slog.Warn("kube client unavailable; will be required by /kube/* endpoints", "err", err)
	} else {
		slog.Info("kube client ready", "source", cluster.Source())
		if cfg.StorageSeed != "" {
			if added, serr := cluster.SeedStorageLocations(context.Background(), cfg.StorageSeed); serr != nil {
				slog.Warn("GAMECTL_STORAGE_LOCATIONS seed failed", "err", serr)
			} else if len(added) > 0 {
				slog.Info("seeded storage locations", "added", added)
			}
		}
	}

	taskStore := tasks.NewStore(200)

	// Background reconcilers — currently just CS2 workshop auto-preload.
	// The reconciler ctx is tied to the process so it stops on shutdown.
	reconCtx, reconCancel := context.WithCancel(context.Background())
	defer reconCancel()
	if cluster != nil {
		cluster.StartCS2Reconciler(reconCtx)
		// Resource monitoring: 30s usage samples + ~1h in-memory history
		// for every game instance (hub pressure badges + manage graphs).
		cluster.StartMetricsSampler(reconCtx)
	}

	router := httpapi.NewRouter(authn, cluster, cfg, taskStore)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("server starting", "addr", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	slog.Info("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
