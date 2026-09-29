import { createFileRoute } from "@tanstack/react-router";
import { Badge, Button } from "@teb-ooo/ui";
import { factory, requireAdmin } from "@teb-ooo/web";
import { ExternalLink } from "lucide-react";
import { describeError } from "../api/describe-error";
import { agentApi, type AgentKey } from "../api/agent";

export const Route = createFileRoute("/_agent")({
  staticData: { title: "Agent" },
  beforeLoad: requireAdmin({ redirectTo: "/" }),
  component: AgentPanel,
});

const KEYS: { label: string; key: AgentKey }[] = [
  { label: "Esc", key: "Escape" },
  { label: "Tab", key: "Tab" },
  { label: "Ctrl+C", key: "C-c" },
  { label: "Up", key: "Up" },
  { label: "Down", key: "Down" },
  { label: "Enter", key: "Enter" },
];

function AgentPanel() {
  const status = agentApi.useQuery("get", "/_agent/status", {}, { refetchInterval: 5000 });
  const send = agentApi.useMutation("post", "/_agent/keys");
  const claudeUrl = factory.claudeSessionUrl || status.data?.claude_session_url || "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl text-ink">{factory.appName || "app"} agent</h1>
        {status.data ? <Badge tone="accent">{status.data.status}</Badge> : null}
      </div>
      {status.error ? (
        <p role="alert" className="text-sm text-danger">The agent status could not be read. {describeError(status.error)}</p>
      ) : status.data?.last_summary ? (
        <p className="text-sm text-muted">{status.data.last_summary}</p>
      ) : null}

      {claudeUrl ? (
        <a href={claudeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-ink underline">
          <ExternalLink aria-hidden size={16} />
          Open in Claude app
        </a>
      ) : (
        <p className="text-sm text-muted">The Claude app link appears here once the agent session has started.</p>
      )}

      {factory.agentUrl ? (
        <iframe title="Agent terminal" src={factory.agentUrl} className="h-[60vh] w-full border border-line" />
      ) : (
        <p className="text-sm text-muted">This environment has no agent terminal. It is only available on staging.</p>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Terminal keys">
        {KEYS.map(({ label, key }) => (
          <Button key={key} disabled={send.isPending || !factory.agentUrl} onClick={() => send.mutate({ body: { key } })}>
            {label}
          </Button>
        ))}
      </div>
      {send.error ? <p role="alert" className="text-sm text-danger">The key could not be sent. {describeError(send.error)}</p> : null}
    </div>
  );
}
