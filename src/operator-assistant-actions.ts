/**
 * The Operator Assistant's action tools (Settings → Assistant): steering, starting sessions,
 * session control, approvals and merge, automation. Served on the assistant's own MCP endpoint and
 * nobody else's (`AgentCapabilities.operatorActions`, src/agent-control.ts) — no herd agent ever
 * gets an approve or merge tool.
 *
 * Each tool is a thin, declarative mapping onto an EXISTING operator route, dispatched in-process
 * through the full app (`OperatorActionDeps.dispatch`, wired in src/server.ts). So an action runs
 * the very guards, events and error codes the operator's own button does, and cannot drift from
 * it. What this module adds on top:
 *  - the gate: a group set to `off` is refused here, per call, before anything is dispatched —
 *    whatever Claude's own permission rules say or how fast it re-reads them — and a group set to
 *    `ask` runs only once the operator approves that exact call in the HUD (an Action Request,
 *    src/action-request.ts; audit F08). Claude's own rule for `ask` groups is `allow`, so the
 *    operator is asked once, by the server;
 *  - target resolution: sessions by desig, and only herd sessions (live, an agent, not the
 *    assistant itself, never another machine's); repos by path or unique basename;
 *  - the repo scope: a repo-scoped assistant reaches only its repo's sessions, held tasks and
 *    repo settings, starts sessions only there, and takes no herd-wide action (see
 *    HERD_WIDE_ACTIONS);
 *  - bounded answers: never a route's body (session rows carry ids and prompts), only whitelisted
 *    scalars, and route errors redacted and clipped;
 *  - one audit line per action in Shepherd's log.
 *
 * Agent-facing English, no i18n — same precedent as the other tool descriptions.
 */
import { basename } from "node:path";
import { parseIssueDrainOperation } from "./issue-drain";
import type { AgentControlDeps, ApplyResult, McpTool } from "./agent-control";
import type { GitState } from "./forge/types";
import {
  actionGroupOf,
  type AssistantActionTool,
  type AssistantPermissions,
} from "./operator-assistant-permissions";
import {
  inScope,
  isHerdSession,
  resolveRepos,
  resolveScopedRepo,
  type AssistantScope,
} from "./operator-assistant-tools";
import { redactSecretText } from "./redact";
import type { AgentProvider } from "./types";

export interface OperatorActionRequest {
  method: "POST" | "PUT" | "DELETE";
  /** Path plus query, e.g. `/api/repo-config?repo=%2Fr%2Falpha`. */
  path: string;
  /** JSON body; absent ⇒ no body. */
  body?: unknown;
}

/** What New Task would preselect for a repo: its default branch and the operator's default
 *  provider, model and effort. `session_start` sends it; the create route decides the rest. */
export interface TaskDefaults {
  baseBranch: string;
  agentProvider: AgentProvider;
  model: string | null;
  effort: string | null;
}

/** What the action tools need beyond the store: the operator's current settings, a repo's New
 *  Task defaults, and a way to run an operator route in-process. Absent ⇒ every action answers
 *  "unavailable". */
export interface OperatorActionDeps {
  permissions(): AssistantPermissions;
  taskDefaults(repoPath: string): TaskDefaults;
  dispatch(req: OperatorActionRequest): Promise<{ status: number; body: unknown }>;
  /** The audit line sink; default `console.info` (Shepherd's log). */
  log?: (line: string) => void;
}

type ActionDeps = Pick<
  AgentControlDeps,
  "store" | "operatorActions" | "operatorDiag" | "actionRequests" | "actionWaitMs" | "prCache"
>;

/** One `ask` call's wait window. Claude Code's HTTP MCP transport aborts a call at a hard 60s,
 *  so stay under it and let the model call again. */
const ACTION_WAIT_MS = 50_000;

const ACTION_PENDING_NEXT =
  "The operator has not answered yet. Tell them it is waiting for their approval in the " +
  "assistant panel, then call this tool again with exactly the same arguments to keep waiting.";

/** Who is calling: the assistant session, its repo scope (null = the global assistant) and the
 *  HTTP call's abort signal (ends an approval wait early). */
export interface ActionCaller {
  sessionId: string;
  scope: AssistantScope;
  signal?: AbortSignal;
}

type Fail = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

/** A built action: the request(s) to run in order, the target named in answers and the log, any
 *  argument echo for the answer, and the fields its last route body may add (answerFields when
 *  absent). `bind` is state the server captured for the call (a merge's PR revision): it joins the
 *  arguments an `ask` approval is bound to and shows, so a call built on other state needs its own. */
