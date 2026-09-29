package api

import (
	"log/slog"
	"net/http"

	"github.com/teb-ooo/factory-go/assistant"
)

// Assistant overlay: mounts the end-user assistant at /api/assistant/ with conversations stored in the
// app's own database (migrations/00002_assistant.sql).
func init() {
	assistantEnabled = true
	mounts = append(mounts, mountAssistant)
}

func mountAssistant(d *Deps) {
	if !d.Cfg.AssistantEnabled() {
		mountAssistantOff(d, "the assistant is not configured")
		return
	}
	h, err := assistant.New(d.API, d.Mux, d.Cfg.AssistantOptions(assistant.NewPgxStore(d.Pool)))
	if err != nil {
		slog.Error("assistant disabled", "error", err)
		mountAssistantOff(d, "the assistant is unavailable")
		return
	}
	d.Mux.Handle("/api/assistant/", h)
}

// mountAssistantOff keeps the routes answering with a problem body instead of the web app's index page.
func mountAssistantOff(d *Deps, detail string) {
	d.Mux.HandleFunc("/api/assistant/", func(w http.ResponseWriter, _ *http.Request) {
		writeProblem(w, http.StatusServiceUnavailable, detail)
	})
}
