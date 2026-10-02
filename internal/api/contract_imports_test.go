// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces the import bans of three rules by parsing every non-test, non-generated .go file of the module (go/parser):
//   - email convention (docs/building-an-app.md, Email templates), email only through the playground-go `mail` package: no net/smtp and no mail provider SDK (resend, sendgrid,
//     mailgun, SES, postmark, gomail, go-mail, mailjet and similar). net/mail is allowed: it parses addresses and cannot send.
//   - sign-in convention (docs/login-for-apps.md, The pieces), no own passwords, passkeys or token signing: no bcrypt, argon2, scrypt or pbkdf2, no JWT, JOSE, PASETO,
//     WebAuthn or OAuth/OIDC client library. crypto/hmac and crypto/sha256 stay allowed (legitimate for webhooks and hashing).
//   - assistant convention (docs/platform-overview.md, The end-user assistant), the assistant is built on the playground-go `assistant` package at /assistant: no direct LLM SDK (Anthropic,
//     OpenAI, Gemini, Mistral, Cohere, langchaingo, ollama) in a file that does not also import playground-go/assistant, and no
//     registered route path containing "assistant" other than /assistant (and /api/assistant, which the package mounts).
//     Only the negative half is checkable: that an assistant IS built on the package is not.
//
// To fix a failure: send mail with playground-go/mail (Mailer.Send); sign in through the `id` app and the playground-go
// `auth` package; build the assistant with `assistant.New` from playground-go/assistant. There is no escape marker: ask the
// orchestrator to change the rule if you have a case the rule did not foresee.
package api

import (
	"fmt"
	"go/ast"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const (
	ruleEmail     = "email convention (docs/building-an-app.md, Email templates)"
	ruleSignIn    = "sign-in convention (docs/login-for-apps.md, The pieces)"
	ruleAssistant = "assistant convention (docs/platform-overview.md, The end-user assistant)"
)

const importsDoc = "see docs/go-api.md"

type importBan struct {
	rule string // email convention (docs/building-an-app.md, Email templates)
	re   *regexp.Regexp
	what string // what the rule says
	fix  string
}

func banRE(s string) *regexp.Regexp { return regexp.MustCompile(s) }

var importBans = []importBan{
	{ruleEmail, banRE(`^net/smtp$|^github\.com/jordan-wright/email$|^github\.com/aws/aws-sdk-go(-v2)?/service/ses(v2)?(/|$)|^github\.com/aws/aws-sdk-go/service/ses|(^|/)(resend|sendgrid|mailgun|postmark|mailjet|gomail|go-mail|go-simple-mail|sparkpost|mandrill|mailersend|brevo|sendinblue)([-_.]|/|$|v?\d)`),
		"apps send email only through the playground-go mail package", "send with playground-go/mail (mail.Mailer.Send; internal/mail holds the templates)"},
	{ruleSignIn, banRE(`^golang\.org/x/crypto/(bcrypt|argon2|scrypt|pbkdf2)(/|$)|argon2id|^github\.com/golang-jwt/|^github\.com/dgrijalva/jwt-go|^github\.com/form3tech-oss/jwt-go|^github\.com/lestrrat-go/jwx|(^|/)go-jose(/|\.|$)|^github\.com/square/go-jose|^gopkg\.in/square/go-jose|^github\.com/cristalhq/jwt|^github\.com/pascaldekloe/jwt|paseto|^github\.com/go-webauthn/|^github\.com/duo-labs/webauthn|^github\.com/fxamacker/webauthn|^golang\.org/x/oauth2(/|$)|^github\.com/coreos/go-oidc|^github\.com/markbates/goth|^github\.com/ory/fosite`),
		"apps do not build passwords, passkeys or token signing", "sign users in through the playground-go auth package and the `id` app (auth.Require, auth.RequireAdmin)"},
	{ruleAssistant, banRE(`^github\.com/anthropics/anthropic-sdk-go|^github\.com/liushuangls/go-anthropic|^github\.com/sashabaranov/go-openai|^github\.com/openai/openai-go|^github\.com/google/generative-ai-go|^google\.golang\.org/genai|^github\.com/tmc/langchaingo|^github\.com/ollama/ollama|^github\.com/cohere-ai/|^github\.com/mistralai/|^github\.com/gage-technologies/mistral-go|^github\.com/anush008/|^github\.com/pkoukk/tiktoken-go`),
		"an app's assistant is built on the playground-go assistant package, not on an LLM SDK", "build the assistant with assistant.New from playground-go/assistant (the template's assistant overlay does it)"},
}

var assistantPkg = regexp.MustCompile(`(^|/)playground-go/assistant(/|$)`)

// allowedAssistantRoute: the web page and the API mount of the package.
var allowedAssistantRoute = regexp.MustCompile(`^/(api/)?assistant(/.*)?$`)

func isAssistantPath(p string) bool { return strings.Contains(strings.ToLower(p), "assistant") }

// routePaths returns the string-literal route paths a file registers: mux.Handle/HandleFunc first argument (an optional
// "METHOD " prefix is dropped), huma.Get/Post/... path argument, and the Path field of a huma.Operation literal.
func routePaths(f scanFile) map[string]int {
	out := map[string]int{}
	add := func(e ast.Expr) {
		if bl, ok := e.(*ast.BasicLit); ok {
			if s, err := strconv.Unquote(bl.Value); err == nil {
				if i := strings.Index(s, " "); i > 0 && !strings.Contains(s[:i], "/") {
					s = strings.TrimSpace(s[i:])
				}
				out[s] = f.line(bl.Pos())
			}
		}
	}
	ast.Inspect(f.ast, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			sel, ok := x.Fun.(*ast.SelectorExpr)
			if !ok {
				if ix, ok2 := x.Fun.(*ast.IndexListExpr); ok2 { // huma.Register[I, O](...)
					sel, _ = ix.X.(*ast.SelectorExpr)
				}
			}
			if sel == nil {
				return true
			}
			switch sel.Sel.Name {
			case "Handle", "HandleFunc":
				if len(x.Args) >= 1 {
					add(x.Args[0])
				}
			case "Get", "Post", "Put", "Patch", "Delete", "Head", "Options":
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == f.localName("github.com/danielgtaylor/huma/v2") && len(x.Args) >= 2 {
					add(x.Args[1])
				}
			}
		case *ast.KeyValueExpr:
			if id, ok := x.Key.(*ast.Ident); ok && id.Name == "Path" {
				add(x.Value)
			}
		}
		return true
	})
	return out
}

