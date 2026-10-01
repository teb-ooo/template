// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces REL-3: routes that depend on playd, the registry or other platform services MUST degrade to a clear
// unavailable state. The gate candidate has no platform credentials, so this test starts the API with none
// (testConfig sets no PLAYD_URL, PLAYD_TOKEN, PLAYD_ASSERTION_KEY or STAGING_GATE_TOKEN) and with the throwaway
// migrated database, then GETs every operation of the OpenAPI document that has no path parameter and no required
// query parameter, once as a signed-in member and once as an administrator. No response may be a 5xx, with one
// exception: 503 with content type application/problem+json (huma.Error503ServiceUnavailable) is the clear
// unavailable state. A panic fails the test. An operation that answers text/event-stream (a stream never ends) is
// requested over a real connection: the test reads its first line, checks the status and closes it.
// To fix a failure: check for the missing client, URL or token before using it and return
// huma.Error503ServiceUnavailable("<service> is not configured") instead of an internal error; never panic on config.
// The database comes from requireTestDB (contract_db_test.go): bin/playground-app test provides it and fails, not skips, without it.
package api

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
	srv := httptest.NewServer(h) // for event streams only
	defer srv.Close()
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
				if contractIsEventStream(o) {
					contractFirstFrame(t, srv, req, rec)
					return
				}
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

// contractIsEventStream reports whether a successful response of the operation is text/event-stream.
func contractIsEventStream(o contractOp) bool {
	for code, r := range o.op.Responses {
		if _, ok := r.Content["text/event-stream"]; ok && strings.HasPrefix(code, "2") {
			return true
		}
	}
	return false
}

// contractFirstFrame sends req to the server, records the status and headers and the first line of the body in rec,
// and closes the connection: a stream has no end to wait for.
func contractFirstFrame(t *testing.T, srv *httptest.Server, req *http.Request, rec *httptest.ResponseRecorder) {
	t.Helper()
	ctx, cancel := context.WithTimeout(req.Context(), 10*time.Second)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, req.Method, srv.URL+req.URL.RequestURI(), nil)
	if err != nil {
		t.Fatal(err)
	}
	out.Header = req.Header.Clone()
	resp, err := srv.Client().Do(out)
	if err != nil {
		t.Errorf("%s: %v (an event stream must send headers and a first line at once)", req.URL.Path, err)
		rec.WriteHeader(http.StatusGatewayTimeout)
		return
	}
	defer resp.Body.Close()
	for k, v := range resp.Header {
		rec.Header()[k] = v
	}
	rec.WriteHeader(resp.StatusCode)
	if resp.StatusCode/100 == 2 {
		if _, err := bufio.NewReader(resp.Body).ReadString('\n'); err != nil {
			t.Errorf("%s: no first line from the event stream: %v", req.URL.Path, err)
		}
	}
}
