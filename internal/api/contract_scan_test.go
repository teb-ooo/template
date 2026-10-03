// Shared scanner for the playground-owned source contract tests (listed in .playground-files; do not edit in an app):
// contract_imports_test.go (email and sign-in conventions), contract_sql_test.go (SQL convention), contract_errors_test.go (Huma error
// convention) and contract_migrations_test.go (migration convention).
//
// It parses Go files with go/parser. Test files (*_test.go), generated files (a "Code generated ... DO NOT EDIT."
// header), hidden, vendor, node_modules, testdata and web directories are never scanned. An escape is a marker comment
// `// playground:<name> <reason>` on the flagged line or the line above it; the reason is mandatory and a marker
// without one is itself a failure.
package api

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// scanFile is one parsed non-test, non-generated Go file.
type scanFile struct {
	rel  string // slash path relative to the scanned root, for messages
	dir  string // slash directory of rel
	fset *token.FileSet
	ast  *ast.File
}

var generatedHeader = regexp.MustCompile(`(?m)^// Code generated .* DO NOT EDIT\.$`)

// scanGoFiles parses every Go file under root that the contract tests look at.
func scanGoFiles(root string) ([]scanFile, error) {
	var out []scanFile
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if path != root && (strings.HasPrefix(name, ".") || name == "vendor" || name == "node_modules" || name == "testdata" || name == "web") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		head := string(src)
		if i := strings.Index(head, "\npackage "); i >= 0 {
			head = head[:i]
		}
		if generatedHeader.MatchString(head) {
			return nil
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, src, parser.ParseComments)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		out = append(out, scanFile{rel: rel, dir: filepath.ToSlash(filepath.Dir(rel)), fset: fset, ast: f})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].rel < out[j].rel })
	return out, err
}

// contractModuleRoot is the directory with go.mod, found from the test's working directory (the package directory).
func contractModuleRoot(t testing.TB) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d
		}
		if filepath.Dir(d) == d {
			t.Fatalf("no go.mod above %s", dir)
		}
	}
}

func (f scanFile) line(p token.Pos) int { return f.fset.Position(p).Line }

// importPaths maps each import's path to its line.
func (f scanFile) imports() map[string]int {
	m := map[string]int{}
	for _, im := range f.ast.Imports {
		p, err := strconv.Unquote(im.Path.Value)
		if err == nil {
			m[p] = f.line(im.Pos())
		}
	}
	return m
}

// localName is the identifier under which the file imports the package with this path ("" when it does not).
func (f scanFile) localName(path string) string {
	for _, im := range f.ast.Imports {
		if p, _ := strconv.Unquote(im.Path.Value); p == path {
			if im.Name != nil {
				return im.Name.Name
			}
			base := filepath.Base(path)
			if strings.HasPrefix(base, "v") && len(base) <= 3 { // a /v2 suffix
				base = filepath.Base(filepath.Dir(path))
			}
			return base
		}
	}
	return ""
}

// escapes returns the reason of every `// playground:<name> <reason>` marker by line ("" is a marker without a reason).
func (f scanFile) escapes(name string) map[int]string {
	re := regexp.MustCompile(`playground:` + regexp.QuoteMeta(name) + `\b(.*)`)
	m := map[int]string{}
	for _, cg := range f.ast.Comments {
		for _, c := range cg.List {
			if sub := re.FindStringSubmatch(c.Text); sub != nil {
				m[f.line(c.Pos())] = strings.TrimSpace(strings.TrimSuffix(sub[1], "*/"))
			}
		}
	}
	return m
}

// escaped reports whether the finding at line is excused by a marker on the same or the previous line. When a marker is
// there but has no reason, it returns the message to report instead.
func escaped(marks map[int]string, name string, line int) (ok bool, problem string) {
	for _, l := range []int{line, line - 1} {
		if reason, found := marks[l]; found {
			if reason == "" {
				return false, fmt.Sprintf("the marker `// playground:%s` on line %d has no reason; write `// playground:%s <why this is needed>`", name, l, name)
			}
			return true, ""
		}
	}
	return false, ""
}

// writeFixture writes a file below dir for a fixture test.
func writeFixture(t testing.TB, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
