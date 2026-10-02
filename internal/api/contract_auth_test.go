// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces the auth convention (docs/go-api.md, Users and permissions). The test builds the API with the same constructor the server and TestParity use, reads
// its OpenAPI document and, for every operation:
//   - Security non-empty: a request with no cookie and no bearer token MUST answer 401 (the handler calls
//     auth.Require(ctx) first, before touching anything else);
//   - Security empty: the operation MUST carry the extension `x-public: true` (a deliberately public operation, for
//     example a webhook), otherwise it is reported as an operation that forgot its Security;
//   - extension `x-admin: true`: a signed-in user who is not an administrator MUST get 403 (call
//     auth.RequireAdmin(ctx) or check user.IsAdmin).
//
// To fix a failure: call auth.Require(ctx) (or auth.RequireAdmin(ctx)) as the first statement of the handler and
// declare Security on the operation. Markers go on huma.Operation: Extensions: map[string]any{"x-admin": true} or
// {"x-public": true}. Requests carry a body generated from the schema so validation (422) does not hide the check.
// No database is needed: the pool never connects because the handler stops at auth.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/teb-ooo/playground-go/auth"
	"github.com/teb-ooo/playground-go/testkit"

	playground "github.com/teb-ooo/playground-go"
)

// contractOp is one OpenAPI operation with what a request for it needs.
type contractOp struct {
	method, path string
	op           *huma.Operation
	api          huma.API
}

func (o contractOp) name() string { return o.method + " " + o.path + " (" + o.op.OperationID + ")" }
func (o contractOp) ext(key string) bool {
	v, _ := o.op.Extensions[key].(bool)
	return v
}

func contractOperations(api huma.API) []contractOp {
	var ops []contractOp
	for path, item := range api.OpenAPI().Paths {
		for method, op := range map[string]*huma.Operation{
			http.MethodGet: item.Get, http.MethodPost: item.Post, http.MethodPut: item.Put,
			http.MethodPatch: item.Patch, http.MethodDelete: item.Delete, http.MethodHead: item.Head,
		} {
			if op != nil {
				ops = append(ops, contractOp{method, path, op, api})
			}
		}
	}
	sort.Slice(ops, func(i, j int) bool { return ops[i].name() < ops[j].name() })
	return ops
}

