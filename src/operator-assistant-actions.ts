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
import {
  normalizeRepoAgentProviderSetting,
  repoEffortFitsProvider,
  repoModelFitsProvider,
  resolveSpawnAgentProvider,
  type RepoAgentProviderSetting,
} from "./agent-provider";
import { config } from "./config";
import { effortsForProvider, normalizeRepoDefaultEffortSetting } from "./default-effort";
import { normalizeRepoDefaultModelSetting } from "./default-model";
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
import { PROFILE_RANK, SANDBOX_PROFILES, type SandboxProfile } from "./sandbox";
import {
  daysToMask,
  DEFAULT_LAUNCH,
  SCHEDULE_LAUNCH_KEYS,
  WEEKDAYS,
  type Schedule,
  type ScheduleInput,
  type ScheduleLaunch,
} from "./schedules-core";
import { AGENT_PROVIDERS, EFFORTS, MODELS_BY_PROVIDER, type AgentProvider } from "./types";

export interface OperatorActionRequest {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
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

/** A schedule's firing sandbox and its repo's own, or the create validator's refusal. */
export type ScheduleProfiles = { spawn: SandboxProfile; repo: SandboxProfile } | { error: string };

/** What the action tools need beyond the store: the operator's current settings, a repo's New
 *  Task defaults, a way to run an operator route in-process, and the sandbox a schedule's firing
 *  would spawn under. Absent ⇒ every action answers "unavailable". */
export interface OperatorActionDeps {
  permissions(): AssistantPermissions;
  taskDefaults(repoPath: string): TaskDefaults;
  dispatch(req: OperatorActionRequest): Promise<{ status: number; body: unknown }>;
  /** The profile a firing of this schedule spawns under (the server's spawnProfile over the
   *  schedule's create input) and its repo's own (repoEffectiveProfile). */
  scheduleProfiles(s: Pick<ScheduleInput, "repoPath" | "prompt" | "launch">): ScheduleProfiles;
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
  /** A stored schedule this assistant may reach. */
  schedule(id: unknown): Schedule | Fail;
  /** A session's designation, or null once it is gone. */
  desig(sessionId: string): string | null;
  scheduleProfiles: OperatorActionDeps["scheduleProfiles"];
  /** The coding CLI a repo's new starts run with its CLI set to `setting` (absent ⇒ the stored
   *  one): that CLI, or the global default for "inherit". */
  repoCli(repoPath: string, setting?: RepoAgentProviderSetting): AgentProvider;
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
  "agentProvider",
  "defaultModel",
  "defaultEffort",
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

const SCHEDULE_FIELDS = ["name", "prompt", "days", "times", "enabled"] as const;
/** The launch options that decide a firing's sandbox: an explicit Codex provider runs trusted,
 *  research opens an autonomous repo's egress (SessionService.spawnProfile). */
const SANDBOX_LAUNCH_KEYS = ["agentProvider", "research", "sandboxProfile"] as const;
const CREATE_REQUIRED = ["name", "prompt", "days", "times"] as const;
const CREATE_ARGS = new Set<string>(["repo", ...SCHEDULE_FIELDS, ...SCHEDULE_LAUNCH_KEYS]);
const UPDATE_ARGS = new Set<string>(["scheduleId", ...SCHEDULE_FIELDS, ...SCHEDULE_LAUNCH_KEYS]);

interface ScheduleFields {
  /** The top-level fields given, days as the mask. */
  fields: Record<string, unknown>;
  /** The launch options given; null = the default at fire time. */
  launch: Partial<ScheduleLaunch>;
}

/** Each top-level schedule field's shape check: the value the route gets (days as the mask), or
 *  the argument error. */
const SCHEDULE_FIELD_CHECKS: Record<(typeof SCHEDULE_FIELDS)[number], (v: unknown) => unknown> = {
  name: (v) => nonEmptyText(v, "name"),
  prompt: (v) => nonEmptyText(v, "prompt"),
  days: (v) =>
    (Array.isArray(v) && daysToMask(v)) ||
    fail(400, `days must be a non-empty array of ${WEEKDAYS.join(", ")}`),
  times: (v) => (Array.isArray(v) ? v : fail(400, 'times must be an array of "HH:MM" strings')),
  enabled: (v) => (typeof v === "boolean" ? v : fail(400, "enabled must be a boolean")),
};

/** The schedule fields among the agent's arguments, shaped for the schedules routes: weekday names
 *  become the mask, launch options go under `launch`. The route's validator stays the authority on
 *  times, lengths, the prompt and the launch values; this only shapes the arguments. */
function scheduleFields(
  args: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): ScheduleFields | Fail {
  const stray = Object.keys(args).filter((k) => !allowed.has(k));
  if (stray.length > 0) return fail(400, `not settable here: ${stray.join(", ")}`);
  const fields: Record<string, unknown> = {};
  for (const key of SCHEDULE_FIELDS) {
    if (args[key] === undefined) continue;
    const value = SCHEDULE_FIELD_CHECKS[key](args[key]);
    if (isFail(value)) return value;
    fields[key] = value;
  }
  const base = args.baseBranch;
  if (base !== undefined && base !== null && isFail(nonEmptyText(base, "baseBranch")))
    return fail(400, "baseBranch must be a non-empty string or null");
  const launch = Object.fromEntries(
    SCHEDULE_LAUNCH_KEYS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]),
  ) as Partial<ScheduleLaunch>;
  return { fields, launch };
}

