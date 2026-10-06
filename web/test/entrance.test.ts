/**
 * The entrance test (contract: docs/login-for-apps.md, "The entrance").
 *
 * Playground-owned (listed in .playground-files). An app that sends signed-out visitors to its own entrance page
 * (`setLoginPath("/enter")` in `src/main.tsx`) must have that page, and the page must be reachable without signing in:
 *
 *   a. `src/routes/enter.tsx` exists.
 *   b. it does not use `RequireUser`, `RequireAdmin`, `requireUser` or `requireAdmin` (the door cannot be behind the lock:
 *      a signed-out visitor would be sent to the door again and again).
 *   c. it links to `/auth/login` (the one link that starts the sign-in).
 *
 * An app that does not call `setLoginPath` is not checked. To fix a failure, make `/enter` a public route that renders the
 * app's own page and a plain link to `/auth/login?next=<where the person was going>` (see the template's routes/enter.tsx).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The file's code without its comments (a comment may name a guard). */
const code = (path: string): string =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
    : "";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const main = existsSync(join(src, "main.tsx")) ? readFileSync(join(src, "main.tsx"), "utf8") : "";
const usesEntrance = /\bsetLoginPath\s*\(/.test(main);

describe.runIf(usesEntrance)("the entrance page", () => {
  const file = join(src, "routes", "enter.tsx");

  it("exists when main.tsx calls setLoginPath", () => {
    expect(existsSync(file), "src/routes/enter.tsx is missing: main.tsx sends signed-out visitors to /enter").toBe(
      true,
    );
  });

  it("is public: no RequireUser or RequireAdmin guard", () => {
    const text = code(file);
    expect(/\b(Require(User|Admin)|require(User|Admin))\b/.test(text), "the entrance page must not be guarded").toBe(
      false,
    );
  });

  it("links to /auth/login", () => {
    const text = code(file);
    expect(text.includes("/auth/login"), "the entrance page needs a link to /auth/login").toBe(true);
  });
});

it("is a no-op for an app that keeps the instant redirect", () => {
  expect(true).toBe(true);
});