interface Built {
  requests: OperatorActionRequest[];
  target: string;
  echo?: Record<string, unknown>;
  answer?: (body: unknown) => Record<string, unknown>;
  bind?: Record<string, unknown>;
}

interface Resolve {
  session(desig: unknown): { id: string; desig: string } | Fail;
  repo(repo: unknown): string | Fail;
  held(id: unknown): string | Fail;
  /** The session's cached PR state, if any. */
  pr(sessionId: string): GitState | undefined;
  taskDefaults(repoPath: string): TaskDefaults;
}

type Builder = (args: Record<string, unknown>, resolve: Resolve) => Built | Fail;

const MAX_ERROR_CHARS = 500;
/** Scalars a route answer may carry back: counts and the plan-answer delivery flag. Nothing else of
 *  a route's body reaches the agent. */
const ANSWER_FIELDS = ["delivered", "halted", "resumed", "steered", "total"] as const;
const REPO_AUTOMATION_FIELDS = [
  "autoDrainEnabled",
  "autoMergeEnabled",
  "maxAuto",
  "autoLabel",
  "criticEnabled",
  "usageCeilingPct",
] as const;

const sessionPath = (id: string, sub = "") => `/api/sessions/${id}${sub ? `/${sub}` : ""}`;
const isFail = (x: unknown): x is Fail =>
  typeof x === "object" && x !== null && (x as Fail).ok === false;

/** A one-request action on one session. */
function onSession(
  method: OperatorActionRequest["method"],
  sub: string,
  body?: (args: Record<string, unknown>) => unknown | Fail,
): Builder {
  return (args, resolve) => {
    const s = resolve.session(args.desig);
    if (isFail(s)) return s;
    const payload = body?.(args);
    if (isFail(payload)) return payload;
    return {
      requests: [{ method, path: sessionPath(s.id, sub), ...(body && { body: payload }) }],
      target: s.desig,
    };
  };
}

function nonEmptyText(value: unknown, name: string): string | Fail {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : fail(400, `${name} must be a non-empty string`);
}

const toggle = (v: unknown) => v === true || v === false || v === null;

/** A create's answer: the new session's desig, or the held task's id when the usage hold queued
 *  it — never the session row. */
function startAnswer(body: unknown): Record<string, unknown> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.held === true && typeof b.id === "string") return { held: true, heldId: b.id };
  return typeof b.desig === "string" ? { desig: b.desig } : {};
}