/** A schedule route's body: the fields, plus `launch` only when an option was given. */
const scheduleRouteBody = ({ fields, launch }: ScheduleFields) => ({
  ...fields,
  ...(Object.keys(launch).length > 0 && { launch }),
});

/**
 * An assistant's schedule change may tighten a firing's sandbox, never loosen it below both the
 * repo's profile and the schedule's current one (a create's current one is the repo's). Mirrors the
 * below-`full` token rule (server.ts tokenProfileError → sandboxOverrideRefused); loosening stays
 * the operator's. Only a change to a SANDBOX_LAUNCH_KEYS option is checked: no other field moves
 * the profile, so an operator-loosened schedule stays editable.
 */
function sandboxRefusal(
  resolve: Resolve,
  given: Partial<ScheduleLaunch>,
  next: Pick<ScheduleInput, "repoPath" | "prompt" | "launch">,
  current: Schedule | null,
): Fail | null {
  if (!SANDBOX_LAUNCH_KEYS.some((k) => given[k] !== undefined)) return null;
  const after = resolve.scheduleProfiles(next);
  if ("error" in after) return fail(400, after.error);
  // A current launch the validator now refuses sets no floor of its own: the repo's holds.
  const before = current ? resolve.scheduleProfiles(current) : null;
  const floor = Math.min(
    PROFILE_RANK[after.repo],
    before && !("error" in before) ? PROFILE_RANK[before.spawn] : PROFILE_RANK[after.repo],
  );
  if (PROFILE_RANK[after.spawn] >= floor) return null;
  return fail(
    403,
    `sandbox_override_not_allowed: these launch options would run each firing ${after.spawn}, ` +
      `below the repo's ${after.repo} profile — loosening a schedule's sandbox stays the ` +
      "operator's (Repo automation → Schedules)",
  );
}

const schedulePath = (id: string, sub = "") =>
  `/api/schedules/${encodeURIComponent(id)}${sub ? `/${sub}` : ""}`;
const scheduleTarget = (repoPath: string, name: string) =>
  `${basename(repoPath)} schedule ${JSON.stringify(name)}`;

