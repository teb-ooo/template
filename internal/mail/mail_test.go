package mail

import (
	"context"
	"strings"
	"testing"

	pgmail "github.com/teb-ooo/playground-go/mail"
)

type fake struct{ got []pgmail.Message }

func (f *fake) Send(_ context.Context, m pgmail.Message) error { f.got = append(f.got, m); return nil }

func TestInviteWithCode(t *testing.T) {
	d := Invite{Heading: "You are invited", Intro: "Ada added you.", Code: "123-456", ActionLabel: "Set up your passkey", ActionURL: "https://x.teb.ooo/i?a=1&b=2"}
	text, html, err := RenderInvite(d)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"You are invited", "code: 123-456", "Set up your passkey: https://x.teb.ooo/i?a=1&b=2"} {
		if !strings.Contains(text, w) {
			t.Errorf("text lacks %q: %q", w, text)
		}
	}
	if strings.Contains(text, "<") {
		t.Errorf("text has markup: %q", text)
	}
	for _, w := range []string{"<!doctype html>", "monospace", "123-456", `href="https://x.teb.ooo/i?a=1&amp;b=2"`} {
		if !strings.Contains(html, w) {
			t.Errorf("html lacks %q", w)
		}
	}
	if n := strings.Count(html, "<a "); n != 1 {
		t.Errorf("want exactly one action button, got %d", n)
	}
	for _, banned := range []string{"<table", "<footer", "<img", "box-shadow", "border:"} {
		if strings.Contains(html, banned) {
			t.Errorf("html must stay minimal, found %q", banned)
		}
	}
}

func TestInviteWithoutCodeAndEscaping(t *testing.T) {
	text, html, err := RenderInvite(Invite{Heading: "Hi <Ada>", Intro: "x", ActionLabel: "Go", ActionURL: "https://a.b/c"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "code:") || strings.Contains(html, "code:") {
		t.Error("no code line expected")
	}
	if strings.Contains(html, "<Ada>") {
		t.Error("html not escaped")
	}
}

func TestSendInvite(t *testing.T) {
	f := &fake{}
	if err := SendInvite(context.Background(), f, "ada@teb.ooo", "You are invited", Invite{Heading: "h", Intro: "i", ActionLabel: "Go", ActionURL: "https://a.b"}); err != nil {
		t.Fatal(err)
	}
	m := f.got[0]
	if m.Subject != "You are invited" || m.To[0] != "ada@teb.ooo" || m.Text == "" || m.HTML == "" {
		t.Errorf("sent %+v", m)
	}
	if err := SendInvite(context.Background(), f, "a@b.c", "s", Invite{}); err == nil {
		t.Error("expected error for missing action")
	}
}
