// Package api wires the HTTP surface: Huma operations, MCP, auth, health and the embedded web app.
package api

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5/pgxpool"
	factory "github.com/teb-ooo/factory-go"
	"github.com/teb-ooo/factory-go/auth"
	"github.com/teb-ooo/factory-go/health"
	factorylog "github.com/teb-ooo/factory-go/log"
	"github.com/teb-ooo/factory-go/openapimcp"
	"github.com/teb-ooo/factory-go/spa"

	"app/internal/db"
	"app/web"
)

// Deps is what registration hooks receive.
type Deps struct {
	Cfg  factory.Config
	Pool *pgxpool.Pool
	Mux  *http.ServeMux
	API  huma.API
	Q    *db.Queries
}

// registrations run before the MCP handler is built: they register operations.
// A resource file adds its hook from init, so api.go never changes.
var registrations []func(*Deps)

// mounts run after it: they mount handlers that derive tools from the API (the assistant overlay).
var mounts []func(*Deps)

// assistantEnabled is set by the assistant overlay's init: only apps generated with the overlay tell the web
// app that the assistant exists, whatever FACTORY_ASSISTANT says.
var assistantEnabled bool

func spaConfig(cfg factory.Config) spa.Config {
	c := cfg.SPA()
	c.Assistant = assistantEnabled
	return c
}

// New builds the whole application handler.
func New(cfg factory.Config, pool *pgxpool.Pool) http.Handler {
	h, _, _ := build(cfg, pool)
	return h
}

// build also returns the Huma API and the MCP handler, which the parity test needs.
func build(cfg factory.Config, pool *pgxpool.Pool) (http.Handler, huma.API, http.Handler) {
	authn, err := cfg.NewAuth()
	if err != nil {
		panic("api: " + err.Error())
	}
	mux := http.NewServeMux()
	humaAPI := humago.New(mux, huma.DefaultConfig(cfg.AppName, cfg.Version))
	auth.AddSecuritySchemes(humaAPI.OpenAPI())
	authn.Register(humaAPI, mux)
	health.Register(humaAPI, pool, cfg.Version, health.WithEnv(cfg.Env))

	d := &Deps{Cfg: cfg, Pool: pool, Mux: mux, API: humaAPI, Q: db.New(pool)}
	for _, register := range registrations {
		register(d)
	}

	mcpH := openapimcp.Handler(humaAPI, mux, openapimcp.Options{Name: cfg.AppName, Auth: authn.BearerOrSession})
	mux.Handle("/mcp", mcpH)
	for _, mount := range mounts {
		mount(d)
	}

	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		panic("api: " + err.Error())
	}
	mux.Handle("/", spa.Handler(dist, spaConfig(cfg)))

	return factorylog.Middleware(authn.Middleware(mux)), humaAPI, mcpH
}

// internalError logs the cause and returns a 500 that does not leak it.
func internalError(ctx context.Context, what string, err error) error {
	slog.ErrorContext(ctx, what+" failed", "error", err)
	return huma.Error500InternalServerError("internal error")
}
