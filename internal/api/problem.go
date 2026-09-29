package api

import (
	"encoding/json"
	"net/http"
)

// writeProblem answers with an RFC 9457 problem body, for routes outside the Huma API.
func writeProblem(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"title": http.StatusText(status), "status": status, "detail": detail})
}
