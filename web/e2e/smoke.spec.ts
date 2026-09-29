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

  test("opens with Ctrl+K, lists routes and built-ins, runs the create-item command, closes with Esc", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const factory = await page.evaluate(() => window.__FACTORY__ ?? {});
    const env = typeof factory.env === "string" ? factory.env : "";
    const claudeUrl = typeof factory.claude_session_url === "string" ? factory.claude_session_url : "";

    await page.keyboard.press("Control+K");
    const input = page.getByRole("combobox", { name: "Search commands" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("listbox")).toBeVisible();

    // One "Go to" entry per static route. The palette hides private routes (path segment starting with "_").
    const navigable = routes.filter((r) => !r.split("/").some((seg) => seg.startsWith("_")));
    const goTo = page.getByRole("group", { name: "Go to" }).getByRole("option");
    await expect(goTo).toHaveCount(navigable.length);

    await expect(page.getByRole("option", { name: /Toggle theme/ })).toBeVisible();
    const agentPanel = page.getByRole("option", { name: /Open agent panel/ });
    if (env === "staging") await expect(agentPanel).toBeVisible();
    else await expect(agentPanel).toHaveCount(0);
    const claudeApp = page.getByRole("option", { name: /Open in Claude app/ });
    if (claudeUrl !== "") await expect(claudeApp).toBeVisible();
    else await expect(claudeApp).toHaveCount(0);
    await page.screenshot({ path: join(shots, "palette-desktop.png") });

    await input.fill("new");
    await expect(page.getByRole("option", { name: /New item/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();

    await page.keyboard.press("Control+K");
    await expect(input).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
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
