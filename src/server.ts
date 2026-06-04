import type { SessionStore } from "./store";
import type { SessionService } from "./service";
import type { EventHub } from "./events";
import { PtyBridge } from "./pty-bridge";
import { config, SESSION_RETENTION_DAYS, SESSION_RETENTION_KEEP } from "./config";
import {
  validateCreate,
  validateCloneUrl,
  isAuthorized,
  originAllowed,
  safeRepoDir,
  parseTermDims,
  validateSteers,
  validateBroadcast,
  validateIconPatch,
} from "./validate";
import { slugifyManual } from "./namer";
import { planHouseRulesInjection, prioritize } from "./house-rules";
import { listRepos, readTodo, writeTodo, cloneRepo } from "./repos";
import { listCommands } from "./commands";
import { listDirs, validateRoot, collapseHome } from "./dirs";
import { loadSteers, saveSteers } from "./steers";
import { loadIcons, setIcon } from "./project-icons";
import { listBranches } from "./branches";
import { computeDiff } from "./diff";
import { sessionTokens, jsonlPathFor } from "./usage";
import { sessionActivity } from "./activity";
import { handleUpload } from "./uploads";
import type { UsageLimitsService } from "./usage-limits";
import type { UpdateService } from "./update";
import type { HerdrUpdateService } from "./herdr-update";
import type { Session, LearningStatus, SignalKind } from "./types";
import type { HerdrDriver } from "./herdr";
import type { GitForge, GitState, MergeMethod } from "./forge/types";
import { DEPENDABOT_REBASE_COMMAND } from "./forge/types";
import type { PrCache } from "./pr-poller";
import type { PushService } from "./push";
import type { Presence } from "./presence";
import type { StatusPoller } from "./poller";
import type { SessionActivity } from "./activity-signal";
import type { DrainStatus, QueuedItem } from "./drain";
import { countDefinedWorkflows, type CountsService, type RepoCounts } from "./backlog";
import { join, normalize } from "node:path";
import { homedir } from "node:os";
import type { ServerWebSocket } from "bun";

const UI_DIR = join(import.meta.dir, "..", "ui", "build");

async function serveStatic(pathname: string): Promise<Response> {
  // strip leading traversal, normalize
  const rel = normalize(pathname)
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/^\/+/, "");
  const target = rel === "" ? "index.html" : rel;
  const resolved = join(UI_DIR, target);
  // extra traversal guard: resolved path must stay within UI_DIR
  if (!resolved.startsWith(UI_DIR + "/") && resolved !== UI_DIR) {
    return new Response(Bun.file(join(UI_DIR, "index.html")), {
      headers: { "content-type": "text/html" },
    });
  }
  const file = Bun.file(resolved);
  const headers: Record<string, string> = {};
  if (target.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
  if (await file.exists()) return new Response(file, { headers });
  return new Response(Bun.file(join(UI_DIR, "index.html")), {
    headers: { "content-type": "text/html" },
  });
}

export interface AppDeps {
  store: SessionStore;
  service: SessionService;
  events: EventHub;
  usageLimits: Pick<UsageLimitsService, "limits">;
  /** Resolve the git forge for a repo dir; null when none is configured. */
  resolveForge?: (repoDir: string) => GitForge | null;
  /** Self-update tracker; absent in environments where it isn't wired. */
  updates?: Pick<UpdateService, "current" | "apply"> & Partial<Pick<UpdateService, "applyState">>;
  /** herdr-version tracker + applier; absent in environments where it isn't wired. */
  herdrUpdates?: Pick<HerdrUpdateService, "current" | "apply">;
  /** Herdr driver (for liveness checks). Absent in some tests; gate fails open. */
  herdr?: Pick<HerdrDriver, "list">;
  /** In-memory PR-status cache surfaced in the list overview; absent in tests
   *  that don't exercise it. */
  prCache?: PrCache;
  /** Last-emitted activity signal per running session, for client bootstrap; absent in tests that skip it. */
  activity?: { snapshot(): Record<string, SessionActivity> };
  /** Web Push delivery; absent in tests that don't exercise notifications. */
  push?: Pick<PushService, "publicKey" | "subscribe" | "unsubscribe">;
  /** Active-window tracker fed by /events presence frames; gates push suppression. */
  presence?: Pick<Presence, "set" | "drop">;
  /** Status poller; used to manually dismiss a stall flag. Absent in tests. */
  poller?: Pick<StatusPoller, "acknowledgeStall">;
  /** Snapshot of critic verdicts keyed by session id (+ in-flight run ids); absent in tests that skip it. */
  reviewCache?: {
    snapshot(): Record<string, import("./types").ReviewVerdict>;
    reviewing?(): string[];
  };
  /** Backlog counts service; absent in tests that don't exercise it. */
  backlog?: Pick<CountsService, "counts">;
  /** Learning distiller — manual trigger for the proposal pass over a repo's transcripts.
   *  Optional so environments/tests that don't wire it still type-check; the route
   *  no-ops the trigger when absent. Wired to the real DistillerService in index.ts. */
  distiller?: { distillNow: (repoPath: string) => void };
  /** Promote a curated rule into the repo's CLAUDE.md via an auto-opened PR. */
  promoter?: { promote: (id: string) => Promise<import("./promote").PromoteResult> };
  /** Self-draining work queue snapshot; absent in tests that don't exercise it. */
  drain?: {
    snapshot(): Promise<DrainStatus[]>;
    queue(repoPath: string): Promise<QueuedItem[]>;
  };
}

const sessionUsage = (s: Session) =>
  s.claudeSessionId
    ? sessionTokens(jsonlPathFor(s.worktreePath, s.claudeSessionId))
    : sessionTokens("/nonexistent"); // pre-feature session → zeroed usage

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function checkAuth(req: Request): Response | null {
  if (!isAuthorized(req.headers.get("Authorization"), config.token)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function checkOrigin(req: Request): Response | null {
  const method = req.method;
  if (method !== "POST" && method !== "DELETE" && method !== "PUT") return null;
  if (!originAllowed(req.headers.get("Origin"), config.allowedOriginHosts)) {
    return json({ error: "forbidden: origin not allowed" }, 403);
  }
  return null;
}

// Shared `Content-Type: application/json` guard. Returns the 415 Response when
// the header is absent/wrong, or null to proceed — same message everywhere.
function requireJsonContentType(req: Request): Response | null {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  return null;
}

// ── per-resource route handlers ────────────────────────────────────────────
// Each handler matches its own resource group and returns a Response when it
// owns the request, or `null` to fall through to the next handler — mirroring
// the original sequential `if`-guard chain exactly. Ordering is significant:
// some groups share a `parts[1]` prefix (e.g. `sessions`), and a handler must
// return `null` (not a 404) for sub-routes it doesn't own so a later handler
// can claim them.

type Ctx = { req: Request; parts: string[]; url: URL; deps: AppDeps };

function handleGitSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "git" && !parts[2]) {
    return json(deps.prCache?.snapshot() ?? {});
  }
  return null;
}

function handleActivitySnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "activity" && !parts[2]) {
    return json(deps.activity?.snapshot() ?? {});
  }
  return null;
}

function handleReviews({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "reviews") {
    if (!parts[2]) return json(deps.reviewCache?.snapshot() ?? {});
    // in-flight run ids so a client loading mid-review still shows the indicator
    if (parts[2] === "inflight") return json(deps.reviewCache?.reviewing?.() ?? []);
  }
  return null;
}

async function handleDrain({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "GET" && parts[0] === "api" && parts[1] === "drain")) return null;
  // GET /api/drain/queue?repo= — the backlog issues behind a repo's `queued` count
  if (parts[2] === "queue") {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    return json((await deps.drain?.queue(dir)) ?? []);
  }
  // GET /api/drain — a status per drain-enabled repo
  if (!parts[2]) return json((await deps.drain?.snapshot()) ?? []);
  return null;
}

// maxAuto: finite integer ≥ 1; clamp > 20 to 20
function parseMaxAuto(v: unknown): number | { error: string } {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
    return { error: "maxAuto must be an integer >= 1" };
  }
  return Math.min(v, 20);
}

