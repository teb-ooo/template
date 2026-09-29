// Package web embeds the built SPA (web/dist, produced by `npm run build`) into the Go binary.
package web

import "embed"

// Dist holds the Vite build output. dist/.gitkeep is committed so this compiles on a fresh clone.
//
//go:embed all:dist
var Dist embed.FS
