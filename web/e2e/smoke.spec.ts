import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ConsoleMessage, type Response } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "__screenshots__");

/**
 * Static routes of the router, read from the generated route tree (never hard-coded): every key of
 * `FileRoutesByFullPath` without a path parameter (`$id`, `{-$x}`) or a splat.
 */
function staticRoutes(treeSource: string): string[] {
  const block = /export interface FileRoutesByFullPath \{([^}]*)\}/.exec(treeSource)?.[1] ?? "";
  const paths = [...block.matchAll(/'([^']+)':/g)].map((m) => m[1]).filter((p): p is string => p !== undefined);
  return paths.filter((p) => !p.includes("$")).sort();
}

const routes = staticRoutes(readFileSync(join(here, "..", "src", "routeTree.gen.ts"), "utf8"));

/** URLs (path only) whose 4xx/5xx responses are expected. Extend deliberately, with a reason. */
const allowedFailures: { path: RegExp; status: number; reason: string; onlyWithoutSession?: boolean }[] = [
  { path: /^\/auth\/me$/, status: 401, reason: "useUser probes the session; 401 means signed out", onlyWithoutSession: true },
];

const sessionCookie = process.env.SESSION_COOKIE;

function screenshotName(route: string): string {
  return route === "/" ? "index" : route.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * The Content-Security-Policy Caddy adds to every site (compose/caddy/Caddyfile, `security_headers`). The app itself
 * sends none, so a test that talks to the app directly would never see a violation. Every page gets the same policy
 * as a <meta> tag before any script runs (`frame-ancestors` is header-only and left out), so anything it blocks
 * (`unsafe-eval` from `new Function`, inline scripts, other origins) is a console error that fails the tests below.
 * A meta tag, not a rewritten response: re-served documents lose their address space and Chrome then blocks the
 * candidate's private-network subresources.
 */
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'";

test.beforeEach(async ({ context }) => {
  await context.addInitScript((policy) => {
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = policy;
    // The script can run before the document has any element: wait for the first one, still before any page script.
    const attach = () => {
      const parent = document.head ?? document.documentElement;
      parent?.appendChild(meta);
      return parent !== null;
    };
    if (!attach()) {
      const observer = new MutationObserver(() => {
        if (attach()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  }, CSP);
});

test.beforeEach(async ({ context, baseURL }) => {
  if (!sessionCookie) return;
  const eq = sessionCookie.indexOf("=");
  if (eq < 1) throw new Error("SESSION_COOKIE must look like name=value");
  await context.addCookies([{ name: sessionCookie.slice(0, eq), value: sessionCookie.slice(eq + 1), url: baseURL ?? "http://localhost:8080" }]);
});

test("the router exports at least one static route", () => {
  expect(routes.length).toBeGreaterThan(0);
});

for (const route of routes) {
  test(`route ${route}: no console errors, no failed requests`, async ({ page }) => {
    const problems: string[] = [];
    const isAllowed = (url: string, status: number) => {
      const path = new URL(url).pathname;
      return allowedFailures.some((a) => a.path.test(path) && a.status === status && (!a.onlyWithoutSession || !sessionCookie));
    };

    page.on("pageerror", (err) => problems.push(`uncaught exception: ${err.message}`));
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      // The browser logs "Failed to load resource" for every 4xx/5xx; those are judged by the response check below.
      if (msg.text().startsWith("Failed to load resource")) return;
      problems.push(`console error: ${msg.text()}`);
    });
    page.on("requestfailed", (req) => {
      // Aborted navigations (redirects to sign-in) are not failures.
      if (req.failure()?.errorText === "net::ERR_ABORTED") return;
      problems.push(`request failed: ${req.method()} ${req.url()} (${req.failure()?.errorText ?? "unknown"})`);
    });
    page.on("response", (res: Response) => {
      if (res.status() >= 400 && !isAllowed(res.url(), res.status())) {
        problems.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
      }
    });

    await page.goto(route);
    await page.waitForLoadState("networkidle");

    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${screenshotName(route)}.png`), fullPage: true });

    expect(problems, problems.join("\n")).toEqual([]);
  });
}

// The Cmd+K palette (BOOTSTRAP 9.7c, exit item 12). Needs a signed-in page: "/" requires a user.
test.describe("command palette", () => {
  test.skip(!sessionCookie, "SESSION_COOKIE is not set: the start page redirects to sign-in");

  test("opens with Ctrl+K, lists routes and built-ins, closes with Esc", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const playground = await page.evaluate(() => window.__PLAYGROUND__ ?? {});
    const claudeUrl = typeof playground.claude_session_url === "string" ? playground.claude_session_url : "";

    await page.keyboard.press("Control+K");
    const input = page.getByRole("combobox", { name: "Search commands" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("listbox")).toBeVisible();

    // One "Go to" entry per static route. The palette hides private routes (path segment starting with "_").
    const navigable = routes.filter((r) => !r.split("/").some((seg) => seg.startsWith("_")));
    const goTo = page.getByRole("group", { name: "Go to" }).getByRole("option");
    await expect(goTo).toHaveCount(navigable.length);

    // Apps follow the system colour scheme: the palette has no theme command and the header no theme control.
    await expect(page.getByRole("option", { name: /theme/i })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /agent panel/i })).toHaveCount(0); // the in-browser terminal is gone
    const claudeApp = page.getByRole("option", { name: /Open in Claude app/ });
    if (claudeUrl !== "") await expect(claudeApp).toBeVisible();
    else await expect(claudeApp).toHaveCount(0);
    await page.screenshot({ path: join(shots, "palette-desktop.png") });

    await page.keyboard.press("Control+K");
    await expect(input).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("there is no theme toggle anywhere in the app", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("header").getByText(/theme/i)).toHaveCount(0);
    await expect(page.locator("header").getByRole("button", { name: /theme|dark|light/i })).toHaveCount(0);
    await expect(page.locator("[aria-label*='theme' i], [data-testid*='theme' i]")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(false);
  });

  test("on a 390px wide screen the trigger opens a full-height sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Open command palette" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(844 * 0.95);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(390 * 0.95);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "palette-mobile.png") });
  });
});

// Signed out, a guarded page must send the browser to the sign-in page (a real document load), not render the
// router's not-found page. The sign-in page itself is served by the Go app and redirects to the identity
// provider, which a test cannot reach, so its response is stubbed.
test("signed out: the start page navigates to /auth/login instead of rendering not-found", async ({ page, context }) => {
  await context.clearCookies();
  let loginRequests = 0;
  await context.route("**/auth/login**", (route) => {
    loginRequests++;
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>sign in</title><p>sign-in page</p>" });
  });
  await page.goto("/");
  await expect(page.getByText("sign-in page")).toBeVisible();
  expect(page.url()).toContain("/auth/login?next=%2F");
  expect(loginRequests).toBeGreaterThan(0);
  await expect(page.getByText("There is nothing at this address.")).toHaveCount(0);
});

// Phones: the header stays on one row, the page does not scroll sideways, and the palette sheet can be closed by touch.
test.describe("390px", () => {
  test.skip(!sessionCookie, "SESSION_COOKIE is not set: the start page redirects to sign-in");
  test.use({ viewport: { width: 390, height: 844 } });

  test("the header does not wrap, nothing overflows, the palette sheet closes with its Close button", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const header = await page.locator("header").boundingBox();
    expect(header?.height ?? Infinity).toBeLessThan(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "Open command palette" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(844 * 0.95);
    await page.getByRole("button", { name: "Close command palette" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

// Desktops: the app is a real desktop interface too (owner decision 2026-09-30), not a stretched phone layout.
// At 1280 and 1920 the header stays on one row and the page does not scroll sideways; app-specific desktop layout tests
// (sidebar, tables, detail panes) belong next to the screens that have them.
for (const width of [1280, 1920]) {
  test.describe(`${width}px`, () => {
    test.skip(!sessionCookie, "SESSION_COOKIE is not set: the start page redirects to sign-in");
    test.use({ viewport: { width, height: 900 } });

    test("the header does not wrap and nothing overflows", async ({ page }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      const header = await page.locator("header").boundingBox();
      expect(header?.height ?? Infinity).toBeLessThan(60);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  });
}
