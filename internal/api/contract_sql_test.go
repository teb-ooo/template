// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces API-27: SQL lives in internal/db/queries/*.sql compiled by sqlc, with no SQL strings in handlers. The test
// parses every non-test, non-generated .go file of the module outside internal/db (go/parser) and fails on a string
// literal that is a SQL statement: it starts, after white space, with SELECT ... FROM, INSERT INTO, UPDATE ... SET,
// DELETE FROM, WITH x AS (, or CREATE/ALTER/DROP followed by TABLE, INDEX, VIEW, FUNCTION, TRIGGER, EXTENSION, TYPE,
// SCHEMA or SEQUENCE. The leading keyword must be all upper case or all lower case, so an English sentence such as
// "Select an item from the list" is not flagged. Struct tags, import paths and comments are not literals and never match.
//
// To fix a failure: move the statement to internal/db/queries/<resource>.sql as a named sqlc query (`-- name: ListItems :many`),
// run `sqlc generate` (internal/db) and call the generated method (d.Q.ListItems). If a literal only looks like SQL (for
// example documentation text or a prompt), put `// playground:allow-sql <reason>` on that line or the line above; the
// reason is mandatory.
package api

import (
	"fmt"
	"go/ast"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const sqlDoc = "see docs/go-api.md"

const sqlObj = `(table|index|view|function|trigger|extension|type|schema|sequence|materialized|unique|or\s+replace)`

// One alternative per statement form; the keyword is matched in its upper and lower case spelling only.
var sqlStatement = func() *regexp.Regexp {
	form := func(kw string, rest string) string {
		return `(?:` + strings.ToUpper(kw) + `|` + strings.ToLower(kw) + `)` + rest
	}
	ci := func(s string) string { return `(?i:` + s + `)` }
	parts := []string{
		form("select", `\s+`+`[^;]*?`+ci(`\bfrom\b`)+`\s+\S`),
		form("insert", `\s+`+ci(`into`)+`\s+\S`),
		form("update", `\s+\S+\s+`+ci(`set`)+`\s+\S`),
		form("delete", `\s+`+ci(`from`)+`\s+\S`),
		form("with", `\s+(?:recursive\s+)?\w+\s+`+ci(`as`)+`\s*\(`),
		form("create", `\s+`+ci(sqlObj)+`\b`),
		form("alter", `\s+`+ci(`(table|index|view|function|type|schema|sequence)`)+`\s+\S`),
		form("drop", `\s+`+ci(sqlObj)+`\b`),
	}
	return regexp.MustCompile(`^\s*(?:--[^\n]*\n\s*)*(?:` + strings.Join(parts, "|") + `)`)
}()

// looksLikeSQL reports whether the string value is a SQL statement.
func looksLikeSQL(s string) bool { return sqlStatement.MatchString(s) }

func inSQLPackage(dir string) bool {
	return dir == "internal/db" || strings.HasSuffix(dir, "/internal/db") || strings.Contains(dir, "/internal/db/") || strings.HasPrefix(dir, "internal/db/") ||
		dir == "migrations" || strings.HasSuffix(dir, "/migrations") || strings.HasPrefix(dir, "migrations/")
}

// findSQLLiterals returns one message per SQL-looking string literal outside internal/db and migrations.
func findSQLLiterals(files []scanFile) []string {
	var out []string
	for _, f := range files {
		if inSQLPackage(f.dir) {
			continue
		}
		marks := f.escapes("allow-sql")
		skip := map[*ast.BasicLit]bool{}
		ast.Inspect(f.ast, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.Field:
				if x.Tag != nil {
					skip[x.Tag] = true
				}
			case *ast.ImportSpec:
				skip[x.Path] = true
			}
			return true
		})
		ast.Inspect(f.ast, func(n ast.Node) bool {
			bl, ok := n.(*ast.BasicLit)
			if !ok || bl.Kind.String() != "STRING" || skip[bl] {
				return true
			}
			s, err := strconv.Unquote(bl.Value)
			if err != nil || !looksLikeSQL(s) {
				return true
			}
			line := f.line(bl.Pos())
			if ok, problem := escaped(marks, "allow-sql", line); ok {
				return true
			} else if problem != "" {
				out = append(out, fmt.Sprintf("%s:%d: rule API-27: %s; %s", f.rel, line, problem, sqlDoc))
				return true
			}
			snippet := strings.Join(strings.Fields(s), " ")
			if len(snippet) > 50 {
				snippet = snippet[:50] + "..."
			}
			out = append(out, fmt.Sprintf("%s:%d: rule API-27: this string literal is a SQL statement (%q); SQL belongs in internal/db/queries/*.sql compiled by sqlc, not in handlers. To fix: move it to a named query in internal/db/queries/, run `sqlc generate` and call the generated method; if it only looks like SQL, add `// playground:allow-sql <reason>` on that line or the line above; %s",
				f.rel, line, snippet, sqlDoc))
			return true
		})
	}
	return out
}