// autoLabel: non-empty string after trim
function parseAutoLabel(v: unknown): string | { error: string } {
  if (typeof v !== "string" || v.trim() === "") {
    return { error: "autoLabel must be a non-empty string" };
  }
  return v.trim();
}

// usageCeilingPct: finite number; clamp to [0, 100], floor
function parseUsageCeiling(v: unknown): number | { error: string } {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { error: "usageCeilingPct must be a number" };
  }
  return Math.floor(Math.min(100, Math.max(0, v)));
}

// the optional boolean fields of a repo-config patch body
const REPO_CFG_BOOL_FIELDS = [
  "criticEnabled",
  "autoAddressEnabled",
  "learningsEnabled",
  "autopilotEnabled",
  "autoDrainEnabled",
] as const;

type RepoCfgBody = {
  criticEnabled?: unknown;
  autoAddressEnabled?: unknown;
  learningsEnabled?: unknown;
  autopilotEnabled?: unknown;
  autoDrainEnabled?: unknown;
  maxAuto?: unknown;
  autoLabel?: unknown;
  usageCeilingPct?: unknown;
};

// true when any present boolean field is not actually a boolean
function hasBadBoolField(body: RepoCfgBody): boolean {
  return REPO_CFG_BOOL_FIELDS.some((k) => {
    const v = body[k];
    return v !== undefined && typeof v !== "boolean";
  });
}

// Validate a repo-config PUT body → a partial patch, or the 400 Response to send.
// All fields optional but each present one must pass its type check; at least one present.
async function parseRepoConfigPatch(req: Request): Promise<
  | {
      criticEnabled?: boolean;
      autoAddressEnabled?: boolean;
      learningsEnabled?: boolean;
      autopilotEnabled?: boolean;
      autoDrainEnabled?: boolean;
      maxAuto?: number;
      autoLabel?: string;
      usageCeilingPct?: number;
    }
  | Response
> {
  const body = (await req.json().catch(() => null)) as RepoCfgBody | null;
  if (!body || hasBadBoolField(body)) {
    return json(
      {
        error:
          "boolean fields (criticEnabled/autoAddressEnabled/learningsEnabled/autopilotEnabled/autoDrainEnabled) must be booleans",
      },
      400,
    );
  }
  let maxAuto: number | undefined;
  if (body.maxAuto !== undefined) {
    const r = parseMaxAuto(body.maxAuto);
    if (typeof r !== "number") return json(r, 400);
    maxAuto = r;
  }
  let autoLabel: string | undefined;
  if (body.autoLabel !== undefined) {
    const r = parseAutoLabel(body.autoLabel);
    if (typeof r !== "string") return json(r, 400);
    autoLabel = r;
  }
  let usageCeilingPct: number | undefined;
  if (body.usageCeilingPct !== undefined) {
    const r = parseUsageCeiling(body.usageCeilingPct);
    if (typeof r !== "number") return json(r, 400);
    usageCeilingPct = r;
  }
  const present =
    REPO_CFG_BOOL_FIELDS.some((k) => body[k] !== undefined) ||
    maxAuto !== undefined ||
    autoLabel !== undefined ||
    usageCeilingPct !== undefined;
  if (!present) {
    return json(
      {
        error:
          "body must set at least one of: criticEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled, autoDrainEnabled, maxAuto, autoLabel, usageCeilingPct",
      },
      400,
    );
  }
  return {
    criticEnabled: body.criticEnabled as boolean | undefined,
    autoAddressEnabled: body.autoAddressEnabled as boolean | undefined,
    learningsEnabled: body.learningsEnabled as boolean | undefined,
    autopilotEnabled: body.autopilotEnabled as boolean | undefined,
    autoDrainEnabled: body.autoDrainEnabled as boolean | undefined,
    maxAuto,
    autoLabel,
    usageCeilingPct,
  };
}

async function handleRepoConfig({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "repo-config" && !parts[2])) return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (req.method === "GET") return json(deps.store.getRepoConfig(dir));
  if (req.method !== "PUT") return null;

  const patch = await parseRepoConfigPatch(req);
  if (patch instanceof Response) return patch;
  const cur = deps.store.getRepoConfig(dir);
  deps.store.setRepoConfig(dir, {
    criticEnabled: patch.criticEnabled ?? cur.criticEnabled,
    autoAddressEnabled: patch.autoAddressEnabled ?? cur.autoAddressEnabled,
    learningsEnabled: patch.learningsEnabled ?? cur.learningsEnabled,
    autopilotEnabled: patch.autopilotEnabled ?? cur.autopilotEnabled,
    autoDrainEnabled: patch.autoDrainEnabled ?? cur.autoDrainEnabled,
    maxAuto: patch.maxAuto ?? cur.maxAuto,
    autoLabel: patch.autoLabel ?? cur.autoLabel,
    usageCeilingPct: patch.usageCeilingPct ?? cur.usageCeilingPct,
  });
  return json(deps.store.getRepoConfig(dir));
}

// /api/learnings — list (GET ?repo=), approve/dismiss (POST :id/action), distill (POST distill ?repo=)
async function handleLearnings(ctx: Ctx): Promise<Response | null> {
  if (ctx.parts[0] !== "api" || ctx.parts[1] !== "learnings") return null;
  if (ctx.req.method === "GET") return handleLearningsGet(ctx);
  if (ctx.req.method === "POST") return handleLearningsPost(ctx);
  return null;
}

/** Flatten a captured signal payload to a short single-line preview for the
 *  drawer's evidence list (terminal tails / corrections can be multi-line). */
function evidenceExcerpt(payload: string, max = 140): string {
  const flat = payload.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function handleLearningsGet({ parts, url, deps }: Ctx): Response | null {
  // GET /api/learnings/pending — all proposed rules across repos (drawer + badge).
  // Resolve each rule's cited signal ids into provenance: a per-kind breakdown
  // plus the source session + excerpt for each signal, so the drawer shows where
  // the rule came from rather than a bare count.
  if (parts[2] === "pending") {
    const pending = deps.store.listPendingLearnings().map((l) => {
      const evidenceKinds: Partial<Record<SignalKind, number>> = {};
      const evidenceDetail = deps.store.getSignalsByIds(l.evidence).map((s) => {
        evidenceKinds[s.kind] = (evidenceKinds[s.kind] ?? 0) + 1;
        return {
          kind: s.kind,
          desig: s.sessionId ? (deps.store.get(s.sessionId)?.desig ?? null) : null,
          excerpt: evidenceExcerpt(s.payload),
          ts: s.ts,
        };
      });
      return { ...l, evidenceKinds, evidenceDetail };
    });
    return json(pending);
  }

  // GET /api/learnings/injectable — cross-repo injected/over-budget view (drawer).
  // One entry per repo with ≥1 active/promoted rule; the budget value flows from
  // here so the UI never hardcodes it. Shares the planner with service.houseRules.
  if (parts[2] === "injectable") {
    const budgetChars = config.houseRulesBudgetChars;
    const out = deps.store.listRepoPathsWithInjectableLearnings().map((repoPath) => {
      const rules = deps.store.listActiveLearnings(repoPath);
      const enabled = deps.store.getRepoConfig(repoPath).learningsEnabled;
      if (!enabled) {
        // Injection disabled: skip the planner; every rule uninjected, used 0.
        return {
          repoPath,
          enabled,
          budgetChars,
          usedChars: 0,
          rules: prioritize(rules).map((r) => ({ ...r, injected: false })),
        };
      }
      const plan = planHouseRulesInjection(rules, budgetChars);
      const injectedIds = new Set(plan.injected.map((r) => r.id));
      // injected first (priority order), then dropped (priority order) — same
      // ordering the drawer renders.
      return {
        repoPath,
        enabled,
        budgetChars,
        usedChars: plan.usedChars,
        rules: [...plan.injected, ...plan.dropped].map((r) => ({
          ...r,
          injected: injectedIds.has(r.id),
        })),
      };
    });
    return json(out);
  }

  // GET /api/learnings?repo=&status=
  if (!parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    const status = url.searchParams.get("status") ?? undefined;
    return json(
      deps.store.listLearnings(dir, status ? { status: status as LearningStatus } : undefined),
    );
  }

  return null;
}

async function handleLearningsPost({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  // POST /api/learnings/distill?repo= — checked BEFORE :id so "distill" isn't an id
  if (parts[2] === "distill") {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    deps.distiller?.distillNow(dir);
    return json({ ok: true });
  }

  // POST /api/learnings/:id/promote — open a CLAUDE.md PR for an active rule
  if (parts[2] && parts[3] === "promote") {
    if (!deps.promoter) return json({ error: "promote unavailable" }, 503);
    const res = await deps.promoter.promote(parts[2]);
    if (!res.ok) return json({ error: res.error }, res.status);
    deps.events.emit("learnings:update", { pending: deps.store.pendingLearningCount() });
    return json({ url: res.url });
  }

  // POST /api/learnings/:id/approve  |  /:id/dismiss
  if (parts[2] && (parts[3] === "approve" || parts[3] === "dismiss")) {
    return handleLearningStatus(req, deps, parts[2], parts[3]);
  }

  return null;
}

async function handleLearningStatus(
  req: Request,
  deps: AppDeps,
  id: string,
  action: "approve" | "dismiss",
): Promise<Response> {
  let rule: string | undefined;
  if (action === "approve") {
    const body = (await req.json().catch(() => null)) as { rule?: unknown } | null;
    if (body && typeof body.rule === "string") {
      // Normalize an edited rule to match addLearning's contract (trim + 240 cap).
      // An empty/whitespace-only edit falls back to the stored rule rather than
      // persisting a blank active rule (e.g. operator cleared the textarea).
      const trimmed = body.rule.trim().slice(0, 240);
      if (trimmed) rule = trimmed;
    }
  }
  const status = action === "approve" ? "active" : "dismissed";
  const updated = deps.store.setLearningStatus(id, status, rule);
  if (!updated) return json({ error: "not found" }, 404);
  deps.events.emit("learnings:update", { pending: deps.store.pendingLearningCount() });
  return json(updated);
}

async function pushSubscribe(req: Request, deps: AppDeps): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    locale?: unknown;
  } | null;
  if (
    !body ||
    typeof body.endpoint !== "string" ||
    typeof body.keys?.p256dh !== "string" ||
    typeof body.keys?.auth !== "string"
  ) {
    return json({ error: "body must be a PushSubscription" }, 400);
  }
  deps.push?.subscribe(
    {
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      locale: typeof body.locale === "string" ? body.locale : undefined,
    },
    req.headers.get("User-Agent") ?? "",
  );
  return json({ ok: true });
}

