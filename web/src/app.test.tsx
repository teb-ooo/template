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
);

function renderApp(path: string) {
  const queryClient = createTestQueryClient();
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("root route", () => {
  it("renders the header, the signed-in user and the empty state", async () => {
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
    expect(screen.getByText("staging")).toBeTruthy();
    expect(await screen.findByText("ada")).toBeTruthy();
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it("opens the command palette with the shortcut and lists the route", async () => {
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Home" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox");
    expect(box).toBeTruthy();
    // "Go to" reads staticData.title, a route's own commands come from useRegisterCommands.
    expect(screen.getByRole("option", { name: /Home/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /agent panel/i })).toBeNull();
    // Apps follow the system colour scheme: there is no theme command.
    expect(screen.queryByRole("option", { name: /theme/i })).toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
  });

  it("shows the live indicator next to the staging label: not live while the stream is off", async () => {
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Home" });
    const dot = screen.getByRole("status", { name: "Not live" });
    expect(dot.previousElementSibling?.textContent).toBe("staging");
  });

  it("reports live once /api/live answers with an event stream", async () => {
    window.history.replaceState(null, "", "/?live=1");
    server.use(
      http.get("*/api/live", () => {
        const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(": live\n\n")) });
        return new HttpResponse(body, { headers: { "Content-Type": "text/event-stream" } });
      }),
    );
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    expect(await screen.findByRole("status", { name: "Live" })).toBeTruthy();
  });

  // The feedback tool: "Send feedback" is in Cmd+K only for the superadmin or the app's owner (/auth/me), never for
  // anybody else. (navigator.webdriver is not set in jsdom, so this is the person check alone.)
  async function paletteHas(me: Record<string, unknown>) {
    server.use(http.get("*/auth/me", () => HttpResponse.json({ ...user, ...me })));
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Home" });
    await screen.findByText("ada");
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox");
    await screen.findByRole("option", { name: /Home/ });
    const found = screen.queryByRole("option", { name: /send feedback/i }) !== null;
    fireEvent.keyDown(box, { key: "Escape" });
    return found;
  }

  it("offers Send feedback in the palette to the app's owner", async () => {
    expect(await paletteHas({ is_owner: true })).toBe(true);
  });

  it("offers Send feedback in the palette to the superadmin", async () => {
    expect(await paletteHas({ is_admin: true })).toBe(true);
  });

  it("does not offer Send feedback to anybody else", async () => {
    expect(await paletteHas({})).toBe(false);
    cleanup();
    expect(await paletteHas({ is_owner: false, is_admin: false })).toBe(false);
  });

  it("has no feedback button in the header", async () => {
    server.use(http.get("*/auth/me", () => HttpResponse.json({ ...user, is_owner: true })));
    setPlayground({ app_name: "sample", env: "staging" });
    renderApp("/");
    await screen.findByText("ada");
    expect(screen.queryByRole("button", { name: /feedback/i })).toBeNull();
  });

  it("is off under a test browser (navigator.webdriver)", async () => {
    Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
    try {
      expect(await paletteHas({ is_owner: true })).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "webdriver");
    }
  });
});
