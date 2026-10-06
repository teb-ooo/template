import { createFileRoute } from "@tanstack/react-router";
import { LinkButton } from "@teb-ooo/ui";
import { platformUrl, playground } from "@teb-ooo/web";
import { appName, safeNext } from "../lib/entrance";

// The page an emailed invitation link opens, on this app's own address: /invite?flow=...&token=...&next=/where/to/land
// (docs/login-for-apps.md, "Invitations"). It spends nothing: mail programs fetch links to scan them. The button hands
// the link to `id`, which registers the passkey and sends the person back to this app at `next`. Public route; the root
// layout draws no platform bar around it. Replace the page with the app's own design; keep the button's target.
export const Route = createFileRoute("/invite")({
  staticData: { title: "Invitation" },
  validateSearch: (s: Record<string, unknown>): { flow?: string; token?: string; next?: string } => ({
    flow: typeof s.flow === "string" ? s.flow : undefined,
    token: typeof s.token === "string" ? s.token : undefined,
    next: typeof s.next === "string" ? s.next : undefined,
  }),
  component: InvitePage,
});

function InvitePage() {
  const { flow, token, next } = Route.useSearch();
  const q = new URLSearchParams();
  if (flow) q.set("flow", flow);
  if (token) q.set("token", token);
  q.set("app", playground.appName);
  q.set("next", safeNext(next));
  const href = flow && token ? platformUrl("id", `/invite?${q.toString()}`) : null;
  return (
    <main className="flex h-full flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="display-lg text-ink">You are invited to {appName()}</h1>
      {href ? (
        <LinkButton intent="solid" href={href}>
          Continue
        </LinkButton>
      ) : (
        <p className="text-ink-muted">
          This invitation link does not work. Ask the person who invited you for a new one.
        </p>
      )}
    </main>
  );
}
