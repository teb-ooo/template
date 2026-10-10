import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { createTestQueryClient, http, HttpResponse, setPlayground, setupMswServer } from "@teb-ooo/web/testing";
import { routeTree } from "./routeTree.gen";

const user = { subject: "u1", email: "ada@example.com", username: "ada", groups: [], is_admin: false };

afterEach(cleanup);
// useLive() reads ?live= from the window: keep the stream off unless a test turns it on (jsdom is not a test browser).
beforeEach(() => window.history.replaceState(null, "", "/?live=0"));
window.scrollTo = () => undefined; // jsdom does not implement it; the router calls it on navigation

const server = setupMswServer(
  http.get("*/auth/me", () => HttpResponse.json(user)),
  // the bar polls the agent status route of the platform edge (owner only); it does not exist under test
  http.get("*/_playground/agent", () => new HttpResponse(null, { status: 404 })),
);

function renderApp(path: string) {
  const queryClient = createTestQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("root route", () => {
  it("renders the platform bar with the app name, the page and the empty state, and no header of its own", async () => {
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
    const bars = screen.getAllByRole("banner");
    expect(bars).toHaveLength(1); // the shell's bar is the only header
    expect(bars[0]?.textContent?.trim()).toBe("sample"); // the app's name is the only text in it
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it("opens the command palette with the shortcut and lists the route and the platform commands", async () => {
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Home" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox");
    expect(box).toBeTruthy();
    // "Go to" reads staticData.title, a route's own commands come from useRegisterCommands.
    expect(screen.getByRole("option", { name: /Home/ })).toBeTruthy();
    // The shell registers the platform commands (group "Platform"); Sign out only while signed in.
    expect(await screen.findByRole("option", { name: /sign out/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /agent panel/i })).toBeNull();
    // Apps follow the system colour scheme: there is no theme command.
    expect(screen.queryByRole("option", { name: /theme/i })).toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
  });

  // Since ui 0.30 the bar draws the live dot only when the stream is reconnecting or degraded: an off or healthy stream shows
  // nothing.
  it("draws no live dot while the stream is off", async () => {
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Home" });
    expect(screen.queryByRole("status", { name: /live/i })).toBeNull();
  });

  it("draws no live dot while /api/live is healthy", async () => {
    window.history.replaceState(null, "", "/?live=1");
    server.use(
      http.get("*/api/live", () => {
        const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(": live\n\n")) });
        return new HttpResponse(body, { headers: { "Content-Type": "text/event-stream" } });
      }),
    );
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Home" });
    expect(screen.queryByRole("status", { name: /live/i })).toBeNull();
  });

  // The feedback tool belongs to the shell: "Send feedback" is in Cmd+K (and an icon in the bar) only for the superadmin or
  // the app's owner (/auth/me), never for anybody else. (navigator.webdriver is not set in jsdom, so this is the user
  // check alone.)
  async function feedbackOffered(me: Record<string, unknown>) {
    server.use(http.get("*/auth/me", () => HttpResponse.json({ ...user, ...me })));
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Home" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox");
    await screen.findByRole("option", { name: /sign out/i }); // the user is known
    const inPalette = screen.queryByRole("option", { name: /send feedback/i }) !== null;
    fireEvent.keyDown(box, { key: "Escape" });
    return inPalette;
  }

  it("offers Send feedback in the palette to the app's owner", async () => {
    expect(await feedbackOffered({ is_owner: true })).toBe(true);
  });

  it("offers Send feedback in the palette to the superadmin", async () => {
    expect(await feedbackOffered({ is_admin: true })).toBe(true);
  });

  it("does not offer Send feedback to anybody else", async () => {
    expect(await feedbackOffered({})).toBe(false);
    cleanup();
    expect(await feedbackOffered({ is_owner: false, is_admin: false })).toBe(false);
  });

  it("is off under a test browser (navigator.webdriver)", async () => {
    Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
    try {
      expect(await feedbackOffered({ is_owner: true })).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "webdriver");
    }
  });
});
