package api

import (
	"os"
	"strings"
	"testing"
)

// The top handler mounts surface.Middleware outermost, so a browser request reads as surface.UI and an API call as surface.API
// (playground-go surface package). Without it every request reads as API and a rule written as `!= surface.UI` misfires.
func TestTopHandlerMountsSurfaceMiddleware(t *testing.T) {
	b, err := os.ReadFile("api.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "surface.Middleware(") {
		t.Fatal("api.go must wrap the top handler with surface.Middleware, outside auth: return surface.Middleware(playgroundlog.Middleware(authn.Middleware(mux)))")
	}
}
