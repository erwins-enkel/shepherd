/**
 * The agent→server control plane as a TOOL surface (issue #2003).
 *
 * Shepherd used to teach this control plane in English: the build-queue directive spent 3,443
 * chars of system prompt explaining `curl` invocations — and baked a literal bearer token into
 * them — while the epic-authoring directive hand-wrote a JSON body the agent had to reproduce.
 * A tool whose parameters ARE the contract (`queue_step(stepId, status)` with `status`
 * enumerated) carries the same semantics in its signature, so the prose can go.
 *
 * This module owns three things, deliberately together:
 *
 *  1. **The appliers** (`applyQueueWrite` / `applyQueueStep` / `applyEpicDraft`) — validate →
 *     store → emit, returning a transport-neutral result. Both the REST routes (src/server.ts)
 *     and the MCP tools below render these, so the two entry points cannot drift in validation,
 *     events, or status semantics.
 *  2. **The session-gated tool catalog** (`agentTools`) — a session only sees the tools its
 *     capabilities warrant (queue tools when the repo runs the build queue, the draft tool for
 *     an epic-authoring session). An empty catalog means the spawn passes no `--mcp-config` at
 *     all (see `agentMcpConfigArg` in src/service.ts), so a session with no control plane to
 *     drive pays nothing.
 *  3. **The MCP protocol handler** (`handleMcpRequest`) — a stateless streamable-HTTP MCP
 *     server: plain `application/json` JSON-RPC responses, no SSE stream, no `Mcp-Session-Id`,
 *     no server→client requests. Verified against Claude Code 2.1.220, which negotiates
 *     `initialize` → `notifications/initialized` → `tools/list` → `tools/call` over exactly this.
 *
 * Auth: none, by design and unchanged from the routes it mirrors. Agents reach Shepherd through
 * the restricted agent-ingress listener, which is exempt from the human cookie/password gate
 * (issue #1079) — the unguessable per-session id in the URL path IS the capability, exactly as
 * for `…/queue` and `…/epic-draft`. That is why no token needs to appear in prompt text.
 *
 * Agent-facing English (tool descriptions are read by the model, never rendered as operator
 * chrome), so no i18n — same precedent as the spawn directives in src/service.ts.
 */
import { validateEpicDraft } from "./epic-author";
import type { SessionStore } from "./store";
import type { BuildQueue, EpicDraft } from "./types";
import {
  BUILD_STEP_STATUSES,
  validateBuildStepStatus,
  validateBuildSteps,
  validateEpicDraftBody,
} from "./validate";

/** The slice of `AppDeps` the control plane needs. Narrow on purpose: `AppDeps` lives in
 *  src/server.ts, which imports THIS module — depending on it would close an import cycle. */
export interface AgentControlDeps {
  store: SessionStore;
  events?: { emit(event: string, data: unknown): void };
}

/** Transport-neutral outcome of an applier: the REST route renders it as a Response, the MCP
 *  tool renders it as a tool result. `matches` rides only the ambiguous-step-id 409. */
export type ApplyResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: string; matches?: string[] };

/** Author/replace the whole build queue. `body` is the raw PUT body / tool arguments —
 *  `{ steps: [...] }` — validated here so both callers share one contract. */
export function applyQueueWrite(
  deps: AgentControlDeps,
  sessionId: string,
  body: unknown,
): ApplyResult<BuildQueue> {
  const steps = validateBuildSteps(body);
  if (steps === null) return { ok: false, status: 400, error: "invalid build steps" };
  const queue = deps.store.replaceBuildQueue(sessionId, steps);
  deps.events?.emit("queue:update", queue);
  return { ok: true, data: queue };
}

/** Set one step's status. `stepId` is the agent's own id (or an unambiguous ≥8-char prefix of a
 *  server-minted UUID); `body` is `{ status }`. Resolution failures return the same 404/409 the
 *  REST route always did, with the message the agent needs to self-correct. */
export function applyQueueStep(
  deps: AgentControlDeps,
  sessionId: string,
  stepId: string,
  body: unknown,
): ApplyResult<BuildQueue> {
  const status = validateBuildStepStatus(body);
  if (status === null) return { ok: false, status: 400, error: "invalid status" };
  const resolved = deps.store.resolveStepId(sessionId, stepId);
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") {
      return {
        ok: false,
        status: 409,
        error: `ambiguous step id prefix "${stepId}" matches ${resolved.matches.length} steps — use a longer prefix or the full id`,
        matches: resolved.matches,
      };
    }
    return {
      ok: false,
      status: 404,
      error: `step "${stepId}" not found — use a full or unambiguous (≥8-char) prefix step id from the queue`,
    };
  }
  // resolved.ok ⇒ the row exists, so setBuildStepStatus returns true; ignore its boolean.
  deps.store.setBuildStepStatus(sessionId, resolved.id, status);
  const queue = deps.store.getBuildQueue(sessionId);
  deps.events?.emit("queue:update", queue);
  return { ok: true, data: queue };
}

