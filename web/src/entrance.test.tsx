import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { createTestQueryClient, http, HttpResponse, setPlayground, setupMswServer } from "@teb-ooo/web/testing";
import { routeTree } from "./routeTree.gen";

afterEach(cleanup);
window.scrollTo = () => undefined;

const signedOut = () =>
  new HttpResponse(JSON.stringify({ title: "Unauthorized", status: 401 }), {
    status: 401,
    headers: { "Content-Type": "application/problem+json" },
  });
const server = setupMswServer(http.get("*/auth/me", signedOut));

function renderAt(path: string) {
  const queryClient = createTestQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("the entrance (/enter)", () => {
  it("shows the app's door to a signed-out visitor, with no platform bar, and Enter starts the sign-in and returns to next", async () => {
    setPlayground({ app_name: "sample", env: "production" });
    renderAt("/enter?next=%2Fthings%2F5");
    expect(await screen.findByRole("heading", { name: "sample" })).toBeTruthy();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByRole("link", { name: "Enter" }).getAttribute("href")).toBe("/auth/login?next=%2Fthings%2F5");
  });

  it("never sends the person to another site: next must be a path of this app", async () => {
    setPlayground({ app_name: "sample", env: "production" });
    renderAt("/enter?next=%2F%2Fevil.example");
    expect((await screen.findByRole("link", { name: "Enter" })).getAttribute("href")).toBe("/auth/login?next=%2F");
  });

  it("says what went wrong with a sign-in problem", async () => {
    setPlayground({ app_name: "sample", env: "production" });
    renderAt("/enter?problem=unavailable");
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not answer/);
  });

  it("sends a signed-in person on to next", async () => {
    server.use(
      http.get("*/auth/me", () =>
        HttpResponse.json({ subject: "u1", email: "a@x", username: "ada", groups: [], is_admin: false }),
      ),
    );
    setPlayground({ app_name: "sample", env: "production" });
    const router = renderAt("/enter?next=%2F");
    await screen.findByText(/Nothing here yet/).catch(() => undefined);
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("the invitation (/invite)", () => {
  it("hands the link to id with the app and where to land, and spends nothing itself", async () => {
    setPlayground({ app_name: "sample", env: "production", platform_domain: "teb.ooo" });
    renderAt("/invite?flow=f1&token=t1&next=%2Fthings");
    const a = await screen.findByRole("link", { name: "Continue" });
    const u = new URL(a.getAttribute("href") ?? "");
    expect(u.origin).toBe("https://id.teb.ooo");
    expect(u.pathname).toBe("/invite");
    expect(Object.fromEntries(u.searchParams)).toEqual({ flow: "f1", token: "t1", app: "sample", next: "/things" });
  });

  it("says the link does not work when it is cut off", async () => {
    setPlayground({ app_name: "sample", env: "production", platform_domain: "teb.ooo" });
    renderAt("/invite");
    expect(await screen.findByText(/does not work/)).toBeTruthy();
  });
});
