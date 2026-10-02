// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces the table conventions of docs/data-and-secrets.md (Migrations): it applies the app's goose migrations to a throwaway schema of the test
// database and inspects the real catalog. Every table (goose's own table excluded) must have
//   - a single-column primary key `id` of type uuid,
//   - `created_at` and `updated_at` as timestamptz NOT NULL DEFAULT now(),
//   - a BEFORE UPDATE row trigger whose function assigns updated_at (the template's set_updated_at()),
//   - snake_case table and column names, and no timestamp without time zone anywhere.
//
// To fix a failure add a NEW migration (never edit a promoted one): ALTER TABLE ... ADD COLUMN / ALTER COLUMN ... TYPE
// timestamptz, and CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION
// set_updated_at(); (create the function first with the body from the template's 00001_init.sql if the app lacks it).
// The database comes from requireTestDB (contract_db_test.go): bin/playground-app test provides it and fails, not skips, without it.
package api

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"app/migrations"
)

var contractSnakeCase = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`)

const contractSeeDocs = "see docs/go-api.md"

// contractMigratedPool migrates a fresh schema of the throwaway database and returns a pool bound to it.
func contractMigratedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := requireTestDB(t)
	ctx := context.Background()
	schema := "c_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestContractSchema(t *testing.T) {
	pool := contractMigratedPool(t)
	ctx := context.Background()

	rows, err := pool.Query(ctx, `
		SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
		       coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
		       EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary
		               AND i.indnatts = 1 AND i.indkey[0] = a.attnum)
		FROM pg_class c
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
		WHERE c.relkind IN ('r', 'p') AND c.relnamespace = current_schema()::regnamespace
		  AND c.relname <> 'goose_db_version'
		ORDER BY c.relname, a.attnum`)
	if err != nil {
		t.Fatal(err)
	}
	type col struct {
		typ, def string
		notNull  bool
		pk       bool
	}
	tables := map[string]map[string]col{}
	for rows.Next() {
		var table, name string
		var c col
		if err := rows.Scan(&table, &name, &c.typ, &c.notNull, &c.def, &c.pk); err != nil {
			t.Fatal(err)
		}
		if tables[table] == nil {
			tables[table] = map[string]col{}
		}
		tables[table][name] = c
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	trig := map[string]bool{} // tables with a BEFORE UPDATE row trigger that assigns updated_at
	trows, err := pool.Query(ctx, `
		SELECT c.relname FROM pg_trigger g
		JOIN pg_class c ON c.oid = g.tgrelid
		JOIN pg_proc p ON p.oid = g.tgfoid
		WHERE NOT g.tgisinternal AND c.relnamespace = current_schema()::regnamespace
		  AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 16) = 16
		  AND p.prosrc ~* 'new\.updated_at\s*:?='`)
	if err != nil {
		t.Fatal(err)
	}
	for trows.Next() {
		var name string
		if err := trows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		trig[name] = true
	}
	trows.Close()

	for table, cols := range tables {
		fail := func(format string, args ...any) {
			t.Errorf("table %s: %s; %s", table, fmt.Sprintf(format, args...), contractSeeDocs)
		}
		if !contractSnakeCase.MatchString(table) {
			fail("table convention: the name is not snake_case (docs/data-and-secrets.md, Migrations)")
		}
		for name, c := range cols {
			if !contractSnakeCase.MatchString(name) {
				fail("table convention: column %q is not snake_case (docs/data-and-secrets.md, Migrations)", name)
			}
			if strings.HasPrefix(c.typ, "timestamp") && c.typ != "timestamp with time zone" {
				fail("table convention: column %q is %s, want timestamptz (docs/data-and-secrets.md, Migrations)", name, c.typ)
			}
		}
		if id, ok := cols["id"]; !ok || id.typ != "uuid" || !id.pk {
			fail("table convention: needs id uuid as the primary key (found %+v) (docs/data-and-secrets.md, Migrations)", cols["id"])
		}
		for _, name := range []string{"created_at", "updated_at"} {
			c, ok := cols[name]
			switch {
			case !ok:
				fail("table convention: has no %s column (docs/data-and-secrets.md, Migrations)", name)
			case c.typ != "timestamp with time zone" || !c.notNull || c.def != "now()":
				fail("table convention: %s must be timestamptz NOT NULL DEFAULT now() (found %s, not null %v, default %q) (docs/data-and-secrets.md, Migrations)", name, c.typ, c.notNull, c.def)
			}
		}
		if _, ok := cols["updated_at"]; ok && !trig[table] {
			fail("table convention: has no BEFORE UPDATE row trigger that sets NEW.updated_at (use set_updated_at()) (docs/data-and-secrets.md, Migrations)")
		}
	}
	if len(tables) == 0 {
		t.Log("no tables in the app schema")
	}
}
