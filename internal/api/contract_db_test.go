// Contract test helper, playground-owned (listed in .playground-files; do not edit in an app).
//
// requireTestDB is how every playground-owned test that needs the throwaway test database gets its URL. The
// database-backed contract tests (TestContractSchema (the table conventions), TestContractSmokeWithoutCredentials REL-3) must never
// pass silently without a database: bin/playground-app test (and restart, gate-check) provide
// PLAYGROUND_TEST_DATABASE_URL (the app's staging database; the tests only create and drop a throwaway c_<uuid>
// schema) and set PLAYGROUND_REQUIRE_DB=1. With PLAYGROUND_REQUIRE_DB=1 or CI=1 a missing URL FAILS the test; without
// either (a bare `go test`) the test skips and says it did NOT run.
package api

import (
	"os"
	"testing"
)

const contractDBMissing = "the contract tests need a database: PLAYGROUND_TEST_DATABASE_URL is not set; run bin/playground-app test, which provides it (see docs/go-api.md)"

// requireTestDB returns PLAYGROUND_TEST_DATABASE_URL, failing (PLAYGROUND_REQUIRE_DB=1 or CI=1) or skipping when unset.
func requireTestDB(t testing.TB) string {
	t.Helper()
	if url := os.Getenv("PLAYGROUND_TEST_DATABASE_URL"); url != "" {
		return url
	}
	if os.Getenv("PLAYGROUND_REQUIRE_DB") == "1" || os.Getenv("CI") == "1" {
		t.Fatal(contractDBMissing)
	}
	t.Skip("this test did NOT run: PLAYGROUND_TEST_DATABASE_URL is not set; run bin/playground-app test, which provides the database (see docs/go-api.md)")
	return ""
}
