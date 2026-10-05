package api

// App-owned seam for the platform-owned contract tests: the playground creates this file once and never overwrites it. Edit it freely.

// contractLiveExempt is empty for an app that serves GET /api/live (UI-yvn, the contract_live_test.go checks it). An app with no
// live data (for example a static gallery whose data is generated at build time) sets the reason here, and says the same in its
// brain/docs/spec.md ("Live data"); the live-stream test then only logs the reason.
const contractLiveExempt = ""
