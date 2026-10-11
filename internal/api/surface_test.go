package api

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The top handler mounts surface.Middleware outermost, so a browser request reads as surface.UI and an API call as surface.API
// (playground-go surface package). Without it every request reads as API and a rule written as `!= surface.UI` misfires.
// The call may live in any non-test Go file under internal/ or cmd/ (the app may split api.go or build its handler in main).
func TestTopHandlerMountsSurfaceMiddleware(t *testing.T) {
	for _, root := range []string{"../../internal", "../../cmd"} {
		found := false
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			if b, err := os.ReadFile(path); err == nil && strings.Contains(string(b), "surface.Middleware(") {
				found = true
			}
			return nil
		})
		if found {
			return
		}
	}
	t.Fatal("no non-test Go file calls surface.Middleware: wrap the top handler with it, outside auth: return surface.Middleware(playgroundlog.Middleware(authn.Middleware(mux)))")
}
