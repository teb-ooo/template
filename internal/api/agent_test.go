package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/teb-ooo/factory-go/auth"
	"github.com/teb-ooo/factory-go/testkit"
)

func newAgentRoutes(t *testing.T, staging bool) (*agentRoutes, *[]string) {
	t.Helper()
	var sent []string
	return &agentRoutes{
		appName: "hello", staging: staging, client: http.DefaultClient,
		sessionFile: filepath.Join(t.TempDir(), "session_url"),
		fromGate:    func(*http.Request) bool { return true },
		sendKey:     func(_ context.Context, k string) error { sent = append(sent, k); return nil },
	}, &sent
}

func TestAgentAccess(t *testing.T) {
	admin := auth.User{Subject: "a", Groups: []string{"admin"}}
	member := auth.User{Subject: "m"}
	tests := []struct {
		name    string
		staging bool
		user    *auth.User
		cookie  bool
		header  string
		gate    bool
		want    int
	}{
		{"production is 404 even for admin", false, &admin, false, "", true, http.StatusNotFound},
		{"admin session", true, &admin, false, "", false, http.StatusOK},
		{"member session", true, &member, false, "", true, http.StatusForbidden},
		{"anonymous", true, nil, false, "", true, http.StatusUnauthorized},
		{"gate header from the proxy", true, nil, false, "me@example.com", true, http.StatusOK},
		{"gate header from elsewhere", true, nil, false, "me@example.com", false, http.StatusUnauthorized},
		{"gate header with a stale session cookie", true, nil, true, "me@example.com", true, http.StatusUnauthorized},
		{"gate header on production", false, nil, false, "me@example.com", true, http.StatusNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, _ := newAgentRoutes(t, tc.staging)
			a.fromGate = func(*http.Request) bool { return tc.gate }
			r := httptest.NewRequest(http.MethodGet, "/_agent/status", nil)
			if tc.user != nil {
				r = r.WithContext(auth.WithUser(r.Context(), *tc.user))
			}
			if tc.cookie {
				r.AddCookie(&http.Cookie{Name: auth.CookieName, Value: "stale"})
			}
			if tc.header != "" {
				r.Header.Set(gateHeader, tc.header)
			}
			w := httptest.NewRecorder()
			a.route(http.MethodGet, a.status)(w, r)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body)
			}
		})
	}
}

func TestAgentKeys(t *testing.T) {
	admin := auth.User{Subject: "a", Groups: []string{"admin"}}
	tests := []struct {
		name        string
		contentType string
		body        string
		want        int
		sent        string
	}{
		{"Escape", "application/json", `{"key":"Escape"}`, 200, "Escape"},
		{"Tab", "application/json", `{"key":"Tab"}`, 200, "Tab"},
		{"Ctrl-C", "application/json; charset=utf-8", `{"key":"C-c"}`, 200, "C-c"},
		{"Up", "application/json", `{"key":"Up"}`, 200, "Up"},
		{"Down", "application/json", `{"key":"Down"}`, 200, "Down"},
		{"Enter", "application/json", `{"key":"Enter"}`, 200, "Enter"},
		{"other tmux key", "application/json", `{"key":"C-d"}`, 422, ""},
		{"lowercase", "application/json", `{"key":"escape"}`, 422, ""},
		{"injection", "application/json", `{"key":"Enter; rm -rf /"}`, 422, ""},
		{"flag lookalike", "application/json", `{"key":"-t"}`, 422, ""},
		{"empty", "application/json", `{}`, 422, ""},
		{"unknown field", "application/json", `{"key":"Tab","extra":1}`, 400, ""},
		{"not json", "application/json", `nope`, 400, ""},
		{"form content type", "application/x-www-form-urlencoded", `{"key":"Tab"}`, 415, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, sent := newAgentRoutes(t, true)
			r := httptest.NewRequest(http.MethodPost, "/_agent/keys", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.contentType)
			r = r.WithContext(auth.WithUser(r.Context(), admin))
			w := httptest.NewRecorder()
			a.route(http.MethodPost, a.keys)(w, r)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body)
			}
			if got := strings.Join(*sent, ","); got != tc.sent {
				t.Fatalf("sent %q, want %q", got, tc.sent)
			}
		})
	}
	t.Run("GET is not allowed", func(t *testing.T) {
		a, _ := newAgentRoutes(t, true)
		w := httptest.NewRecorder()
		a.route(http.MethodPost, a.keys)(w, httptest.NewRequest(http.MethodGet, "/_agent/keys", nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d", w.Code)
		}
	})
}