const record = (body: unknown) =>
  (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

/** A created or edited schedule's answer: its id, whether it is on and its next firing — never the
 *  stored row. */
function scheduleAnswer(body: unknown): Record<string, unknown> {
  const b = record(body);
  return {
    ...(typeof b.id === "string" && { scheduleId: b.id }),
    ...(typeof b.enabled === "boolean" && { enabled: b.enabled }),
    nextAt: typeof b.nextAt === "number" ? new Date(b.nextAt).toISOString() : null,
  };
}

/**
 * repo_automation_set's coding-CLI fields (#3442): each must be a valid setting, and a model or
 * effort must run on the CLI the repo uses after this change (the patched agentProvider, else the
 * stored one, else the global default). The route would store an unfit one and every spawn would
 * then skip it, so it is refused here with the values that do fit. Null when the patch passes.
 */
function runDefaultsRefusal(
  patch: Record<string, unknown>,
  repoPath: string,
  resolve: Resolve,
): Fail | null {
  const { agentProvider, defaultModel, defaultEffort } = patch;
  if (agentProvider !== undefined && normalizeRepoAgentProviderSetting(agentProvider) === null)
    return fail(400, `agentProvider must be one of: inherit, ${AGENT_PROVIDERS.join(", ")}`);
  if (defaultModel !== undefined && normalizeRepoDefaultModelSetting(defaultModel) === null)
    return fail(400, "defaultModel must be inherit, auto, default or a model alias");
  if (defaultEffort !== undefined && normalizeRepoDefaultEffortSetting(defaultEffort) === null)
    return fail(400, `defaultEffort must be one of: inherit, default, ${EFFORTS.join(", ")}`);
  if (defaultModel === undefined && defaultEffort === undefined) return null;
  const cli = resolve.repoCli(repoPath, agentProvider as RepoAgentProviderSetting | undefined);
  const where = `${cli}, the coding CLI ${basename(repoPath)} uses after this change`;
  const hint = agentProvider === undefined ? "; to switch the CLI as well, pass agentProvider" : "";
  if (defaultModel !== undefined && !repoModelFitsProvider(defaultModel as string, cli)) {
    const models = MODELS_BY_PROVIDER[cli].join(", ");
    return fail(
      400,
      `defaultModel "${defaultModel as string}" does not run on ${where} — use inherit, auto, ` +
        `default or a ${cli} model: ${models}${hint}`,
    );
  }
  if (defaultEffort !== undefined && !repoEffortFitsProvider(defaultEffort as string, cli)) {
    const efforts = effortsForProvider(cli).join(", ");
    return fail(
      400,
      `defaultEffort "${defaultEffort as string}" does not run on ${where} — use inherit, ` +
        `default or one of: ${efforts}${hint}`,
    );
  }
  return null;
}

/** A run-now's answer: its outcome, the started session's desig (never its id) and the reason,
 *  redacted and clipped — it can carry a launch error. */
function runAnswer(body: unknown, resolve: Resolve): Record<string, unknown> {
  const b = record(body);
  const desig = typeof b.sessionId === "string" ? resolve.desig(b.sessionId) : null;
  return {
    ...(typeof b.outcome === "string" && { outcome: b.outcome }),
    ...(desig && { desig }),
    ...(typeof b.reason === "string" && { reason: redactedClip(b.reason) }),
  };
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
    const refusal = runDefaultsRefusal(patch, repo, resolve);
    if (refusal) return refusal;
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
  issue_create: (args, resolve) => {
    const stray = Object.keys(args).filter((k) => !["repo", "title", "body"].includes(k));
    if (stray.length > 0) return fail(400, `not settable here: ${stray.join(", ")}`);
    const repo = resolve.repo(args.repo);
    if (isFail(repo)) return repo;
    if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 200)
      return fail(400, "title must be a non-empty string ≤ 200 chars");
    if (typeof args.body !== "string" || args.body.length > 16000)
      return fail(400, "body must be a string ≤ 16000 chars");
    return {
      requests: [
        {
          method: "POST",
          path: "/api/issues",
          body: { repo, title: args.title.trim(), body: args.body },
        },
      ],
      target: repo,
      bind: { repo },
      answer: (body) => {
        const b = (typeof body === "object" && body !== null ? body : {}) as Record<
          string,
          unknown
        >;
        return {
          ...(Number.isSafeInteger(b.number) && (b.number as number) > 0 && { number: b.number }),
          ...(typeof b.url === "string" && { url: b.url }),
          ...(typeof b.slug === "string" && { slug: b.slug }),
        };
      },
    };
  },
  schedule_create: (args, resolve) => {
    const repo = resolve.repo(args.repo);
    if (isFail(repo)) return repo;
    const missing = CREATE_REQUIRED.filter((k) => args[k] === undefined);
    if (missing.length > 0) return fail(400, `missing: ${missing.join(", ")}`);
    const shaped = scheduleFields(args, CREATE_ARGS);
    if (isFail(shaped)) return shaped;
    const name = shaped.fields.name as string;
    const next = {
      repoPath: repo,
      prompt: shaped.fields.prompt as string,
      launch: { ...DEFAULT_LAUNCH, ...shaped.launch },
    };
    const refused = sandboxRefusal(resolve, shaped.launch, next, null);
    if (refused) return refused;
    return {
      requests: [
        {
          method: "POST",
          path: "/api/schedules",
          body: { repoPath: repo, ...scheduleRouteBody(shaped) },
        },
      ],
      target: scheduleTarget(repo, name),
      echo: { days: args.days, times: args.times },
      answer: scheduleAnswer,
    };
  },
  // PATCH merges the given fields and launch options over the stored ones; the route re-baselines
  // a cadence change or an enable, so slots already past never fire.
  schedule_update: (args, resolve) => {
    const s = resolve.schedule(args.scheduleId);
    if (isFail(s)) return s;
    const shaped = scheduleFields(args, UPDATE_ARGS);
    if (isFail(shaped)) return shaped;
    const changed = Object.keys(args).filter((k) => k !== "scheduleId");
    if (changed.length === 0) {
      return fail(
        400,
        `set at least one of ${[...SCHEDULE_FIELDS, ...SCHEDULE_LAUNCH_KEYS].join(", ")}`,
      );
    }
    const next = {
      repoPath: s.repoPath,
      prompt: (shaped.fields.prompt as string | undefined) ?? s.prompt,
      launch: { ...s.launch, ...shaped.launch },
    };
    const refused = sandboxRefusal(resolve, shaped.launch, next, s);
    if (refused) return refused;
    return {
      requests: [{ method: "PATCH", path: schedulePath(s.id), body: scheduleRouteBody(shaped) }],
      target: scheduleTarget(s.repoPath, s.name),
      echo: { changed },
      answer: scheduleAnswer,
    };
  },
  schedule_delete: (args, resolve) => {
    const s = resolve.schedule(args.scheduleId);
    if (isFail(s)) return s;
    return {
      requests: [{ method: "DELETE", path: schedulePath(s.id) }],
      target: scheduleTarget(s.repoPath, s.name),
    };
  },
  // The operator's Run now: fires even a disabled schedule, still skipped while its last run is open.
  schedule_run: (args, resolve) => {
    const s = resolve.schedule(args.scheduleId);
    if (isFail(s)) return s;
    return {
      requests: [{ method: "POST", path: schedulePath(s.id, "run") }],
      target: scheduleTarget(s.repoPath, s.name),
      answer: (body) => runAnswer(body, resolve),
    };
  },
};

