// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces the import bans of two rules by parsing every non-test, non-generated .go file of the module (go/parser):
//   - email convention (docs/building-an-app.md, Email templates), email only through the playground-go `mail` package: no net/smtp and no mail provider SDK (resend, sendgrid,
//     mailgun, SES, postmark, gomail, go-mail, mailjet and similar). net/mail is allowed: it parses addresses and cannot send.
//   - sign-in convention (docs/login-for-apps.md, The pieces), no own passwords, passkeys or token signing: no bcrypt, argon2, scrypt or pbkdf2, no JWT, JOSE, PASETO,
//     WebAuthn or OAuth/OIDC client library. crypto/hmac and crypto/sha256 stay allowed (legitimate for webhooks and hashing).
//
// To fix a failure: send mail with playground-go/mail (Mailer.Send); sign in through the `id` app and the playground-go
// `auth` package. There is no escape marker: ask the
// orchestrator to change the rule if you have a case the rule did not foresee.
package api

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const (
	ruleEmail  = "email convention (docs/building-an-app.md, Email templates)"
	ruleSignIn = "sign-in convention (docs/login-for-apps.md, The pieces)"
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
}

// findImportViolations returns one message per banned import.
func findImportViolations(files []scanFile) []string {
	var out []string
	for _, f := range files {
		imports := f.imports()
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
				out = append(out, fmt.Sprintf("%s:%d: %s: %s, and this file imports %q. To fix: %s; %s",
					f.rel, imports[p], b.rule, b.what, p, b.fix, importsDoc))
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
		t.Errorf("%d banned import(s):\n%s", len(v), strings.Join(v, "\n"))
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
			"github.com/teb-ooo/playground-go/auth", "github.com/jackc/pgx/v5"))
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
