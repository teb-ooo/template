// Command server runs the app: migrations, then the HTTP server.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
	factory "github.com/teb-ooo/factory-go"
	factorylog "github.com/teb-ooo/factory-go/log"

	"app/internal/api"
	"app/migrations"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("server", flag.ContinueOnError)
	migrateOnly := fs.Bool("migrate-only", false, "apply database migrations and exit")
	printOpenAPI := fs.Bool("print-openapi", false, "print /openapi.json to stdout and exit (needs no database)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *printOpenAPI {
		return printSpec(os.Stdout)
	}

	cfg, err := factory.LoadConfig()
	if err != nil {
		return err
	}
	cfg.Version = version
	slog.SetDefault(factorylog.Setup(slog.LevelInfo))
	slog.Info("starting", "config", cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open database pool: %w", err)
	}
	defer pool.Close()

	if err := migrate(ctx, pool); err != nil {
		return err
	}
	if *migrateOnly {
		slog.Info("migrations applied")
		return nil
	}

	srv := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           api.New(cfg, pool),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("listening", "addr", srv.Addr)

	select {
	case err := <-errc:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

// migrate applies the embedded goose migrations under a Postgres advisory lock.
func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	return migrateDB(ctx, sqlDB)
}

func migrateDB(ctx context.Context, sqlDB *sql.DB) error {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("migration lock: %w", err)
	}
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	results, err := p.Up(ctx)
	for _, r := range results {
		slog.Info("migration applied", "version", r.Source.Version, "file", r.Source.Path)
	}
	if err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

// printSpec builds the API without a database and writes its OpenAPI document. The pool never connects
// and the configuration is placeholders (only APP_NAME is read), so it needs no environment.
func printSpec(w io.Writer) error {
	defaults := map[string]string{
		"APP_NAME": "app", "APP_ENV": "staging", "PUBLIC_URL": "http://localhost:8080",
		"DATABASE_URL": "postgres://app@127.0.0.1:1/app", "OIDC_ISSUER": "http://127.0.0.1:1",
		"OIDC_CLIENT_ID": "openapi", "OIDC_CLIENT_SECRET": "openapi",
		"SESSION_KEY": strings.Repeat("0", 64),
	}
	cfg, err := factory.FromEnv(func(k string) string {
		if k == "APP_NAME" && os.Getenv(k) != "" {
			return os.Getenv(k)
		}
		return defaults[k]
	})
	if err != nil {
		return err
	}
	cfg.Version = version
	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL) // lazy: no connection is made
	if err != nil {
		return fmt.Errorf("build pool: %w", err)
	}
	defer pool.Close()

	rec := httptest.NewRecorder()
	api.New(cfg, pool).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/openapi.json", nil))
	if rec.Code != http.StatusOK {
		return fmt.Errorf("openapi.json returned %d", rec.Code)
	}
	var doc any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		return fmt.Errorf("decode openapi.json: %w", err)
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("encode openapi.json: %w", err)
	}
	if _, err := w.Write(append(out, '\n')); err != nil {
		return fmt.Errorf("write openapi.json: %w", err)
	}
	return nil
}
