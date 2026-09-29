import { createFileRoute } from "@tanstack/react-router";
import { Button, Chip, LinkButton, type ChipProps } from "@teb-ooo/ui";
import { factory, requireAdmin } from "@teb-ooo/web";
import { ArrowDown, ArrowUp, CornerDownLeft, ExternalLink, Keyboard, Square, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { describeError } from "../api/describe-error";
import { agentApi, type AgentKey } from "../api/agent";

export const Route = createFileRoute("/_agent")({
  staticData: { title: "Agent" },
  beforeLoad: requireAdmin({ redirectTo: "/" }),
  component: AgentPanel,
});

const KEYS: { label: string; key: AgentKey; icon: ReactNode }[] = [
  { label: "Escape", key: "Escape", icon: <Square aria-hidden size={16} /> },
  { label: "Tab", key: "Tab", icon: <Keyboard aria-hidden size={16} /> },
  { label: "Interrupt (Ctrl+C)", key: "C-c", icon: <Terminal aria-hidden size={16} /> },
  { label: "Up", key: "Up", icon: <ArrowUp aria-hidden size={16} /> },
  { label: "Down", key: "Down", icon: <ArrowDown aria-hidden size={16} /> },
  { label: "Enter", key: "Enter", icon: <CornerDownLeft aria-hidden size={16} /> },
];

/** Agent states from factoryd mapped to a chip tone: working is ok, waiting needs someone, everything else is quiet. */
function toneOf(status: string): NonNullable<ChipProps["tone"]> {
  if (status === "working" || status === "idle") return "ok";
  if (status === "waiting") return "warn";
  return "muted";
}

function AgentPanel() {
  const status = agentApi.useQuery("get", "/_agent/status", {}, { refetchInterval: 5000 });
  const send = agentApi.useMutation("post", "/_agent/keys");
  const claudeUrl = factory.claudeSessionUrl || status.data?.claude_session_url || "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="display-lg text-ink">{factory.appName || "app"} agent</h1>
        {status.data ? <Chip tone={toneOf(status.data.status)}>{status.data.status}</Chip> : null}
      </div>
      {status.error ? (
        <p role="alert" className="text-danger">The agent status could not be read. {describeError(status.error)}</p>
      ) : status.data?.last_summary ? (
        <p className="text-ink-muted">{status.data.last_summary}</p>
      ) : null}

      {claudeUrl ? (
        <div>
          <LinkButton href={claudeUrl} target="_blank" rel="noreferrer" icon={<ExternalLink aria-hidden size={16} />}>
            Open in Claude app
          </LinkButton>
        </div>
      ) : (
        <p className="text-ink-faint">The Claude app link appears here once the agent session has started.</p>
      )}

      {factory.agentUrl ? (
        <iframe title="Agent terminal" src={factory.agentUrl} className="panel h-[60vh] w-full" />
      ) : (
        <p className="text-ink-muted">This environment has no agent terminal. It is only available on staging.</p>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Terminal keys">
        {KEYS.map(({ label, key, icon }) => (
          <Button key={key} icon={icon} tip={label} disabled={send.isPending || !factory.agentUrl} onClick={() => send.mutate({ body: { key } })} />
        ))}
      </div>
      {send.error ? <p role="alert" className="text-danger">The key could not be sent. {describeError(send.error)}</p> : null}
    </div>
  );
}
