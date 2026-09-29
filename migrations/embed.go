// Package migrations embeds the goose migrations; the server applies them at start.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