async function pushUnsubscribe(req: Request, deps: AppDeps): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (!body || typeof body.endpoint !== "string") {
    return json({ error: "body must be {endpoint: string}" }, 400);
  }
  deps.push?.unsubscribe(body.endpoint);
  return json({ ok: true });
}

/** GET /api/push/prefs?endpoint=… — the device's category selection (all-on if unknown). */
function pushPrefsRead(url: URL, deps: AppDeps): Response {
  const endpoint = url.searchParams.get("endpoint");
  if (!endpoint) return json({ error: "endpoint query param required" }, 400);
  const prefs = deps.store.getPushPrefs(endpoint) ?? { agent: true, reviews: true, ci: true };
  return json({ categories: prefs });
}

/** POST /api/push/prefs {endpoint, categories} — update a device's category selection. */
async function pushPrefsWrite(req: Request, deps: AppDeps): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as {
    endpoint?: unknown;
    categories?: { agent?: unknown; reviews?: unknown; ci?: unknown };
  } | null;
  const c = body?.categories;
  if (
    !body ||
    typeof body.endpoint !== "string" ||
    !c ||
    typeof c.agent !== "boolean" ||
    typeof c.reviews !== "boolean" ||
    typeof c.ci !== "boolean"
  ) {
    return json({ error: "body must be {endpoint, categories:{agent,reviews,ci}}" }, 400);
  }
  const ok = deps.store.setPushPrefs(body.endpoint, {
    agent: c.agent,
    reviews: c.reviews,
    ci: c.ci,
  });
  // No row means the client thinks it's subscribed but the server has no record
  // (pruned/raced) — report it so the UI can revert rather than silently no-op.
  return ok ? json({ ok: true }) : json({ error: "no subscription for endpoint" }, 404);
}

// Table-driven so adding a push route doesn't grow handlePush's branch count.
const PUSH_ROUTES: {
  method: string;
  seg: string;
  run: (ctx: Ctx) => Response | Promise<Response>;
}[] = [
  {
    method: "GET",
    seg: "vapid",
    run: ({ deps }) => json({ publicKey: deps.push?.publicKey() ?? null }),
  },
  { method: "POST", seg: "subscribe", run: ({ req, deps }) => pushSubscribe(req, deps) },
  { method: "POST", seg: "unsubscribe", run: ({ req, deps }) => pushUnsubscribe(req, deps) },
  { method: "GET", seg: "prefs", run: ({ url, deps }) => pushPrefsRead(url, deps) },
  { method: "POST", seg: "prefs", run: ({ req, deps }) => pushPrefsWrite(req, deps) },
];

async function handlePush(ctx: Ctx): Promise<Response | null> {
  const { req, parts } = ctx;
  if (parts[0] !== "api" || parts[1] !== "push") return null;
  const route = PUSH_ROUTES.find((r) => r.method === req.method && r.seg === parts[2]);
  return route ? route.run(ctx) : null;
}

// POST /api/sessions — create a session.
async function handleSessionCreate({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && !parts[2])) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  const result = validateCreate(body, config.repoRoot);
  if (!result.ok) return json({ error: result.error }, 400);
  let s;
  try {
    s = await deps.service.create(result.value);
  } catch (e) {
    // create shells out to herdr (and git); surface the real reason instead of a
    // bare 500 so the New Task dialog can show it. 409 ⇒ a name still collided
    // (a slip past uniqueName under a race), anything else ⇒ 502 (herdr/git failed).
    const msg = e instanceof Error ? e.message : "create failed";
    const taken = /agent_name_taken/.test(msg);
    return json({ error: taken ? "task name already in use, retry" : msg }, taken ? 409 : 502);
  }
  deps.events.emit("session:new", s);
  return json(s, 201);
}

async function sessionUsageRead(id: string, deps: AppDeps): Promise<Response> {
  const s = deps.store.get(id);
  return s ? json(await sessionUsage(s)) : json({ error: "not found" }, 404);
}

async function sessionActivityRead(id: string, deps: AppDeps): Promise<Response> {
  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);
  // pre-feature session (no pinned id) → no transcript to read
  const path = s.claudeSessionId ? jsonlPathFor(s.worktreePath, s.claudeSessionId) : "";
  return json(path ? await sessionActivity(path) : []);
}

function sessionDiffRead(id: string, deps: AppDeps): Response {
  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);
  try {
    return json(computeDiff(s.worktreePath, s.baseBranch, s.branch));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "diff failed" }, 500);
  }
}

function sessionRead(id: string, deps: AppDeps): Response {
  const s = deps.store.get(id);
  return s ? json(s) : json({ error: "not found" }, 404);
}

