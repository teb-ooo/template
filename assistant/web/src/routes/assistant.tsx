import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Button, Chip, Field, Input } from "@teb-ooo/ui";
import { RequireUser, createApi, useEventStream } from "@teb-ooo/web";
import { Send } from "lucide-react";
import { describeError } from "../api/describe-error";

export const Route = createFileRoute("/assistant")({
  staticData: { title: "Assistant" },
  // The command palette's "Ask assistant..." navigates here with ?q=<first message>.
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === "string" ? search.q.trim() : "";
    return q === "" ? {} : { q };
  },
  beforeLoad: RequireUser,
  component: AssistantPage,
});

/**
 * Server-sent events of `POST /api/assistant/conversations/{id}/messages` (factory-go `assistant` package).
 * `AssistantEvents` from @teb-ooo/web lacks the `error` event the Go side also sends, so the full set is declared here.
 */
interface AssistantStreamEvents {
  text: { text: string };
  tool_call: { id: string; name: string; input: unknown };
  tool_result: { id: string; content: unknown; is_error?: boolean };
  done: { stop_reason?: string };
  error: { detail: string };
}

/**
 * The assistant endpoints exist only when the app enables the assistant, so they are not in the committed
 * schema.d.ts (which is generated without it). Hand-typed in the shape openapi-typescript emits; keep in step with Go.
 */
interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
type NoParams = { query?: never; header?: never; path?: never; cookie?: never };
type Unused = { get?: never; put?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never };
interface AssistantPaths {
  "/api/assistant/conversations": Unused & {
    parameters: NoParams;
    post: {
      parameters: NoParams;
      requestBody?: { content: { "application/json": { title?: string } } };
      responses: { 201: { headers: Record<string, unknown>; content: { "application/json": Conversation } } };
    };
  };
}
const assistantApi = createApi<AssistantPaths>();

type Step = { kind: "text"; text: string } | { kind: "tool"; id: string; name: string; state: "running" | "done" | "failed" };
type Turn = { role: "user"; text: string } | { role: "assistant"; steps: Step[]; problem?: string };

function AssistantPage() {
  const { q } = Route.useSearch();
  const navigate = useNavigate();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  // The stream hook is bound to one URL, so the first message waits here until the conversation exists.
  const [pending, setPending] = useState<string | null>(null);

  const createConversation = useMutation({
    mutationFn: async () => {
      const { data } = await assistantApi.client.POST("/api/assistant/conversations", { body: {} });
      if (!data) throw new Error("The server returned no conversation.");
      return data.id;
    },
  });

  /** Applies `update` to the assistant turn currently being streamed (always the last one). */
  const updateLast = (update: (t: Extract<Turn, { role: "assistant" }>) => Extract<Turn, { role: "assistant" }>) =>
    setTurns((all) => {
      const last = all[all.length - 1];
      return last && last.role === "assistant" ? [...all.slice(0, -1), update(last)] : all;
    });

  const stream = useEventStream<AssistantStreamEvents>(
    conversationId ? `/api/assistant/conversations/${conversationId}/messages` : null,
    {
      text: ({ text }) =>
        updateLast((t) => {
          const last = t.steps[t.steps.length - 1];
          const steps: Step[] =
            last && last.kind === "text"
              ? [...t.steps.slice(0, -1), { kind: "text", text: last.text + text }]
              : [...t.steps, { kind: "text", text }];
          return { ...t, steps };
        }),
      tool_call: ({ id, name }) => updateLast((t) => ({ ...t, steps: [...t.steps, { kind: "tool", id, name, state: "running" }] })),
      tool_result: ({ id, is_error }) =>
        updateLast((t) => ({
          ...t,
          steps: t.steps.map((s) => (s.kind === "tool" && s.id === id ? { ...s, state: is_error ? "failed" : "done" } : s)),
        })),
      error: ({ detail }) => updateLast((t) => ({ ...t, problem: detail })),
    },
    { method: "POST", closeOn: ["done", "error"] },
  );

  const busy = createConversation.isPending || stream.status === "connecting" || stream.status === "open";

  async function sendMessage(content: string) {
    setTurns((all) => [...all, { role: "user", text: content }, { role: "assistant", steps: [] }]);
    if (!conversationId) {
      try {
        const id = await createConversation.mutateAsync();
        setPending(content);
        setConversationId(id);
      } catch {
        // createConversation.error renders below.
      }
      return;
    }
    await stream.send({ content });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    await sendMessage(content);
  }

  // The first message may arrive in the URL. `handledQ` guards against StrictMode's double effect and re-renders;
  // the parameter is then removed from the URL so a reload does not send it again.
  const handledQ = useRef<string | null>(null);
  useEffect(() => {
    if (!q || handledQ.current === q) return;
    handledQ.current = q;
    void navigate({ to: "/assistant", search: {}, replace: true });
    void sendMessage(q);
  }, [q]);

  useEffect(() => {
    if (pending === null || conversationId === null) return;
    setPending(null);
    void stream.send({ content: pending });
  }, [pending, conversationId, stream]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="display-lg text-ink">Assistant</h1>

      {turns.length === 0 ? (
        <div className="flex flex-col gap-2 py-6">
          <p className="display-lg text-ink">Ask anything</p>
          <p className="text-ink-muted">The assistant can look things up and make changes. It can do what you can do here, and nothing more.</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-4" aria-live="polite">
          {turns.map((turn, i) =>
            turn.role === "user" ? (
              <li key={i} className="border-b border-line pb-2 text-ink-muted">
                {turn.text}
              </li>
            ) : (
              <li key={i} className="flex flex-col gap-2">
                {turn.steps.map((step, j) =>
                  step.kind === "text" ? (
                    <p key={j} className="whitespace-pre-wrap text-ink">
                      {step.text}
                    </p>
                  ) : (
                    <div key={step.id}>
                      <Chip tone={step.state === "failed" ? "danger" : "agent"}>
                        {step.state === "running" ? "Using " : step.state === "failed" ? "Could not use " : "Used "}
                        {step.name}
                        {step.state === "running" ? "..." : ""}
                      </Chip>
                    </div>
                  ),
                )}
                {turn.problem ? <p role="alert" className="text-danger">The assistant stopped: {turn.problem}</p> : null}
              </li>
            ),
          )}
        </ol>
      )}

      {createConversation.error ? (
        <p role="alert" className="text-danger">The conversation could not be started. {describeError(createConversation.error)}</p>
      ) : null}
      {stream.error && stream.status === "error" ? (
        <p role="alert" className="text-danger">The connection to the assistant failed. {describeError(stream.error)}</p>
      ) : null}

      <form onSubmit={(e) => void submit(e)} className="panel flex flex-col gap-3 p-4">
        <Field label="Message">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
        </Field>
        <div>
          <Button type="submit" intent="solid" icon={<Send aria-hidden size={16} />} loading={busy} disabled={draft.trim() === ""}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
