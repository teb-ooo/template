import { createApi, type ProblemDetails } from "@teb-ooo/web";

/**
 * The `/_agent/*` endpoints are served by the Go app for the staging agent panel and are deliberately NOT part of
 * the OpenAPI document (they are not MCP tools and not part of the app's product API), so `gen:api` cannot type
 * them. The path types are written by hand here, in the same shape openapi-typescript emits, and go through the
 * same client as everything else (credentials, request id, 401 redirect, ApiError). This is the one hand-typed
 * exception to "types come from schema.d.ts"; keep it in step with the Go handlers.
 */
export interface AgentStatus {
  /** Coarse state from factoryd, e.g. "working", "idle", "waiting", "unknown". */
  status: string;
  /** RFC 3339 time the status began, or null. */
  since?: string | null;
  /** One line about what the agent last said or did. */
  last_summary?: string;
  /** The claude.ai session link, when the session has started (also in window.__FACTORY__). */
  claude_session_url?: string;
}

/** Key names understood by `POST /_agent/keys` (tmux send-keys names). */
export type AgentKey = "Escape" | "Tab" | "C-c" | "Up" | "Down" | "Enter";

export interface AgentKeyBody {
  key: AgentKey;
}

type ProblemResponse = { headers: Record<string, unknown>; content: { "application/problem+json": ProblemDetails } };
type NoParams = { query?: never; header?: never; path?: never; cookie?: never };
type Unused = { put?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never };

export interface AgentPaths {
  "/_agent/status": Unused & {
    parameters: NoParams;
    post?: never;
    get: {
      parameters: NoParams;
      requestBody?: never;
      responses: {
        200: { headers: Record<string, unknown>; content: { "application/json": AgentStatus } };
        default: ProblemResponse;
      };
    };
  };
  "/_agent/keys": Unused & {
    parameters: NoParams;
    get?: never;
    post: {
      parameters: NoParams;
      requestBody: { content: { "application/json": AgentKeyBody } };
      responses: {
        200: { headers: Record<string, unknown>; content: { "application/json": { key: AgentKey } } };
        default: ProblemResponse;
      };
    };
  };
}

export const agentApi = createApi<AgentPaths>();
