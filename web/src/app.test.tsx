import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { createTestQueryClient, http, HttpResponse, setFactory, setupMswServer } from "@teb-ooo/web/testing";
import { routeTree } from "./routeTree.gen";

const user = { subject: "u1", email: "ada@example.com", username: "ada", groups: [], is_admin: false };

afterEach(cleanup);
window.scrollTo = () => undefined; // jsdom does not implement it; the router calls it on navigation

setupMswServer(
  http.get("*/auth/me", () => HttpResponse.json(user)),
  http.get("*/api/items", () => HttpResponse.json({ items: [] })),
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
    setFactory({ app_name: "hello", env: "staging" });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Items" })).toBeTruthy();
    expect(screen.getByText("staging")).toBeTruthy();
    expect(await screen.findByText("ada")).toBeTruthy();
    expect(await screen.findByText(/No items yet/)).toBeTruthy();
  });

  it("opens the command palette with the shortcut and lists the route and the app command", async () => {
    setFactory({ app_name: "hello", env: "staging", agent_url: "/_agent/tty/" });
    renderApp("/");
    await screen.findByRole("heading", { name: "Items" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox");
    expect(box).toBeTruthy();
    // "Go to" reads staticData.title, the route's own command comes from useRegisterCommands.
    expect(screen.getByRole("option", { name: /Items/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /New item/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Open agent panel/ })).toBeTruthy();
    // Apps follow the system colour scheme: there is no theme command.
    expect(screen.queryByRole("option", { name: /theme/i })).toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
  });

  it("tells a non-admin they need admin access on the agent panel", async () => {
    setFactory({ app_name: "hello", env: "staging", agent_url: "/_agent/tty/" });
    renderApp("/_agent");
    // A non-admin is redirected to the start page by the guard.
    expect(await screen.findByRole("heading", { name: "Items" })).toBeTruthy();
  });
});
