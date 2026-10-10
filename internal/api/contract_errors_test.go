// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces the checkable part of the Huma error convention (docs/go-api.md, Errors): a handler registered through Huma (huma.Register, huma.Get, huma.Post, ...)
// returns errors as `huma.Error*` problem+json and writes no other wire shape. The test parses every non-test, non-generated
// .go file under internal/ (go/parser), finds the handler of each Huma registration (a function literal, a function or a
// method named in the call, also inside a wrapper call) and fails on these calls inside it:
//   - http.Error(...)
//   - WriteHeader(...) or Write(...) on an http.ResponseWriter parameter, or on huma.Context's BodyWriter()
//   - json.NewEncoder(w) over such a writer.
//
// Routes outside Huma (mux.Handle) may use apierr.WriteProblem, which writes problem+json; they are not scanned. Only calls written
// directly in the handler are seen: a helper that the handler calls is not followed.
//
// To fix a failure: return the error from the handler, for example `return nil, huma.Error404NotFound("item not found")`
// or `huma.Error400BadRequest(...)`; Huma writes it as application/problem+json. When one route must answer another shape
// (a text/plain error of a proxy, a stream), put `// playground:allow-raw-response <reason>` on the flagged line, the line
// above it, or above the handler function (it then covers the whole function); the reason is mandatory.
package api

import (
	"fmt"
	"go/ast"
	"sort"
	"strings"
	"testing"
)

const errorsDoc = "see docs/go-api.md"

var humaRegistrars = map[string]bool{"Register": true, "Get": true, "Post": true, "Put": true, "Patch": true, "Delete": true, "Head": true, "Options": true}

// handlerRef is a registered handler: a literal, or a function or method name resolved in the same directory.
type handlerRef struct {
	lit  *ast.FuncLit
	name string
	line int
	file scanFile
}

// registeredHandlers returns the handlers a file registers through huma.
func registeredHandlers(f scanFile) []handlerRef {
	huma := f.localName("github.com/danielgtaylor/huma/v2")
	if huma == "" {
		return nil
	}
	var out []handlerRef
	var collect func(e ast.Expr)
	collect = func(e ast.Expr) {
		switch x := e.(type) {
		case *ast.FuncLit:
			out = append(out, handlerRef{lit: x, line: f.line(x.Pos()), file: f})
		case *ast.Ident:
			out = append(out, handlerRef{name: x.Name, line: f.line(x.Pos()), file: f})
		case *ast.SelectorExpr:
			out = append(out, handlerRef{name: x.Sel.Name, line: f.line(x.Pos()), file: f})
		case *ast.CallExpr: // a wrapper such as logged(h.list)
			for _, a := range x.Args {
				collect(a)
			}
		}
	}
	ast.Inspect(f.ast, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		fun := call.Fun
		switch ix := fun.(type) {
		case *ast.IndexExpr:
			fun = ix.X
		case *ast.IndexListExpr:
			fun = ix.X
		}
		sel, ok := fun.(*ast.SelectorExpr)
		if !ok || !humaRegistrars[sel.Sel.Name] {
			return true
		}
		if id, ok := sel.X.(*ast.Ident); !ok || id.Name != huma {
			return true
		}
		collect(call.Args[len(call.Args)-1])
		return true
	})
	return out
}

// writerNames are the parameters of a function that carry the response: an http.ResponseWriter or a huma.Context.
func writerNames(f scanFile, ft *ast.FuncType) (writers, humaCtx map[string]bool) {
	writers, humaCtx = map[string]bool{}, map[string]bool{}
	if ft.Params == nil {
		return
	}
	httpName, humaName := f.localName("net/http"), f.localName("github.com/danielgtaylor/huma/v2")
	for _, p := range ft.Params.List {
		sel, ok := p.Type.(*ast.SelectorExpr)
		if !ok {
			continue
		}
		pkg, _ := sel.X.(*ast.Ident)
		if pkg == nil {
			continue
		}
		for _, n := range p.Names {
			switch {
			case pkg.Name == httpName && sel.Sel.Name == "ResponseWriter":
				writers[n.Name] = true
			case pkg.Name == humaName && sel.Sel.Name == "Context":
				humaCtx[n.Name] = true
			}
		}
	}
	return
}

