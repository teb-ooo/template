// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Every user action must be reachable from Cmd+K (rule UI-yze). `palette.Check` (playground-go, docs/go-api.md "Cmd+K commands
// from the API: x-palette") fails on a malformed `x-palette` tag, on an action tag on a GET or a source tag on a non-GET, on a
// prompted argument that the request body does not have, and on every operation that changes something and has neither a tag nor
// `palette.None("reason")`.
//
// To fix a failure: give the operation `Extensions: palette.Action{Title: "...", Group: "...", ...}.Ext()` (the command), or
// `palette.None("why this has no command")` when it deliberately has none (it needs several fields, a secret, a typed
// confirmation). The title is the same verb phrase as the button. Operations that are hidden from the OpenAPI document are not
// checked.
package api

import (
	"testing"

	"github.com/teb-ooo/playground-go/palette"
)

func TestPaletteCoversEveryAction(t *testing.T) {
	cfg := testConfig(t, nil)
	_, humaAPI, _ := build(cfg, lazyPool(t, cfg.DatabaseURL))
	palette.Check(t, humaAPI)
}