// findImportViolations returns one message per banned import or assistant route.
func findImportViolations(files []scanFile) []string {
	var out []string
	for _, f := range files {
		imports := f.imports()
		_, hasAssistant := func() (int, bool) {
			for p, l := range imports {
				if assistantPkg.MatchString(p) {
					return l, true
				}
			}
			return 0, false
		}()
		paths := make([]string, 0, len(imports))
		for p := range imports {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		for _, p := range paths {
			for _, b := range importBans {
				if !b.re.MatchString(p) {
					continue
				}
				if b.rule == ruleAssistant && hasAssistant {
					continue
				}
				extra := ""
				if b.rule == ruleAssistant {
					extra = " (a file that also imports playground-go/assistant is not flagged)"
				}
				out = append(out, fmt.Sprintf("%s:%d: %s: %s, and this file imports %q%s. To fix: %s; %s",
					f.rel, imports[p], b.rule, b.what, p, extra, b.fix, importsDoc))
			}
		}
		routes := routePaths(f)
		rs := make([]string, 0, len(routes))
		for p := range routes {
			rs = append(rs, p)
		}
		sort.Strings(rs)
		for _, p := range rs {
			if isAssistantPath(p) && !allowedAssistantRoute.MatchString(p) {
				out = append(out, fmt.Sprintf("%s:%d: "+ruleAssistant+": the assistant lives at /assistant (its API under /api/assistant), and this file registers the route %q. To fix: drop the route and mount the playground-go assistant package instead (assistant.New); %s",
					f.rel, routes[p], p, importsDoc))
			}
		}
	}
	return out
}

func TestSourceImportBans(t *testing.T) {
	files, err := scanGoFiles(contractModuleRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	if v := findImportViolations(files); len(v) > 0 {
		t.Errorf("%d banned import(s) or route(s):\n%s", len(v), strings.Join(v, "\n"))
	}
}

func TestSourceImportBansFixtures(t *testing.T) {
	check := func(name, src string) []string {
		t.Helper()
		dir := t.TempDir()
		writeFixture(t, dir, "internal/api/x.go", src)
		files, err := scanGoFiles(dir)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return findImportViolations(files)
	}
	imp := func(paths ...string) string {
		s := "package api\nimport (\n"
		for _, p := range paths {
			s += "\t_ \"" + p + "\"\n"
		}
		return s + ")\n"
	}
	t.Run("accepts", func(t *testing.T) {
		got := check("ok", imp("crypto/hmac", "crypto/sha256", "net/mail", "net/http", "github.com/teb-ooo/playground-go/mail",
			"github.com/teb-ooo/playground-go/auth", "github.com/teb-ooo/playground-go/assistant", "github.com/jackc/pgx/v5"))
		if len(got) != 0 {
			t.Fatalf("unexpected: %v", got)
		}
	})
	t.Run("rejects mail", func(t *testing.T) {
		for _, p := range []string{"net/smtp", "github.com/resend/resend-go/v2", "github.com/sendgrid/sendgrid-go", "github.com/mailgun/mailgun-go/v4",
			"github.com/aws/aws-sdk-go-v2/service/sesv2", "github.com/keighl/postmark", "gopkg.in/gomail.v2", "github.com/wneessen/go-mail", "github.com/mailjet/mailjet-apiv3-go/v4"} {
			got := check(p, imp(p))
			if len(got) != 1 || !strings.Contains(got[0], "email convention") || !strings.Contains(got[0], "internal/api/x.go:3") || !strings.HasSuffix(got[0], "see docs/go-api.md") {
				t.Errorf("%s: got %v", p, got)
			}
		}
	})
	t.Run("rejects own auth", func(t *testing.T) {
		for _, p := range []string{"golang.org/x/crypto/bcrypt", "golang.org/x/crypto/argon2", "golang.org/x/crypto/scrypt", "github.com/golang-jwt/jwt/v5",
			"github.com/go-webauthn/webauthn/webauthn", "github.com/go-jose/go-jose/v4", "github.com/lestrrat-go/jwx/v2", "golang.org/x/oauth2"} {
			got := check(p, imp(p))
			if len(got) != 1 || !strings.Contains(got[0], "sign-in convention") || !strings.HasSuffix(got[0], "see docs/go-api.md") {
				t.Errorf("%s: got %v", p, got)
			}
		}
	})
	t.Run("rejects an LLM SDK unless the file imports the assistant package", func(t *testing.T) {
		for _, p := range []string{"github.com/anthropics/anthropic-sdk-go", "github.com/anthropics/anthropic-sdk-go/option", "github.com/openai/openai-go", "github.com/sashabaranov/go-openai"} {
			got := check(p, imp(p))
			if len(got) != 1 || !strings.Contains(got[0], "assistant convention") {
				t.Errorf("%s: got %v", p, got)
			}
		}
		if got := check("both", imp("github.com/anthropics/anthropic-sdk-go", "github.com/teb-ooo/playground-go/assistant")); len(got) != 0 {
			t.Errorf("a file that also imports the assistant package must pass: %v", got)
		}
	})
	t.Run("assistant routes", func(t *testing.T) {
		src := func(route string) string {
			return "package api\nimport \"net/http\"\nvar mux = http.NewServeMux()\nfunc init() {\n\tmux.Handle(\"" + route + "\", nil)\n}\n"
		}
		for _, ok := range []string{"/assistant", "/api/assistant/", "/", "/api/items", "GET /assistant"} {
			if got := check(ok, src(ok)); len(got) != 0 {
				t.Errorf("%s: unexpected %v", ok, got)
			}
		}
		for _, bad := range []string{"/api/v1/assistant", "/chat-assistant", "/api/assistants", "/Assistant-bot"} {
			got := check(bad, src(bad))
			if len(got) != 1 || !strings.Contains(got[0], "assistant convention") || !strings.Contains(got[0], "x.go:5") {
				t.Errorf("%s: got %v", bad, got)
			}
		}
		op := "package api\nimport \"github.com/danielgtaylor/huma/v2\"\nvar _ = huma.Operation{Path: \"/api/ai-assistant\"}\n"
		if got := check("op", op); len(got) != 1 {
			t.Errorf("huma.Operation Path: got %v", got)
		}
	})
	t.Run("ignores test and generated files", func(t *testing.T) {
		dir := t.TempDir()
		writeFixture(t, dir, "internal/api/x_test.go", imp("net/smtp"))
		writeFixture(t, dir, "internal/db/gen.go", "// Code generated by sqlc. DO NOT EDIT.\n\n"+imp("net/smtp"))
		files, err := scanGoFiles(dir)
		if err != nil {
			t.Fatal(err)
		}
		if got := findImportViolations(files); len(got) != 0 {
			t.Fatalf("unexpected: %v", got)
		}
	})
}
