import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { CommandProvider, CommandTrigger } from "@teb-ooo/cmdk";
import { Avatar, Badge } from "@teb-ooo/ui";
import { factory, isForbiddenError, useUser } from "@teb-ooo/web";
import { Bot, LogIn, LogOut } from "lucide-react";
import { describeError } from "../api/describe-error";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
});

const linkClass = "inline-flex items-center gap-1 text-muted underline";

function RootLayout() {
  // The provider lives in the root route component, so it is inside the router (it reads the router for the
  // "Go to" entries). Never remove it (BOOTSTRAP 9.7c).
  return (
    <CommandProvider>
      <div className="flex min-h-full flex-col">
        <AppHeader />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
          <Outlet />
        </main>
      </div>
    </CommandProvider>
  );
}

function AppHeader() {
  const { user, isLoading } = useUser();
  const name = factory.appName || "app";
  const next = encodeURIComponent(window.location.pathname + window.location.search);

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
      <Link to="/" className="text-lg text-ink">
        {name}
      </Link>
      {factory.env === "staging" ? <Badge tone="accent">staging</Badge> : null}
      <div className="flex-1" />
      <CommandTrigger />
      {factory.agentUrl ? (
        <Link to="/_agent" className={linkClass}>
          <Bot aria-hidden size={16} />
          Agent
        </Link>
      ) : null}
      {isLoading ? null : user ? (
        <div className="flex items-center gap-2">
          <Avatar name={user.username || user.email} src={user.picture} size="sm" />
          <span className="text-sm text-ink">{user.username || user.email}</span>
          <a href="/auth/logout" className={linkClass}>
            <LogOut aria-hidden size={16} />
            Sign out
          </a>
        </div>
      ) : (
        <a href={`/auth/login?next=${next}`} className={linkClass}>
          <LogIn aria-hidden size={16} />
          Sign in
        </a>
      )}
    </header>
  );
}

function RouteError({ error }: { error: unknown }) {
  if (isForbiddenError(error)) {
    return (
      <div className="flex flex-col gap-2 px-4 py-6">
        <p className="text-base text-ink">You need admin access to open this page.</p>
        <Link to="/" className={linkClass}>
          Go back to the start page.
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-4 py-6">
      <p className="text-base text-danger">Something went wrong while loading this page.</p>
      <p className="text-sm text-muted">{describeError(error)}</p>
      <Link to="/" className={linkClass}>
        Go back to the start page.
      </Link>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col gap-2 px-4 py-6">
      <p className="text-base text-ink">There is nothing at this address.</p>
      <Link to="/" className={linkClass}>
        Go back to the start page.
      </Link>
    </div>
  );
}
