// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces WEB-18: web/src/api/openapi.json must be what `npm run gen:api` would write from the code now. The test
// builds the spec by running `go run ./cmd/server --print-openapi` (the very code path gen:api uses, so the bytes are
// identical; it needs no database or platform environment) and compares it with the committed file. On a difference it
// names the first differing path and operation. To fix a failure run `npm run gen:api` in web/ and commit
// web/src/api/openapi.json and web/src/api/schema.d.ts.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

const specFreshHint = "the generated file is stale: the API changed; run `npm run gen:api` and commit it; see docs/web-ui.md"

// specDiff returns "" when the two spec documents are byte-identical, otherwise a one-line summary of the first
// difference (a path, an operation, a component schema, another top-level key, or formatting only).
func specDiff(committed, built []byte) string {
	if bytes.Equal(committed, built) {
		return ""
	}
	var a, b map[string]any
	if err := json.Unmarshal(committed, &a); err != nil {
		return fmt.Sprintf("the committed file is not valid JSON (%v)", err)
	}
	if err := json.Unmarshal(built, &b); err != nil {
		return fmt.Sprintf("the built spec is not valid JSON (%v)", err)
	}
	pa, _ := a["paths"].(map[string]any)
	pb, _ := b["paths"].(map[string]any)
	for _, p := range unionKeys(pa, pb) {
		x, y := pa[p], pb[p]
		switch {
		case x == nil:
			return fmt.Sprintf("path %s exists in the code but not in the committed file", p)
		case y == nil:
			return fmt.Sprintf("path %s is in the committed file but no longer in the code", p)
		case !reflect.DeepEqual(x, y):
			xm, _ := x.(map[string]any)
			ym, _ := y.(map[string]any)
			for _, m := range unionKeys(xm, ym) {
				op := strings.ToUpper(m) + " " + p
				switch {
				case xm[m] == nil:
					return fmt.Sprintf("operation %s exists in the code but not in the committed file", op)
				case ym[m] == nil:
					return fmt.Sprintf("operation %s is in the committed file but no longer in the code", op)
				case !reflect.DeepEqual(xm[m], ym[m]):
					return fmt.Sprintf("operation %s differs", op)
				}
			}
		}
	}
	ca, _ := a["components"].(map[string]any)
	cb, _ := b["components"].(map[string]any)
	sa, _ := ca["schemas"].(map[string]any)
	sb, _ := cb["schemas"].(map[string]any)
	for _, n := range unionKeys(sa, sb) {
		if !reflect.DeepEqual(sa[n], sb[n]) {
			return fmt.Sprintf("component schema %s differs", n)
		}
	}
	for _, k := range unionKeys(a, b) {
		if !reflect.DeepEqual(a[k], b[k]) {
			return fmt.Sprintf("top-level key %q differs", k)
		}
	}
	return "the content is equal but the formatting differs"
}

func unionKeys(a, b map[string]any) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range []map[string]any{a, b} {
		for k := range m {
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	sort.Strings(out)
	return out
}

// specFreshProblem compares the committed spec file with the freshly built bytes; "" means fresh.
func specFreshProblem(specPath string, built []byte) string {
	committed, err := os.ReadFile(specPath)
	if err != nil {
		return fmt.Sprintf("%s cannot be read (%v): the file is missing; run `npm run gen:api` and commit it; see docs/web-ui.md", specPath, err)
	}
	if d := specDiff(committed, built); d != "" {
		return fmt.Sprintf("web/src/api/openapi.json: %s. %s", d, specFreshHint)
	}
	return ""
}

// builtSpec runs the server's --print-openapi code path from the module root.
// The spec title is the app name (APP_NAME, "app" when unset), which is environment, not API: it is taken from the
// committed file so that only a real API change fails the test.
func builtSpec(t *testing.T, root, specPath string) []byte {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		goBin = filepath.Join(runtime.GOROOT(), "bin", "go")
	}
	cmd := exec.Command(goBin, "run", "./cmd/server", "--print-openapi")
	cmd.Dir = root
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "APP_NAME=") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	if title := committedTitle(specPath); title != "" {
		cmd.Env = append(cmd.Env, "APP_NAME="+title)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go run ./cmd/server --print-openapi failed: %v\n%s\nsee docs/web-ui.md", err, stderr.String())
	}
	return out
}

// committedTitle is info.title of the committed spec, or "" when it cannot be read.
func committedTitle(specPath string) string {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		return ""
	}
	var doc struct {
		Info struct {
			Title string `json:"title"`
		} `json:"info"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	return doc.Info.Title
}

func TestOpenAPISpecFresh(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	specPath := filepath.Join(root, "web", "src", "api", "openapi.json")
	if _, err := os.Stat(specPath); err != nil {
		t.Fatal(specFreshProblem(specPath, nil))
	}
	if p := specFreshProblem(specPath, builtSpec(t, root, specPath)); p != "" {
		t.Fatal("WEB-18: " + p)
	}
}

func TestSpecFreshHelpers(t *testing.T) {
	base := `{"paths":{"/a":{"get":{"x":1},"post":{"x":2}},"/b":{"get":{}}},"components":{"schemas":{"S":{"t":1}}}}`
	cases := []struct{ name, committed, want string }{
		{"match", base, ""},
		{"operation changed", `{"paths":{"/a":{"get":{"x":9},"post":{"x":2}},"/b":{"get":{}}},"components":{"schemas":{"S":{"t":1}}}}`, "operation GET /a differs"},
		{"operation missing", `{"paths":{"/a":{"get":{"x":1}},"/b":{"get":{}}},"components":{"schemas":{"S":{"t":1}}}}`, "operation POST /a exists in the code"},
		{"path missing", `{"paths":{"/a":{"get":{"x":1},"post":{"x":2}}},"components":{"schemas":{"S":{"t":1}}}}`, "path /b exists in the code"},
		{"path stale", `{"paths":{"/a":{"get":{"x":1},"post":{"x":2}},"/b":{"get":{}},"/c":{}},"components":{"schemas":{"S":{"t":1}}}}`, "path /c is in the committed file"},
		{"schema changed", `{"paths":{"/a":{"get":{"x":1},"post":{"x":2}},"/b":{"get":{}}},"components":{"schemas":{"S":{"t":2}}}}`, "component schema S differs"},
		{"formatting", "{\n" + base[1:], "formatting differs"},
	}
	for _, c := range cases {
		got := specDiff([]byte(c.committed), []byte(base))
		if c.want == "" && got != "" || !strings.Contains(got, c.want) {
			t.Errorf("%s: got %q, want it to contain %q", c.name, got, c.want)
		}
	}
	dir := t.TempDir()
	missing := specFreshProblem(filepath.Join(dir, "nope.json"), []byte(base))
	if !strings.Contains(missing, "missing") || !strings.HasSuffix(missing, "see docs/web-ui.md") {
		t.Errorf("missing file message: %q", missing)
	}
	f := filepath.Join(dir, "openapi.json")
	if err := os.WriteFile(f, []byte(`{"paths":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := specFreshProblem(f, []byte(base))
	if !strings.Contains(stale, "npm run gen:api") || !strings.HasSuffix(stale, "see docs/web-ui.md") {
		t.Errorf("stale message: %q", stale)
	}
	if specFreshProblem(f, []byte(`{"paths":{}}`)) != "" {
		t.Error("identical bytes must be fresh")
	}
}