// GET reads on /api/sessions[/:id[/usage|/activity|/diff|/leftovers]].
async function handleSessionReads({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (!parts[2]) return json(deps.store.list({ activeOnly: true }));
  if (parts[3] === "usage") return sessionUsageRead(parts[2], deps);
  if (parts[3] === "activity") return sessionActivityRead(parts[2], deps);
  if (parts[3] === "diff") return sessionDiffRead(parts[2], deps);
  // leftover subprocesses/proxies that would survive this session's close
  if (parts[3] === "leftovers") return json(deps.service.leftovers(parts[2]));
  if (!parts[3]) return sessionRead(parts[2], deps);
  return null;
}

// Active sessions whose cached PR state is "merged" — the set "clear all merged"
// operates on. Reads the same prCache snapshot the UI partitions on, so server and
// client agree on what "merged" means without extra `gh` calls.
function mergedSessionIds(deps: AppDeps): string[] {
  const git = deps.prCache?.snapshot() ?? {};
  return deps.store
    .list({ activeOnly: true })
    .filter((s) => git[s.id]?.state === "merged")
    .map((s) => s.id);
}

// /api/sessions/clear-merged — bulk-close every merged-branch session.
//   GET  → { ids, leftovers } summary feeding the confirm modal.
//   POST {ids} → archive the merged subset, terminating each one's leftover
//     subprocesses. The client ids are intersected with the server's merged set
//     (re-validation) so a stale snapshot can never archive a still-live session;
//     an absent or non-array `ids` falls back to the full merged set (an explicit
//     empty array clears nothing). Returns what was actually cleared. Registered
//     before the generic :id handlers so the literal "clear-merged" segment is never
//     mistaken for a session id — including a 405 on DELETE/PUT so it can't fall
//     through to handleSessionDelete and emit a spurious archived event.
async function handleSessionsClearMerged({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[2] !== "clear-merged" || parts[3]) return null;
  const merged = new Set(mergedSessionIds(deps));
  if (req.method === "GET") {
    const ids = [...merged];
    const leftovers = ids.reduce((n, id) => n + deps.service.leftovers(id).length, 0);
    return json({ ids, leftovers });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const requested = Array.isArray(body?.ids)
    ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [...merged];
  const target = requested.filter((id) => merged.has(id)); // merged-only, no matter what was sent
  const { cleared, leftovers } = deps.service.archiveMany(target);
  for (const id of cleared) {
    deps.prCache?.drop(id);
    deps.events.emit("session:archived", { id });
  }
  return json({ cleared, leftovers });
}

// DELETE /api/sessions/:id — archive. An optional `{reap: string[]}` body lists the
// leftover keys (from GET …/leftovers) the operator chose to terminate alongside.
async function handleSessionDelete({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "DELETE" && parts[2])) return null;
  const body = (await req.json().catch(() => null)) as { reap?: unknown } | null;
  const reap = Array.isArray(body?.reap)
    ? (body!.reap as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  deps.service.archive(parts[2], reap);
  deps.prCache?.drop(parts[2]);
  deps.events.emit("session:archived", { id: parts[2] });
  return json({ ok: true });
}

// POST /api/sessions/:id/reply — steer a running session.
async function handleSessionReply({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "reply")) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  if (!body || typeof (body as { text?: unknown }).text !== "string") {
    return json({ error: "body must be {text: string}" }, 400);
  }
  // reply() returns false for an unknown id, a dead pane, OR a transient herdr-unreachable
  // (it can't confirm liveness, so it can't deliver) — all collapse to 404 here. The last
  // case is rare and "couldn't deliver" is honest; differentiating would need a richer
  // return than the boolean that broadcast()/auto-address also rely on.
  const ok = deps.service.reply(parts[2], (body as { text: string }).text);
  return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
}

// Validate the rename body, returning the typed name or the error Response to send.
async function parseRenameName(req: Request): Promise<string | Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  const raw = (body as { name?: unknown })?.name;
  if (typeof raw !== "string" || raw.trim() === "") {
    return json({ error: "body must be {name: string}" }, 400);
  }
  return raw;
}

// Decide whether the local branch moves. An OPEN PR forces the host into the loop:
// GitHub retargets it by renaming the remote branch first (so `s.branch` never points
// away from the PR); a host that can't (Gitea) yields a display-only rename. Returns the
// flag, or a 502 Response when the remote rename failed.
async function resolveRenameBranch(
  deps: AppDeps,
  s: Session,
  newBranch: string,
  hasOpenPr: boolean,
): Promise<boolean | Response> {
  const renameLocalBranch = s.isolated && !!s.branch;
  if (!hasOpenPr || !renameLocalBranch || !s.branch) return renameLocalBranch;

  const forge = deps.resolveForge?.(s.repoPath) ?? null;
  if (!forge?.renameBranch) return false; // can't retarget → keep the branch + PR, display-only

  try {
    await forge.renameBranch(s.branch, newBranch);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "rename failed" }, 502);
  }
  return renameLocalBranch;
}

// POST /api/sessions/:id/rename — rename a session (display name + git branch).
// When a PR is already open the local branch only moves if the host can retarget the
// PR (GitHub renames the remote branch; Gitea can't, so it's a display-only rename).
async function handleSessionRename({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "rename")) return null;
  const raw = await parseRenameName(req);
  if (raw instanceof Response) return raw;
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "not found" }, 404);

  const slug = slugifyManual(raw);
  if (slug === s.name) return json({ session: s, branchRenamed: false, prRetargeted: false });

  const newBranch = `shepherd/${slug}`;
  if (s.isolated && deps.service.branchExists(s.repoPath, newBranch)) {
    return json({ error: "name_taken" }, 409);
  }

  // capture before the cache drop below, which would otherwise hide the open PR
  const hadOpenPr = deps.prCache?.snapshot()[s.id]?.state === "open";
  const renameLocalBranch = await resolveRenameBranch(deps, s, newBranch, hadOpenPr);
  if (renameLocalBranch instanceof Response) return renameLocalBranch;

  let updated: Session | null;
  try {
    updated = deps.service.rename(s.id, slug, { renameLocalBranch });
  } catch {
    return json({ error: "name_taken" }, 409); // git branch -m lost a race since the pre-check
  }
  if (!updated) return json({ error: "not found" }, 404);

  deps.prCache?.drop(s.id); // clear stale state; the next poll re-reads the new/retargeted branch
  deps.events.emit("session:renamed", {
    id: updated.id,
    name: updated.name,
    branch: updated.branch,
  });
  return json({
    session: updated,
    branchRenamed: renameLocalBranch,
    prRetargeted: renameLocalBranch && hadOpenPr,
  });
}

// POST /api/sessions/:id/resume — resume a finished session in a fresh agent.
function handleSessionResume({ req, parts, deps }: Ctx): Response | null {
  if (!(req.method === "POST" && parts[2] && parts[3] === "resume")) return null;
  const s = deps.service.resume(parts[2]);
  if (!s) return json({ error: "cannot resume" }, 409);
  // flip the badge back to running + nudge clients to re-attach to the fresh agent
  deps.events.emit("session:status", { id: s.id, status: s.status });
  return json(s);
}

// POST /api/sessions/:id/ready — toggle the manual "ready to merge" flag.
async function handleSessionReady({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "ready")) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as { ready?: unknown } | null;
  if (!body || typeof body.ready !== "boolean") {
    return json({ error: "body must be {ready: boolean}" }, 400);
  }
  if (!deps.store.get(parts[2])) return json({ error: "not found" }, 404);
  deps.service.setReadyToMerge(parts[2], body.ready);
  return json({ ok: true });
}

// POST /api/sessions/:id/dismiss-stall — acknowledge a stall flag.
function handleSessionDismissStall({ req, parts, deps }: Ctx): Response | null {
  if (!(req.method === "POST" && parts[2] && parts[3] === "dismiss-stall")) return null;
  const ok = deps.poller?.acknowledgeStall(parts[2]) ?? false;
  return ok ? json({ ok: true }) : json({ error: "no stall to dismiss" }, 404);
}

// PUT /api/sessions/:id/autopilot — set the per-session opt-in override.
// Body: { enabled: boolean | null }  (null = inherit the repo default)
async function handleSessionAutopilot({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "PUT" && parts[2] && parts[3] === "autopilot")) return null;
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
  const e = body.enabled;
  if (!(e === true || e === false || e === null)) {
    return json({ error: "enabled must be true, false, or null" }, 400);
  }
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "no session" }, 404);
  deps.store.setAutopilotState(parts[2], { enabled: e });
  const updated = deps.store.get(parts[2]);
  if (updated)
    deps.events.emit("session:autopilot", {
      id: parts[2],
      paused: updated.autopilotPaused,
      question: updated.autopilotQuestion,
      enabled: updated.autopilotEnabled,
    });
  return json(updated);
}

// Sessions core: dispatch to the create / read / delete / reply sub-handlers,
// preserving the original inner guard order. Returns null for anything those
// don't claim (e.g. `…/git` sub-routes), so handleSessionGit can pick it up.
async function handleSessions(ctx: Ctx): Promise<Response | null> {
  const { parts } = ctx;
  if (parts[0] !== "api" || parts[1] !== "sessions") return null;
  for (const sub of [
    handleSessionsClearMerged,
    handleSessionCreate,
    handleSessionReads,
    handleSessionDelete,
    handleSessionReply,
    handleSessionRename,
    handleSessionResume,
    handleSessionReady,
    handleSessionDismissStall,
    handleSessionAutopilot,
  ]) {
    const res = await sub(ctx);
    if (res) return res;
  }
  return null;
}

