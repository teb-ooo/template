import { Link, Outlet, createRootRouteWithContext, useRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { CommandProvider, CommandTrigger, useFeedbackCommand } from "@teb-ooo/ui/cmdk";
import { Avatar, Chip, FeedbackPanel, LinkButton, LiveIndicator, type LiveStatus } from "@teb-ooo/ui";
import { playground, isForbiddenError, useFeedback, useLive, useUser } from "@teb-ooo/web";
import { Bot, LogIn, LogOut, MessageCircle } from "lucide-react";
import { describeError } from "../api/describe-error";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteError,
  notFoundComponent: NotFound,
});

const textLink = "text-ink-muted underline";

function RootLayout() {
  // Live data (rule UI-7): the server tells this screen which resource changed (GET /api/live) and the generated
  // queries under it refetch. Call useLive() once, here at the root; it is off by itself under a test browser
  // (navigator.webdriver, or ?live=0). A screen that polls can stop while `status` is "live".
  const { status } = useLive();
  // The provider lives in the root route component, so it is inside the router (it reads the router for the
  // "Go to" entries). Never remove it (BOOTSTRAP 9.7c).
  return (
    <CommandProvider>
      <RootBody live={status} />
    </CommandProvider>
  );
}

function RootBody({ live }: { live: LiveStatus }) {
  // The feedback tool (push-and-feedback.md): "Send feedback" in Cmd+K, only for the owner (is_admin or is_owner from
  // /auth/me), never under a test browser (navigator.webdriver). There is no header button. It must sit inside the
  // CommandProvider, the router and the query provider, so it is a child of the provider.
  const feedback = useFeedback();
  useFeedbackCommand(feedback);
  return (
    <>
      <div className="flex min-h-full flex-col">
        <AppHeader live={live} />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
          <Outlet />
        </main>
      </div>
      <FeedbackPanel feedback={feedback} />
    </>
  );
}

function AppHeader({ live }: { live: LiveStatus }) {
  const { user, isLoading } = useUser();
  const router = useRouter();
  const name = playground.appName || "app";
  const next = encodeURIComponent(window.location.pathname + window.location.search);

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:gap-3">
      <Link to="/" className="text-ink">
        {name}
      </Link>
      {playground.env === "staging" ? <Chip tone="warn">staging</Chip> : null}
      <LiveIndicator status={live} />
      <div className="flex-1" />
      <CommandTrigger />
      {playground.assistant ? (
        <LinkButton
          href="/assistant"
          icon={<MessageCircle aria-hidden size={16} />}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            // The route only exists in assistant apps (overlay), so it is not in the typed route tree of the base template.
            router.history.push("/assistant");
          }}
        >
          <span className="max-sm:sr-only">Assistant</span>
        </LinkButton>
      ) : null}
      {playground.claudeSessionUrl ? (
        <LinkButton href={playground.claudeSessionUrl} target="_blank" rel="noreferrer" icon={<Bot aria-hidden size={16} />}>
          <span className="max-sm:sr-only">Claude</span>
        </LinkButton>
      ) : null}
      {isLoading ? null : user ? (
        <div className="flex items-center gap-2">
          <Avatar name={user.username || user.email} src={user.picture} size="sm" />
          <span className="text-ink-muted max-sm:sr-only">{user.username || user.email}</span>
          <LinkButton href="/auth/logout" icon={<LogOut aria-hidden size={16} />} tip="Sign out" />
        </div>
      ) : (
        <LinkButton href={`/auth/login?next=${next}`} icon={<LogIn aria-hidden size={16} />}>
          Sign in
        </LinkButton>
      )}
    </header>
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