// contractRequest builds a request for the operation: path parameters filled, required query parameters filled and a
// JSON body generated from the schema, so that validation passes and the handler (and its auth check) runs.
func contractRequest(o contractOp) *http.Request {
	path := o.path
	query := []string{}
	for _, p := range o.op.Parameters {
		v := contractValue(o.api, p.Schema, 0)
		// huma publishes uuid.UUID parameters as plain strings: recognise them by name or description.
		if d := strings.ToLower(p.Name + " " + p.Description); p.Schema != nil && p.Schema.Type == "string" &&
			(p.Name == "id" || strings.HasSuffix(strings.ToLower(p.Name), "id") || strings.Contains(d, "uuid")) {
			v = "01890a5d-ac96-774b-bcce-b302099a8057"
		}
		switch p.In {
		case "path":
			path = strings.ReplaceAll(path, "{"+p.Name+"}", fmt.Sprint(v))
		case "query":
			if p.Required {
				query = append(query, p.Name+"="+fmt.Sprint(v))
			}
		}
	}
	if len(query) > 0 {
		path += "?" + strings.Join(query, "&")
	}
	var body *strings.Reader
	if o.op.RequestBody != nil {
		if mt := o.op.RequestBody.Content["application/json"]; mt != nil {
			b, _ := json.Marshal(contractValue(o.api, mt.Schema, 0))
			body = strings.NewReader(string(b))
		}
	}
	if body == nil {
		body = strings.NewReader("")
	}
	req := httptest.NewRequest(o.method, path, body)
	if o.op.RequestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

// contractValue generates a minimal valid value for a schema.
func contractValue(api huma.API, s *huma.Schema, depth int) any {
	if s == nil || depth > 6 {
		return nil
	}
	if s.Ref != "" {
		name := s.Ref[strings.LastIndex(s.Ref, "/")+1:]
		return contractValue(api, api.OpenAPI().Components.Schemas.Map()[name], depth+1)
	}
	if len(s.Enum) > 0 {
		return s.Enum[0]
	}
	if len(s.OneOf) > 0 {
		return contractValue(api, s.OneOf[0], depth+1)
	}
	if len(s.AnyOf) > 0 {
		return contractValue(api, s.AnyOf[0], depth+1)
	}
	switch s.Type {
	case "string":
		switch s.Format {
		case "uuid":
			return "01890a5d-ac96-774b-bcce-b302099a8057"
		case "date-time":
			return "2026-01-01T00:00:00Z"
		case "date":
			return "2026-01-01"
		case "email":
			return "a@example.com"
		}
		if s.ContentEncoding == "base64" {
			return "AAAA"
		}
		n := 1
		if s.MinLength != nil && *s.MinLength > 1 {
			n = *s.MinLength
		}
		if s.Pattern != "" {
			if re, err := regexp.Compile(s.Pattern); err == nil {
				for _, c := range []string{"X", "x", "1", "X_1", "x-1", "a@example.com", "https://example.com"} {
					for _, v := range []string{strings.Repeat(c, n), c} {
						if re.MatchString(v) {
							return v
						}
					}
				}
			}
		}
		return strings.Repeat("x", n)
	case "integer":
		if s.Minimum != nil {
			return int(*s.Minimum)
		}
		return 1
	case "number":
		if s.Minimum != nil {
			return *s.Minimum
		}
		return 1.0
	case "boolean":
		return false
	case "array":
		return []any{}
	case "object", "":
		m := map[string]any{}
		for _, name := range s.Required {
			m[name] = contractValue(api, s.Properties[name], depth+1)
		}
		return m
	}
	return nil
}

// contractAPI builds the API like the server does; the pool never connects.
func contractAPI(t *testing.T, pool *pgxpool.Pool, cfg playground.Config) (http.Handler, huma.API) {
	t.Helper()
	h, humaAPI, _ := build(cfg, pool)
	return h, humaAPI
}

// contractEnv is a staging configuration with throwaway credentials and no platform variable (no PLAYD_*, no
// STAGING_GATE_TOKEN); it does not depend on the app's own test helpers.
func contractEnv(t testing.TB) playground.Config {
	t.Helper()
	env := map[string]string{
		"APP_NAME": "app", "APP_ENV": "staging", "PUBLIC_URL": "http://localhost:8080",
		"DATABASE_URL": "postgres://app@127.0.0.1:1/app", "OIDC_ISSUER": "http://127.0.0.1:1",
		"OIDC_CLIENT_ID": "test", "OIDC_CLIENT_SECRET": "test-not-a-secret",
		"SESSION_KEY":       strings.Repeat("ab", 32),
		"ANTHROPIC_API_KEY": "test-not-a-key", // builds the assistant overlay when present; never called
	}
	cfg, err := playground.FromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	cfg.Version = "test"
	return cfg
}

// contractLazyPool never connects: pgxpool connects on first use.
func contractLazyPool(t testing.TB, url string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestContractAuth(t *testing.T) {
	cfg := contractEnv(t)
	h, humaAPI := contractAPI(t, contractLazyPool(t, cfg.DatabaseURL), cfg)
	member, err := testkit.MintSession(cfg.SessionKey, auth.User{Subject: "contract-user", Email: "member@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	ops := contractOperations(humaAPI)
	if len(ops) == 0 {
		t.Fatalf("the OpenAPI document has no operations; %s", contractSeeDocs)
	}
	for _, o := range ops {
		secured := len(o.op.Security) > 0
		if !secured && !o.ext("x-public") {
			t.Errorf("auth convention (docs/go-api.md, Users and permissions): %s declares no Security and is not marked x-public; declare Security and call auth.Require first, or set Extensions x-public: true; %s", o.name(), contractSeeDocs)
		}
		if secured {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, contractRequest(o))
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("auth convention (docs/go-api.md, Users and permissions): %s answered %d without credentials, want 401: call auth.Require(ctx) first in the handler; %s", o.name(), rec.Code, contractSeeDocs)
			}
		}
		if o.ext("x-admin") {
			req := contractRequest(o)
			req.AddCookie(member)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Errorf("auth convention (docs/go-api.md, Users and permissions): %s (x-admin) answered %d to a signed-in non-admin, want 403: use auth.RequireAdmin(ctx); %s", o.name(), rec.Code, contractSeeDocs)
			}
		}
	}
}