const ACTIONS: Record<AssistantActionTool, Builder> = {
  // ── steer ──
  session_steer: onSession("POST", "reply", (a) => {
    const text = nonEmptyText(a.text, "text");
    return isFail(text) ? text : { text };
  }),
  plan_answer: onSession("POST", "answer-plan-questions", (a) =>
    Array.isArray(a.answers) && a.answers.length > 0
      ? { answers: a.answers }
      : fail(400, "answers must be a non-empty array"),
  ),

  // ── start ──
  // New Task's create with what New Task would preselect; plan gate, autopilot and sandbox follow
  // the repo's settings, and the usage hold applies as for the operator.
  session_start: (args, resolve) => {
    const repo = resolve.repo(args.repo);
    if (isFail(repo)) return repo;
    const prompt = nonEmptyText(args.prompt, "prompt");
    if (isFail(prompt)) return prompt;
    if (args.baseBranch !== undefined) {
      const base = nonEmptyText(args.baseBranch, "baseBranch");
      if (isFail(base)) return base;
    }
    const defaults = resolve.taskDefaults(repo);
    const baseBranch = (args.baseBranch as string | undefined) ?? defaults.baseBranch;
    return {
      requests: [
        {
          method: "POST",
          path: "/api/sessions",
          body: { ...defaults, repoPath: repo, baseBranch, prompt },
        },
      ],
      target: basename(repo),
      echo: { baseBranch },
      answer: startAnswer,
    };
  },

  // ── sessions ──
  session_interrupt: onSession("POST", "interrupt"),
  session_resume: onSession("POST", "resume", () => ({})),
  // No body: the quick relaunch (same prompt, model and settings).
  session_relaunch: onSession("POST", "relaunch"),
  // No `reap`: the archive never kills the session's leftover processes on the agent's say-so.
  session_archive: onSession("DELETE", ""),

  // ── approve ──
  plan_release: onSession("POST", "go"),
  queue_approve: onSession("POST", "queue/approve"),
  pr_ready: onSession("POST", "git/ready"),
  // The confirm binds the merge to the PR revision captured here — and, under `ask`, approved —
  // so a head or base that moved since is refused (merge_confirm_stale) and the forge enforces
  // the head (audit run-2 R2-F05). Never a takeover: taking over a merge someone else is
  // responsible for stays the operator's decision, so the route answers merge_confirm_required
  // and the agent hands it back.
  pr_merge: (args, resolve) => {
    const s = resolve.session(args.desig);
    if (isFail(s)) return s;
    const pr = resolve.pr(s.id);
    if (pr?.state !== "open" || !pr.number || !pr.headSha) {
      return fail(409, `no open PR with a known head on ${s.desig} — refresh and retry`);
    }
    const base = pr.baseRefName ?? null;
    return {
      requests: [
        {
          method: "POST",
          path: sessionPath(s.id, "git/merge"),
          body: { confirm: { headSha: pr.headSha, baseRefName: base } },
        },
      ],
      target: `${s.desig} PR #${pr.number} @ ${pr.headSha.slice(0, 12)}${base ? ` → ${base}` : ""}`,
      bind: { pr: { number: pr.number, headSha: pr.headSha, baseRefName: base } },
    };
  },

  // ── automation ──
  repo_automation_set: (args, resolve) => {
    const repo = resolve.repo(args.repo);
    if (isFail(repo)) return repo;
    const extra = Object.keys(args).filter(
      (k) => k !== "repo" && !(REPO_AUTOMATION_FIELDS as readonly string[]).includes(k),
    );
    if (extra.length > 0) {
      return fail(
        400,
        `not settable here: ${extra.join(", ")} — only ${REPO_AUTOMATION_FIELDS.join(", ")}`,
      );
    }
    const patch = Object.fromEntries(
      REPO_AUTOMATION_FIELDS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]),
    );
    if (Object.keys(patch).length === 0) {
      return fail(400, `set at least one of ${REPO_AUTOMATION_FIELDS.join(", ")}`);
    }
    return {
      requests: [
        { method: "PUT", path: `/api/repo-config?repo=${encodeURIComponent(repo)}`, body: patch },
      ],
      target: basename(repo),
      echo: { set: patch },
    };
  },
  drain_enqueue: (args, resolve) => {
    const repo = resolve.repo(args.repo);
    if (isFail(repo)) return repo;
    const { issueNumber, ...raw } = args;
    delete raw.repo;
    if (!Number.isSafeInteger(issueNumber) || (issueNumber as number) < 1)
      return fail(400, "issueNumber must be a positive safe integer");
    const payload = parseIssueDrainOperation(raw);
    if (!payload) return fail(400, "invalid drain operation or unexpected fields");
    return {
      requests: [
        {
          method: "POST",
          path: `/api/issues/${issueNumber}/drain?repo=${encodeURIComponent(repo)}`,
          body: payload,
        },
      ],
      target: `${basename(repo)}#${issueNumber}`,
      echo: { issueNumber, ...payload },
    };
  },
  session_automation_set: (args, resolve) => {
    const s = resolve.session(args.desig);
    if (isFail(s)) return s;
    const requests: OperatorActionRequest[] = [];
    const echo: Record<string, unknown> = {};
    for (const [arg, sub] of [
      ["autopilot", "autopilot"],
      ["autoMerge", "automerge"],
    ] as const) {
      if (args[arg] === undefined) continue;
      if (!toggle(args[arg])) return fail(400, `${arg} must be true, false or null`);
      requests.push({ method: "PUT", path: sessionPath(s.id, sub), body: { enabled: args[arg] } });
      echo[arg] = args[arg];
    }
    if (requests.length === 0) return fail(400, "set autopilot, autoMerge or both");
    return { requests, target: s.desig, echo: { set: echo } };
  },
  epic_run_set: (args, resolve) => {
    const repo = resolve.repo(args.repo);
    if (isFail(repo)) return repo;
    const parent = args.epicParent;
    if (!Number.isInteger(parent) || (parent as number) < 1) {
      return fail(400, "epicParent must be a positive issue number");
    }
    if (args.status !== "running" && args.status !== "paused") {
      return fail(400, 'status must be "running" or "paused"');
    }
    return {
      requests: [
        {
          method: "PUT",
          path: `/api/epic?repo=${encodeURIComponent(repo)}&parent=${parent as number}`,
          body: { status: args.status },
        },
      ],
      target: `${basename(repo)}#${parent as number}`,
      echo: { status: args.status },
    };
  },
  held_task: (args, resolve) => {
    const id = resolve.held(args.heldId);
    if (isFail(id)) return id;
    const path = `/api/held/${encodeURIComponent(id)}`;
    if (args.action === "spawn") {
      return { requests: [{ method: "POST", path: `${path}/spawn` }], target: id };
    }
    if (args.action === "discard") return { requests: [{ method: "DELETE", path }], target: id };
    return fail(400, 'action must be "spawn" or "discard"');
  },
  herd_halt: () => ({ requests: [{ method: "POST", path: "/api/halt" }], target: "herd" }),
  herd_retry: (args, resolve) => {
    if (!Array.isArray(args.desigs) || args.desigs.length === 0) {
      return fail(400, "desigs must be a non-empty array");
    }
    const ids: string[] = [];
    const desigs: string[] = [];
    for (const d of args.desigs) {
      const s = resolve.session(d);
      if (isFail(s)) return s;
      ids.push(s.id);
      desigs.push(s.desig);
    }
    const text = typeof args.text === "string" ? args.text : "";
    return {
      requests: [{ method: "POST", path: "/api/retry", body: { text, ids } }],
      target: desigs.join(","),
    };
  },
};