func TestNoSQLInGoCode(t *testing.T) {
	files, err := scanGoFiles(contractModuleRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	if v := findSQLLiterals(files); len(v) > 0 {
		t.Errorf("%d SQL literal(s) outside internal/db:\n%s", len(v), strings.Join(v, "\n"))
	}
}

func TestNoSQLInGoCodeFixtures(t *testing.T) {
	run := func(files map[string]string) []string {
		t.Helper()
		dir := t.TempDir()
		for rel, body := range files {
			writeFixture(t, dir, rel, body)
		}
		fs, err := scanGoFiles(dir)
		if err != nil {
			t.Fatal(err)
		}
		return findSQLLiterals(fs)
	}
	lit := func(s string) string { return "package api\nvar q = " + s + "\n" }
	t.Run("accepts", func(t *testing.T) {
		for _, s := range []string{
			`"Select an item from the list"`, `"Update your profile"`, `"delete the item"`, `"with care"`, "`drop it like it is hot`",
			`"created_at"`, `"select"`, `"Creating the table failed"`, `"insert coin"`, `"/api/items"`, `"Delete from the menu"`,
		} {
			if got := run(map[string]string{"internal/api/x.go": lit(s)}); len(got) != 0 {
				t.Errorf("%s flagged: %v", s, got)
			}
		}
		struct1 := "package api\ntype T struct {\n\tA string `json:\"select * from x\"`\n}\n"
		if got := run(map[string]string{"internal/api/x.go": struct1}); len(got) != 0 {
			t.Errorf("struct tag flagged: %v", got)
		}
	})
	t.Run("rejects with file and line", func(t *testing.T) {
		for _, s := range []string{
			`"SELECT id, name FROM items WHERE id = $1"`, "`\n\tSELECT *\n\tFROM items`", `"select count(*) from items"`, `"INSERT INTO items (id) VALUES ($1)"`,
			`"UPDATE items SET name = $1"`, `"DELETE FROM items"`, `"WITH x AS (SELECT 1) SELECT * FROM x"`, `"CREATE TABLE t (id int)"`,
			`"ALTER TABLE items ADD COLUMN x int"`, `"DROP TABLE items"`, `"-- name\nSELECT * FROM t"`,
		} {
			got := run(map[string]string{"internal/api/x.go": lit(s)})
			if len(got) != 1 || !strings.HasPrefix(got[0], "internal/api/x.go:2: rule API-27") || !strings.HasSuffix(got[0], "see docs/go-api.md") {
				t.Errorf("%s: got %v", s, got)
			}
		}
	})
	t.Run("ignores internal/db, migrations, tests and generated files", func(t *testing.T) {
		sql := lit(`"SELECT 1 FROM t"`)
		got := run(map[string]string{
			"internal/db/items.sql.go":   sql,
			"assistant/internal/db/x.go": sql,
			"migrations/embed.go":        sql,
			"internal/api/x_test.go":     sql,
			"internal/api/gen.go":        "// Code generated by x. DO NOT EDIT.\n\n" + sql,
		})
		if len(got) != 0 {
			t.Fatalf("unexpected: %v", got)
		}
	})
	t.Run("escape marker needs a reason", func(t *testing.T) {
		with := "package api\n// playground:allow-sql the prompt shows an example query\nvar q = \"SELECT a FROM b\"\n"
		same := "package api\nvar q = \"SELECT a FROM b\" // playground:allow-sql documentation text\n"
		without := "package api\n// playground:allow-sql\nvar q = \"SELECT a FROM b\"\n"
		if got := run(map[string]string{"a.go": with}); len(got) != 0 {
			t.Errorf("previous-line marker: %v", got)
		}
		if got := run(map[string]string{"a.go": same}); len(got) != 0 {
			t.Errorf("same-line marker: %v", got)
		}
		got := run(map[string]string{"a.go": without})
		if len(got) != 1 || !strings.Contains(got[0], "has no reason") || !strings.HasPrefix(got[0], "a.go:3:") {
			t.Errorf("no reason: %v", got)
		}
	})
}
