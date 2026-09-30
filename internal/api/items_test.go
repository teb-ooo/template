package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/teb-ooo/playground-go/auth"
	"github.com/teb-ooo/playground-go/testkit"

	"app/migrations"
)

// testDatabase migrates a fresh schema of the throwaway database in PLAYGROUND_TEST_DATABASE_URL and returns a
// pool bound to it; the test is skipped when the variable is not set.
func testDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("PLAYGROUND_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PLAYGROUND_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	schema := "t_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	pcfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	pcfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	sqlDB := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = sqlDB.Close() })
	migrateForTest(t, sqlDB)
	return pool
}

func migrateForTest(t *testing.T, sqlDB *sql.DB) {
	t.Helper()
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestItems(t *testing.T) {
	pool := testDatabase(t)
	cfg := testConfig(t, nil)
	h := New(cfg, pool)
	cookie, err := testkit.MintSession(cfg.SessionKey, auth.User{Subject: "user-1", Email: "u@example.com"})
	if err != nil {
		t.Fatal(err)
	}

	do := func(method, path, body string, signedIn bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		if signedIn {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	var created Item
	t.Run("create", func(t *testing.T) {
		tests := []struct {
			name string
			body string
			auth bool
			want int
		}{
			{"anonymous", `{"name":"x"}`, false, http.StatusUnauthorized},
			{"missing name", `{}`, true, http.StatusUnprocessableEntity},
			{"empty name", `{"name":""}`, true, http.StatusUnprocessableEntity},
			{"name too long", fmt.Sprintf(`{"name":%q}`, strings.Repeat("a", 201)), true, http.StatusUnprocessableEntity},
			{"ok", `{"name":"first"}`, true, http.StatusCreated},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				w := do(http.MethodPost, "/api/items", tc.body, tc.auth)
				if w.Code != tc.want {
					t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body)
				}
				if tc.want == http.StatusCreated {
					if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	})

	t.Run("created item shape", func(t *testing.T) {
		if created.Name != "first" || created.ID.Version() != 7 {
			t.Fatalf("created = %+v", created)
		}
		if created.CreatedAt.Location() != time.UTC {
			t.Errorf("created_at is not UTC: %v", created.CreatedAt)
		}
	})

	t.Run("get", func(t *testing.T) {
		tests := []struct {
			name string
			path string
			auth bool
			want int
		}{
			{"anonymous", "/api/items/" + created.ID.String(), false, http.StatusUnauthorized},
			{"found", "/api/items/" + created.ID.String(), true, http.StatusOK},
			{"missing", "/api/items/" + uuid.NewString(), true, http.StatusNotFound},
			{"not a uuid", "/api/items/nope", true, http.StatusUnprocessableEntity},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				w := do(http.MethodGet, tc.path, "", tc.auth)
				if w.Code != tc.want {
					t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body)
				}
				if tc.want == http.StatusOK && !strings.Contains(w.Body.String(), `"name":"first"`) {
					t.Errorf("body = %s", w.Body)
				}
				if tc.want == http.StatusNotFound && w.Header().Get("Content-Type") != "application/problem+json" {
					t.Errorf("content type = %q", w.Header().Get("Content-Type"))
				}
			})
		}
	})

	t.Run("list newest first", func(t *testing.T) {
		if w := do(http.MethodGet, "/api/items", "", false); w.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous list = %d", w.Code)
		}
		if w := do(http.MethodPost, "/api/items", `{"name":"second"}`, true); w.Code != http.StatusCreated {
			t.Fatalf("create second = %d: %s", w.Code, w.Body)
		}
		w := do(http.MethodGet, "/api/items", "", true)
		if w.Code != http.StatusOK {
			t.Fatalf("list = %d: %s", w.Code, w.Body)
		}
		var got struct {
			Items []Item `json:"items"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Items) != 2 || got.Items[0].Name != "second" || got.Items[1].Name != "first" {
			t.Fatalf("items = %+v", got.Items)
		}
	})

	t.Run("mcp tool names match", func(t *testing.T) {
		_, humaAPI, _ := build(cfg, pool)
		ops := humaAPI.OpenAPI().Paths
		if ops["/api/items"] == nil || ops["/api/items/{id}"] == nil {
			t.Fatal("item paths missing from the OpenAPI document")
		}
	})
}