/**
 * How a repo-scoped assistant's actions stay in its repo, per tool:
 *  - every desig-targeted tool (steer, plan_answer, the sessions and approve groups,
 *    session_automation_set) and herd_retry (by desigs) resolve through `session()`, which refuses
 *    a session of another repo;
 *  - session_start, repo_automation_set, epic_run_set, schedule_create and issue_create resolve through
 *    `repo()`, which refuses another repo;
 *  - held_task resolves through `held()`, which refuses another repo's held task;
 *  - schedule_update, schedule_delete and schedule_run resolve through `schedule()`, which refuses
 *    another repo's schedule;
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
    repoCli: (repoPath, setting) =>
      resolveSpawnAgentProvider(
        undefined,
        setting ?? deps.store.getRepoConfig(repoPath).agentProvider,
        config.defaultAgentProvider,
      ),
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
    schedule(id) {
      const s = typeof id === "string" ? deps.store.getSchedule(id) : null;
      if (!s) {
        return fail(
          404,
          `schedule "${String(id)}" not found — repo_automation lists schedules with their id`,
        );
      }
      return inScope(scope, s.repoPath) ? s : outsideScope(`schedule "${s.id}"`, scope!);
    },
    desig: (sessionId) => deps.store.get(sessionId)?.desig ?? null,
    scheduleProfiles: (s) => deps.operatorActions!.scheduleProfiles(s),
  };
}

/** Text from a route the agent reads: redacted and clipped. */
function redactedClip(text: string): string {
  const clean = redactSecretText(text);
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

/** A route's refusal as the agent reads it: `code: error`, redacted and clipped. */
function routeError(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; code?: unknown };
  const error = typeof b.error === "string" ? b.error : `HTTP ${status}`;
  return redactedClip(typeof b.code === "string" ? `${b.code}: ${error}` : error);
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
  if (deps.store.getSetting(`assistantHandoff:${caller.sessionId}`)) {
    return fail(
      409,
      "Conversation transferred. Wait for a fresh operator request before taking actions; never replay actions from the handoff.",
    );
  }
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
  return dispatchOperatorAction(actions, tool, built);
}

