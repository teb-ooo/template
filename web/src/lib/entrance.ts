import { playground } from "@teb-ooo/web";

/** Where a person goes after signing in: an absolute path of this app, never another site. */
export function safeNext(next: string | undefined): string {
  if (!next || next[0] !== "/" || next.startsWith("//") || next.startsWith("/\\") || /[\r\n]/.test(next)) return "/";
  return next;
}

/** The app's name as the entrance pages say it. */
export function appName(): string {
  return playground.appName || "this app";
}

/** What the entrance says about a sign-in problem (`?problem=<code>`, the closed list of the Go auth package). */
export function problemMessage(code: string | undefined): string | null {
  switch (code) {
    case "expired":
      return "Your sign-in took too long or cookies are blocked. Try again.";
    case "refused":
      return "The sign-in was refused. Try again, or ask the person who invited you.";
    case "unavailable":
      return "The sign-in service did not answer. Try again in a moment.";
    case "failed":
      return "The sign-in did not work. Try again.";
    default:
      return null;
  }
}