/** Author/replace the epic draft (issue #1507). Structural then semantic (cycle/edge) validation
 *  before store; a draft that already left `draft` status is frozen, so a late re-submit cannot
 *  race a materializing/approved epic. */
export function applyEpicDraft(
  deps: AgentControlDeps,
  sessionId: string,
  body: unknown,
): ApplyResult<EpicDraft> {
  const existing = deps.store.getEpicDraft(sessionId);
  if (existing && existing.status !== "draft") {
    return { ok: false, status: 409, error: `epic draft is ${existing.status}, not editable` };
  }
  const content = validateEpicDraftBody(body);
  if (content === null) return { ok: false, status: 400, error: "invalid epic draft" };
  const semantic = validateEpicDraft(content);
  if (!semantic.ok) return { ok: false, status: 400, error: semantic.error };
  const draft = deps.store.replaceEpicDraft(sessionId, content);
  deps.events?.emit("session:epic-draft", draft);
  return { ok: true, data: draft };
}

// ── tool catalog ─────────────────────────────────────────────────────────────

/** One MCP tool as `tools/list` reports it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const STEP_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        'Your own short stable id for this step (e.g. "s1"). Resend the SAME id for a step you\'re carrying over — an id you own is stored verbatim, so it stays valid across rewrites.',
    },
    title: { type: "string", description: "One line naming the step." },
    detail: { type: "string", description: "Optional detail." },
  },
  required: ["id", "title"],
  additionalProperties: false,
} as const;

const QUEUE_WRITE: McpTool = {
  name: "queue_write",
  description:
    "Author or replace this session's build queue — the ordered plan the operator watches you " +
    "execute. Write it before starting work. Rewriting is how you revise: resend every step you " +
    "are keeping (same id — completed steps keep their status server-side) and change only steps " +
    "that are still pending. Keep the plan to a handful of steps.",
  inputSchema: {
    type: "object",
    properties: { steps: { type: "array", items: STEP_SCHEMA, maxItems: 100 } },
    required: ["steps"],
    additionalProperties: false,
  },
};

const QUEUE_STEP: McpTool = {
  name: "queue_step",
  description:
    "Set one build-queue step's status. Call it the moment you start a step (active) and again " +
    "the moment you finish it (done) — never batch the updates at the end; the operator's view of " +
    "your progress is these calls. Advancing a step auto-completes earlier pending ones. Returns " +
    "the full queue.",
  inputSchema: {
    type: "object",
    properties: {
      stepId: { type: "string", description: "The step's id, as returned by queue_write." },
      status: { type: "string", enum: [...BUILD_STEP_STATUSES] },
    },
    required: ["stepId", "status"],
    additionalProperties: false,
  },
};

const EPIC_DRAFT_CHILD_SCHEMA = {
  type: "object",
  properties: {
    key: {
      type: "string",
      description:
        'Stable temp id you assign (e.g. "c1"), referenced by other children\'s blockedBy.',
    },
    title: { type: "string" },
    body: { type: "string", description: "The goal and the vertical cut. No issue numbers." },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    blockedBy: {
      type: "array",
      items: { type: "string" },
      description: "Keys of sibling children that must land first.",
    },
  },
  required: ["key", "title"],
  additionalProperties: false,
} as const;

const EPIC_DRAFT: McpTool = {
  name: "epic_draft",
  description:
    "Submit (or re-submit) this session's epic draft for the operator to review. This is the " +
    "ONLY way the epic reaches Shepherd: you never create or edit GitHub issues yourself — the " +
    "operator approves the draft in the UI and the server materializes it, appending the " +
    "structural marker with real issue numbers. Author parent.body WITHOUT any epic-dag fence or " +
    "issue numbers. Re-submit the whole draft to amend it.",
  inputSchema: {
    type: "object",
    properties: {
      parent: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          nonGoals: { type: "array", items: { type: "string" } },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
      children: { type: "array", items: EPIC_DRAFT_CHILD_SCHEMA, maxItems: 50 },
    },
    required: ["parent", "children"],
    additionalProperties: false,
  },
};

/** What a session is allowed to drive. Kept separate from the session ROW because the spawn path
 *  needs the answer before the row exists (`create` pre-generates the id), while the request path
 *  reads it back off the row. */
export interface AgentCapabilities {
  buildQueue: boolean;
  epicDraft: boolean;
}

/** The tools those capabilities warrant, in a stable order. */
function toolsFor(caps: AgentCapabilities): McpTool[] {
  const tools: McpTool[] = [];
  if (caps.buildQueue) tools.push(QUEUE_WRITE, QUEUE_STEP);
  if (caps.epicDraft) tools.push(EPIC_DRAFT);
  return tools;
}

/** True when a session has any control plane to drive — the gate on passing `--mcp-config` at
 *  spawn/resume at all (src/service.ts). */
export function hasAgentTools(caps: AgentCapabilities): boolean {
  return toolsFor(caps).length > 0;
}