async function dispatchOperatorAction(
  actions: OperatorActionDeps,
  tool: AssistantActionTool,
  built: Built,
): Promise<ApplyResult<unknown>> {
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

const SCHEDULE_ID = {
  type: "string",
  description: "The schedule's id, as repo_automation lists it.",
};
const SCHEDULE_FIELD_PROPS = {
  name: { type: "string", description: "A short name, up to 80 chars." },
  prompt: {
    type: "string",
    description: "What each run's agent gets. Self-contained: it sees nothing of this chat.",
  },
  days: {
    type: "array",
    minItems: 1,
    items: { type: "string", enum: [...WEEKDAYS] },
    description: "Weekdays it fires on.",
  },
  times: {
    type: "array",
    minItems: 1,
    maxItems: 12,
    items: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    description: 'Server-local "HH:MM" times, e.g. ["09:00"].',
  },
};
/** A schedule's launch options, flat; each run starts as New Task would with them. */
const SCHEDULE_LAUNCH_PROPS = {
  agentProvider: {
    type: ["string", "null"],
    enum: [...AGENT_PROVIDERS, null],
    description:
      "null: the repo's coding CLI at fire time, else the operator's default. An explicit codex " +
      "runs unsandboxed.",
  },
  model: { type: ["string", "null"], description: "null: the default model at fire time." },
  effort: { type: ["string", "null"], description: "null: the default effort at fire time." },
  autopilotEnabled: {
    type: ["boolean", "null"],
    description: "true runs unattended; null inherits the repo default. Default false.",
  },
  planGateEnabled: { type: ["boolean", "null"], description: "null inherits the repo default." },
  research: { type: "boolean", description: "A research run instead of a code task." },
  sandboxProfile: {
    type: ["string", "null"],
    enum: [...SANDBOX_PROFILES, null],
    description: "null inherits the repo's profile.",
  },
  baseBranch: {
    type: ["string", "null"],
    description: "The branch each run starts from; null: the repo's default branch.",
  },
};
const SCHEDULE_SANDBOX_NOTE =
  "Launch options may tighten a run's sandbox, never loosen it below the repo's profile " +
  "(sandbox_override_not_allowed: loosening is the operator's).";

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
    description:
      "[automation] Change a repo's automation settings and its coding CLI, default model and " +
      "effort (what repo_automation reports). A model or effort the repo's CLI after the change " +
      "can't run is refused; switching agentProvider resets a stored one it can't run to " +
      "inherit. Applies from the next start: running sessions keep their CLI. Verify with " +
      `repo_automation's nextDrainStart.${NOTE}`,
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
        agentProvider: {
          type: "string",
          enum: ["inherit", ...AGENT_PROVIDERS],
          description: "The repo's coding CLI for new starts; inherit follows the global default.",
        },
        defaultModel: {
          type: "string",
          description:
            "inherit, auto, default or a model alias of the repo's CLI (claude: opus, sonnet, …; " +
            "codex: gpt-…).",
        },
        defaultEffort: {
          type: "string",
          enum: ["inherit", "default", ...EFFORTS],
          description: "ultra runs on codex only.",
        },
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
  {
    name: "schedule_create",
    description:
      "[automation] Create a repo schedule: on the given weekdays and times Shepherd starts a " +
      "fresh session with the prompt (a task or a /skill), as the operator's Repo automation → " +
      "Schedules would. Times are the SERVER's local time; the answer's nextAt " +
      "(ISO, UTC) is the first firing — tell the operator. Launch options not given take the " +
      "operator's defaults at fire time, autopilot off (attended). " +
      SCHEDULE_SANDBOX_NOTE +
      " Check repo_automation's schedules first: never duplicate one." +
      NOTE,
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        ...SCHEDULE_FIELD_PROPS,
        ...SCHEDULE_LAUNCH_PROPS,
        enabled: { type: "boolean", description: "Default true." },
      },
      required: ["repo", "name", "prompt", "days", "times"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_update",
    description:
      "[automation] Edit a repo schedule (repo_automation lists its id and current fields): pass " +
      "only what changes; launch options merge over the stored ones, null resets one to its " +
      "default. Changing days or times, or enabling it, never fires slots already past. Answers " +
      "enabled and nextAt (ISO, UTC) — tell the operator. " +
      SCHEDULE_SANDBOX_NOTE +
      NOTE,
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: SCHEDULE_ID,
        ...SCHEDULE_FIELD_PROPS,
        ...SCHEDULE_LAUNCH_PROPS,
        enabled: { type: "boolean", description: "false pauses it; true resumes it." },
      },
      required: ["scheduleId"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_delete",
    description:
      "[automation] Delete a repo schedule and its run history. Only when the operator asked to " +
      "delete exactly this one; to pause it, schedule_update with enabled false." +
      NOTE,
    inputSchema: {
      type: "object",
      properties: { scheduleId: SCHEDULE_ID },
      required: ["scheduleId"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_run",
    description:
      "[automation] Fire a repo schedule now, outside its cadence — even a disabled one (the " +
      "operator's Run now). Answers the outcome: spawned (with the new session's desig), held " +
      "(queued by the usage or capacity hold), skipped:overlap (its previous run is still open) " +
      "or error (with the reason)." +
      NOTE,
    inputSchema: {
      type: "object",
      properties: { scheduleId: SCHEDULE_ID },
      required: ["scheduleId"],
      additionalProperties: false,
    },
  },
  {
    name: "issue_create",
    description:
      "[automation] Create an issue in the explicitly named repo. Returns its number, URL and slug. " +
      "Ask the operator if the target is unclear. Creates no queue entry or session. Report success " +
      "only with the returned issue URL; never blindly retry a failed or uncertain write." +
      NOTE,
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 16000 },
      },
      required: ["repo", "title", "body"],
      additionalProperties: false,
    },
  },
];