// ── git host (forge) actions: /api/sessions/:id/git[/pr|/merge|/redeploy] ──
async function forgeOpenPr(
  forge: GitForge,
  session: Session,
  req: Request,
  deps: AppDeps,
): Promise<Response> {
  const head = session.branch ?? "";
  const body = (await req.json().catch(() => ({}))) as { title?: string; body?: string };
  const status = await forge.openPr({
    head,
    base: session.baseBranch,
    title: body.title?.trim() || session.name,
    body: body.body ?? session.prompt,
  });
  const git: GitState = { kind: forge.kind, ...status };
  deps.prCache?.set(session.id, git);
  deps.events.emit("session:git", { id: session.id, git });
  return json(status);
}

async function forgeMerge(
  forge: GitForge,
  session: Session,
  req: Request,
  deps: AppDeps,
): Promise<Response> {
  const head = session.branch ?? "";
  const body = (await req.json().catch(() => ({}))) as {
    method?: MergeMethod;
    deleteBranch?: boolean;
  };
  const cur = await forge.prStatus(head);
  if (cur.state !== "open" || !cur.number) {
    return json({ error: "no open PR to merge" }, 409);
  }
  await forge.merge(cur.number, {
    method: body.method ?? forge.mergeMethod,
    deleteBranch: body.deleteBranch ?? true,
  });
  const status = await forge.prStatus(head);
  const git: GitState = { kind: forge.kind, ...status };
  deps.prCache?.set(session.id, git);
  deps.events.emit("session:git", { id: session.id, git });
  return json(status);
}

async function forgeRedeploy(forge: GitForge, session: Session): Promise<Response> {
  if (!forge.deployWorkflow) {
    return json({ error: "no deploy workflow configured" }, 400);
  }
  await forge.redeploy({ workflow: forge.deployWorkflow, ref: session.baseBranch });
  return json({ ok: true });
}

async function dispatchForgeAction(
  forge: GitForge,
  session: Session,
  ctx: Ctx,
): Promise<Response | null> {
  const { req, parts, deps } = ctx;
  if (req.method === "GET") {
    if (!parts[4])
      return json({ kind: forge.kind, ...(await forge.prStatus(session.branch ?? "")) });
    return null;
  }
  if (req.method === "POST") {
    if (parts[4] === "pr") return forgeOpenPr(forge, session, req, deps);
    if (parts[4] === "merge") return forgeMerge(forge, session, req, deps);
    if (parts[4] === "redeploy") return forgeRedeploy(forge, session);
  }
  return null;
}

async function handleSessionGit(ctx: Ctx): Promise<Response | null> {
  const { parts, deps } = ctx;
  if (!(parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "git")) {
    return null;
  }
  const session = deps.store.get(parts[2]);
  if (!session) return json({ error: "not found" }, 404);
  const forge = deps.resolveForge?.(session.repoPath) ?? null;
  if (!forge) return json({ error: "no forge for this repo" }, 404);
  try {
    return await dispatchForgeAction(forge, session, ctx);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "forge error" }, 502);
  }
}

function handleUsageLimits({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "usage" && parts[2] === "limits") {
    return json(deps.usageLimits.limits(Date.now()));
  }
  return null;
}

// ── self-update: status + trigger ──────────────────────────────────────
function updateStatus(deps: AppDeps): Response {
  return json(
    deps.updates?.current() ?? {
      behind: 0,
      current: null,
      latest: null,
      commits: [],
      checkedAt: Date.now(),
    },
  );
}

function updateApply(deps: AppDeps): Response {
  if (!deps.updates) return json({ error: "updates not available" }, 503);
  const status = deps.updates.current();
  if (!status || status.behind <= 0) return json({ error: "no update available" }, 409);
  const r = deps.updates.apply();
  if (r.started) return json({ ok: true }, 202);
  // never a bare status: carry the real reason so the UI can show it
  return json({ error: r.error ?? "could not start the update" }, 409);
}

function handleUpdate({ req, parts, deps }: Ctx): Response | null {
  if (parts[0] === "api" && parts[1] === "update" && !parts[2]) {
    if (req.method === "GET") return updateStatus(deps);
    if (req.method === "POST") return updateApply(deps);
  }
  // live state of an in-flight/failed deploy so the modal can show why it failed
  if (
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "update" &&
    parts[2] === "log" &&
    !parts[3]
  ) {
    return json(deps.updates?.applyState?.() ?? { phase: "idle", exitCode: null, log: "" });
  }
  return null;
}

const HERDR_UPDATE_IDLE = {
  current: null,
  latest: null,
  updateAvailable: false,
  notes: null,
  checkedAt: 0,
} as const;

// ── herdr update: status + (destructive) apply ─────────────────────────
function handleHerdrUpdate({ req, parts, deps }: Ctx): Response | null {
  if (!(parts[0] === "api" && parts[1] === "herdr-update" && !parts[2])) return null;
  if (req.method === "GET") {
    return json(deps.herdrUpdates?.current() ?? { ...HERDR_UPDATE_IDLE, checkedAt: Date.now() });
  }
  if (req.method !== "POST") return null;
  if (!deps.herdrUpdates) return json({ error: "herdr updates not available" }, 503);
  if (!deps.herdrUpdates.current()?.updateAvailable) {
    return json({ error: "no update available" }, 409);
  }
  const r = deps.herdrUpdates.apply();
  return json({ ok: r.started }, r.started ? 202 : 409);
}

function handleUploads({ req, parts, deps }: Ctx): Promise<Response> | null {
  if (parts[0] === "api" && parts[1] === "uploads" && !parts[2]) {
    if (req.method === "POST") {
      return handleUpload(req, { store: deps.store, repoRoot: config.repoRoot });
    }
  }
  return null;
}

// HTTP status per clone-failure code; anything unlisted falls back to 422.
const CLONE_ERROR_STATUS: Record<string, number> = {
  clonerepo_failed_exists: 409,
  clonerepo_failed_outside: 400,
  clonerepo_failed_timeout: 504,
};

async function cloneRepoFromRequest(req: Request): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const parsed = validateCloneUrl(body?.url);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const r = cloneRepo(parsed.value.url, parsed.value.name, config.repoRoot);
  if (!r.ok) return json({ error: r.error }, CLONE_ERROR_STATUS[r.error] ?? 422);
  return json(r.entry, 201);
}

async function handleRepos({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "repos" && !parts[2]) {
    if (req.method === "GET") {
      const lastUsed = deps.store.lastUsedByRepo();
      const repos = listRepos(config.repoRoot).map((r) => ({
        ...r,
        lastUsedAt: lastUsed[r.path],
      }));
      return json(repos);
    }
    if (req.method === "POST") return cloneRepoFromRequest(req);
  }
  return null;
}

// ── settings: read/update the repo root (persisted, applied at runtime) ──
async function handleSettings({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "settings" && !parts[2])) return null;
  if (req.method === "GET") {
    return json({
      repoRoot: config.repoRoot,
      repoRootDisplay: collapseHome(config.repoRoot),
      remoteControlAtStartup: config.remoteControlAtStartup,
      standardCommand: config.standardCommand,
      sessionHousekeepingEnabled: config.sessionHousekeepingEnabled,
      // display-only: the real retention thresholds, so the UI shows the actual numbers
      // instead of hardcoding a mirror of the server constants.
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      sessionRetentionKeep: SESSION_RETENTION_KEEP,
    });
  }
  if (req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as {
      repoRoot?: unknown;
      remoteControlAtStartup?: unknown;
      standardCommand?: unknown;
      sessionHousekeepingEnabled?: unknown;
    } | null;
    // Remote Control toggle is a standalone boolean patch (no repoRoot in the body).
    if (body && "remoteControlAtStartup" in body && body.repoRoot === undefined) {
      return putRemoteControl(body.remoteControlAtStartup, deps);
    }
    // Standard command is a standalone string patch (no repoRoot in the body).
    if (body && "standardCommand" in body && body.repoRoot === undefined) {
      return putStandardCommand(body.standardCommand, deps);
    }
    // Session housekeeping toggle is a standalone boolean patch (no repoRoot in the body).
    if (body && "sessionHousekeepingEnabled" in body && body.repoRoot === undefined) {
      return putSessionHousekeeping(body.sessionHousekeepingEnabled, deps);
    }
    return putRepoRoot(body?.repoRoot, deps);
  }
  return null;
}