/**
 * How a repo-scoped assistant's actions stay in its repo, per tool:
 *  - every desig-targeted tool (steer, plan_answer, the sessions and approve groups,
 *    session_automation_set) and herd_retry (by desigs) resolve through `session()`, which refuses
 *    a session of another repo;
 *  - session_start, repo_automation_set and epic_run_set resolve through `repo()`, which refuses
 *    another repo;
 *  - held_task resolves through `held()`, which refuses another repo's held task;
 *  - herd_halt interrupts every working session of every repo (`/api/halt` takes no target), so it
 *    is refused outright here — the global assistant halts the herd; a scoped one can interrupt
 *    its own sessions one by one.
 */
const HERD_WIDE_ACTIONS: ReadonlySet<AssistantActionTool> = new Set(["herd_halt"]);

const outsideScope = (what: string, scope: string) =>
  fail(
    403,
    `${what} is outside this assistant's repo ${basename(scope)} — the global Operator Assistant ` +
      "covers every repo; the operator can ask there",
  );

function resolver(deps: ActionDeps, scope: AssistantScope): Resolve {
  return {
    session(desig) {
      const s = typeof desig === "string" ? deps.store.getByDesig(desig) : null;
      if (!s || !isHerdSession(s)) return fail(404, `session "${String(desig)}" not found`);
      if (!inScope(scope, s.repoPath)) return outsideScope(`session "${s.desig}"`, scope!);
      return { id: s.id, desig: s.desig };
    },
    repo(repo) {
      if (typeof repo !== "string" || repo === "") return fail(400, "repo is required");
      if (scope !== null) return resolveScopedRepo(scope, repo);
      const known = deps.operatorDiag?.repos() ?? [];
      const resolved = resolveRepos(known, repo);
      if (!Array.isArray(resolved)) {
        return resolved.ok
          ? fail(500, "repo resolution failed")
          : fail(resolved.status, resolved.error);
      }
      return resolved[0]!;
    },
    taskDefaults: (repoPath) => deps.operatorActions!.taskDefaults(repoPath),
    pr: (sessionId) => deps.prCache?.get(sessionId),
    held(id) {
      const task =
        typeof id === "string" ? deps.store.listHeldTasks().find((h) => h.id === id) : undefined;
      if (!task)
        return fail(404, `held task "${String(id)}" not found — herd_status lists held tasks`);
      return inScope(scope, task.repoPath)
        ? task.id
        : outsideScope(`held task "${task.id}"`, scope!);
    },
  };
}

/** A route's refusal as the agent reads it: `code: error`, redacted and clipped. */
function routeError(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; code?: unknown };
  const error = typeof b.error === "string" ? b.error : `HTTP ${status}`;
  const text = typeof b.code === "string" ? `${b.code}: ${error}` : error;
  const clean = redactSecretText(text);
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

/** The whitelisted scalars of a route's answer — never the body itself. */
function answerFields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const out: Record<string, unknown> = {};
  for (const k of ANSWER_FIELDS) {
    const v = (body as Record<string, unknown>)[k];
    if (typeof v === "boolean" || typeof v === "number") out[k] = v;
  }
  return out;
}

/** Hold an `ask` call for the operator's approval: null once approved, else the answer to return
 *  now — denied, or still pending (the model calls again). */
