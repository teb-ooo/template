// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces the checkable part of DAT-1: every file in migrations/ (embed.go aside) is named NNNNN_snake_case.sql with a
// five-digit number, the numbers run 00001, 00002, ... strictly increasing with no gap and no duplicate, and each file
// contains a `-- +goose Up` line and a later `-- +goose Down` line. That each migration holds one concern is a judgement
// the test cannot make: keep one concern per file yourself.
//
// To fix a failure: rename the file to the next free number (`ls migrations`), name it for what it does
// (`00003_add_mood.sql`), start it with `-- +goose Up` and write the undo under `-- +goose Down`. Never renumber or edit a
// migration that was already promoted; add a new one.
package api

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const migrationsDoc = "see docs/data-and-secrets.md and docs/go-api.md"

var (
	migrationName = regexp.MustCompile(`^([0-9]{5})_[a-z0-9_]+\.sql$`)
	gooseUp       = regexp.MustCompile(`(?m)^--\s*\+goose\s+Up\b`)
	gooseDown     = regexp.MustCompile(`(?m)^--\s*\+goose\s+Down\b`)
)

// findMigrationProblems checks the migrations directory of a module root.
func findMigrationProblems(root string) []string {
	dir := filepath.Join(root, "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{fmt.Sprintf("migrations/: cannot read the migrations directory (%v); schema changes are goose migrations in migrations/, one numbered file each; %s", err, migrationsDoc)}
	}
	var out []string
	type numbered struct {
		n    int
		name string
	}
	var seq []numbered
	for _, e := range entries {
		name := e.Name()
		if name == "embed.go" {
			continue
		}
		if e.IsDir() || !migrationName.MatchString(name) {
			out = append(out, fmt.Sprintf("migrations/%s:1: rule DAT-1: the name must match NNNNN_snake_case.sql (five digits, lower-case words, for example 00003_add_mood.sql). To fix: rename it (or remove it if it is not a migration); %s", name, migrationsDoc))
			continue
		}
		n, _ := strconv.Atoi(migrationName.FindStringSubmatch(name)[1])
		seq = append(seq, numbered{n, name})
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			out = append(out, fmt.Sprintf("migrations/%s:1: cannot read: %v", name, err))
			continue
		}
		up, down := gooseUp.FindIndex(body), gooseDown.FindIndex(body)
		switch {
		case up == nil:
			out = append(out, fmt.Sprintf("migrations/%s:1: rule DAT-1: no `-- +goose Up` line. To fix: start the file with `-- +goose Up` and put the schema change under it; %s", name, migrationsDoc))
		case down == nil:
			out = append(out, fmt.Sprintf("migrations/%s:1: rule DAT-1: no `-- +goose Down` line. To fix: add `-- +goose Down` after the Up section with the statements that undo it; %s", name, migrationsDoc))
		case down[0] < up[0]:
			out = append(out, fmt.Sprintf("migrations/%s:1: rule DAT-1: `-- +goose Down` comes before `-- +goose Up`. To fix: put the Up section first; %s", name, migrationsDoc))
		}
	}
	sort.Slice(seq, func(i, j int) bool {
		if seq[i].n != seq[j].n {
			return seq[i].n < seq[j].n
		}
		return seq[i].name < seq[j].name
	})
	want := 1
	for i, s := range seq {
		switch {
		case i > 0 && s.n == seq[i-1].n:
			out = append(out, fmt.Sprintf("migrations/%s:1: rule DAT-1: number %05d is used twice (also %s). To fix: give the newer migration the next free number; %s", s.name, s.n, seq[i-1].name, migrationsDoc))
		case s.n != want:
			out = append(out, fmt.Sprintf("migrations/%s:1: rule DAT-1: expected number %05d here, found %05d: numbers run 00001, 00002, ... without a gap. To fix: renumber it if it was never promoted, otherwise add the missing migration; %s", s.name, want, s.n, migrationsDoc))
			want = s.n + 1
		default:
			want++
		}
	}
	return out
}

func TestMigrationsAreNumberedGooseFiles(t *testing.T) {
	if v := findMigrationProblems(contractModuleRoot(t)); len(v) > 0 {
		t.Errorf("%d migration problem(s):\n%s", len(v), strings.Join(v, "\n"))
	}
}

func TestMigrationChecker(t *testing.T) {
	const good = "-- +goose Up\nCREATE TABLE a (id int);\n-- +goose Down\nDROP TABLE a;\n"
	run := func(files map[string]string) []string {
		dir := t.TempDir()
		for n, b := range files {
			writeFixture(t, dir, "migrations/"+n, b)
		}
		if len(files) == 0 {
			_ = os.MkdirAll(filepath.Join(dir, "migrations"), 0o755)
		}
		return findMigrationProblems(dir)
	}
	t.Run("accepts a numbered sequence, ignores embed.go", func(t *testing.T) {
		got := run(map[string]string{"00001_init.sql": good, "00002_add_mood.sql": good, "embed.go": "package migrations\n",
			"00003_x.sql": "-- +goose Up\n-- +goose StatementBegin\nSELECT 1;\n-- +goose StatementEnd\n-- +goose Down\nSELECT 1;\n"})
		if len(got) != 0 {
			t.Fatalf("unexpected: %v", got)
		}
	})
	t.Run("rejects a bad name", func(t *testing.T) {
		for _, n := range []string{"1_init.sql", "00001-init.sql", "00001_Init.sql", "00001_init.sql.bak", "README.md", "0001_init.sql"} {
			got := run(map[string]string{n: good})
			if len(got) == 0 || !strings.Contains(got[0], "migrations/"+n+":1: rule DAT-1: the name must match") || !strings.HasSuffix(got[0], "see docs/data-and-secrets.md and docs/go-api.md") {
				t.Errorf("%s: got %v", n, got)
			}
		}
	})
	t.Run("rejects a gap and a duplicate", func(t *testing.T) {
		got := run(map[string]string{"00001_a.sql": good, "00003_c.sql": good})
		if len(got) != 1 || !strings.Contains(got[0], "00003_c.sql:1") || !strings.Contains(got[0], "expected number 00002") {
			t.Errorf("gap: %v", got)
		}
		got = run(map[string]string{"00001_a.sql": good, "00002_b.sql": good, "00002_c.sql": good})
		if len(got) != 1 || !strings.Contains(got[0], "00002_c.sql") || !strings.Contains(got[0], "used twice") {
			t.Errorf("duplicate: %v", got)
		}
		if got = run(map[string]string{"00002_b.sql": good}); len(got) != 1 {
			t.Errorf("must start at 00001: %v", got)
		}
	})
	t.Run("rejects missing markers", func(t *testing.T) {
		got := run(map[string]string{"00001_a.sql": "CREATE TABLE a (id int);\n"})
		if len(got) != 1 || !strings.Contains(got[0], "no `-- +goose Up`") {
			t.Errorf("no up: %v", got)
		}
		got = run(map[string]string{"00001_a.sql": "-- +goose Up\nCREATE TABLE a (id int);\n"})
		if len(got) != 1 || !strings.Contains(got[0], "no `-- +goose Down`") {
			t.Errorf("no down: %v", got)
		}
		got = run(map[string]string{"00001_a.sql": "-- +goose Down\nX;\n-- +goose Up\nY;\n"})
		if len(got) != 1 || !strings.Contains(got[0], "comes before") {
			t.Errorf("order: %v", got)
		}
	})
	t.Run("a missing directory fails", func(t *testing.T) {
		if got := findMigrationProblems(t.TempDir()); len(got) != 1 {
			t.Errorf("got %v", got)
		}
	})
}