// rawWrites returns the line and form of every raw response write in a handler body.
func rawWrites(f scanFile, ft *ast.FuncType, body *ast.BlockStmt) (lines []int, forms []string) {
	if body == nil {
		return
	}
	writers, hctx := writerNames(f, ft)
	httpName := f.localName("net/http")
	jsonName := f.localName("encoding/json")
	isWriter := func(e ast.Expr) bool {
		switch x := e.(type) {
		case *ast.Ident:
			return writers[x.Name]
		case *ast.CallExpr: // ctx.BodyWriter()
			if s, ok := x.Fun.(*ast.SelectorExpr); ok && s.Sel.Name == "BodyWriter" {
				id, _ := s.X.(*ast.Ident)
				return id != nil && hctx[id.Name]
			}
		}
		return false
	}
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkg, _ := sel.X.(*ast.Ident)
		add := func(form string) {
			lines = append(lines, f.line(call.Pos()))
			forms = append(forms, form)
		}
		switch {
		case pkg != nil && httpName != "" && pkg.Name == httpName && sel.Sel.Name == "Error":
			add("http.Error(...)")
		case pkg != nil && jsonName != "" && pkg.Name == jsonName && sel.Sel.Name == "NewEncoder" && len(call.Args) == 1 && isWriter(call.Args[0]):
			add("json.NewEncoder(<response writer>)")
		case (sel.Sel.Name == "WriteHeader" || sel.Sel.Name == "Write") && isWriter(sel.X):
			add(sel.Sel.Name + "(...) on the response writer")
		}
		return true
	})
	return
}