async function awaitApproval(
  deps: ActionDeps,
  tool: AssistantActionTool,
  args: Record<string, unknown>,
  target: string,
  caller: ActionCaller,
): Promise<ApplyResult<unknown> | null> {
  if (!deps.actionRequests) return fail(503, "operator approvals unavailable");
  const state = deps.actionRequests.request(caller.sessionId, tool, args, target);
  const outcome =
    state.status === "open"
      ? await deps.actionRequests.wait(
          caller.sessionId,
          state.request.id,
          deps.actionWaitMs ?? ACTION_WAIT_MS,
          caller.signal,
        )
      : state.status;
  if (outcome === "approved") return null;
  if (outcome === "denied") {
    return fail(403, "the operator denied this action — do not retry it unless they ask you to");
  }
  return {
    ok: true,
    data: { status: "awaiting_approval", action: tool, target, next: ACTION_PENDING_NEXT },
  };
}

/** Run one action tool for `caller` — the assistant session and its repo scope
 *  (`Session.assistantRepo`): null for the global assistant, which reaches the whole herd. */
export async function applyOperatorAction(
  deps: ActionDeps,
  tool: AssistantActionTool,
  args: Record<string, unknown>,
  caller: ActionCaller,
): Promise<ApplyResult<unknown>> {
  const { scope } = caller;
  const actions = deps.operatorActions;
  if (!actions) return fail(503, "operator actions unavailable");
  const group = actionGroupOf(tool)!;
  const level = actions.permissions()[group];
  if (level === "off") {
    return fail(
      403,
      `${group} actions are turned off in Settings → Assistant — tell the operator that setting ` +
        "would allow it; do not work around it",
    );
  }
  if (scope !== null && HERD_WIDE_ACTIONS.has(tool)) {
    return fail(
      403,
      `${tool} acts on the whole herd, and this assistant serves only repo ${basename(scope)} — ` +
        "the global Operator Assistant can do it; here, interrupt this repo's sessions one by one " +
        "with session_interrupt",
    );
  }
  const built = ACTIONS[tool](args, resolver(deps, scope));
  if (isFail(built)) return built;
  if (level === "ask") {
    // `bind` last: the agent's own arguments never stand in for what the server captured.
    const bound = { ...args, ...built.bind };
    const answer = await awaitApproval(deps, tool, bound, built.target, caller);
    if (answer) return answer;
    // Turned off while it waited: the setting outranks a stale approval.
    if (actions.permissions()[group] === "off")
      return fail(403, `${group} actions were turned off`);
  }
  const log = actions.log ?? ((line: string) => console.info(line));
  let last: unknown = null;
  for (const req of built.requests) {
    const res = await actions.dispatch(req);
    log(`[operator-assistant] ${tool} ${built.target} → ${res.status}`);
    if (res.status >= 400) return fail(res.status, routeError(res.status, res.body));
    last = res.body;
  }
  const answer = (built.answer ?? answerFields)(last);
  return {
    ok: true,
    data: { ok: true, action: tool, target: built.target, ...built.echo, ...answer },
  };
}

// ── tool catalog ─────────────────────────────────────────────────────────────

const NOTE =
  " Acts exactly like the operator's own button. Use only when the operator asked for this " +
  "change; a group turned off in Settings → Assistant answers so — never work around it.";

const DESIG = { type: "string", description: 'Session designation, e.g. "TASK-07" or "7".' };
const REPO = { type: "string", description: "A repo's full path or its unique basename." };
const TOGGLE = {
  type: ["boolean", "null"],
  description: "true or false overrides the repo default; null inherits it.",
};

const desigTool = (name: string, group: string, what: string): McpTool => ({
  name,
  description: `[${group}] ${what}${NOTE}`,
  inputSchema: {
    type: "object",
    properties: { desig: DESIG },
    required: ["desig"],
    additionalProperties: false,
  },
});

