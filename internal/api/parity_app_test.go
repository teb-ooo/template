package api

import "github.com/teb-ooo/playground-go/openapimcp"

// App-owned seam for the platform-owned parity_test.go: the playground creates this file once and never overwrites it. Edit it freely.
var (
	// appTestEnv is extra environment for testConfig, for variables your app's configuration needs (a key for an integration the
	// app builds at start, for example). Never a real secret.
	appTestEnv = map[string]string{}
	// parityHidden lists extra routes that must NOT appear in openapi.json (operations you register with Hidden: true).
	parityHidden []string
	// parityOptions are options for openapimcp.ParityCheck (openapimcp.WithExempt, ...).
	parityOptions []openapimcp.ParityOption
)