// findRawResponses returns one message per raw response write inside a huma-registered handler.
func findRawResponses(files []scanFile) []string {
	byDir := map[string][]scanFile{}
	for _, f := range files {
		byDir[f.dir] = append(byDir[f.dir], f)
	}
	var out []string
	seen := map[string]bool{}
	report := func(f scanFile, fnLine int, handler string, ft *ast.FuncType, body *ast.BlockStmt, fnPos int) {
		marks := f.escapes("allow-raw-response")
		lines, forms := rawWrites(f, ft, body)
		for i, line := range lines {
			key := fmt.Sprintf("%s:%d:%s", f.rel, line, forms[i])
			if seen[key] {
				continue
			}
			seen[key] = true
			if ok, problem := escaped(marks, "allow-raw-response", line); ok {
				continue
			} else if problem != "" {
				out = append(out, fmt.Sprintf("%s:%d: Huma error convention (docs/go-api.md, Errors): %s; %s", f.rel, line, problem, errorsDoc))
				continue
			}
			if ok, problem := escaped(marks, "allow-raw-response", fnPos); ok { // above the function
				continue
			} else if problem != "" {
				out = append(out, fmt.Sprintf("%s:%d: Huma error convention (docs/go-api.md, Errors): %s; %s", f.rel, fnPos, problem, errorsDoc))
				continue
			}
			out = append(out, fmt.Sprintf("%s:%d: Huma error convention (docs/go-api.md, Errors): handler %s (registered with huma) writes a raw response with %s; handlers return huma.Error* problem+json errors and no other wire shape. To fix: return huma.Error404NotFound(...), huma.Error400BadRequest(...) or the matching huma.Error* from the handler; if this route must answer another shape, add `// playground:allow-raw-response <reason>` on that line, the line above, or above the function; %s",
				f.rel, line, handler, forms[i], errorsDoc))
		}
	}
	for _, f := range files {
		for _, h := range registeredHandlers(f) {
			if h.lit != nil {
				report(f, h.line, "(function literal)", h.lit.Type, h.lit.Body, f.line(h.lit.Pos()))
				continue
			}
			for _, g := range byDir[f.dir] {
				for _, d := range g.ast.Decls {
					fd, ok := d.(*ast.FuncDecl)
					if ok && fd.Name.Name == h.name {
						report(g, g.line(fd.Pos()), fmt.Sprintf("%q", h.name), fd.Type, fd.Body, g.line(fd.Pos()))
					}
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

func TestHandlersReturnHumaErrors(t *testing.T) {
	files, err := scanGoFiles(contractModuleRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	var internal []scanFile
	for _, f := range files {
		if strings.HasPrefix(f.rel, "internal/") {
			internal = append(internal, f)
		}
	}
	if v := findRawResponses(internal); len(v) > 0 {
		t.Errorf("%d raw response(s) in Huma handlers:\n%s", len(v), strings.Join(v, "\n"))
	}
}

func TestRawResponseChecker(t *testing.T) {
	const head = "package api\nimport (\n\t\"encoding/json\"\n\t\"net/http\"\n\t\"context\"\n\t\"github.com/danielgtaylor/huma/v2\"\n)\nvar _ = json.NewEncoder\nvar _ = context.Background\n"
	run := func(files map[string]string) []string {
		dir := t.TempDir()
		for rel, body := range files {
			writeFixture(t, dir, rel, body)
		}
		fs, err := scanGoFiles(dir)
		if err != nil {
			t.Fatal(err)
		}
		return findRawResponses(fs)
	}
	t.Run("accepts huma errors and apierr.WriteProblem on a plain mux route", func(t *testing.T) {
		src := head + `
func reg(api huma.API, mux *http.ServeMux) {
	huma.Register(api, huma.Operation{}, get)
	mux.HandleFunc("/x", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "x", 500); w.WriteHeader(200) })
}
func get(ctx context.Context, in *struct{}) (*struct{}, error) { return nil, huma.Error404NotFound("x") }
func notRegistered(w http.ResponseWriter) { http.Error(w, "x", 500) }
`
		if got := run(map[string]string{"internal/api/a.go": src}); len(got) != 0 {
			t.Fatalf("unexpected: %v", got)
		}
	})
	t.Run("rejects http.Error in a registered method, literal and wrapped handler", func(t *testing.T) {
		src := head + `
type h struct{}
func reg(api huma.API, x *h) {
	huma.Register(api, huma.Operation{}, x.list)
	huma.Post(api, "/p", func(ctx context.Context, in *struct{}) (*struct{}, error) {
		http.Error(nil, "x", 500)
		return nil, nil
	})
	huma.Register(api, huma.Operation{}, wrap(other))
}
func (x *h) list(ctx context.Context, in *struct{}) (*struct{}, error) {
	http.Error(nil, "bad", 400)
	return nil, nil
}
func other(ctx context.Context, in *struct{}) (*struct{}, error) {
	http.Error(nil, "bad", 400)
	return nil, nil
}
func wrap(f any) any { return f }
`
		got := run(map[string]string{"internal/api/a.go": src})
		if len(got) != 3 {
			t.Fatalf("got %d: %v", len(got), got)
		}
		for _, g := range got {
			if !strings.Contains(g, "Huma error convention") || !strings.Contains(g, "huma.Error") || !strings.HasSuffix(g, "see docs/go-api.md") || !strings.HasPrefix(g, "internal/api/a.go:") {
				t.Errorf("message: %s", g)
			}
		}
	})
	t.Run("rejects writes on a ResponseWriter or huma.Context body writer", func(t *testing.T) {
		src := head + `
func reg(api huma.API) {
	huma.Register(api, huma.Operation{}, func(w http.ResponseWriter) {
		w.WriteHeader(502)
		w.Write([]byte("bad"))
		json.NewEncoder(w).Encode(1)
	})
	huma.Register(api, huma.Operation{}, func(c huma.Context) {
		c.BodyWriter().Write([]byte("x"))
		json.NewEncoder(c.BodyWriter()).Encode(1)
	})
	huma.Register(api, huma.Operation{}, func(b *bytes) { b.Write(nil); b.WriteHeader(1) })
}
type bytes struct{}
func (*bytes) Write([]byte) {}
func (*bytes) WriteHeader(int) {}
`
		got := run(map[string]string{"internal/api/a.go": src})
		if len(got) != 5 {
			t.Fatalf("got %d (want 5; a non-writer Write is fine): %v", len(got), got)
		}
	})
	t.Run("escape marker: same line, previous line, above the function; reason mandatory", func(t *testing.T) {
		src := head + `
func reg(api huma.API) {
	huma.Register(api, huma.Operation{}, a)
	huma.Register(api, huma.Operation{}, b)
	huma.Register(api, huma.Operation{}, c)
	huma.Register(api, huma.Operation{}, d)
}
func a(ctx context.Context, in *struct{}) (*struct{}, error) {
	http.Error(nil, "x", 502) // playground:allow-raw-response proxy answers text/plain
	return nil, nil
}
func b(ctx context.Context, in *struct{}) (*struct{}, error) {
	// playground:allow-raw-response proxy answers text/plain
	http.Error(nil, "x", 502)
	return nil, nil
}
// playground:allow-raw-response whole handler streams text
func c(ctx context.Context, in *struct{}) (*struct{}, error) {
	http.Error(nil, "x", 502)
	http.Error(nil, "y", 502)
	return nil, nil
}
func d(ctx context.Context, in *struct{}) (*struct{}, error) {
	// playground:allow-raw-response
	http.Error(nil, "x", 502)
	return nil, nil
}
`
		got := run(map[string]string{"internal/api/a.go": src})
		if len(got) != 1 || !strings.Contains(got[0], "has no reason") {
			t.Fatalf("want exactly the no-reason failure: %v", got)
		}
	})
	t.Run("ignores test and generated files", func(t *testing.T) {
		bad := head + "func reg(api huma.API) { huma.Register(api, huma.Operation{}, func(c huma.Context) { http.Error(nil, \"x\", 1) }) }\n"
		got := run(map[string]string{"internal/api/a_test.go": bad, "internal/api/g.go": "// Code generated by x. DO NOT EDIT.\n\n" + bad})
		if len(got) != 0 {
			t.Fatalf("unexpected: %v", got)
		}
	})
}
