package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	playground "github.com/teb-ooo/playground-go"
	"github.com/teb-ooo/playground-go/openapimcp"
)

// testConfig is a valid staging configuration with throwaway credentials.
func testConfig(t testing.TB, override map[string]string) playground.Config {
	t.Helper()
	env := map[string]string{
		"APP_NAME": "app", "APP_ENV": "staging", "PUBLIC_URL": "http://localhost:8080",
		"DATABASE_URL": "postgres://app@127.0.0.1:1/app", "OIDC_ISSUER": "http://127.0.0.1:1",
		"OIDC_CLIENT_ID": "test", "OIDC_CLIENT_SECRET": "test-not-a-secret",
		"SESSION_KEY": strings.Repeat("ab", 32),
	}
	for k, v := range override {
		env[k] = v
	}
	cfg, err := playground.FromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	cfg.Version = "test"
	return cfg
}

// lazyPool never connects: pgxpool connects on first use.
func lazyPool(t testing.TB, url string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestParity(t *testing.T) {
	cfg := testConfig(t, nil)
	_, humaAPI, mcpH := build(cfg, lazyPool(t, cfg.DatabaseURL))
	openapimcp.ParityCheck(t, humaAPI, mcpH)
}

func TestOpenAPIHidesInfrastructureRoutes(t *testing.T) {
	cfg := testConfig(t, nil)
	h := New(cfg, lazyPool(t, cfg.DatabaseURL))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/openapi.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("openapi.json = %d", rec.Code)
	}
	for _, hidden := range []string{"/healthz", "/auth/me"} {
		if strings.Contains(rec.Body.String(), hidden) {
			t.Errorf("openapi.json mentions %s", hidden)
		}
	}
}
