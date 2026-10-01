import { createFileRoute } from "@tanstack/react-router";
import { RequireUser } from "@teb-ooo/web";

export const Route = createFileRoute("/")({
  staticData: { title: "Home" },
  beforeLoad: RequireUser,
  component: HomePage,
});

// The schema starts empty: this page is the empty state. Replace it with the app's first screen. A resource's screen
// reads data with the generated hooks (`api.useQuery("get", "/api/<resource>")`, see ../api) and registers a Cmd+K command
// for every user action with `useRegisterCommands` (from "@teb-ooo/ui/cmdk").
function HomePage() {
  return (
    <div className="flex flex-col gap-2 py-6">
      <h1 className="display-lg text-ink">Home</h1>
      <p className="text-ink-muted">Nothing here yet.</p>
    </div>
  );
}
