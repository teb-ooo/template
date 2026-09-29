// Command mintsession prints a signed session cookie ("name=value") for a test admin, for the Playwright smoke
// test (factory-app smoke). It reads SESSION_KEY like the app does and refuses to run with APP_ENV=production
// (testkit.Guard). Not part of the production image: the Dockerfile builds ./cmd/server only.
package main

import (
	"fmt"
	"os"

	"github.com/teb-ooo/factory-go/auth"
	"github.com/teb-ooo/factory-go/testkit"
)

func main() {
	key, err := auth.ParseKey(os.Getenv("SESSION_KEY"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "mintsession: SESSION_KEY:", err)
		os.Exit(1)
	}
	c, err := testkit.MintSession(key, auth.User{Subject: "smoke-test", Email: "smoke@example.invalid", Username: "smoke", Groups: []string{"admin"}})
	if err != nil {
		fmt.Fprintln(os.Stderr, "mintsession:", err)
		os.Exit(1)
	}
	fmt.Println(testkit.CookieHeader(c))
}
