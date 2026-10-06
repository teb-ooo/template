import { createFileRoute, redirect } from "@tanstack/react-router";
import { LinkButton } from "@teb-ooo/ui";
import { ensureUser } from "@teb-ooo/web";
import { appName, problemMessage, safeNext } from "../lib/entrance";

// The app's own front door for a signed-out visitor (docs/login-for-apps.md, "The entrance"). It is a public route: it
// never uses RequireUser, and the root layout draws no platform bar around it. Replace the page with the app's own
// design (a 3D scene, copy, colours); keep the one link that starts the sign-in and the problem message.
export const Route = createFileRoute("/enter")({
  staticData: { title: "Enter" },
  validateSearch: (s: Record<string, unknown>): { next?: string; problem?: string } => ({
    next: typeof s.next === "string" ? s.next : undefined,
    problem: typeof s.problem === "string" ? s.problem : undefined,
  }),
  // A person who is already signed in does not need the door.
  beforeLoad: async ({ context, search }) => {
    if (await ensureUser(context.queryClient)) throw redirect({ href: safeNext(search.next) });
  },
  component: EnterPage,
});

function EnterPage() {
  const { next, problem } = Route.useSearch();
  const message = problemMessage(problem);
  return (
    <main className="flex h-full flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="display-lg text-ink">{appName()}</h1>
      {message ? (
        <p role="alert" className="text-danger">
          {message}
        </p>
      ) : null}
      {/* A plain document link: /auth/login is served by the Go app, not by the router. */}
      <LinkButton intent="solid" href={`/auth/login?next=${encodeURIComponent(safeNext(next))}`}>
        Enter
      </LinkButton>
    </main>
  );
}
