import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { createQueryClient, playground, setLoginPath } from "@teb-ooo/web";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const queryClient = createQueryClient();

// A signed-out visitor of the production site meets the app's own entrance page (routes/enter.tsx) instead of going straight
// to the identity provider. Staging keeps the instant redirect, so the owner and the agent do not click Enter all day; the
// page is still reachable there at /enter.
if (playground.env === "production") setLoginPath("/enter");

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
