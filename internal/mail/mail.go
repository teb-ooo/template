// Package mail holds this app's own email templates and renders them. The
// playground-go mail package is transport only (Mailer.Send); the look of every
// email is decided here, in this repository.
//
// House style (the owner's preference): invitation-style email is plain
// monospaced text with at most a code and a single action button, and no boxes,
// cards, wordmark or footer. Always send both bodies; the text one is the
// source of truth.
package mail

import (
	"bytes"
	"context"
	"embed"
	"fmt"
	htmltemplate "html/template"
	texttemplate "text/template"

	pgmail "github.com/teb-ooo/playground-go/mail"
)

//go:embed invite.tmpl.txt invite.tmpl.html
var files embed.FS

// Invite is the data of the invitation or signup email.
type Invite struct {
	Heading     string // first line, also the HTML title
	Intro       string // one short sentence
	Code        string // optional one-time code; empty for none
	ActionLabel string // the single button, for example "Set up your passkey"
	ActionURL   string
}

// Sender is what Mailer.Send satisfies; the app depends on this, not on the
// concrete mailer, so tests can fake it.
type Sender interface {
	Send(ctx context.Context, msg pgmail.Message) error
}

// RenderInvite renders both bodies of the invitation email.
func RenderInvite(d Invite) (text, html string, err error) {
	if d.ActionURL == "" || d.ActionLabel == "" {
		return "", "", fmt.Errorf("mail: invite needs ActionURL and ActionLabel")
	}
	tt, err := texttemplate.New("invite.tmpl.txt").Option("missingkey=error").ParseFS(files, "invite.tmpl.txt")
	if err != nil {
		return "", "", err
	}
	ht, err := htmltemplate.New("invite.tmpl.html").Option("missingkey=error").ParseFS(files, "invite.tmpl.html")
	if err != nil {
		return "", "", err
	}
	var tb, hb bytes.Buffer
	if err := tt.Execute(&tb, d); err != nil {
		return "", "", err
	}
	if err := ht.Execute(&hb, d); err != nil {
		return "", "", err
	}
	return tb.String(), hb.String(), nil
}

// SendInvite renders the invitation and sends it through the playground-go mailer.
func SendInvite(ctx context.Context, s Sender, to, subject string, d Invite) error {
	text, html, err := RenderInvite(d)
	if err != nil {
		return err
	}
	return s.Send(ctx, pgmail.Message{To: []string{to}, Subject: subject, Text: text, HTML: html})
}
