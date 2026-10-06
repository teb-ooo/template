import { Link, Outlet, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { CommandProvider } from "@teb-ooo/ui/cmdk";
import { Shell, Sidebar } from "@teb-ooo/ui";
import { describeError, isForbiddenError, useLive } from "@teb-ooo/web";
import { Home } from "lucide-react";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
});

const textLink = "text-ink-muted underline";

// The platform shell (docs/shell.md): `Shell` draws the one platform top bar (app name, live dot,
// staging mark, Cmd+K, Send feedback for the owner, person menu), registers the platform commands in Cmd+K and owns the
// feedback panel. This file renders no header of its own, passes none, and uses no feedback hook, no CommandTrigger and
// no sign-in or sign-out control: web/test/platform-shell.test.ts fails the app that does. App-specific navigation goes in
// the sidebar below, the page body and Cmd+K commands (`useRegisterCommands`).
function RootLayout() {
  // Live data (rule UI-yvn): the server tells this screen which resource changed (GET /api/live) and the generated
  // queries under it refetch. Call useLive() once, here at the root; it is off by itself under a test browser
  // (navigator.webdriver, or ?live=0). The bar's live dot follows it by itself. A screen that polls can stop while
  // `status` is "live".
  useLive();
  // The provider lives in the root route component, so it is inside the router (it reads the router for the
  // "Go to" entries) and the query provider. Never remove it (BOOTSTRAP 9.7c).
  return (
    <CommandProvider>
      <Shell sidebar={<AppSidebar />}>
        <main className="mx-auto w-full max-w-3xl px-4 py-6">
          <Outlet />
        </main>
      </Shell>
    </CommandProvider>
  );
}

// One item to start with: add the app's screens here as it grows (each one also gets a Cmd+K command).
function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <Sidebar
      label="Navigation"
      items={[{ id: "home", label: "Home", href: "/", icon: <Home aria-hidden size={16} />, active: pathname === "/" }]}
      renderLink={(_item, content, props) => (
        <Link to="/" {...props}>
          {content}
        </Link>
      )}
    />
  );
}

function RouteError({ error }: { error: unknown }) {
  if (isForbiddenError(error)) {
    return (
      <div className="flex flex-col gap-2 px-4 py-6">
        <p className="text-ink">You need admin access to open this page.</p>
        <Link to="/" className={textLink}>
          Go back to the start page.
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-4 py-6">
      <p className="text-danger">Something went wrong while loading this page.</p>
      <p className="text-ink-muted">{describeError(error)}</p>
      <Link to="/" className={textLink}>
        Go back to the start page.
      </Link>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col gap-2 px-4 py-6">
      <p className="text-ink">There is nothing at this address.</p>
      <Link to="/" className={textLink}>
        Go back to the start page.
      </Link>
    </div>
  );
}