func TestAgentStatusFromFactoryd(t *testing.T) {
	admin := auth.User{Subject: "a", Groups: []string{"admin"}}
	tests := []struct {
		name       string
		token      string
		handler    http.HandlerFunc
		wantStatus string
		wantSum    string
	}{
		{"live shape: under agent", "tok", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"name":"hello","agent":{"app":"hello","status":"working","since":"2026-09-29T10:00:00Z","last_summary":"did a thing","last_event_at":"2026-09-29T10:00:00Z"}}`))
		}, "working", "did a thing"},
		{"no agent object", "tok", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"status":"working"}`))
		}, "unknown", ""},
		{"server error", "tok", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }, "unknown", ""},
		{"garbage", "tok", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`<html>`)) }, "unknown", ""},
		{"no token", "", func(w http.ResponseWriter, _ *http.Request) { t.Error("factoryd must not be called") }, "unknown", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/apps/hello" || r.Header.Get("Authorization") != "Bearer tok" {
					t.Errorf("unexpected request %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
				}
				tc.handler(w, r)
			}))
			defer fd.Close()
			a, _ := newAgentRoutes(t, true)
			a.factorydURL, a.token = fd.URL, tc.token
			if err := os.WriteFile(a.sessionFile, []byte("https://claude.ai/code/session_abc123\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodGet, "/_agent/status", nil)
			r = r.WithContext(auth.WithUser(r.Context(), admin))
			w := httptest.NewRecorder()
			a.route(http.MethodGet, a.status)(w, r)
			body := w.Body.String()
			for _, want := range []string{`"status":"` + tc.wantStatus + `"`, `"last_summary":"` + tc.wantSum + `"`,
				`"claude_session_url":"https://claude.ai/code/session_abc123"`} {
				if !strings.Contains(body, want) {
					t.Errorf("body %s lacks %s", body, want)
				}
			}
		})
	}
}

func TestAgentStatusUnreachableFactorydAndBadSessionFile(t *testing.T) {
	a, _ := newAgentRoutes(t, true)
	a.factorydURL, a.token = "http://127.0.0.1:1", "tok"
	if err := os.WriteFile(a.sessionFile, []byte("https://evil.example/x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/_agent/status", nil)
	r = r.WithContext(auth.WithUser(r.Context(), auth.User{Groups: []string{"admin"}}))
	w := httptest.NewRecorder()
	a.route(http.MethodGet, a.status)(w, r)
	if body := w.Body.String(); !strings.Contains(body, `"status":"unknown"`) || !strings.Contains(body, `"claude_session_url":""`) {
		t.Fatalf("body = %s", body)
	}
}

// The wired routes use the real session cookie and never trust a spoofed gate header from a stranger.
func TestAgentRoutesWired(t *testing.T) {
	cfg := testConfig(t, nil)
	h := New(cfg, lazyPool(t, cfg.DatabaseURL))
	admin, err := testkit.MintSession(cfg.SessionKey, auth.User{Subject: "a", Groups: []string{"admin"}})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		cookie *http.Cookie
		header string
		want   int
	}{
		{"admin cookie", admin, "", http.StatusOK},
		{"anonymous", nil, "", http.StatusUnauthorized},
		{"spoofed header from a test peer", nil, "x@example.com", http.StatusUnauthorized},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/_agent/status", nil)
			if tc.cookie != nil {
				r.AddCookie(tc.cookie)
			}
			if tc.header != "" {
				r.Header.Set(gateHeader, tc.header)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body)
			}
		})
	}
}

func TestProductionAgentRoutesAre404(t *testing.T) {
	cfg := testConfig(t, map[string]string{
		"APP_ENV": "production", "PUBLIC_URL": "https://app.example.com", "OIDC_ISSUER": "https://oidc.example.com"})
	h := New(cfg, lazyPool(t, cfg.DatabaseURL))
	for _, p := range []string{"/_agent/status", "/_agent/keys"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, p, strings.NewReader(`{"key":"Tab"}`)))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", p, w.Code)
		}
	}
}