/** The assistant's action catalog, in group order (ASSISTANT_ACTION_GROUPS; a test pins the two). */
export const OPERATOR_ACTION_TOOLS: McpTool[] = [
  {
    name: "session_steer",
    description: `[steer] Send a message into a session's agent, as the operator's steer.${NOTE}`,
    inputSchema: {
      type: "object",
      properties: { desig: DESIG, text: { type: "string", description: "The message." } },
      required: ["desig", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_answer",
    description:
      "[steer] Answer a planning session's open plan questions (herd_status with a desig lists " +
      "them: blockId, questionId, kind, options). single: one optionIndices entry; multi: any " +
      `number; freeform: text.${NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        desig: DESIG,
        answers: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              blockId: { type: "string" },
              questionId: { type: "string" },
              optionIndices: { type: "array", items: { type: "integer", minimum: 0 } },
              text: { type: "string" },
            },
            required: ["blockId", "questionId"],
            additionalProperties: false,
          },
        },
      },
      required: ["desig", "answers"],
      additionalProperties: false,
    },
  },
  {
    name: "session_start",
    description:
      "[start] Start a new session (task) in a repo, as the operator's New Task: an agent in its " +
      "own worktree works the prompt. Base branch: the repo's default unless given; model, " +
      "effort, plan gate and autopilot: the operator's defaults. Answers the new session's desig — " +
      `or heldId when the usage hold queued it.${NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        prompt: {
          type: "string",
          description:
            "The task for the new agent. Self-contained: it sees nothing of this conversation.",
        },
        baseBranch: {
          type: "string",
          description: "The branch to start from; default the repo's default branch.",
        },
      },
      required: ["repo", "prompt"],
      additionalProperties: false,
    },
  },
  desigTool("session_interrupt", "sessions", "Interrupt a working session's agent (a lone Esc)."),
  desigTool("session_resume", "sessions", "Resume a session whose agent is gone."),
  desigTool(
    "session_relaunch",
    "sessions",
    "Archive a session and start a fresh one with the same task and settings.",
  ),
  desigTool("session_archive", "sessions", "Archive (stop and close) a session."),
  desigTool(
    "plan_release",
    "approve",
    "Release a planning session whose plan the reviewer approved into execution (Go).",
  ),
  desigTool("queue_approve", "approve", "Approve a session's build queue."),
  desigTool("pr_ready", "approve", "Mark a session's draft PR ready for review."),
  desigTool(
    "pr_merge",
    "approve",
    "Merge a session's PR at the head Shepherd last saw. Never takes over a merge someone else " +
      "is responsible for: merge_confirm_required goes back to the operator. merge_confirm_stale " +
      "means the PR changed since — tell the operator; a new head needs a new approval.",
  ),
  {
    name: "repo_automation_set",
    description: `[automation] Change a repo's automation settings (what repo_automation reports).${NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        autoDrainEnabled: { type: "boolean" },
        autoMergeEnabled: { type: "boolean" },
        maxAuto: { type: "integer", minimum: 1, maximum: 20 },
        autoLabel: { type: "string" },
        criticEnabled: { type: "boolean" },
        usageCeilingPct: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
  {
    name: "drain_enqueue",
    description:
      "[automation] Enqueue or dequeue an issue using the repo's autoLabel, set high/normal/low priority (low is only a marker label; drain order does not deprioritize it), or release an orphaned claim. Enqueueing may start work immediately when Auto-Drain is on. Release refuses issues with a session, an open linked PR or an unverifiable PR state. Verify via repo_automation({repo, issueNumber})." +
      NOTE,
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        issueNumber: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        operation: { type: "string", enum: ["queue", "priority", "release"] },
        enabled: { type: "boolean", description: "Required for queue only." },
        priority: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "Required for priority only.",
        },
      },
      required: ["repo", "issueNumber", "operation"],
      additionalProperties: false,
    },
  },
  {
    name: "session_automation_set",
    description: `[automation] Set a session's autopilot and/or auto-merge override.${NOTE}`,
    inputSchema: {
      type: "object",
      properties: { desig: DESIG, autopilot: TOGGLE, autoMerge: TOGGLE },
      required: ["desig"],
      additionalProperties: false,
    },
  },
  {
    name: "epic_run_set",
    description: `[automation] Pause or resume an epic's run.${NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        epicParent: { type: "integer", minimum: 1, description: "The epic's parent issue." },
        status: { type: "string", enum: ["running", "paused"] },
      },
      required: ["repo", "epicParent", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "held_task",
    description: `[automation] Start or discard a held task (herd_status lists them with heldId).${NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        heldId: { type: "string" },
        action: { type: "string", enum: ["spawn", "discard"] },
      },
      required: ["heldId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "herd_halt",
    description: `[automation] Halt the whole herd: interrupt every working session.${NOTE}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "herd_retry",
    description: `[automation] Resume halted sessions and steer them with text.${NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        desigs: { type: "array", minItems: 1, items: { type: "string" } },
        text: { type: "string", description: "The steer each resumed session gets." },
      },
      required: ["desigs"],
      additionalProperties: false,
    },
  },
];