// max length for the persisted standard command; mirrors the 8000-char human-prompt
// guard so a configured command can't be larger than what a session would accept.
const STANDARD_COMMAND_MAX = 8000;

function putStandardCommand(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "string") {
    return json({ error: "standardCommand must be a string" }, 400);
  }
  if (value.length > STANDARD_COMMAND_MAX) {
    return json({ error: `standardCommand must be at most ${STANDARD_COMMAND_MAX} chars` }, 400);
  }
  config.standardCommand = value; // live: next quick-launch picks it up
  deps.store.setSetting("standardCommand", value); // persist across restarts
  return json({ standardCommand: config.standardCommand });
}

function putRemoteControl(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "remoteControlAtStartup must be a boolean" }, 400);
  }
  config.remoteControlAtStartup = value; // live: next spawn picks it up
  deps.store.setSetting("remoteControlAtStartup", value ? "1" : "0"); // persist
  return json({ remoteControlAtStartup: config.remoteControlAtStartup });
}

function putSessionHousekeeping(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "sessionHousekeepingEnabled must be a boolean" }, 400);
  }
  config.sessionHousekeepingEnabled = value; // live: the next daily sweep honors it
  deps.store.setSetting("sessionHousekeepingEnabled", value ? "1" : "0"); // persist
  return json({ sessionHousekeepingEnabled: config.sessionHousekeepingEnabled });
}

function putRepoRoot(value: unknown, deps: Ctx["deps"]): Response {
  const root = validateRoot(value, config.rootCeiling);
  if (!root) {
    return json({ error: "repoRoot must be an existing directory within the root" }, 400);
  }
  config.repoRoot = root; // live: every later read picks it up
  deps.store.setSetting("repoRoot", root); // persist across restarts
  return json({ repoRoot: root, repoRootDisplay: collapseHome(root) });
}

// ── saved steers (canned prompts): list / replace ──
async function handleSteers({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "steers" && !parts[2]) {
    if (req.method === "GET") return json(loadSteers(deps.store));
    if (req.method === "PUT") {
      const ctErr = requireJsonContentType(req);
      if (ctErr) return ctErr;
      const body = await req.json().catch(() => null);
      const steers = validateSteers(body);
      if (!steers) return json({ error: "invalid steers payload" }, 400);
      saveSteers(deps.store, steers);
      return json(steers);
    }
  }
  return null;
}

// ── per-project icons: read full map / patch one entry ──
async function handleProjectIcons({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "project-icons" && !parts[2]) {
    if (req.method === "GET") return json(loadIcons(deps.store));
    if (req.method === "PUT") {
      const ctErr = requireJsonContentType(req);
      if (ctErr) return ctErr;
      const body = await req.json().catch(() => null);
      const patch = validateIconPatch(body);
      if (!patch) return json({ error: "invalid project-icon payload" }, 400);
      const map = setIcon(deps.store, patch.path, patch.emoji);
      deps.events.emit("project-icons:update", map);
      return json(map);
    }
  }
  return null;
}

// ── broadcast a steer to many sessions ──
async function handleBroadcast({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "broadcast" && !parts[2]) {
    if (req.method === "POST") {
      const ctErr = requireJsonContentType(req);
      if (ctErr) return ctErr;
      const body = await req.json().catch(() => null);
      const parsed = validateBroadcast(body);
      if (!parsed) return json({ error: "body must be {text: string, ids: string[]}" }, 400);
      return json(deps.service.broadcast(parsed.ids, parsed.text));
    }
  }
  return null;
}

// ── filesystem browser: list sub-directories for the root picker ──
function handleFsDirs({ req, parts, url }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "fs" && parts[2] === "dirs") {
    return json(listDirs(url.searchParams.get("path") ?? "", config.rootCeiling));
  }
  return null;
}

function handleBranches({ req, parts, url }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "branches" && !parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    return json(listBranches(dir));
  }
  return null;
}

async function handleIssues({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "issues" && !parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    const forge = deps.resolveForge?.(dir) ?? null;
    if (!forge) return json({ slug: null, issues: [] });
    try {
      return json({ slug: forge.slug, issues: await forge.listIssues() });
    } catch {
      // missing/un-authed CLI or network error → graceful empty (matches prior behavior)
      return json({ slug: forge.slug, issues: [] });
    }
  }
  return null;
}

/**
 * Collapse worktrees / multiple clones of the same repo: dedupe by forge identity
 * (kind + owner/repo slug) so each repo appears once, not once per directory.
 * Repos without a slug can't be matched, so each stays distinct (keyed by path).
 * For each group keep the most-recently-used directory; tie-break on shorter then
 * lexicographically smaller path, which favors the canonical checkout (e.g.
 * `epamano-shopify`) over a long-named worktree.
 */
function dedupeReposByForge<T extends { path: string; forge: GitForge }>(
  repos: T[],
  lastUsed: Record<string, number>,
): T[] {
  const key = (r: T) => (r.forge.slug ? `${r.forge.kind} ${r.forge.slug}` : `path ${r.path}`);
  const byRepo = new Map<string, T>();
  for (const r of repos) {
    const k = key(r);
    const cur = byRepo.get(k);
    if (!cur) {
      byRepo.set(k, r);
      continue;
    }
    const ru = lastUsed[r.path] ?? -1;
    const cu = lastUsed[cur.path] ?? -1;
    const better =
      ru !== cu
        ? ru > cu
        : r.path.length !== cur.path.length
          ? r.path.length < cur.path.length
          : r.path < cur.path;
    if (better) byRepo.set(k, r);
  }
  return [...byRepo.values()];
}

// GET /api/prs?repo= — open PRs for one repo (backlog PRs-tab detail pane).
async function handlePrsList({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "prs" || parts[2]) return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge) return json({ slug: null, prs: [] });
  try {
    return json({ slug: forge.slug, prs: await forge.listPullRequests() });
  } catch {
    // missing/un-authed CLI or network error → graceful empty (matches issues path)
    return json({ slug: forge.slug, prs: [] });
  }
}

// GET /api/actions?repo= — latest Actions run per workflow on the default branch
// (backlog Actions-tab detail pane). Alongside the runs it reports three capability
// flags (supportsActions / canRerun / canCancel) derived from which optional forge
// methods exist, so the UI can gate the empty-state and rerun/cancel buttons
// forge-agnostically rather than hardcoding `kind`. Forges without an Actions API
// (e.g. Gitea lacks rerun/cancel) report no runs / the relevant flag false.
async function handleActionsList({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "actions" || parts[2]) return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  const caps = {
    supportsActions: Boolean(forge?.listWorkflowRuns),
    canRerun: Boolean(forge?.rerunWorkflowRun),
    canCancel: Boolean(forge?.cancelWorkflowRun),
  };
  if (!forge?.listWorkflowRuns) {
    return json({ slug: forge?.slug ?? null, kind: forge?.kind ?? null, runs: [], ...caps });
  }
  try {
    return json({
      slug: forge.slug,
      kind: forge.kind,
      runs: await forge.listWorkflowRuns(),
      ...caps,
    });
  } catch {
    // missing/un-authed CLI or network error → graceful empty (matches PRs path)
    return json({ slug: forge.slug, kind: forge.kind, runs: [], ...caps });
  }
}

// POST /api/actions/rerun — re-run a GitHub Actions run by repo + runId. When the
// run failed, `failedOnly` retries just the broken jobs; otherwise the whole run.
// GitHub only; other forges lack the method → 400 (the tab hides the button anyway).
async function handleActionsRerun({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "actions" || parts[2] !== "rerun")
    return null;
  const body = (await req.json().catch(() => ({}))) as {
    repo?: string;
    runId?: number;
    failedOnly?: boolean;
  };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.runId !== "number") return json({ error: "runId required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.rerunWorkflowRun) return json({ error: "no actions for repo" }, 400);
  try {
    await forge.rerunWorkflowRun(body.runId, { failedOnly: body.failedOnly ?? false });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "rerun failed" }, 502);
  }
}

