// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces UI-yvn (server half): the app serves one live stream, GET /api/live, as a plain mux handler (live.Mount):
//   - it is not an OpenAPI operation, so the OpenAPI document, the MCP tools and the parity check never see it;
//   - signed out it answers 401 application/problem+json (never a redirect to the sign-in page);
//   - signed in it answers 200 text/event-stream and the first thing on the wire is the comment ": live", with
//     Cache-Control: no-store, so the browser counts the stream live at once.
//
// The test reads the first frame and closes the connection; it never waits for a change. No database is needed.
// To fix a failure: mount the hub in api.go (live.Mount(mux, d.Hub)); do not wrap it in a Huma operation and do not
// put it behind a middleware that redirects. A static app (no server data) is exempt in its brain/docs, not here.
package api

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/teb-ooo/playground-go/auth"
	"github.com/teb-ooo/playground-go/testkit"
)

func TestContractLiveStream(t *testing.T) {
	if contractLiveExempt != "" { // the app's own seam (contract_app_test.go) records why it has no live stream
		t.Logf("UI-yvn: this app is exempt from the live stream: %s", contractLiveExempt)
		return
	}
	cfg := contractEnv(t)
	h, humaAPI := contractAPI(t, contractLazyPool(t, cfg.DatabaseURL), cfg)
	for path := range humaAPI.OpenAPI().Paths {
		if strings.HasPrefix(path, "/api/live") {
			t.Errorf("UI-yvn %s is an OpenAPI operation; the stream is a plain mux handler (live.Mount), not an operation; %s", path, contractSeeDocs)
		}
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	// Signed out: 401 problem+json.
	resp, err := srv.Client().Get(srv.URL + "/api/live")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/problem+json") {
		t.Errorf("UI-yvn GET /api/live signed out answered %d %q, want 401 application/problem+json; %s", resp.StatusCode, resp.Header.Get("Content-Type"), contractSeeDocs)
	}

	// Signed in: 200 event stream, first frame ": live".
	cookie, err := testkit.MintSession(cfg.SessionKey, auth.User{Subject: "contract-user", Email: "member@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/live", nil)
	req.AddCookie(cookie)
	resp, err = srv.Client().Do(req)
	if err != nil {
		t.Fatalf("UI-yvn GET /api/live signed in: %v; %s", err, contractSeeDocs)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("UI-yvn GET /api/live signed in answered %d %q, want 200 text/event-stream; %s", resp.StatusCode, resp.Header.Get("Content-Type"), contractSeeDocs)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("UI-yvn GET /api/live Cache-Control = %q, want no-store; %s", cc, contractSeeDocs)
	}
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != ": live" {
		t.Errorf("UI-yvn the first line of /api/live is %q (err %v), want \": live\"; %s", line, err, contractSeeDocs)
	}
	cancel() // the stream never ends by itself: stop reading
}

// The smoke test's event-stream path: the helper must return after the first line of a stream that never ends.
func TestContractFirstFrameHelper(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(": live\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		contractFirstFrame(t, srv, httptest.NewRequest(http.MethodGet, "/api/anything", nil), rec)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("contractFirstFrame waited for the stream to end")
	}
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/event-stream") {
		t.Errorf("recorded %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}
