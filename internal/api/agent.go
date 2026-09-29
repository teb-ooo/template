package api

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/teb-ooo/factory-go/auth"
	"github.com/teb-ooo/factory-go/spa"
)

// Routes behind the agent panel (web /_agent). Staging only, plain handlers so they stay out of OpenAPI and MCP.
// Access: an admin session, or, on staging and when the request comes from the Caddy gate, the oauth2-proxy
// identity header (see docs/adr/0060).

const (
	factorydURL     = "http://factoryd:9000"
	gateHeader      = "X-Auth-Request-Email"
	gateProxyHost   = "caddy"
	tmuxSession     = "agent"
	agentCallBudget = 2 * time.Second
)

// tmux key names the panel's key bar may send; nothing else ever reaches tmux.
var allowedKeys = map[string]bool{"Escape": true, "Tab": true, "C-c": true, "Up": true, "Down": true, "Enter": true}

type agentRoutes struct {
	appName     string
	staging     bool
	factorydURL string
	token       string
	sessionFile string
	client      *http.Client
	fromGate    func(*http.Request) bool
	sendKey     func(ctx context.Context, key string) error
}

func registerAgent(d *Deps) {
	base := os.Getenv("FACTORYD_URL")
	if base == "" {
		base = factorydURL
	}
	proxyHost := os.Getenv("FACTORY_GATE_PROXY_HOST")
	if proxyHost == "" {
		proxyHost = gateProxyHost
	}
	a := &agentRoutes{
		appName:     d.Cfg.AppName,
		staging:     d.Cfg.Env == "staging",
		factorydURL: strings.TrimRight(base, "/"),
		token:       os.Getenv("FACTORYD_TOKEN"),
		sessionFile: spa.DefaultSessionURLFile,
		client:      &http.Client{Timeout: agentCallBudget},
		fromGate:    func(r *http.Request) bool { return requestFromHost(r, proxyHost) },
		sendKey:     tmuxSendKey,
	}
	d.Mux.HandleFunc("/_agent/status", a.route(http.MethodGet, a.status))
	d.Mux.HandleFunc("/_agent/keys", a.route(http.MethodPost, a.keys))
}

// route runs h for one method after the environment and access checks; the routes do not exist outside staging.
func (a *agentRoutes) route(method string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.staging {
			writeProblem(w, http.StatusNotFound, "not found")
			return
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeProblem(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if a.authorize(w, r) {
			h(w, r)
		}
	}
}

// authorize reports whether the caller may use the agent routes; when not, it has written the response.
func (a *agentRoutes) authorize(w http.ResponseWriter, r *http.Request) bool {
	if u, ok := auth.FromContext(r.Context()); ok {
		if u.IsAdmin() {
			return true
		}
		writeProblem(w, http.StatusForbidden, "administrator required")
		return false
	}
	// A session cookie that did not validate is never second-guessed by the gate header.
	if _, err := r.Cookie(auth.CookieName); err != nil &&
		strings.TrimSpace(r.Header.Get(gateHeader)) != "" && a.fromGate(r) {
		return true
	}
	writeProblem(w, http.StatusUnauthorized, "sign in as an administrator")
	return false
}

type agentStatus struct {
	Status           string     `json:"status"`
	Since            *time.Time `json:"since"`
	LastSummary      string     `json:"last_summary"`
	ClaudeSessionURL string     `json:"claude_session_url"`
}

func (a *agentRoutes) status(w http.ResponseWriter, r *http.Request) {
	st := a.fetchStatus(r.Context())
	st.ClaudeSessionURL = a.sessionURL()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, st)
}

func (a *agentRoutes) sessionURL() string {
	b, err := os.ReadFile(a.sessionFile)
	if err != nil {
		return ""
	}
	u := strings.TrimSpace(string(b))
	if !strings.HasPrefix(u, "https://claude.ai/code/session_") {
		return ""
	}
	return u
}

// fetchStatus asks factoryd for the agent status; any failure yields "unknown".
func (a *agentRoutes) fetchStatus(ctx context.Context) agentStatus {
	unknown := agentStatus{Status: "unknown"}
	if a.token == "" {
		return unknown
	}
	ctx, cancel := context.WithTimeout(ctx, agentCallBudget)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.factorydURL+"/v1/apps/"+a.appName, nil)
	if err != nil {
		return unknown
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	resp, err := a.client.Do(req)
	if err != nil {
		return unknown
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return unknown
	}
	// factoryd's GET /v1/apps/{name} carries the agent's status under "agent" (checked against the live daemon).
	var body struct {
		Agent *agentFields `json:"agent"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil || body.Agent == nil {
		return unknown
	}
	f := *body.Agent
	if f.Status == "" {
		return unknown
	}
	return agentStatus{Status: f.Status, Since: f.Since, LastSummary: f.LastSummary}
}

type agentFields struct {
	Status      string     `json:"status"`
	Since       *time.Time `json:"since"`
	LastSummary string     `json:"last_summary"`
}

func (a *agentRoutes) keys(w http.ResponseWriter, r *http.Request) {
	// A cross-site form cannot send this content type without a preflight.
	if ct := r.Header.Get("Content-Type"); ct != "application/json" && !strings.HasPrefix(ct, "application/json;") {
		writeProblem(w, http.StatusUnsupportedMediaType, "content type must be application/json")
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeProblem(w, http.StatusBadRequest, "body must be {\"key\": string}")
		return
	}
	if !allowedKeys[body.Key] {
		writeProblem(w, http.StatusUnprocessableEntity, "key must be one of Escape, Tab, C-c, Up, Down, Enter")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), agentCallBudget)
	defer cancel()
	if err := a.sendKey(ctx, body.Key); err != nil {
		writeProblem(w, http.StatusBadGateway, "could not send the key to the agent terminal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"key": body.Key})
}

// tmuxSendKey runs tmux directly (no shell); key has already passed the whitelist.
func tmuxSendKey(ctx context.Context, key string) error {
	return exec.CommandContext(ctx, "tmux", "send-keys", "-t", tmuxSession, key).Run()
}

// requestFromHost reports whether the request's peer is one of the addresses host resolves to.
func requestFromHost(r *http.Request, host string) bool {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if a == peer {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeProblem answers in the same RFC 9457 shape Huma uses.
func writeProblem(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"title": http.StatusText(status), "status": status, "detail": detail})
}