// POST /api/actions/cancel — cancel an in-progress GitHub Actions run by repo + runId.
async function handleActionsCancel({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "cancel"
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; runId?: number };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.runId !== "number") return json({ error: "runId required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.cancelWorkflowRun) return json({ error: "no actions for repo" }, 400);
  try {
    await forge.cancelWorkflowRun(body.runId);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "cancel failed" }, 502);
  }
}

// GET /api/actions/history?repo=&workflowId=&limit= — prior runs of one workflow
// on the default branch (summary rows, jobs empty; lazy-loaded history). GitHub
// only; other forges lack the method → empty. limit defaults to 10, clamped 1..50.
async function handleActionsHistory({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "GET" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "history"
  )
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const wfRaw = url.searchParams.get("workflowId");
  const workflowId = Number(wfRaw);
  if (!wfRaw || !Number.isFinite(workflowId)) return json({ error: "workflowId required" }, 400);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 10), 50);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.listWorkflowRunHistory) return json({ runs: [] });
  try {
    return json({ runs: await forge.listWorkflowRunHistory(workflowId, { limit }) });
  } catch {
    // missing/un-authed CLI or network error → graceful empty (matches list path)
    return json({ runs: [] });
  }
}

// GET /api/actions/run-jobs?repo=&runId= — per-job breakdown for a single run,
// lazy-loaded when a history row is expanded. GitHub only; others → empty.
async function handleActionsRunJobs({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "GET" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "run-jobs"
  )
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const runRaw = url.searchParams.get("runId");
  const runId = Number(runRaw);
  if (!runRaw || !Number.isFinite(runId)) return json({ error: "runId required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.listRunJobs) return json({ jobs: [] });
  try {
    return json({ jobs: await forge.listRunJobs(runId) });
  } catch {
    return json({ jobs: [] });
  }
}

// POST /api/prs/merge — merge a backlog PR by repo + number (no session involved).
async function handlePrMerge({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "prs" || parts[2] !== "merge")
    return null;
  const body = (await req.json().catch(() => ({}))) as {
    repo?: string;
    number?: number;
    method?: MergeMethod;
    deleteBranch?: boolean;
  };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.number !== "number") return json({ error: "number required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge) return json({ error: "no forge for repo" }, 400);
  try {
    await forge.merge(body.number, {
      method: body.method ?? forge.mergeMethod,
      deleteBranch: body.deleteBranch ?? true,
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "merge failed" }, 502);
  }
}

// POST /api/prs/dependabot-rebase — post the opt-in "@dependabot rebase" command on
// a stuck Dependabot PR by repo + number. The body is fixed server-side. GitHub
// only (forge must expose `comment`); other forges 400 and the UI never offers it.
async function handleDependabotRebase({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "prs" ||
    parts[2] !== "dependabot-rebase"
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; number?: number };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.number !== "number") return json({ error: "number required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.comment) return json({ error: "no comment support" }, 400);
  try {
    await forge.comment(body.number, DEPENDABOT_REBASE_COMMAND);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "comment failed" }, 502);
  }
}

/** Per-repo row in the backlog overview. */
export interface BacklogProject {
  path: string;
  display: string;
  slug: string | null;
  kind: string;
  lastUsedAt: number | null;
  openIssues: number | null;
  openPRs: number | null;
  /** Workflows defined under .github/workflows; null for non-GitHub forges. */
  workflows: number | null;
  /** Default-branch CI rollup state for the Actions tab marker; null = unknown / non-GitHub. */
  ciStatus: "success" | "failure" | "pending" | null;
}
export interface BacklogPayload {
  pinnedPath: string | null;
  projects: BacklogProject[];
  totals: { openIssues: number; openPRs: number };
}

/** What an empty/unconfigured backlog looks like — also the no-forge fast path. */
const EMPTY_BACKLOG: BacklogPayload = {
  pinnedPath: null,
  projects: [],
  totals: { openIssues: 0, openPRs: 0 },
};

/** Inputs for {@link buildBacklogPayload} — kept narrow so both the request path
 *  (AppDeps) and the background poller (index.ts locals) can supply them. */
export interface BacklogPayloadInputs {
  counts: (repoDir: string) => Promise<RepoCounts>;
  resolveForge: (repoDir: string) => GitForge | null;
  lastUsedByRepo: () => Record<string, number>;
  repoRoot: string;
}

/**
 * Build the backlog overview payload: forge-backed repos under `repoRoot`,
 * deduped by forge slug, with open issue/PR counts, a pinned project, and
 * totals. Shared by GET /api/backlog and the poller's `backlog:update`
 * broadcast so both emit byte-identical snapshots.
 */
export async function buildBacklogPayload(inputs: BacklogPayloadInputs): Promise<BacklogPayload> {
  const repos = listRepos(inputs.repoRoot);
  const lastUsed = inputs.lastUsedByRepo();

  // Keep only forge-backed repos
  const forgeRepos = repos
    .map((r) => {
      const forge = inputs.resolveForge(r.path);
      return forge ? { ...r, forge } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Collapse worktrees/clones of the same repo so each appears once (see helper).
  const uniqueRepos = dedupeReposByForge(forgeRepos, lastUsed);

  // Fetch counts for the deduped repos in parallel
  const countsArr = await Promise.all(uniqueRepos.map((r) => inputs.counts(r.path)));

  const projects: BacklogProject[] = uniqueRepos.map((r, i) => {
    const counts = countsArr[i]!;
    return {
      path: r.path,
      display: r.display,
      slug: r.forge.slug,
      kind: r.forge.kind,
      lastUsedAt: lastUsed[r.path] ?? null,
      openIssues: counts.openIssues,
      openPRs: counts.openPRs,
      // GitHub-only: the Actions panel is github-gated, so other forges get null
      // (plain "Actions" label) rather than a count that has no panel behind it.
      workflows: r.forge.kind === "github" ? countDefinedWorkflows(r.path) : null,
      ciStatus: counts.ciStatus,
    };
  });

  // Sort: descending openIssues (null → -1), tie-break path ascending
  projects.sort((a, b) => {
    const ai = a.openIssues ?? -1;
    const bi = b.openIssues ?? -1;
    if (bi !== ai) return bi - ai;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  // Pin: project with max lastUsedAt; tie-break lowest path; if none have lastUsedAt → first after sort
  let pinnedPath: string | null = null;
  if (projects.length > 0) {
    const withUsed = projects.filter((p) => p.lastUsedAt !== null);
    if (withUsed.length > 0) {
      const pinned = withUsed.reduce((best, cur) => {
        if (cur.lastUsedAt! > best.lastUsedAt!) return cur;
        if (cur.lastUsedAt! === best.lastUsedAt! && cur.path < best.path) return cur;
        return best;
      });
      pinnedPath = pinned.path;
    } else {
      pinnedPath = projects[0]!.path;
    }
  }

  // Totals: sum non-null values
  let totalIssues = 0;
  let totalPRs = 0;
  for (const p of projects) {
    if (p.openIssues !== null) totalIssues += p.openIssues;
    if (p.openPRs !== null) totalPRs += p.openPRs;
  }

  return { pinnedPath, projects, totals: { openIssues: totalIssues, openPRs: totalPRs } };
}

async function handleBacklog({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "backlog" || parts[2]) return null;
  if (!deps.backlog) return json(EMPTY_BACKLOG);
  const backlog = deps.backlog;
  return json(
    await buildBacklogPayload({
      counts: (p) => backlog.counts(p),
      resolveForge: (p) => deps.resolveForge?.(p) ?? null,
      lastUsedByRepo: () => deps.store.lastUsedByRepo(),
      repoRoot: config.repoRoot,
    }),
  );
}

function todoRead(repoParam: string): Response {
  const r = readTodo(repoParam, config.repoRoot);
  if (!r.ok) return json({ error: "invalid repo path" }, 400);
  return json(r);
}

async function todoWrite(repoParam: string, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (body === null || typeof body !== "object" || typeof (body as any).content !== "string") {
    return json({ error: "body must be {content: string}" }, 400);
  }
  const ok = writeTodo(repoParam, config.repoRoot, (body as any).content);
  if (!ok) return json({ error: "invalid repo path or content too large" }, 400);
  return json({ ok: true });
}

// ── installed slash commands: skills + command files for the New Task picker ──
function handleCommands({ req, parts, url }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "commands" && !parts[2]) {
    // invalid/absent repo → null dir → user-scope commands only (still useful)
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    return json({ commands: listCommands(dir, join(homedir(), ".claude")) });
  }
  return null;
}

async function handleTodo({ req, parts, url }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "todo" && !parts[2]) {
    const repoParam = url.searchParams.get("repo") ?? "";
    if (req.method === "GET") return todoRead(repoParam);
    if (req.method === "PUT") return todoWrite(repoParam, req);
  }
  return null;
}

// Ordered dispatch chain — preserves the original guard sequence verbatim.
const ROUTE_HANDLERS = [
  handleGitSnapshot,
  handleActivitySnapshot,
  handleReviews,
  handleDrain,
  handleRepoConfig,
  handleLearnings,
  handlePush,
  handleSessions,
  handleSessionGit,
  handleUsageLimits,
  handleUpdate,
  handleHerdrUpdate,
  handleUploads,
  handleRepos,
  handleSettings,
  handleSteers,
  handleProjectIcons,
  handleBroadcast,
  handleFsDirs,
  handleBranches,
  handleIssues,
  handlePrsList,
  handleActionsList,
  handleActionsRerun,
  handleActionsCancel,
  handleActionsHistory,
  handleActionsRunJobs,
  handlePrMerge,
  handleDependabotRebase,
  handleBacklog,
  handleTodo,
  handleCommands,
] as const;

/** Returns an object with a `fetch(Request)` method — unit-testable without a port. */
export function makeApp(deps: AppDeps) {
  const app = {
    async fetch(req: Request): Promise<Response> {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      const originErr = checkOrigin(req);
      if (originErr) return originErr;

      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // ["api","sessions",":id"]
      const ctx: Ctx = { req, parts, url, deps };

      for (const handle of ROUTE_HANDLERS) {
        const res = await handle(ctx);
        if (res) return res;
      }

      if (url.pathname.startsWith("/api")) return json({ error: "not found" }, 404);
      if (req.method === "GET" || req.method === "HEAD") {
        const res = await serveStatic(url.pathname);
        // HEAD: same status/headers as GET, but no body
        return req.method === "HEAD"
          ? new Response(null, { status: res.status, headers: res.headers })
          : res;
      }
      return json({ error: "not found" }, 404);
    },
  };
  // Any unhandled throw (e.g. `service.create` when herdr rejects a command) would
  // otherwise bubble out as Bun's HTML error page — which the UI can't parse, so it
  // only sees a bare status code. Convert it to a JSON 500 carrying the real message.
  return {
    fetch: (req: Request): Promise<Response> =>
      app
        .fetch(req)
        .catch((e) => json({ error: e instanceof Error ? e.message : "internal error" }, 500)),
  };
}

type WsData =
  | { kind: "events" }
  | { kind: "pty"; id: string; terminalId: string; cols: number; rows: number; bridge?: PtyBridge };

// A pty WS closed with this code means "a newer client took over this terminal".
// The client parks (shows a take-over prompt) instead of reconnecting — without
// it, two devices on the same session ping-pong herdr's --takeover forever.
// Keep in sync with PTY_SUPERSEDED_CODE in ui/src/lib/pty.ts.
const PTY_SUPERSEDED_CODE = 4000;

// A pty WS closed with this code means "this session has ended" — its herdr
// agent is gone (the user quit claude / ctrl-c'd). The client stops reconnecting
// and shows an ended state instead of looping on herdr's agent_not_found.
// Keep in sync with PTY_GONE_CODE in ui/src/lib/pty.ts.
export const PTY_GONE_CODE = 4001;

export function serve(deps: AppDeps, port: number) {
  const app = makeApp(deps);
  // current owning socket per terminal — a single owner avoids the takeover war
  const ptyOwners = new Map<string, ServerWebSocket<WsData>>();
  return Bun.serve<WsData>({
    port,
    hostname: config.host,
    fetch(req, server) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      const originErr = checkOrigin(req);
      if (originErr) return originErr;

      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const origin = req.headers.get("Origin");
        if (!originAllowed(origin, config.allowedOriginHosts)) {
          return new Response("forbidden: origin not allowed", { status: 403 });
        }
        return server.upgrade(req, { data: { kind: "events" } })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      const m = url.pathname.match(/^\/pty\/([^/]+)$/);
      if (m) {
        const origin = req.headers.get("Origin");
        if (!originAllowed(origin, config.allowedOriginHosts)) {
          return new Response("forbidden: origin not allowed", { status: 403 });
        }
        const s = deps.store.get(m[1]!);
        if (!s) return new Response("no session", { status: 404 });
        // attach at the client's actual terminal size so the very first paint
        // matches; otherwise herdr renders the pane at the default 100×30 and the
        // view stays mis-sized until a follow-up resize forces a TUI repaint.
        const { cols, rows } = parseTermDims(
          url.searchParams.get("cols"),
          url.searchParams.get("rows"),
        );
        return server.upgrade(req, {
          data: { kind: "pty", id: s.id, terminalId: s.herdrAgentId, cols, rows },
        })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "events") {
          const unsub = deps.events.subscribe((event, data) =>
            ws.send(JSON.stringify({ event, data })),
          );
          (ws.data as any).unsub = unsub;
        } else {
          // Don't attach a terminal whose herdr agent is gone: attaching would make
          // herdr reply agent_not_found and the client would reconnect-loop on it.
          // A "done" status only means the agent finished its turn (idle at the
          // prompt) — its herdr pane may still be alive and attachable. So gate on
          // herdr LIVENESS, not on status: block only when the session is missing,
          // archived, or its herdr agent is no longer listed by `herdr agent list`.
          const cur = deps.store.get(ws.data.id);
          if (!cur || cur.status === "archived") {
            ws.close(PTY_GONE_CODE, "ended");
            return;
          }
          let agentLive: boolean;
          try {
            agentLive = deps.herdr?.list().some((a) => a.terminalId === cur.herdrAgentId) ?? true;
          } catch {
            agentLive = true; // a herdr CLI hiccup shouldn't strand a live session
          }
          if (!agentLive) {
            ws.close(PTY_GONE_CODE, "ended");
            return;
          }
          // single owner per terminal: claim it, then bump the previous owner
          // with a "superseded" close so it parks instead of fighting back.
          const tid = ws.data.terminalId;
          const prev = ptyOwners.get(tid);
          ptyOwners.set(tid, ws);
          if (prev && prev !== ws) prev.close(PTY_SUPERSEDED_CODE, "superseded");
          const bridge = new PtyBridge(tid, {
            send: (d) => ws.send(d),
            close: () => ws.close(),
          });
          ws.data.bridge = bridge;
          bridge.open(ws.data.cols, ws.data.rows);
        }
      },
      message(ws, msg) {
        if (ws.data.kind === "events") {
          // Presence frame: the page reports focus+visibility so push delivery
          // can suppress OS banners while a window is actively in use.
          try {
            const m = JSON.parse(typeof msg === "string" ? msg : msg.toString());
            if (m?.type === "presence") deps.presence?.set(ws, !!m.active);
          } catch {
            /* ignore malformed frames */
          }
          return;
        }
        ws.data.bridge?.write(typeof msg === "string" ? msg : msg.toString());
      },
      close(ws) {
        if (ws.data.kind === "events") {
          (ws.data as any).unsub?.();
          deps.presence?.drop(ws);
        } else {
          // only drop ownership if we're still the owner (a newer client may have
          // already claimed this terminal before our close fired)
          if (ptyOwners.get(ws.data.terminalId) === ws) ptyOwners.delete(ws.data.terminalId);
          ws.data.bridge?.close();
        }
      },
    },
  });
}
