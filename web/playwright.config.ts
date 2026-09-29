import { defineConfig } from "@playwright/test";

// BASE_URL: the app to test (default: the binary on localhost:8080, no Caddy, no auth gate).
// SESSION_COOKIE: `name=value`, minted by testkit; the smoke test skips sign-in when absent.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: the Chrome agent-browser installed (no `playwright install` needed).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8080",
    viewport: { width: 1280, height: 800 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
