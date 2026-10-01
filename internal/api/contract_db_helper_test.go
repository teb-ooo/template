// Contract test of the helper in contract_db_test.go, playground-owned (listed in .playground-files).
package api

import (
	"strings"
	"testing"
)

// fakeT records what requireTestDB did instead of stopping the goroutine like testing.T.
type fakeT struct {
	testing.TB
	failed, skipped bool
	msg             string
}

func (f *fakeT) Helper() {}
func (f *fakeT) Fatal(a ...any) {
	f.failed = true
	f.msg = a[0].(string)
	panic(f)
}
func (f *fakeT) Skip(a ...any) {
	f.skipped = true
	f.msg = a[0].(string)
	panic(f)
}

func runRequire(t *testing.T, env map[string]string) (f *fakeT, url string) {
	for _, k := range []string{"PLAYGROUND_TEST_DATABASE_URL", "PLAYGROUND_REQUIRE_DB", "CI"} {
		t.Setenv(k, env[k])
	}
	f = &fakeT{TB: t}
	defer func() {
		if r := recover(); r != nil && r != f {
			panic(r)
		}
	}()
	url = requireTestDB(f)
	return
}

func TestContractRequireTestDB(t *testing.T) {
	if f, url := runRequire(t, map[string]string{"PLAYGROUND_TEST_DATABASE_URL": "postgres://x"}); f.failed || f.skipped || url != "postgres://x" {
		t.Errorf("with the URL set: failed=%v skipped=%v url=%q", f.failed, f.skipped, url)
	}
	for _, env := range []map[string]string{{"PLAYGROUND_REQUIRE_DB": "1"}, {"CI": "1"}} {
		f, _ := runRequire(t, env)
		if !f.failed || f.skipped || !strings.Contains(f.msg, "the contract tests need a database: PLAYGROUND_TEST_DATABASE_URL is not set; run bin/playground-app test") {
			t.Errorf("env %v: failed=%v skipped=%v msg=%q", env, f.failed, f.skipped, f.msg)
		}
	}
	if f, _ := runRequire(t, nil); f.failed || !f.skipped || !strings.Contains(f.msg, "did NOT run") {
		t.Errorf("without the variable or REQUIRE_DB: failed=%v skipped=%v msg=%q", f.failed, f.skipped, f.msg)
	}
}
