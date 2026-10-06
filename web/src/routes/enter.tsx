import { createFileRoute, redirect } from "@tanstack/react-router";
import { LinkButton } from "@teb-ooo/ui";
import { EntrancePage } from "@teb-ooo/ui/entrance";
import { ensureUser } from "@teb-ooo/web";
import { appName, problemMessage, safeNext } from "../lib/entrance";

// The app's own front door for a signed-out visitor (docs/login-for-apps.md, "The entrance"). It is a public route: it
// never uses RequireUser, and the root layout draws no platform bar around it. Replace the page with the app's own
// design; keep the one link that starts the sign-in and the problem message. `EntrancePage` (@teb-ooo/ui/entrance) is the
// platform's front door: a small swingset in a cloud of mist, drawn after the page is usable (three.js loads in its own
// chunk, so the bundle a signed-in person loads does not grow) and absent without WebGL; its title is the heading for assistive
// technology and tests. A design of your own may replace it.
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
    <EntrancePage title={appName()}>
      <p className="display-lg text-ink">{appName()}</p>
      {message ? (
        <p role="alert" className="text-danger">
          {message}
        </p>
      ) : null}
      {/* A plain document link: /auth/login is served by the Go app, not by the router. */}
      <LinkButton intent="solid" href={`/auth/login?next=${encodeURIComponent(safeNext(next))}`}>
        Enter
      </LinkButton>
    </EntrancePage>
  );
}
