// Contract test, playground-owned (listed in .playground-files; do not edit in an app).
//
// Enforces the README convention (docs/conventions.md, Repositories and commits) as far as a check can: the repository has a README.md that opens with a title, says what the app is,
// and names the command that runs its tests. That it is short and clear stays with the agent.
//
// To fix a failure: write README.md at the repository root: `# name`, then a few sentences saying what the app is and how to
// run its tests (`make test`). see docs/conventions.md
package api

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var testCommand = regexp.MustCompile("`[^`]*\\btest\\b[^`]*`")

// readmeProblems checks the README of a module root.
func readmeProblems(root string) []string {
	b, err := os.ReadFile(filepath.Join(root, "README.md"))
	if err != nil {
		return []string{"README.md is missing at the repository root"}
	}
	var lines []string
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, strings.TrimSpace(l))
		}
	}
	var out []string
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "# ") {
		out = append(out, "README.md must start with a `# title` line")
	}
	if len(lines) < 2 {
		out = append(out, "README.md must say what the app is")
	}
	if !testCommand.MatchString(string(b)) {
		out = append(out, "README.md must name the command that runs the tests, in backticks (for example `make test`)")
	}
	return out
}

func TestReadmeNamesTheAppAndItsTestCommand(t *testing.T) {
	if got := readmeProblems(contractModuleRoot(t)); len(got) > 0 {
		t.Fatalf("README convention (docs/conventions.md, Repositories and commits): %s (see docs/conventions.md)", strings.Join(got, "; "))
	}
}

func TestReadmeChecker(t *testing.T) {
	d := t.TempDir()
	if got := readmeProblems(d); len(got) != 1 {
		t.Fatalf("missing README: %v", got)
	}
	write := func(s string) { _ = os.WriteFile(filepath.Join(d, "README.md"), []byte(s), 0o644) }
	write("# x\n\nA thing. Run the tests with `make test`.\n")
	if got := readmeProblems(d); len(got) != 0 {
		t.Fatalf("good README: %v", got)
	}
	write("A thing without a title, no command.\n")
	if got := readmeProblems(d); len(got) != 3 {
		t.Fatalf("bad README: %v", got)
	}
}