/** A stored session's capabilities; an unknown session has none. */
export function sessionCapabilities(deps: AgentControlDeps, sessionId: string): AgentCapabilities {
  const session = deps.store.get(sessionId);
  if (!session) return { buildQueue: false, epicDraft: false };
  return {
    buildQueue: deps.store.getRepoConfig(session.repoPath).buildQueueEnabled,
    epicDraft: session.epicAuthoring,
  };
}

/**
 * The tools one session may call. Recomputed per request (never cached) so a repo config flipped
 * mid-session is honored on the next `tools/list`. An unknown session gets none.
 */
export function agentTools(deps: AgentControlDeps, sessionId: string): McpTool[] {
  return toolsFor(sessionCapabilities(deps, sessionId));
}

// ── MCP protocol ─────────────────────────────────────────────────────────────

/** Protocol revision this server implements. A client asking for a different one is answered
 *  with its own version when we know it (the negotiated-down path clients expect), else this. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

const SERVER_INFO = { name: "shepherd", title: "Shepherd", version: "1" };

/** What the route should send: a JSON body at `status`, or `null` for a bodyless 202 (the
 *  correct response to a JSON-RPC notification, which by definition expects no reply). */
export interface McpOutcome {
  status: number;
  body: unknown | null;
}

function result(id: unknown, value: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: "2.0", id, result: value } };
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

/** A tool outcome as MCP reports it: applier failures come back as `isError` results (which the
 *  model sees and can correct) rather than protocol errors (which it cannot). */
function toolResult(payload: unknown, isError = false): McpOutcome["body"] {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError && { isError }),
  };
}

/** A plain JSON object, or `{}` for anything else (arrays and primitives included). */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The `initialize` result: negotiate the protocol version and advertise the tools capability. */
function initializeResult(params: Record<string, unknown>): unknown {
  const asked = params.protocolVersion;
  const protocolVersion =
    typeof asked === "string" && KNOWN_PROTOCOL_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
  };
}

/** Run one `tools/call`. A tool the session isn't entitled to is a protocol error (-32602); an
 *  applier failure is an `isError` RESULT, which the model can read and correct. */
function toolCallOutcome(
  deps: AgentControlDeps,
  sessionId: string,
  id: unknown,
  params: Record<string, unknown>,
): McpOutcome {
  const name = typeof params.name === "string" ? params.name : "";
  const args = asRecord(params.arguments);
  const entitled = agentTools(deps, sessionId).some((t) => t.name === name);
  if (!entitled) return rpcError(id, -32602, `unknown tool: ${name}`);
  const applied: ApplyResult<unknown> =
    name === "queue_write"
      ? applyQueueWrite(deps, sessionId, args)
      : name === "queue_step"
        ? applyQueueStep(deps, sessionId, String(args.stepId ?? ""), args)
        : applyEpicDraft(deps, sessionId, args);
  return result(
    id,
    applied.ok ? toolResult(applied.data) : toolResult({ error: applied.error }, true),
  );
}

/**
 * Handle one JSON-RPC request for a session's MCP endpoint. Pure over `deps` — no PTY, no
 * network, no filesystem — so the whole protocol is unit-testable against an in-memory store.
 *
 * JSON-RPC batching is deliberately unsupported: MCP removed it in 2025-06-18, and Claude Code
 * never sends one.
 */
export function handleMcpRequest(
  deps: AgentControlDeps,
  sessionId: string,
  body: unknown,
): McpOutcome {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return rpcError(null, -32600, "invalid request");
  }
  const req = body as { id?: unknown; method?: unknown; params?: unknown };
  // A notification (no id) gets no reply body at all — including every `notifications/*` the
  // client sends after initialize.
  if (req.id === undefined) return { status: 202, body: null };
  const method = typeof req.method === "string" ? req.method : "";
  const params = asRecord(req.params);

  switch (method) {
    case "initialize":
      return result(req.id, initializeResult(params));
    case "ping":
      return result(req.id, {});
    case "tools/list":
      return result(req.id, { tools: agentTools(deps, sessionId) });
    case "tools/call":
      return toolCallOutcome(deps, sessionId, req.id, params);
    default:
      return rpcError(req.id, -32601, `method not found: ${method}`);
  }
}

/**
 * The `--mcp-config` payload wiring a spawned Claude session to its own MCP endpoint. The `type`
 * is `http` (streamable HTTP): no child process to launch, nothing to bind inside the sandbox
 * membrane, and no credential — `baseUrl` is the same already-resolved agent-ingress base the
 * hooks fragment uses, so autonomous (slirp `10.0.2.2`) and trusted/standard (host loopback)
 * resolve identically here. Deliberately NOT paired with `--strict-mcp-config`, which would
 * suppress the operator's own MCP servers for every Shepherd session.
 */
export function agentMcpConfigArg(sessionId: string, baseUrl: string): string {
  return JSON.stringify({
    mcpServers: { shepherd: { type: "http", url: `${baseUrl}/api/sessions/${sessionId}/mcp` } },
  });
}
