// Package api wires the HTTP surface: Huma operations, MCP, auth, health and the embedded web app.
package api

import (
	"io/fs"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5/pgxpool"
	playground "github.com/teb-ooo/playground-go"
	"github.com/teb-ooo/playground-go/auth"
	"github.com/teb-ooo/playground-go/health"
	"github.com/teb-ooo/playground-go/live"
	playgroundlog "github.com/teb-ooo/playground-go/log"
	"github.com/teb-ooo/playground-go/openapimcp"
	"github.com/teb-ooo/playground-go/spa"
	"github.com/teb-ooo/playground-go/surface"

	"app/internal/db"
	"app/web"
)

// Deps is what registration hooks receive.
type Deps struct {
	Cfg  playground.Config
	Pool *pgxpool.Pool
	Mux  *http.ServeMux
	API  huma.API
	Q    *db.Queries
	// Hub tells every open screen that a resource changed (rule UI-yvn). After a successful create, update or
	// delete call d.Hub.Publish("widgets", live.Everyone()); the resource name is the first path segment after
	// /api/ ("widgets" for /api/widgets and /api/widgets/{id}). The stream itself, GET /api/live, is mounted below.
	Hub *live.Hub
}

// registrations run before the MCP handler is built: they register operations.
// A resource file adds its hook from init, so api.go never changes.
var registrations []func(*Deps)

// New builds the whole application handler. Call Close on it once the server has shut down.
func New(cfg playground.Config, pool *pgxpool.Pool) http.Handler {
	h, _, _ := build(cfg, pool)
	return h
}

// closingHandler is the application handler that also holds the Auth, so Close can stop its key poller.
type closingHandler struct {
	http.Handler
	authn *auth.Auth
}

// Close stops what New started (the Auth's key poller); h is the handler New returned. Safe to call more than once.
func Close(h http.Handler) {
	if c, ok := h.(closingHandler); ok {
		c.authn.Close()
	}
}

// build also returns the Huma API and the MCP handler, which the parity test needs.
func build(cfg playground.Config, pool *pgxpool.Pool) (http.Handler, huma.API, http.Handler) {
	// Sign-in problems go to the entrance page (web/src/routes/enter.tsx) as /enter?problem=<code>.
	authn, err := cfg.NewAuth(auth.WithEntrance("/enter"))
	if err != nil {
		panic("api: " + err.Error())
	}
	mux := http.NewServeMux()
	humaAPI := humago.New(mux, huma.DefaultConfig(cfg.AppName, cfg.Version))
	auth.AddSecuritySchemes(humaAPI.OpenAPI())
	authn.Register(humaAPI, mux)
	health.Register(humaAPI, pool, cfg.Version, health.WithEnv(cfg.Env))

	d := &Deps{Cfg: cfg, Pool: pool, Mux: mux, API: humaAPI, Q: db.New(pool), Hub: live.NewHub()}
	// A plain mux handler, not an operation: the OpenAPI document, the MCP tools and the parity check never see it.
	// authn.Middleware (below) puts the signed-in user in the context; a signed-out call answers 401 problem+json.
	live.Mount(mux, d.Hub)
	for _, register := range registrations {
		register(d)
	}

	// MCPOptions wires the caller's identity and the OAuth discovery MCP clients use to sign in; platform API keys (pk_)
	// are accepted by cfg.NewAuth with no app code, and tools are filtered by the key's scopes.
	mcpH := openapimcp.Handler(humaAPI, mux, cfg.MCPOptions(authn))
	mux.Handle("/mcp", mcpH)
	if s, ok := mcpH.(*openapimcp.Server); ok {
		s.RegisterMetadata(mux) // /.well-known/oauth-protected-resource
	}

	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		panic("api: " + err.Error())
	}
	mux.Handle("/", spa.Handler(dist, cfg.SPA()))

	// surface.Middleware is outermost: it tells a browser (UI) from an API call and strips a client-sent surface header.
	top := surface.Middleware(playgroundlog.Middleware(authn.Middleware(mux)))
	return closingHandler{Handler: top, authn: authn}, humaAPI, mcpH
}
