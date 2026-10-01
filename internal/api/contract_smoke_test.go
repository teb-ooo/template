// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces REL-3: routes that depend on playd, the registry or other platform services MUST degrade to a clear
// unavailable state. The gate candidate has no platform credentials, so this test starts the API with none
// (testConfig sets no PLAYD_URL, PLAYD_TOKEN, PLAYD_ASSERTION_KEY or STAGING_GATE_TOKEN) and with the throwaway
// migrated database, then GETs every operation of the OpenAPI document that has no path parameter and no required
// query parameter, once as a signed-in member and once as an administrator. No response may be a 5xx, with one
// exception: 503 with content type application/problem+json (huma.Error503ServiceUnavailable) is the clear
// unavailable state. A panic fails the test.
// To fix a failure: check for the missing client, URL or token before using it and return
// huma.Error503ServiceUnavailable("<service> is not configured") instead of an internal error; never panic on config.
// The test is skipped without PLAYGROUND_TEST_DATABASE_URL.
package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/teb-ooo/playground-go/auth"
	"github.com/teb-ooo/playground-go/testkit"
)

func TestContractSmokeWithoutCredentials(t *testing.T) {
	pool := contractMigratedPool(t)
	cfg := contractEnv(t)
	for _, k := range []string{"PLAYD_TOKEN", "PLAYD_URL", "PLAYD_ASSERTION_KEY", "STAGING_GATE_TOKEN"} {
		t.Setenv(k, "") // the handlers may read the process environment directly
	}
	h, humaAPI := contractAPI(t, pool, cfg)
	users := map[string]auth.User{
		"member": {Subject: "contract-user", Email: "member@example.com"},
		"admin":  {Subject: "contract-admin", Email: "admin@example.com", Groups: []string{auth.AdminGroup}},
	}
	checked := 0
	for who, u := range users {
		cookie, err := testkit.MintSession(cfg.SessionKey, u)
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range contractOperations(humaAPI) {
			if o.method != http.MethodGet || strings.Contains(o.path, "{") || contractNeedsQuery(o) {
				continue
			}
			checked++
			req := contractRequest(o)
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Errorf("REL-3 %s as %s panicked without platform credentials: %v; %s", o.name(), who, r, contractSeeDocs)
					}
				}()
				h.ServeHTTP(rec, req)
			}()
			if rec.Code < 500 {
				continue
			}
			if rec.Code == http.StatusServiceUnavailable && strings.HasPrefix(rec.Header().Get("Content-Type"), "application/problem+json") {
				continue
			}
			t.Errorf("REL-3 %s as %s answered %d without platform credentials (%s), want a 4xx or a 503 application/problem+json: return huma.Error503ServiceUnavailable; %s",
				o.name(), who, rec.Code, rec.Header().Get("Content-Type"), contractSeeDocs)
		}
	}
	t.Logf("%d GET requests answered below 500 or 503 problem+json", checked)
}

func contractNeedsQuery(o contractOp) bool {
	for _, p := range o.op.Parameters {
		if p.In == "query" && p.Required {
			return true
		}
	}
	return false
}
