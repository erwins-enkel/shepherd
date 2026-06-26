import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { RepoConfig, SessionStore } from "./store";
import type { EventHub } from "./events";
import type { WorktreeMgr } from "./worktree";
import type { HerdrAgent, HerdrDriver } from "./herdr";
import { matchAgents } from "./herdr";
import { config } from "./config";
import type {
  AgentProvider,
  CreateSessionInput,
  IssueRef,
  RelaunchOverrides,
  Session,
} from "./types";
import {
  copyStagedIntoWorktree,
  stagingDir,
  sweepStaging,
  STAGING_TTL_MS,
  uploadFilename,
  worktreeUploadsDir,
} from "./uploads";
import { slugifyManual, isHeuristicNameStrong } from "./namer";
import { spawnModelForAvailability } from "./default-model";
import {
  isApiKeyMode,
  isApiKeyConfigured,
  apiKeySettingsFragment,
  apiKeyMembraneFields,
  apiKeyPassthroughEnv,
} from "./spawn-auth";
import type { Leftover, ProcessReaper } from "./process-reaper";
import type { PreviewService } from "./preview";
import { extractTargetPaths, planHouseRulesInjection, renderHouseRulesBlock } from "./house-rules";
import { isGoodOutcome } from "./learnings-lifecycle";
import { effectiveAutopilot } from "./effective-autopilot";
import { MAX_IMAGES } from "./validate";
import {
  resolveProfile,
  detectBackend as detectSandboxBackend,
  autoHoldReason,
  isDegraded,
  isEgressDegraded,
  egressApplies,
  willEgressConfine,
  wrapArgv,
  buildMembraneFlags,
  safeRealpath,
  collectPassthroughEnv,
  SandboxAutoRefused,
  type SandboxProfile,
  type SandboxBackend,
  type MembraneInputs,
} from "./sandbox";
import {
  detectEgressBackend as detectRealEgressBackend,
  detectEgressHostLoopback as detectRealEgressHostLoopback,
  SLIRP_HOST_GATEWAY,
  egressMembraneOverrideFlags,
  buildEgressAllowlist,
  buildEgressConfig,
  writeEgressConfigFiles,
  wrapEgress,
  egressTmpDir,
  removeEgressTmp,
  sweepEgressTmp,
  type EgressBackend,
} from "./egress";
import type { EgressWatcher } from "./egress-watch";
import { SHEPHERD_ISSUE_LOG_MARKER } from "./forge/types";
import type { GitForge, GitState, IssueComment } from "./forge/types";

/** Post-archive late-credit await window: after a merge-train session archives,
 *  its completion-tracker entry waits this long for a poller-gated late merge to
 *  credit it before the sweep reclaims it (no-credit); also bounds the same await
 *  started in clearMergingForTrain. NOTE: per-session marks are NOT aged out by
 *  this — they persist for the life of the train (see sweepStaleMerging, which
 *  releases a mark only when its train leaves #liveTrains). */
export const MERGE_STALE_MS = 30 * 60_000;

/** Absolute backstop for a STILL-RUNNING merge-train completion-tracker entry: a
 *  train session that dies without ever emitting `session:archived` would orphan
 *  its live entry forever, so the sweep reclaims a live entry this long after launch.
 *  Set far beyond any realistic run (no merge train runs for a day) so it can only
 *  reclaim a genuinely dead train, never one still landing PRs. */
export const TRAIN_TRACKER_MAX_MS = 24 * 60 * 60_000;

export interface ServiceDeps {
  store: SessionStore;
  worktree: Pick<
    WorktreeMgr,
    | "create"
    | "ensureBaseRef"
    | "remove"
    | "renameBranch"
    | "branchExists"
    | "commitsAhead"
    | "currentBranch"
    | "gitCommonDir"
  >;
  herdr: Pick<HerdrDriver, "start" | "list" | "stop" | "send" | "relabel">;
  namer: (prompt: string) => string | Promise<string>;
  /** Background namer: comprehends the prompt into a slug (null = keep heuristic). Absent → no refine. */
  refineName?: (args: { taskText: string; label: string }) => Promise<string | null>;
  /** Event bus for live state pushes (e.g. session:ready); absent in tests that skip it. */
  events?: Pick<EventHub, "emit">;
  /** Inject point for tests; defaults to the real fs copy (copyStagedIntoWorktree). */
  copyUploads?: (images: string[], worktreePath: string) => string[];
  /** Detects/terminates leftover subprocesses at close; absent in tests that skip it. */
  reaper?: Pick<ProcessReaper, "detect" | "reap" | "stopListenersOnPort">;
  /** Live preview service; provides devPortFor for stopPreview. Absent → stopPreview returns not_found. */
  preview?: Pick<PreviewService, "devPortFor">;
  /** Fast-poll one session's PR (= prPoller.pollSession), to nudge merge detection
   *  when a merge train archives before the 120s sweep surfaces its members' merges.
   *  Fire-and-forget, debounced, no-ops on archived sessions. Absent → no nudge. */
  refreshPr?: (id: string) => void;
  /** Live PR-state map keyed by session id (= prPoller.snapshot), the source the
   *  merge-train reconcile reads to derive which active sessions hold a selected,
   *  still-open PR. Absent → reconcile sees an empty snapshot (marks nothing). Wired
   *  from the poller in src/index.ts. */
  prSnapshot?: () => Record<string, GitState>;
  /** Plugin ids to disable on trimmed auto spawns; defaults to the memoized read of
   *  ~/.claude/settings.json `enabledPlugins` (installedPluginIds). Inject point for tests. */
  pluginIds?: () => Promise<string[]>;
  /** Sandbox backend probe seam (tests inject `() => "bwrap"` / `() => null` so no real
   *  bwrap is spawned); defaults to the cached real self-test in sandbox.ts. */
  detectBackend?: () => SandboxBackend;
  /** Egress-firewall backend probe seam (tests inject `() => "slirp4netns"` / `() => null`
   *  so no real netns/dnsmasq stack is spawned); defaults to the cached real self-test in
   *  egress.ts. Probed only for an autonomous spawn that already has an FS backend. */
  detectEgressBackend?: () => EgressBackend;
  /** Restricted agent-ingress listener port accessor (lazy: the listener starts after this
   *  service is constructed; see src/index.ts). Returns undefined when not wired (tests) or not
   *  yet started; resolveSpawnBaseUrl/prepareSpawn fall back to the loopback main port then. */
  agentIngressPort?: () => number | undefined;
  /** slirp host-loopback capability probe seam (tests inject `() => true` / `() => false`); defaults
   *  to the cached real version probe in egress.ts. Gates reaching Shepherd via 10.0.2.2. */
  detectEgressHostLoopback?: () => boolean;
  /** Per-session DNS-drop watcher; absent in tests that don't care → no-op. */
  egressWatcher?: Pick<EgressWatcher, "start" | "stop">;
  /** Best-effort pre-teardown hook (recap generation) — runs while the worktree still
   *  exists; bounded + swallowed so it can never block teardown. Absent → no hook. */
  beforeArchive?: (s: Session) => Promise<void>;
  /** Hard cap on the beforeArchive hook (ms) so a stuck git can never permanently stall
   *  teardown / the merge train. Defaults to 15_000; tests inject a tiny value. */
  beforeArchiveTimeoutMs?: number;
  /** Resolve the forge for a repo, used at spawn to pull an attached issue's comment
   *  thread into the prompt (see composePromptArg). Absent (tests) or a host without
   *  listIssueComments → the spawn prompt stays body-only. */
  resolveForge?: (repoPath: string) => GitForge | null;
}

/**
 * Keys of `enabledPlugins` in the operator's global ~/.claude/settings.json — the plugin
 * ids a trimmed auto spawn disables per-spawn (see trimDecision). Enumerated at runtime,
 * never hardcoded, so the trim is machine-agnostic. A successful read+parse yields the
 * ids (`[]` when the key is absent/empty — nothing enabled means nothing to disable);
 * `null` when the read or parse THROWS (missing file, bad JSON), so callers can tell a
 * transient error from a legitimately empty config. Async fs only — this server is a
 * single Bun loop pumping the live web terminal, so a sync read here would freeze typing
 * (see src/instrument.ts). `read` is the test seam; production reads the real file.
 */
export async function readInstalledPluginIds(
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<string[] | null> {
  try {
    const raw = await read(join(homedir(), ".claude", "settings.json"));
    const plugins = (JSON.parse(raw) as { enabledPlugins?: unknown }).enabledPlugins;
    return plugins !== null && typeof plugins === "object" ? Object.keys(plugins) : [];
  } catch {
    return null;
  }
}

let pluginIdsCache: Promise<string[]> | null = null;
/** Memoized readInstalledPluginIds: plugins change ~never, so one read per process
 *  lifetime — a server restart picks up changes. Only SUCCESSFUL reads are cached: on
 *  `null` (transient read/parse error) the cache is cleared inside the chained promise,
 *  so in-flight awaiters of this attempt all get `[]` (the spawn proceeds without
 *  plugin-disable this once) while the next NEW caller retries instead of the error
 *  poisoning the trim for the process lifetime. Exported for tests; `read` is the
 *  same test seam as readInstalledPluginIds. */
export function installedPluginIds(read?: (path: string) => Promise<string>): Promise<string[]> {
  return (pluginIdsCache ??= readInstalledPluginIds(read).then((ids) => {
    if (ids === null) pluginIdsCache = null;
    return ids ?? [];
  }));
}

/** Test seam: drop the process-lifetime plugin-ids cache. The cache is populated for
 *  good by the first real spawn (which reads it via the default env path), so the
 *  order-sensitive installedPluginIds cache test must clear it first to assert from a
 *  clean slate regardless of which other suite ran before it. Not used in production. */
export function resetPluginIdsCacheForTests(): void {
  pluginIdsCache = null;
}

/**
 * Per-spawn `--settings` overlay merged on top of the user's settings files. Applied to every
 * Shepherd task spawn — both `create` (`buildSpawnArgv`) and `resume`.
 *
 * Pins `remoteControlAtStartup` so a global opt-in in ~/.claude/settings.json doesn't auto-start
 * Claude Code's Remote Control for every Shepherd session (default false suppresses the
 * notification noise); `/remote-control` in the terminal still toggles it per-session.
 *
 * Pins `env.ENABLE_CLAUDEAI_MCP_SERVERS = "false"` to disable the claude.ai account-connector MCP
 * servers (Gmail / Google Calendar / Google Drive / Notion / Microsoft 365) for every spawned
 * coding agent (issue #509). Least-privilege hygiene, NOT a token win — the #499 spike measured
 * the saving at only −132 tok/turn (connectors load as deferred, name-only tools) — but an
 * autonomous coding agent has no business reaching the operator's personal Gmail/Notion.
 * Unconditional and not opt-out'able by design; the overlay `env` merges key-by-key over the
 * user's settings so the rest of their env is untouched. (Reviewer/critic/plan-gate spawns don't
 * use this overlay — they run `--safe-mode`, which disables file/plugin MCP *loading* + other
 * customizations, plus `enableAllProjectMcpServers` in their own `--settings` to clear Claude's
 * interactive project-.mcp.json approval gate; see buildTransientAgentArgv.)
 *
 * `disablePlugins` (trimmed auto spawns only) adds `enabledPlugins: {<id>: false, ...}`,
 * which overrides the global `true` per-spawn and kills plugin SessionStart hooks, plugin
 * skills, and plugin MCP for this process only. Absent/empty → key omitted entirely, so
 * untrimmed spawns keep today's exact overlay.
 *
 * `hooks` (issue #704, only when `config.hooksIngest`) adds PostToolUse/PostToolUseFailure/
 * Notification/SessionStart/Stop/SessionEnd/SubagentStart/SubagentStop HTTP hooks pointing at
 * this session's ingest route (see buildHooksFragment). Flag off → key omitted entirely, so the
 * overlay JSON stays byte-for-byte identical to today.
 */
export function spawnSettingsOverlay(
  opts: {
    disablePlugins?: string[];
    hooks?: { sessionId: string; baseUrl: string; token: string | null };
  } = {},
): string {
  const settings: Record<string, unknown> = {
    remoteControlAtStartup: config.remoteControlAtStartup,
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
  };
  if (opts.disablePlugins && opts.disablePlugins.length > 0) {
    settings.enabledPlugins = Object.fromEntries(opts.disablePlugins.map((id) => [id, false]));
  }
  if (config.hooksIngest && opts.hooks) {
    settings.hooks = buildHooksFragment(opts.hooks);
  }
  // api-key mode folds in `apiKeyHelper` LAST so key order is stable; subscription
  // returns {} so the JSON is byte-for-byte identical to before (see spawn-auth).
  Object.assign(settings, apiKeySettingsFragment());
  return JSON.stringify(settings);
}

/**
 * Build the `hooks` overlay fragment (issue #704): one synchronous `http` hook per event
 * (PostToolUse, PostToolUseFailure, Notification, SessionStart, Stop, SessionEnd, plus the
 * Phase-3 #710 SubagentStart/SubagentStop sub-agent fan-out lifecycle), matcher `"*"`, short
 * fail-open timeout, pointed at `POST <baseUrl>/api/sessions/<sessionId>/hooks`.
 *
 * Auth (Finding 2): the `--settings` JSON rides the spawn process argv (ps-visible), NOT the
 * transcript — so we NEVER bake the literal token. When a token is configured we emit a
 * `$SHEPHERD_TOKEN` placeholder + `allowedEnvVars`; Claude Code resolves it from the hook
 * process env (only listed vars are interpolated). With no token (open loopback) we omit the
 * `headers` + `allowedEnvVars` keys entirely, matching the queue route's no-auth path.
 *
 * Token + `autonomous` (issue #711, DELIBERATE): under the autonomous membrane `--clearenv`
 * strips `SHEPHERD_TOKEN`, so `$SHEPHERD_TOKEN` interpolates empty → the ingress listener 401s
 * → hooks fail-open to polling (today's behaviour). We keep the placeholder rather than baking
 * the literal token here ON PURPOSE: the hook header rides the ps-visible argv and is readable
 * from the autonomous agent's own `/proc/self/cmdline`, so baking it would hand a hijacked agent
 * the control-plane token — defeating the containment the autonomous profile exists to provide.
 * This is asymmetric with the build-queue curl (buildQueueDirective), which DOES carry the literal
 * token over the same ingress transport: that exposure is pre-existing, opt-in (only when
 * `buildQueueEnabled`), and already documented as accepted there. Token-LESS deployments (the
 * default) are unaffected and reach hooks under autonomous normally. To make token + autonomous
 * hooks reach, re-inject the token into the sandbox env or accept the literal-in-argv exposure —
 * intentionally NOT done here.
 */
export function buildHooksFragment(input: {
  sessionId: string;
  baseUrl: string;
  token: string | null;
}): Record<string, unknown> {
  const authFields: Record<string, unknown> =
    input.token !== null
      ? {
          headers: { Authorization: "Bearer $SHEPHERD_TOKEN" },
          allowedEnvVars: ["SHEPHERD_TOKEN"],
        }
      : {};
  const httpHook = {
    type: "http",
    url: `${input.baseUrl}/api/sessions/${input.sessionId}/hooks`,
    timeout: 5,
    ...authFields,
  };
  const eventEntry = [{ matcher: "*", hooks: [httpHook] }];
  return {
    PostToolUse: eventEntry,
    PostToolUseFailure: eventEntry,
    Notification: eventEntry,
    SessionStart: eventEntry,
    Stop: eventEntry,
    SessionEnd: eventEntry,
    // Phase 3 (#710): the same HTTP hook receives the sub-agent fan-out lifecycle so the
    // server can track each session's live/done sub-agent roster.
    SubagentStart: eventEntry,
    SubagentStop: eventEntry,
  };
}

/**
 * Trim decision for one spawn/resume argv — the single helper shared by buildSpawnArgv
 * and resume() so the two spawn sites can't drift (issue #499). An auto (drain) session
 * with `config.trimAutoContext` on gains:
 *  - `--disable-slash-commands`: removes the entire skill catalog from the fixed prefix;
 *  - an `enabledPlugins:false` settings overlay for every operator-enabled plugin
 *    (spawnSettingsOverlay): kills plugin SessionStart hook injections, skills, and MCP;
 *  - the context-trim system-prompt notice (composeSystemPrompt `trimmed`) — fresh spawns
 *    only: resume() re-passes no `--append-system-prompt` (pre-existing: house rules /
 *    directives don't ride resumes either), so a resumed trimmed session deliberately has
 *    skills off without the notice.
 * Measured −6,349 tokens/turn combined in the issue-499 spike. Deliberately NOT
 * `--settings disableAllHooks` — that would kill the operator's global SessionStart hook
 * Shepherd's status pipeline depends on. Interactive spawns are untouched.
 */
async function trimDecision(
  auto: boolean,
  pluginIds: () => Promise<string[]>,
): Promise<{ extraFlags: string[]; overlayOpts: { disablePlugins?: string[] }; trimmed: boolean }> {
  if (!auto || !config.trimAutoContext) {
    return { extraFlags: [], overlayOpts: {}, trimmed: false };
  }
  return {
    extraFlags: ["--disable-slash-commands"],
    overlayOpts: { disablePlugins: await pluginIds() },
    trimmed: true,
  };
}
type TrimDecision = Awaited<ReturnType<typeof trimDecision>>;

/**
 * Appended to every spawned session's system prompt. The async namer
 * (`refineNameInBackground`) can `git branch -m` the session branch 10–60s after
 * start — while the agent is already working — so an agent that inspects git state
 * mid-task would otherwise read the changed branch name as an error (cf. TASK-177).
 * Pre-warning it at spawn removes the surprise at the source. Not user-facing chrome
 * (it's an instruction to the agent), so no i18n.
 */
const BRANCH_RENAME_NOTICE =
  "Shepherd may rename this session's git branch shortly after startup to a clearer, " +
  "prompt-derived name (via `git branch -m`). This is expected: your working tree, " +
  "commits, and checked-out HEAD are unaffected — never treat a changed branch name as an error.";

/**
 * Injected only into trimmed auto (drain) spawns — sessions launched with
 * `--disable-slash-commands` + an `enabledPlugins:false` settings overlay (issue #499,
 * see trimDecision). Without it, CLAUDE.md / memory instructions like "use the superpowers
 * skill" would send the agent hunting for a Skill tool that isn't there. Agent-facing
 * prompt text (not operator UI), so fixed English — same precedent as BRANCH_RENAME_NOTICE.
 */
const CONTEXT_TRIM_NOTICE =
  "This unattended session runs with the skill catalog, slash commands, and optional " +
  "plugins disabled to cut per-turn context overhead. The Skill tool and slash commands " +
  "are unavailable — ignore any instructions (e.g. in CLAUDE.md or memory files) to invoke " +
  "skills such as superpowers; use built-in tools directly instead (the Agent tool for " +
  "subagent execution, Bash, Edit, and so on).";

/**
 * Universal engineering posture injected into every spawn (issue #349, adapted from the
 * MIT-licensed Karpathy-style Claude Code skills). Unlike the `<shepherd-house-rules>` block
 * — per-repo, learned, budget-limited and toggle-gated — this is fixed, repo-independent
 * standing posture, so it lives in source and rides every spawn unconditionally.
 *
 * It biases the agent *against over-building*, the classic unattended-overnight failure mode
 * the curated (defect-prevention) house rules don't cover. Scope notes baked into the wording:
 *  - "Think before coding" is deliberately scoped to PRE-EXECUTION. Once running autonomously,
 *    the autopilot don't-pause-to-ask rule still wins — the agent proceeds on stated assumptions.
 *  - The dead-code clause harmonizes with the curated "don't ship dead code" rule: remove only
 *    what YOUR change orphaned; surface (don't silently delete) pre-existing unrelated dead code.
 * Agent-facing prompt text (not operator UI), so fixed English — same precedent as
 * BRANCH_RENAME_NOTICE and the distiller/critic spawn prompts.
 */
const ENGINEERING_POSTURE =
  "Standing engineering posture for every change — adopt it regardless of the task.\n" +
  "- Think before coding (pre-execution only): before you start, state your key assumptions, " +
  "surface genuine ambiguity and any clearly simpler approach, and name what's unclear. Resolve " +
  "this up front — once you are executing autonomously, do NOT pause to ask; proceed on your stated assumptions.\n" +
  "- Simplicity first: write the minimum code that solves the stated problem, nothing speculative. " +
  "No features beyond what was asked, no abstractions for single-use code, no unrequested " +
  "flexibility/config, no error handling for genuinely impossible cases. Test: would a senior " +
  "engineer call this overcomplicated?\n" +
  "- Surgical changes: touch only what the task requires — every changed line should trace to the " +
  "request. Don't refactor working code, reformat, or polish adjacent code/comments; match existing " +
  "style. Delete only the imports/vars/functions YOUR change orphaned; for pre-existing unrelated " +
  "dead code, surface it rather than silently expanding the diff.\n" +
  "- Goal-driven execution: turn the task into explicit, verifiable success criteria up front, then " +
  "loop until they actually pass — never declare work done before verifying against them.\n" +
  "- Ephemeral scaffolding self-cleans: never leave a detached `&` background job (load generator, " +
  "busy-loop, dev server, watcher) running past the step that needs it. Backgrounded jobs reparent to " +
  "PID 1 when their shell exits and outlive you — silently burning CPU for days. Kill what you spawn in " +
  "the SAME shell, or wrap a throwaway repro script so a `trap` reaps its jobs on exit.";

/**
 * Fixed, repo-independent standing guidance injected into every spawn (issue #347, sourced from
 * the upstream Tank unattended prompt). Counterpart to ENGINEERING_POSTURE: that block stops the
 * agent *over-building*; this one stops it building against a *stale or assumed* external API. Left
 * uncorrected on an overnight/unattended run, the agent confidently scaffolds many files against a
 * library version or pattern that's no longer current, with no human to catch it early — a cheap
 * web search up front is high-leverage insurance against that.
 *
 * Deliberately scoped to non-trivial code against an external library/framework/API the agent isn't
 * sure is current, so it doesn't fire a search on every trivial edit or well-known pattern. WebSearch
 * is already allowed for task agents, so this adds no new permission prompt. Agent-facing prompt text
 * (not operator UI), so fixed English — same precedent as the other notices.
 */
const RESEARCH_FIRST_NOTICE =
  "Before writing non-trivial code against an external library, framework, or API — especially one " +
  "you're not certain is current — do a quick web search to confirm the present best approach, then " +
  "note in one or two lines what you found and why you chose it. Skip this for trivial edits and " +
  "well-established patterns you're already confident about; it exists to stop you scaffolding many " +
  "files against a stale or assumed API with no human to correct course.";

/**
 * Injected into the system prompt only for isolated sessions (worktree-backed). Non-isolated
 * sessions share the main repo directory and have no dedicated worktree, so the file would be
 * ambiguous and the hint would be misleading — it is intentionally omitted there.
 *
 * The hint is advisory and safe: Shepherd uses the declared port only when it is actually
 * listening (auto-detection still fires otherwise), and it explicitly never starts or stops the
 * dev server. Agent-facing prompt text (not operator UI), so fixed English — same precedent as
 * BRANCH_RENAME_NOTICE and the other spawn-constant notices. No i18n.
 */
const PREVIEW_HINT_NOTICE =
  "If you start a long-running dev server in this worktree and want Shepherd's live preview to " +
  "target a specific port, write that port — a bare number, nothing else — to a file named " +
  "`.shepherd-preview` in the repository root. Shepherd uses it only when that port is actually " +
  "listening; otherwise it auto-detects the port. This is optional: skip it if you have no dev " +
  "server or the default detection already targets the right port. Shepherd never starts or stops " +
  "your dev server.";

/**
 * Seeded into the system prompt at spawn when the repo has autopilot on, so the agent knows
 * up front it's running unattended. Without it autopilot is purely reactive — the agent stops
 * to ask "commit + open a PR?", and a steer only lands after a stop is detected and classified
 * (which the operator routinely beats by answering manually). Stating the contract up front
 * stops the procedural halt at the source. Deliberately conditional ("for a code change…") so a
 * research / issue-creation task isn't pushed to open a meaningless PR. Not user-facing chrome
 * (an instruction to the agent), so no i18n.
 */
const AUTOPILOT_DIRECTIVE =
  "You are running unattended in Shepherd autopilot. Do not stop to ask for permission on " +
  "procedural or workflow steps — writing a spec or plan, committing, pushing, or opening a " +
  "pull request. Make a reasonable decision and keep going until the task's deliverable is " +
  "complete; for a code change that means an open PR (`gh pr create`). Only stop to ask when " +
  "you hit a genuine product or requirements decision that only a human can make.";

/**
 * The one-session-one-PR invariant (issue #839). Shepherd tracks ONE branch per session and
 * resolves its PR on demand — there is no per-session list of PRs. When one session opens a second
 * PR on a different branch (e.g. the #830/#835 "Part A / Part B" split out of #825), that PR is
 * invisible to the session entirely: never reviewed, never merge-tracked, never recapped, never
 * landed. The critic, pr-poller, review, merge-train, epic, and recap wiring are all
 * session → single-tracked-PR by design.
 *
 * Wording is deliberately CONDITIONAL ("when you open a pull request…"), not an absolute "this
 * session opens exactly one PR." It rides the same `!opts.research` path as non-research
 * issue-creation / triage spawns; an absolute form would mandate a PR and contradict
 * AUTOPILOT_DIRECTIVE's deliberately-conditional framing (see above — "for a code change that means
 * an open PR…"), pushing those spawns toward a meaningless PR.
 *
 * Escape hatch (a) is worded honestly: epic drain is operator/drain-driven (server
 * `/api/epic/approve-next` → drain.approveEpicNext + drain.tick), so an agent CANNOT self-trigger
 * Shepherd to drain an epic — it sets the epic up and STOPS. Hatch (b) (one PR + follow-up issue)
 * is the always-safe default.
 *
 * Advisory only — there is no enforcement. The data layer cannot see a second PR on another branch,
 * so recurrence stays possible; the deferred detection guardrail (split-marker scan) is the
 * enforcement path if guidance proves insufficient. Agent-facing prompt text (not operator UI), so
 * fixed English — same precedent as AUTOPILOT_DIRECTIVE and the other spawn-constant directives.
 */
const SINGLE_PR_INVARIANT =
  'When you open a pull request, open exactly one — never a second, and never label work "PR 1 of ' +
  'N." This holds even when the task or its issue describes multiple parts, phases, or "Part A / ' +
  'Part B." If the work is genuinely too large for one cohesive PR, pick ONE of:\n' +
  "- (a) Promote to an epic: convert the issue into an epic — add one sub-issue per intended PR " +
  "(and an `epic-dag` fence if you map dependencies) — open NO pull request yourself, then STOP " +
  "and tell the operator the epic is ready to drain. Shepherd drains each sub-issue as its own " +
  "session and its own PR, but that drain is operator-started — you cannot trigger it yourself.\n" +
  "- (b) Ship one PR + file a follow-up: complete and open a single cohesive PR for the slice you " +
  "can finish, then `gh issue create` a follow-up issue capturing the remainder for a later agent, " +
  "and reference it from the PR body. This is the always-safe default.\n" +
  "Never split the work across two PRs from this one session.";

/**
 * Injected as the highest-priority directive for an attended RESEARCH task (`research: true`).
 * A research session does open-ended web research with sub-agents and delivers a report-only PR
 * OR a GitHub issue — never code. It SUPPRESSES the plan-gate, autopilot, and build-queue
 * directives (see composeSystemPrompt), since none of those fit a research deliverable. Not
 * user-facing chrome (an instruction to the agent), so no i18n — same precedent as
 * AUTOPILOT_DIRECTIVE and the other spawn-constant directives.
 */
const RESEARCH_DIRECTIVE =
  "You are running as an attended RESEARCH task — open-ended web research with sub-agents, NOT " +
  "writing product code.\n" +
  "- Use web search / fetch and dispatch sub-agents to investigate thoroughly, then synthesize " +
  "the findings yourself.\n" +
  "- Deliver exactly ONE of: (a) a markdown report written to `docs/research/<slug>.md` and " +
  "opened as a report-only PR — that report file is the ENTIRE diff, no code changes; or (b) a " +
  "GitHub issue capturing the findings and recommendation. Choose (a) for reference material, " +
  "(b) for actionable follow-up work.\n" +
  "- Do NOT open a code pull request and do NOT modify product code. Once your deliverable " +
  "(report PR or issue) is up, you are done.\n" +
  "- You are attended: ask the user on a genuine product/requirements decision; otherwise keep going.";

/**
 * Build the build-queue directive injected at spawn when the repo has `buildQueueEnabled`.
 *
 * The build queue is a per-session, ordered, self-revising plan: the agent authors it via a
 * local REST API right after reading the task, a human (or autopilot) approves it, then the
 * agent executes it step-by-step IN THIS SAME SESSION so it retains full context throughout.
 *
 * Why bake the actual endpoint + session id at spawn time (rather than leaving the agent to
 * discover them)? Two reasons:
 *  1. Reliability: the agent doesn't have to guess the server address or its own session id
 *     under an unattended run — a misread would silently produce an unreachable URL.
 *  2. Curation gate: the autopilot/attended split is a policy decision that should be stated
 *     up front, not inferred mid-run. The agent knows BEFORE starting whether it must wait
 *     for human approval or may immediately execute after authoring.
 *
 * Token/auth: when `config.token` is set the server requires `Authorization: Bearer <token>`;
 * when null it's open to loopback callers — the curl lines must match exactly.
 *
 * SECURITY NOTE: baking the bearer token into the spawn prompt means it is persisted into the
 * agent's Claude Code transcript jsonl on disk (`~/.claude/projects/.../<session>.jsonl`). This
 * is an accepted exposure, not an oversight: the token is Shepherd's own loopback control-plane
 * secret, the transcript lives under the same user account on the same host, and the agent is
 * already spawned with `--dangerously-skip-permissions` (it can read that token from the running
 * server's env or config anyway). The exposure is also opt-in — most deployments leave
 * `config.token` null, so nothing is written. It is NOT a credential that reaches any third party.
 *
 * Agent-facing prompt text (not operator UI), so fixed English — same precedent as
 * AUTOPILOT_DIRECTIVE, BRANCH_RENAME_NOTICE, and the other spawn-constant notices.
 */
export function buildQueueDirective(args: {
  sessionId: string;
  baseUrl: string;
  token: string | null;
  autopilot: boolean;
}): string {
  const { sessionId, baseUrl, token, autopilot } = args;
  const authHeader = token ? ` \\\n  -H "Authorization: Bearer ${token}"` : "";
  const queueUrl = `${baseUrl}/api/sessions/${sessionId}/queue`;

  const curationGate = autopilot
    ? "No human will gate this run — the queue is auto-approved for visibility and curation. " +
      "Author the queue, then immediately begin executing the steps in order without waiting."
    : "After you author the queue, STOP and wait. A human will review, edit, and approve it " +
      "in the UI; you will then receive a message telling you to begin. " +
      "Do NOT start executing steps until you get that go-ahead.";

  return (
    "This session has a build queue: an ordered, curatable, self-revising plan that you author " +
    "via the Shepherd API, then execute step-by-step IN THIS SAME SESSION. Each step builds on " +
    "the previous one and you retain full context throughout — no context loss between steps.\n\n" +
    "Build-queue API (use these exact curl commands):\n\n" +
    "1. Author / replace the whole plan (do this first, before starting any work):\n" +
    `   curl -s -X PUT${authHeader} \\\n` +
    `     -H "Content-Type: application/json" \\\n` +
    `     -d '{"steps":[{"id":"s1","title":"Step title","detail":"Optional detail"}]}' \\\n` +
    `     ${queueUrl}\n` +
    "   Assign each step your own short, stable `id` (`s1`, `s2`, …) and ALWAYS resend a step with " +
    "the SAME `id` on every PUT: an id you own is stored verbatim and never regenerated, so your " +
    "cached ids stay valid across re-PUTs. The response echoes each step's `id` and the queue's " +
    "`approved` flag.\n\n" +
    "2. Mark a step's progress (use the `id` values from the PUT/GET response):\n" +
    `   curl -s -X POST${authHeader} \\\n` +
    `     -H "Content-Type: application/json" \\\n` +
    '     -d \'{"status":"active"}\' \\\n' +
    `     ${queueUrl}/steps/{stepId}     # when you start a step\n` +
    `   curl -s -X POST${authHeader} \\\n` +
    `     -H "Content-Type: application/json" \\\n` +
    '     -d \'{"status":"done"}\' \\\n' +
    `     ${queueUrl}/steps/{stepId}     # when you finish a step\n` +
    '   Use "skipped" if you decide to drop a step.\n\n' +
    "   Update as you go: mark a step `active` the moment you start it and `done` the moment you " +
    "finish — never batch the updates at the end. Work the steps IN ORDER; when you advance a step " +
    "the server automatically completes any earlier steps still pending, so even a single timely " +
    "update keeps the whole queue accurate. The operator's view of your progress depends entirely " +
    "on these. If your reported statuses ever fall behind your actual progress you may receive a " +
    "reminder to reconcile them — do so promptly.\n\n" +
    "   The POST response echoes the full queue — confirm your step's new status in it. A 4xx body " +
    "means the update did NOT take. IMPORTANT: ids you assign yourself (`s1`, `s2`, …) are kept " +
    "verbatim across every PUT, so always reuse them — that is what keeps your cached ids valid. " +
    "Only a step PUT WITHOUT an `id` gets a server-generated one, and an omitted id survives a " +
    "re-PUT only when that step keeps the same position AND title; otherwise it is regenerated. " +
    "So the rule is: assign and resend your own ids. Fallback only if you didn't — re-GET (or read " +
    "the PUT response) to pick up the current ids before posting status. A short id resolves by " +
    "exact match; a server UUID may also be posted as an unambiguous prefix of ≥8 chars (a 409 " +
    "means the prefix matched several steps — use a longer prefix or the full id).\n\n" +
    "3. Inspect the current queue at any time:\n" +
    `   curl -s${authHeader} ${queueUrl}\n\n` +
    "Self-revision: if you discover a better approach mid-run, PUT an updated steps array. " +
    "Only add, change, or remove steps that are still PENDING. ALWAYS include each carried step " +
    "with its existing `id` (its status is kept server-side) — that is how completed and " +
    "in-progress steps keep their identity across the revision.\n\n" +
    "Runaway guard: keep the plan small and focused (a handful of steps). " +
    "Do not let self-revision loop indefinitely — each PUT should reflect a genuine course correction, " +
    "not iterative micro-adjustment.\n\n" +
    curationGate
  );
}

/**
 * Pre-execution PLAN GATE directives. When the plan gate is on for a session, one of these
 * REPLACES the autopilot directive during the planning phase — planning deliberately suppresses
 * autopilot so the agent stops to plan/grill instead of rushing to a PR. The interactive variant
 * grills a present human ACTIVELY — clarifying questions are asked via AskUserQuestion / in the
 * conversation, never parked as an open-questions list in the plan; the auto variant runs
 * unattended (drain) and just writes the plan. English, not i18n'd — agent-facing prompt text,
 * same precedent as AUTOPILOT_DIRECTIVE.
 */
/**
 * Returns agent-facing instructions for optionally emitting a `.shepherd-plan-blocks.json`
 * sidecar alongside `.shepherd-plan.md`. Not i18n'd — same precedent as the directives.
 * When `allowQuestionForm` is false (interactive), the `question-form` block type is omitted
 * entirely and the agent is told to ask questions live, not park them in the sidecar.
 */
export function planBlockInstructions(opts: { allowQuestionForm: boolean }): string {
  const lines: string[] = [
    "## Optional visual-plan sidecar",
    "",
    "Emitting blocks is OPTIONAL. The authoritative plan is `.shepherd-plan.md`; " +
      "`.shepherd-plan-blocks.json` is purely a visual-rendering aid for that plan. " +
      "It is NOT a place to park decisions or open questions.",
    "",
    "**Sidecar contract:** write a JSON ARRAY of blocks to `.shepherd-plan-blocks.json` " +
      "in the repo root (same directory as `.shepherd-plan.md`). Strict valid JSON, no comments.",
    "",
    "**Same-turn write coupling (critical):** write/update `.shepherd-plan-blocks.json` " +
      "in the same turn as — and before you stop after — writing/updating `.shepherd-plan.md`. " +
      "Re-write the sidecar on EVERY plan revision. " +
      "(The server captures blocks when it reviews the plan; a sidecar written after the plan text is missed.)",
    "",
    "**No diff at plan time:** a plan is built TOWARD a change, so there is NO diff yet. Therefore: " +
      "do not use `diff`, `code`, or `annotated-code` blocks (the server drops them — there is no real content to show). " +
      "`file-tree` lists the paths the plan INTENDS to touch (intended, not yet changed). " +
      '`data-model`/`api-endpoint`/`mermaid` describe PROPOSED designs and will be tagged "inferred" automatically.',
    "",
    "**Block catalog (plan-relevant subset):**",
    '- rich-text:    {"type":"rich-text","id":"<unique>","markdown":"<prose>"} — narrative / the why.',
    '- callout:      {"type":"callout","id":"...","tone":"info|decision|risk|warning|success","markdown":"..."} — toned note for a decision, risk, or assumption.',
    '- file-tree:    {"type":"file-tree","id":"...","title?":"...","entries":[{"path":"<intended path>","change":"added|modified|removed|renamed","note?":"<short>"}]} — paths the plan INTENDS to touch.',
    '- data-model:   {"type":"data-model","id":"...","entities":[{"id":"...","name":"...","fields":[{"name":"...","type":"...","pk?":true,"fk?":"<ref>","nullable?":true}]}],"relations?":[{"from":"...","to":"...","kind":"..."}]} — proposed ERD. Will be tagged inferred automatically.',
    '- api-endpoint: {"type":"api-endpoint","id":"...","method":"GET|POST|...","path":"<route>","summary?":"...","params?":[{"name":"...","in":"path|query|body","type":"...","required?":true}],"responses?":[{"status":200,"description?":"..."}]} — proposed route. Will be tagged inferred automatically.',
    '- table:        {"type":"table","id":"...","columns":["A","B"],"rows":[["a","b"]]} — columnar comparison or summary. Redact secrets.',
    '- checklist:    {"type":"checklist","id":"...","items":[{"id":"...","label":"...","note?":"...","checked?":false}]} — task list or step checklist.',
    '- mermaid:      {"type":"mermaid","id":"...","source":"<mermaid diagram source>","caption?":"..."} — proposed architecture or flow diagram. Will be tagged inferred automatically.',
    '- wireframe:    {"type":"wireframe","id":"...","surface":"browser|desktop|mobile|popover|panel","html":"<themed HTML mockup>","caption?":"..."} — ONLY for intended UI. ' +
      "Author with the wf helper classes + class-based color; NEVER inline hex/rgb()/hsl()/color()/font-family/box-shadow, and never <script>/<style>/event handlers/href.",
  ];

  if (opts.allowQuestionForm) {
    lines.push(
      '- question-form: {"type":"question-form","id":"...","questions":[{"id":"...","prompt":"...","kind":"single|multi|freeform","options?":["..."]}]} ' +
        "— for surfacing genuinely-undecidable-without-a-human questions when running unattended. Use sparingly: only for questions that cannot be resolved by reading the codebase.",
    );
  } else {
    lines.push(
      "In interactive mode you must ask questions live — never park them in the plan or sidecar. " +
        "Ask questions live in the conversation (or via AskUserQuestion for choices); the sidecar carries only rendering blocks.",
    );
  }

  lines.push(
    "",
    "**Rules:**",
    "- Every block must have a unique string `id`.",
    "- Redact secrets (API keys, tokens, passwords) in any summary/markdown/annotation — use placeholders like `sk-•••` / `<redacted>`.",
  );

  return lines.join("\n");
}

const PLAN_GATE_DIRECTIVE_INTERACTIVE =
  "You are in Shepherd's pre-execution PLAN GATE. Do NOT write or modify any product code yet.\n" +
  "1. Research the codebase enough to plan confidently.\n" +
  "2. Ask the user actively — do NOT hide questions in the plan or a spec file. Use the AskUserQuestion " +
  "tool for choice-style clarifications, and ask open-ended questions directly in the conversation. Keep " +
  "asking sharp, specific questions until you and the user are genuinely aligned on scope, approach, and " +
  "success criteria. Misalignment now is the costliest failure.\n" +
  "3. When aligned, write the plan to `.shepherd-plan.md` at the repo root (goal, approach, files, " +
  "steps, risks, success criteria) and tell the user it's ready for review. The plan must contain NO open / " +
  "unresolved / TBD questions — resolve every question by asking first; it may still record stated " +
  "assumptions and resolved decisions.\n" +
  "An adversarial reviewer will critique the plan; address its findings by revising `.shepherd-plan.md`. " +
  "Begin implementing ONLY after the plan is approved and you are told to execute.\n\n" +
  planBlockInstructions({ allowQuestionForm: false });
const PLAN_GATE_DIRECTIVE_AUTO =
  "You are in Shepherd's pre-execution PLAN GATE, running unattended (no human to ask). Do NOT write " +
  "or modify product code yet. Research the codebase, then write a concrete plan to `.shepherd-plan.md` " +
  "at the repo root (goal, approach, files, steps, risks, success criteria). An adversarial reviewer " +
  "will critique it; revise `.shepherd-plan.md` to address findings. Begin implementing ONLY after you " +
  "are told the plan is approved.\n\n" +
  planBlockInstructions({ allowQuestionForm: true });
export { PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO };

/**
 * Appended to a draftMode repo's spawn prompt and PR-open steers. Agent-facing, NOT i18n'd.
 * The reconcile service (draft-reconcile.ts) is the backstop that promotes drafts once signed
 * off; this note is the primary, best-effort signal so the agent opens it correctly up front.
 */
export const DRAFT_PR_NOTE =
  "This repo runs in draft mode: when you open the pull request, open it as a DRAFT (`gh pr create --draft`). " +
  "Shepherd promotes it to ready-for-review automatically once it's signed off (a human approval and/or the " +
  "critic, per repo config) — do NOT run `gh pr ready` yourself.";

/**
 * Build the steer text sent to an agent to start its dev server in the background.
 * Must instruct the agent to run the command in an agent-appropriate background
 * mechanism so it does NOT block on the dev server (a foreground dev server never
 * exits and would hang the agent's turn forever), and to report the tailnet HTTPS
 * URL — operators reach previews over the tailnet, so a localhost-only confirmation
 * is useless to them. The FQDN is resolved by the agent at runtime (never baked into
 * this prompt — it would leak the operator's tailnet name into every transcript
 * template). Agent-facing, NOT i18n'd.
 */
export function PREVIEW_START_STEER(
  command: string,
  agentProvider: "claude" | "codex" = "claude",
): string {
  const startDirective =
    agentProvider === "codex"
      ? `For Codex: please start \`${command}\` as a Codex-managed long-running/background terminal command, not as a blocking foreground command. In Codex CLI, keep it in a background terminal so it can be inspected with \`/ps\` and stopped with \`/stop\`; in the Codex app, use the integrated terminal or a project Action for the dev server. `
      : `For Claude Code: please run \`${command}\` in the background (use Claude Code's background run / append \`&\` so it does NOT block your turn — a foreground dev server never exits and would hang you forever). `;

  return (
    startDirective +
    `Confirm the port it's listening on once it starts. Then ALWAYS report the tailnet HTTPS URL, ` +
    `not just localhost: ensure the mapping \`tailscale serve --bg --https <port> http://localhost:<port>\` ` +
    `is registered, resolve this node's MagicDNS name (e.g. \`tailscale status --json\` → Self.DNSName), ` +
    `verify \`https://<fqdn>:<port>/\` responds, and include that URL in your confirmation. If tailscale ` +
    `is unavailable on this machine, say so and report the local URL instead. ` +
    `Then continue what you were doing.`
  );
}

/** Steered into a planning session when its plan is approved and the operator hits Go (or an
 *  auto session auto-releases). Hands the agent from the grill/plan phase into execution. NOT i18n'd.
 *  When `draftMode` is true, appends the draft-PR note so the agent opens a draft PR. */
const PLAN_GO_STEER_BASE =
  "Plan approved. Execute `.shepherd-plan.md` now, autonomously — implement it fully, commit, push, " +
  "and open a pull request (`gh pr create`). Don't re-litigate the plan; if you hit a genuine product " +
  "decision that only the user can make, ask, otherwise keep going.";

/** Returns the plan-go steer, appending the draft-mode note when `draftMode` is true. */
export function planGoSteer(draftMode: boolean): string {
  return draftMode ? `${PLAN_GO_STEER_BASE} ${DRAFT_PR_NOTE}` : PLAN_GO_STEER_BASE;
}

/**
 * Compose the spawn-time system prompt passed via a single `--append-system-prompt`
 * (the flag is last-wins, not repeatable, so all blocks must share one value).
 *
 * House rules used to be prepended to the human prompt, which let standing guidance bleed
 * into the task on every spawn. They now live in the system prompt, each block XML-wrapped
 * so the agent can cleanly separate persistent guidance from the task in its human turn.
 * `houseRules` is the already-wrapped `<shepherd-house-rules>` block, or null when there are
 * none / learnings are disabled; the engineering-posture, research-first, and branch-rename blocks
 * always ride. The `<single-pr-invariant>` block (issue #839) rides every spawn EXCEPT a research
 * one (`opts.research`) — research already caps at one report-PR / issue, so it's redundant there.
 * `autopilotActive` appends the autopilot directive (see above), UNLESS `opts.planGate`
 * is set: the plan gate and autopilot are mutually exclusive. During the planning phase the matching
 * plan-gate directive (interactive/auto) is appended INSTEAD of the autopilot directive, even when
 * `autopilotActive` is true — planning must suppress autopilot so the agent stops to plan/grill
 * rather than driving straight to a PR. `opts.research`, when set, takes precedence over BOTH and
 * appends the research directive INSTEAD — and it also suppresses the build-queue block (a research
 * session authors no queue), so research suppresses plan-gate, autopilot, AND build-queue.
 * `opts.buildQueue`, when set (and not research), appends the build-queue
 * directive — orthogonal to the plan-gate/autopilot choice, so it always rides. `opts.previewHint`,
 * when true, appends the preview-hint notice AFTER the build-queue block (or after the
 * plan-gate/autopilot block when no build-queue is present) — isolated-only, orthogonal to all
 * other options. `opts.draftMode`, when true, appends a `<draft-mode>` block instructing the agent
 * to open PRs as drafts — independent of the plan-gate/autopilot/build-queue choice (harmless during
 * planning; the agent only opens a PR later). `opts.trimmed`, when true, appends the context-trim
 * notice — set only for trimmed auto spawns (see trimDecision), orthogonal to everything else.
 */
export function composeSystemPrompt(
  houseRules: string | null,
  autopilotActive = false,
  opts: {
    research?: boolean;
    planGate?: "interactive" | "auto";
    buildQueue?: string | null;
    previewHint?: boolean;
    draftMode?: boolean;
    trimmed?: boolean;
  } = {},
): string {
  const posture = `<engineering-posture>\n${ENGINEERING_POSTURE}\n</engineering-posture>`;
  const research = `<research-first-notice>\n${RESEARCH_FIRST_NOTICE}\n</research-first-notice>`;
  const branchNotice = `<branch-rename-notice>\n${BRANCH_RENAME_NOTICE}\n</branch-rename-notice>`;
  const blocks = houseRules
    ? [posture, research, houseRules, branchNotice]
    : [posture, research, branchNotice];
  // One-session-one-PR invariant (issue #839): rides every code spawn, suppressed only for a
  // research session — which already caps at exactly one report-PR / issue, so the block is
  // redundant there and would muddy that deliverable.
  if (!opts.research) {
    blocks.push(`<single-pr-invariant>\n${SINGLE_PR_INVARIANT}\n</single-pr-invariant>`);
  }
  // Research is the highest-priority directive: it replaces BOTH the plan-gate and the autopilot
  // directive (none of those fit a report-PR/issue deliverable).
  if (opts.research) {
    blocks.push(`<research-directive>\n${RESEARCH_DIRECTIVE}\n</research-directive>`);
  } else if (opts.planGate) {
    const variant =
      opts.planGate === "auto" ? PLAN_GATE_DIRECTIVE_AUTO : PLAN_GATE_DIRECTIVE_INTERACTIVE;
    blocks.push(`<plan-gate-directive>\n${variant}\n</plan-gate-directive>`);
  } else if (autopilotActive) {
    blocks.push(`<autopilot-directive>\n${AUTOPILOT_DIRECTIVE}\n</autopilot-directive>`);
  }
  // Build queue rides independently of the plan-gate/autopilot directive (orthogonal repo config),
  // but a research session authors no queue — suppress it there too.
  if (!opts.research && opts.buildQueue != null)
    blocks.push(`<build-queue>\n${opts.buildQueue}\n</build-queue>`);
  // Preview hint rides last — isolated sessions only. Non-isolated sessions share the main repo dir
  // and have no dedicated worktree, so the hint would be misleading there.
  if (opts.previewHint) {
    blocks.push(`<preview-hint-notice>\n${PREVIEW_HINT_NOTICE}\n</preview-hint-notice>`);
  }
  // Draft-mode block rides independently (orthogonal repo config; harmless during planning phase).
  if (opts.draftMode) blocks.push(`<draft-mode>\n${DRAFT_PR_NOTE}\n</draft-mode>`);
  // Context-trim notice: only trimmed auto spawns (skill catalog / slash commands / plugins off).
  if (opts.trimmed) {
    blocks.push(`<context-trim-notice>\n${CONTEXT_TRIM_NOTICE}\n</context-trim-notice>`);
  }
  return blocks.join("\n\n");
}

/**
 * Base URL an agent uses to reach Shepherd's own API from inside its worktree.
 * When the server binds to 0.0.0.0 (all interfaces) the loopback address is still
 * the right target — the agent always runs on the same machine and 0.0.0.0 isn't
 * a valid call target.
 */
function agentBaseUrl(): string {
  return `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
}

/**
 * Base URL an egress-confined autonomous agent uses to reach Shepherd via the slirp host gateway
 * (10.0.2.2 → host 127.0.0.1), targeting the RESTRICTED agent-ingress listener, not the main port.
 */
function agentEgressBaseUrl(ingressPort: number): string {
  return `http://${SLIRP_HOST_GATEWAY}:${ingressPort}`;
}

/**
 * Base URL a NON-egress-confined agent (trusted / standard — both share the host network namespace)
 * uses to reach the RESTRICTED agent-ingress listener over host loopback (issue #1079). The ingress
 * listener is exempt from the human cookie/password gate, so routing agent hook + build-queue
 * callbacks here keeps them working after auth goes fail-closed — without putting any credential in
 * the agent's env. Autonomous reaches the SAME listener via 10.0.2.2 (agentEgressBaseUrl).
 */
function agentLoopbackIngressBaseUrl(ingressPort: number): string {
  return `http://127.0.0.1:${ingressPort}`;
}

/**
 * Pick an override value over an original: an `undefined` override inherits the original;
 * any present value (including explicit `null`) replaces it. Mirrors the relaunch override
 * semantics where absent means "keep the original" and present means "use this".
 */
function pickOverride<T>(override: T | undefined, original: T): T {
  return override !== undefined ? override : original;
}

/** Renderer env for the MAIN session spawn. Default: pin the classic renderer. The
 *  tuiFullscreen opt-in (research preview) switches to NO_FLICKER. tuiFullscreen also implies
 *  DISABLE_MOUSE (every main session is reachable in the web terminal, where fullscreen
 *  mouse-capture escapes (modes 1000/1002/1003) would be injected into the keystroke stream);
 *  tuiDisableMouse sets it independently (e.g. in classic mode). Applied via both the membrane
 *  --setenv (sandboxed) and the herdr.start env shim (trusted). */
function mainSessionRendererEnv(
  tuiFullscreen: boolean,
  tuiDisableMouse: boolean,
): Record<string, string> {
  const env: Record<string, string> = tuiFullscreen
    ? { CLAUDE_CODE_NO_FLICKER: "1" }
    : { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" };
  if (tuiFullscreen || tuiDisableMouse) env.CLAUDE_CODE_DISABLE_MOUSE = "1";
  return env;
}

/**
 * A freshly-created session is pre-approved into the build queue only when the repo runs the
 * build queue AND the session is effectively on autopilot (so no human approval gate will ever
 * come) AND it isn't a research task. Keyed on the session's EFFECTIVE autopilot (not the raw
 * repo default), so an autopilot-off session — e.g. a merge-train driver — is never auto-approved.
 */
function shouldPreApproveBuildQueue(
  repoConfig: RepoConfig,
  session: Pick<Session, "autopilotEnabled">,
  research?: boolean,
): boolean {
  return (
    repoConfig.buildQueueEnabled &&
    effectiveAutopilot(session, repoConfig.autopilotEnabled) &&
    !research
  );
}

/** Result of the shared spawn-wrap helper (prepareSpawn). `ok:false` carries the
 *  auto-gate hold reason; callers diverge on it (create throws, resume → null). */
type SpawnSuccess = {
  ok: true;
  terminalId: string;
  applied: SandboxProfile;
  degraded: boolean;
  /** True when the egress firewall actually wrapped the spawn (autonomous + both backends). */
  egressApplied: boolean;
  /** True when an interactive autonomous session ran FS-only because egress was unavailable. */
  egressDegraded: boolean;
};
type SpawnOutcome = SpawnSuccess | { ok: false; holdReason: string };

/** Total char budget for the issue-comment block appended to a spawn prompt. Generous —
 *  comments ride out-of-band like the body, so they don't count against the 8000-char
 *  human-prompt guard; this only bounds a runaway thread from bloating the agent's context. */
export const ISSUE_COMMENTS_CHAR_BUDGET = 50_000;

/** Author associations trusted to appear in a spawned task's prompt — accounts with standing
 *  on the repo. Comments from anyone else (CONTRIBUTOR / NONE / first-timers) are dropped:
 *  the issue body has a single (operator-vetted) author, but comments can come from any GitHub
 *  user, so this scopes the included set and bounds the prompt-injection surface. */
const TRUSTED_COMMENT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** True when a comment is one of Shepherd's own issue-log workflow notes: marker-tagged
 *  (current) or matching the pre-marker wording (historical notes posted under the operator's
 *  gh identity — not [bot] and lacking the marker). The wording test is intentionally narrow
 *  (emoji-prefixed, Shepherd-specific) so it won't swallow genuine human comments. */
function isShepherdIssueLogNote(body: string): boolean {
  if (body.includes(SHEPHERD_ISSUE_LOG_MARKER)) return true;
  const t = body.trimStart();
  return t.startsWith("⏸️ Waiting on") || /^✅ PR #\d+ merged/.test(t);
}

/** Render one comment with an author + date header and EVERY body line blockquoted, so a
 *  multi-line comment stays visually fenced from the next. */
function renderIssueComment(c: IssueComment): string {
  const who = c.author ? `@${c.author}` : "unknown";
  const when = c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "";
  const header = when ? `Comment by ${who} (${when}):` : `Comment by ${who}:`;
  const quoted = c.body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `${header}\n${quoted}`;
}

/**
 * Build the out-of-band issue-comment block appended to a task spawned from an issue.
 * Filters Shepherd's own workflow notes, [bot] authors, and untrusted-authorship comments;
 * keeps the NEWEST comments within ISSUE_COMMENTS_CHAR_BUDGET (issue threads put the refined
 * decision at the end), rendered chronologically with each body line blockquoted. When the
 * budget drops older comments, a leading note names how many (and which end) were omitted.
 * Returns "" when nothing survives the filter. Pure + exported for tests.
 */
export function composeIssueCommentsBlock(issueNumber: number, comments: IssueComment[]): string {
  const kept = comments.filter(
    (c) =>
      c.body.trim().length > 0 &&
      !c.author.endsWith("[bot]") &&
      TRUSTED_COMMENT_ASSOCIATIONS.has(c.authorAssociation) &&
      !isShepherdIssueLogNote(c.body),
  );
  if (kept.length === 0) return "";
  const chrono = [...kept].sort((a, b) => a.createdAt - b.createdAt);
  const rendered = chrono.map(renderIssueComment);
  // Walk newest→oldest, accumulating until the next comment would overflow the budget; the
  // newest is always kept (even if it alone exceeds the budget). firstKeptIdx then doubles as
  // the dropped (oldest) count.
  let used = 0;
  let firstKeptIdx = rendered.length;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = (rendered[i]?.length ?? 0) + 2; // +2 ≈ the "\n\n" join between blocks
    if (used + cost > ISSUE_COMMENTS_CHAR_BUDGET && firstKeptIdx < rendered.length) break;
    used += cost;
    firstKeptIdx = i;
  }
  const dropped = firstKeptIdx;
  const lines: string[] = [`GitHub Issue #${issueNumber} comments:`];
  if (dropped > 0)
    lines.push(
      `[${dropped} of ${chrono.length} comments omitted — oldest comments dropped to fit size budget]`,
    );
  lines.push(...rendered.slice(firstKeptIdx));
  return lines.join("\n\n");
}

export class SessionService {
  constructor(private deps: ServiceDeps) {}

  /**
   * Merge-train completion tracker (issue #426). A train that lands ≥1 of its
   * queue PRs should offer a local-checkout fast-forward once, per repo. We track
   * each launched train so we can emit `mergetrain:landed` exactly when the run
   * COMPLETES (the train session archives) — not on the first member merge.
   *
   * `memberToTrain` is the crux of race-safety: a member's merge-credit is looked
   * up by THIS map, never by the session's `mergingTrainId` field, because
   * `clearMergingForTrain` nulls that field at train archive — so a member that
   * merges AFTER the train archived (the poller-gated race) would otherwise be
   * unmappable to its train and its credit lost.
   */
  #trainOffers = new Map<
    string,
    {
      repoPath: string;
      merged: boolean;
      archived: boolean;
      // null while the train is still running — a LIVE entry is reclaimed only once
      // the train leaves #liveTrains (phase A of sweepStaleMerging deregisters a train
      // whose session is archived/missing or inactive past TRAIN_TRACKER_MAX_MS,
      // measured by max(registeredAt, trainSession.updatedAt); phase C then reclaims
      // the offer via liveCrashOrphan). Set to archive time when the train archives
      // awaiting a late credit; the sweep reclaims it once that post-archive window
      // lapses.
      awaitingSince: number | null;
      members: Set<string>;
    }
  >();
  #memberToTrain = new Map<string, string>();

  /**
   * Live merge-trains, the SINGLE source of truth for "is this train running". A
   * train is live iff it has an entry here. Registered when the train session
   * launches (`registerTrain`), removed when it archives (`clearMergingForTrain`)
   * or when the sweep deregisters a crashed/gone one. Keyed by train session id;
   * `prNumbers` is the scoped queue (the PRs the train will land), `repoPath`
   * scopes which active sessions a reconcile may mark, `registeredAt` feeds the
   * crash backstop's last-activity ceiling.
   */
  #liveTrains = new Map<
    string,
    { repoPath: string; prNumbers: Set<number>; registeredAt: number }
  >();

  /**
   * Build the human-turn prompt: the user's text plus any attached images, the issue
   * body, and the issue's comment thread — all appended out-of-band so they never count
   * against the 8000-char human-prompt guard (the same approach for each). The comment
   * thread is the human discussion that refined the original request; fetching it is
   * best-effort (see fetchIssueCommentsBlock) so a spawn never fails on comments.
   *
   * Returns the prompt plus `dropped`: the count of attached images whose staged source
   * was gone (e.g. swept after 24h) so copyStagedIntoWorktree skipped it. The spawn still
   * proceeds without them; the caller emits an operator-visible signal for the drop.
   */
  private async composePromptArg(
    input: CreateSessionInput,
    worktreePath: string,
  ): Promise<{ promptArg: string; dropped: number }> {
    let promptArg = input.prompt;
    let dropped = 0;
    if (input.images.length > 0) {
      const copy = this.deps.copyUploads ?? copyStagedIntoWorktree;
      const copied = copy(input.images, worktreePath);
      if (copied.length > 0) promptArg = `${promptArg}\n\nAttached images:\n${copied.join("\n")}`;
      dropped = input.images.length - copied.length;
      if (dropped > 0) {
        // A staged upload vanished before spawn (swept after STAGING_TTL_MS, or otherwise
        // lost). Note it in-prompt so the agent knows an attachment is missing, and warn.
        promptArg = `${promptArg}\n\n[Note: ${dropped} attached image(s) could not be restored — the upload expired and is unavailable for this session.]`;
        console.warn(
          `[uploads] ${dropped}/${input.images.length} staged image(s) missing at spawn; proceeding without them`,
        );
      }
    }
    if (input.issueRef) {
      const r = input.issueRef;
      promptArg = `${promptArg}\n\nGitHub Issue #${r.number}: ${r.title}\n${r.url}\n\n${r.body}`;
      const comments = await this.fetchIssueCommentsBlock(input.repoPath, r.number);
      if (comments) promptArg = `${promptArg}\n\n${comments}`;
    }
    return { promptArg, dropped };
  }

  /** Best-effort fetch + compose of an attached issue's comment thread. Any missing forge,
   *  a host without listIssueComments, or a fetch/parse error → "" so the spawn proceeds
   *  body-only; a comment fetch must never block or fail a spawn. */
  private async fetchIssueCommentsBlock(repoPath: string, issueNumber: number): Promise<string> {
    try {
      const forge = this.deps.resolveForge?.(repoPath);
      if (!forge?.listIssueComments) return "";
      const comments = await forge.listIssueComments(issueNumber);
      return composeIssueCommentsBlock(issueNumber, comments);
    } catch (err) {
      console.warn(
        `[service] listIssueComments failed for issue #${issueNumber} in ${repoPath}: ${(err as Error)?.message ?? String(err)}`,
      );
      return "";
    }
  }

  /** trimDecision via the injected plugin-id seam (tests) or the real memoized read —
   *  the one resolver both spawn sites (create + resume) go through. */
  private trimFor(auto: boolean | undefined): ReturnType<typeof trimDecision> {
    return trimDecision(auto ?? false, this.deps.pluginIds ?? installedPluginIds);
  }

  /** Sandbox backend probe: injected seam (tests) or the real cached self-test. Checks
   *  for the dep's PRESENCE rather than `?? real()` — the seam legitimately returns null
   *  (no backend), which `??` would collapse into the real probe. */
  private detectBackend(): SandboxBackend {
    if (this.deps.detectBackend) return this.deps.detectBackend();
    return detectSandboxBackend({
      home: homedir(),
      claudeDir: config.claudeDir,
      nodeBinReal: safeRealpath(config.nodeBin),
    });
  }

  /** Egress backend probe: injected seam (tests) or the real cached self-test. Like
   *  detectBackend, checks the dep's PRESENCE rather than `?? real()` — the seam (and the
   *  real probe) legitimately returns null, which `??` would collapse into the real probe. */
  private detectEgressBackend(): EgressBackend {
    if (this.deps.detectEgressBackend) return this.deps.detectEgressBackend();
    return detectRealEgressBackend({
      home: homedir(),
      claudeDir: config.claudeDir,
      nodeBinReal: safeRealpath(config.nodeBin),
    });
  }

  /** slirp host-loopback capability probe: injected seam (tests) or the real cached version
   *  probe. Mirrors detectEgressBackend's PRESENCE check (the seam legitimately returns false). */
  private detectHostLoopback(): boolean {
    return this.deps.detectEgressHostLoopback
      ? this.deps.detectEgressHostLoopback()
      : detectRealEgressHostLoopback();
  }

  /** The host-gateway {ip,port} to bake into an egress-confined autonomous spawn's control-plane
   *  reachability (base URL + the nft allow rule), or null when this spawn must use the loopback
   *  main port instead. SINGLE source for both the baked base URL (resolveSpawnBaseUrl) and the nft
   *  host-gateway rule (prepareSpawn), so the two can never drift. Requires: an egress-confined
   *  autonomous spawn (willEgressConfine) on a host-loopback-capable slirp, with a known ingress port. */
  private egressHostGateway(
    profile: SandboxProfile,
    backend: SandboxBackend,
    egressBackend: EgressBackend,
  ): { ip: string; port: number } | null {
    const ingressPort = this.deps.agentIngressPort?.();
    if (
      ingressPort != null &&
      willEgressConfine(profile, backend, egressBackend) &&
      this.detectHostLoopback()
    ) {
      return { ip: SLIRP_HOST_GATEWAY, port: ingressPort };
    }
    return null;
  }

  /**
   * Which control-plane base URL to bake into a spawn's hooks + build-queue calls. ALL agents are
   * routed through the restricted agent-ingress listener, which is exempt from the human auth gate
   * (issue #1079) so callbacks survive fail-closed without any credential in the agent's env:
   *   - autonomous (egress-confined, host-loopback-capable slirp, known ingress port) → 10.0.2.2;
   *   - trusted / standard (share the host net namespace) → host loopback 127.0.0.1;
   *   - only when the ingress port is unknown (pathological early boot) does it fall back to the
   *     gated main port — those callbacks then 401 and degrade to polling (fail-safe, loggable).
   * Shares the SAME predicate + host-loopback probe + ingress-port accessor that prepareSpawn uses,
   * so the baked URL and the actual wrap/hostGateway decision cannot diverge.
   */
  private resolveSpawnBaseUrl(
    profileOverride: string | null | undefined,
    repoPath: string,
  ): string {
    const profile = resolveProfile(
      profileOverride,
      this.deps.store.getRepoConfig(repoPath).sandboxProfile,
      config.sandboxDefaultProfile,
    );
    if (!egressApplies(profile)) {
      // trusted / standard: reach the exempt ingress over host loopback (no backend probe needed).
      const ingressPort = this.deps.agentIngressPort?.();
      return ingressPort != null ? agentLoopbackIngressBaseUrl(ingressPort) : agentBaseUrl();
    }
    const backend = this.detectBackend();
    const egressBackend = backend !== null ? this.detectEgressBackend() : null;
    const gw = this.egressHostGateway(profile, backend, egressBackend);
    return gw ? agentEgressBaseUrl(gw.port) : agentBaseUrl();
  }

  /**
   * Auto-gate hold reason for resuming an auto session, or null when allowed. Prefers the
   * profile the session was SPAWNED with (`s.sandboxApplied`) so a per-spawn override is
   * preserved across resume; falls back to repo-config resolution only for legacy null rows.
   * Skips the real bwrap self-test for trusted (backend-independent there). Run BEFORE the
   * husk teardown so a refused resume leaves a live agent intact.
   */
  private resumeAutoHold(s: Session): string | null {
    const rc = this.deps.store.getRepoConfig(s.repoPath);
    const profile = resolveProfile(
      s.sandboxApplied ?? undefined,
      rc.sandboxProfile,
      config.sandboxDefaultProfile,
    );
    const backend = profile === "trusted" ? null : this.detectBackend();
    // Re-check egress too: an autonomous auto session must refuse to resume if the egress
    // backend is now gone (same 3-arg semantics as the initial spawn). Only probe for an
    // autonomous profile that still has an FS backend; otherwise leave it undefined so
    // autoHoldReason's 2-arg behavior holds (egress not considered).
    const egressBackend =
      egressApplies(profile) && backend !== null ? this.detectEgressBackend() : undefined;
    return autoHoldReason(profile, backend, egressBackend);
  }

  /**
   * The single spawn-wrap helper both `create` and `resume` route through: resolve the
   * sandbox profile (per-spawn override ?? repo config ?? global default), probe the
   * backend, enforce the auto-gate, wrap the inner claude argv in the bwrap membrane
   * (passthrough for trusted / no-backend), and start the herdr agent.
   *
   * Returns a discriminated result so the two callers can diverge on an auto-refuse:
   * `create` THROWS, `resume` resolves null (its "can't resume" contract). On success
   * it carries the started terminal id plus the recorded sandbox state —
   * `applied` = the resolved profile (what was requested), `degraded` = a sandboxed
   * profile was requested but no backend was present, so it ran unconfined.
   */
  /**
   * Resolve this spawn's api-key auth wiring in one place (the addition this
   * feature layered onto prepareSpawn):
   *   - `hold`: fail-closed reason string when api-key mode is on but no key is
   *     configured (else null) — caller refuses before the auto-gate;
   *   - `membraneFields`: helper-bind + credential-mask flags for the membrane;
   *   - `passthroughEnv(willWrap)`: CLAUDE_CONFIG_DIR override for the non-wrapped
   *     (passthrough) case, undefined otherwise.
   * Subscription mode: hold null, fields null/false, env undefined.
   */
  private resolveApiKeyAuth(): {
    hold: string | null;
    membraneFields: { apiKeyHelperPath: string | null; maskCredentials: boolean };
    passthroughEnv: (willWrap: boolean) => Record<string, string> | undefined;
  } {
    const hold =
      isApiKeyMode() && !isApiKeyConfigured()
        ? "API-key auth mode is enabled but no Anthropic API key is configured (Settings → Session)."
        : null;
    return {
      hold,
      membraneFields: apiKeyMembraneFields(),
      passthroughEnv: apiKeyPassthroughEnv,
    };
  }

  private prepareSpawn(
    innerArgv: string[],
    ctx: {
      sessionId: string;
      name: string;
      worktreePath: string;
      repoPath: string;
      isolated: boolean;
      auto: boolean | undefined;
      profileOverride?: string | null;
    },
  ): SpawnOutcome {
    const repoConfig = this.deps.store.getRepoConfig(ctx.repoPath);
    // Resolve api-key auth wiring once: fail-closed hold reason (null when OK),
    // the membrane mask/helper fields, and the passthrough config-dir env.
    const apiKeyAuth = this.resolveApiKeyAuth();
    // Fail closed: api-key mode with no helper path configured must NOT silently
    // fall back to subscription (OAuth) billing. Refuse before the auto-gate so it
    // applies to BOTH interactive create (prepareSpawnOrThrow → throws) and
    // resume/drain (returns ok:false → null/caught).
    if (apiKeyAuth.hold) return { ok: false, holdReason: apiKeyAuth.hold };
    const profile = resolveProfile(
      ctx.profileOverride,
      repoConfig.sandboxProfile,
      config.sandboxDefaultProfile,
    );
    // Skip the (real subprocess) backend self-test for trusted: backend is irrelevant there
    // — autoHoldReason/isDegraded/wrapArgv are all backend-independent for trusted (passthrough,
    // never held, never degraded). This keeps a default/trusted install from paying a bwrap
    // node/git probe on its first spawn.
    const backend = profile === "trusted" ? null : this.detectBackend();
    // Probe the egress backend ONLY for an autonomous spawn that already has an FS backend;
    // otherwise leave it undefined so autoHoldReason's 2-arg semantics hold (egress not
    // considered — standard/trusted are never egress-confined).
    const egressBackend =
      egressApplies(profile) && backend !== null ? this.detectEgressBackend() : undefined;
    // 3-arg gate: an autonomous AUTO spawn refuses (loud EGRESS_UNAVAILABLE_REASON) when the
    // egress backend is null. standard/trusted are unaffected (egressBackend undefined).
    const hold = autoHoldReason(profile, backend, egressBackend);
    if (ctx.auto && hold) return { ok: false, holdReason: hold };
    const degraded = isDegraded(profile, backend);
    // egress WILL wrap iff autonomous + FS backend + egress backend all present (shared predicate).
    const egressOn = willEgressConfine(profile, backend, egressBackend ?? null);
    // An interactive autonomous session with the FS membrane but no egress backend ran
    // FS-only (network open) — warrants the egress-degraded banner.
    const egressDegraded = isEgressDegraded(profile, backend, egressBackend ?? null);

    // Renderer env for the MAIN session ONLY (satellites call herdr.start directly and keep the
    // classic pin). Applied via BOTH the membrane --setenv (sandboxed; the outer env shim is wiped
    // by bwrap --clearenv) AND spawnEnv (trusted). See mainSessionRendererEnv for details.
    const rendererEnv = mainSessionRendererEnv(config.tuiFullscreen, config.tuiDisableMouse);

    // Build the membrane only when it'll actually wrap (a sandboxed profile WITH a backend).
    // wrapArgv ignores the membrane for trusted / no-backend (passthrough), so skipping the
    // git/realpath resolution avoids needless host work — and the placeholder is never read.
    const willWrap = profile !== "trusted" && backend !== null;
    const nodeBinReal = willWrap ? safeRealpath(config.nodeBin) : config.nodeBin;
    const membrane: MembraneInputs = willWrap
      ? {
          worktreePath: ctx.worktreePath,
          gitCommonDir: this.deps.worktree.gitCommonDir(ctx.worktreePath),
          isolated: ctx.isolated,
          repoPath: ctx.repoPath,
          claudeDir: config.claudeDir,
          home: homedir(),
          nodeBinReal,
          term: process.env.TERM,
          extraEnv: { ...collectPassthroughEnv(), ...rendererEnv },
          // api-key mode: bind the helper RO + mask the OAuth credential in place
          // (the operator's ~/.claude customizations stay bound). Subscription: null/false.
          ...apiKeyAuth.membraneFields,
        }
      : ({} as MembraneInputs);

    const { wrapped, egressAllowlist, egressDnsLog } = this.wrapSpawnArgv({
      innerArgv,
      profile,
      backend,
      egressBackend,
      membrane,
      egressOn,
      sessionId: ctx.sessionId,
      repoPath: ctx.repoPath,
    });
    // api-key passthrough (trusted, or a sandboxed profile degraded to no-backend):
    // no membrane to mask the credential in place, so point the spawn at the
    // credential-less mirror dir. The membrane case masks creds in place (keeping
    // the operator's real ~/.claude customizations), so it needs no env override.
    // The egress branch is always willWrap, so this is undefined there.
    const spawnEnv = { ...(apiKeyAuth.passthroughEnv(willWrap) ?? {}), ...rendererEnv };
    const agent = this.deps.herdr.start(ctx.name, ctx.worktreePath, wrapped, spawnEnv);
    // Start the egress drop-watcher AFTER herdr.start (the agent is now running).
    if (egressOn && egressAllowlist && egressDnsLog) {
      this.deps.egressWatcher?.start(ctx.sessionId, {
        repoPath: ctx.repoPath,
        dnsLogPath: egressDnsLog,
        allowlist: egressAllowlist,
      });
    }
    return {
      ok: true,
      terminalId: agent.terminalId,
      applied: profile,
      degraded,
      egressApplied: egressOn,
      egressDegraded,
    };
  }

  /** Build the final spawn argv for an egress-confined run (writes the per-session egress config +
   *  wraps the membrane bwrap argv in the egress-runner) or the plain membrane wrap otherwise.
   *  Returns the wrapped argv plus the drop-watcher inputs (allowlist + dns log path) when egress wrapped. */
  private wrapSpawnArgv(args: {
    innerArgv: string[];
    profile: SandboxProfile;
    backend: SandboxBackend;
    egressBackend: EgressBackend | undefined;
    membrane: MembraneInputs;
    egressOn: boolean;
    sessionId: string;
    repoPath: string;
  }): { wrapped: string[]; egressAllowlist?: string[]; egressDnsLog?: string } {
    const { innerArgv, profile, backend, egressBackend, membrane, egressOn } = args;
    if (!egressOn) {
      return { wrapped: wrapArgv(innerArgv, { profile, backend, membrane }) };
    }
    // Egress path: write the per-session config artefacts, build the bwrap argv WITH the
    // egress override binds (between the membrane flags and `--`), then wrap that in the
    // egress-runner (netns + nft + dnsmasq). wrapArgv can't inject the override flags, so
    // this case bypasses it.
    const tmp = egressTmpDir(args.sessionId);
    const allowlist = buildEgressAllowlist({
      forges: config.forges,
      extraHosts: [
        ...config.sandboxEgressExtraHosts,
        ...this.deps.store.getRepoConfig(args.repoPath).egressExtraHosts,
      ],
    });
    // Open exactly the restricted agent-ingress listener (host 127.0.0.1:<ingressPort> via the
    // slirp gateway 10.0.2.2) — and ONLY when the slirp is host-loopback-capable AND a port is
    // known. SAME gate as resolveSpawnBaseUrl, so the baked URL and this nft rule never diverge.
    const hostGateway =
      this.egressHostGateway(profile, backend, egressBackend ?? null) ?? undefined;
    const cfg = buildEgressConfig(allowlist, { tmpDir: tmp, hostGateway });
    writeEgressConfigFiles(tmp, cfg);
    const bwrapArgv = [
      "bwrap",
      ...buildMembraneFlags(membrane),
      ...egressMembraneOverrideFlags(tmp),
      "--",
      ...innerArgv,
    ];
    return {
      wrapped: wrapEgress(bwrapArgv, tmp),
      egressAllowlist: allowlist,
      egressDnsLog: join(tmp, "dns.log"),
    };
  }

  /** prepareSpawn for callers that can't proceed on an auto-refuse: throws
   *  SandboxAutoRefused on hold so the caller (create() → route 4xx / drain catch) sees it. */
  private prepareSpawnOrThrow(
    innerArgv: string[],
    ctx: Parameters<SessionService["prepareSpawn"]>[1],
  ): SpawnSuccess {
    const outcome = this.prepareSpawn(innerArgv, ctx);
    if (!outcome.ok) throw new SandboxAutoRefused(outcome.holdReason);
    return outcome;
  }

  /** Active+promoted rules for the repo as an XML-wrapped block, or null when none /
   *  learnings disabled. Always-rules plus glob-scoped rules whose globs match files named
   *  in the task text (prompt + attached issue), with the budget capping within that matched
   *  set (#842). Records the injected rule ids against the session (join rows only — counters
   *  are advanced symmetrically with the reward at archive, never here). Injected into every
   *  new agent's system prompt via composeSystemPrompt. */
  private recordInjectedHouseRules(sessionId: string, input: CreateSessionInput): string | null {
    const { repoPath } = input;
    if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return null;
    const targetPaths = extractTargetPaths(
      [input.prompt, input.issueRef?.title, input.issueRef?.body],
      repoPath,
    );
    const { injected } = planHouseRulesInjection(
      this.deps.store.listActiveLearnings(repoPath),
      config.houseRulesBudgetChars,
      Date.now(),
      targetPaths,
    );
    this.deps.store.recordInjectedLearnings(
      sessionId,
      injected.map((r) => r.id),
    );
    return renderHouseRulesBlock(injected);
  }

  /** Assemble the spawn argv. Shepherd-curated house rules go into the system prompt (not the human
   *  turn) so every spawn (manual AND auto-spawned, e.g. the work-queue drain #222) inherits the
   *  repo's learned corrections without bleeding into the task text. The autopilot directive rides
   *  the same prompt when the repo has autopilot on; the plan-gate directive when planGateOn; the
   *  build-queue directive (baking the exact queue endpoint for `sessionId`) when buildQueueEnabled;
   *  the preview-hint notice when the session is `isolated`; and the context-trim flag + overlay +
   *  notice when `trim` says so (auto spawns, issue #499 — see trimDecision). */
  /** Push the task `--model` flag onto `argv`, substituting opus[1m] when fable is
   *  globally unavailable. Argv-only — never rewrites the stored session model. */
  private pushModelFlag(argv: string[], model: string | null): void {
    const spawnModel = spawnModelForAvailability(model, config.fableAvailable);
    if (model === "fable" && spawnModel !== "fable") {
      console.info(`model: fable unavailable — spawning on ${spawnModel} instead`);
    }
    if (spawnModel) argv.push("--model", spawnModel);
  }

  private buildSpawnArgv(
    input: CreateSessionInput,
    claudeSessionId: string,
    sessionId: string,
    promptArg: string,
    planGateOn: boolean | undefined,
    isolated: boolean,
    trim: Awaited<ReturnType<typeof trimDecision>>,
    baseUrl: string,
  ): string[] {
    const repoConfig = this.deps.store.getRepoConfig(input.repoPath);
    const houseRules = this.recordInjectedHouseRules(sessionId, input);
    const autopilotActive = repoConfig.autopilotEnabled;
    const planGate = planGateOn ? (input.auto ? "auto" : "interactive") : undefined;
    const buildQueue = repoConfig.buildQueueEnabled
      ? buildQueueDirective({
          sessionId,
          baseUrl,
          token: config.token,
          autopilot: autopilotActive,
        })
      : null;
    const argv = [
      "claude",
      "--dangerously-skip-permissions",
      "--session-id",
      claudeSessionId,
      ...trim.extraFlags,
    ];
    argv.push(
      "--settings",
      spawnSettingsOverlay({
        ...trim.overlayOpts,
        hooks: { sessionId, baseUrl, token: config.token },
      }),
    );
    argv.push(
      "--append-system-prompt",
      composeSystemPrompt(houseRules, autopilotActive, {
        research: input.research,
        planGate,
        buildQueue,
        previewHint: isolated,
        draftMode: repoConfig.draftMode,
        trimmed: trim.trimmed,
      }),
    );
    this.pushModelFlag(argv, input.model);
    argv.push(promptArg);
    return argv;
  }

  private buildCodexSpawnArgv(promptArg: string, model: string | null): string[] {
    const argv = ["codex", "--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox"];
    if (model) argv.push("--model", model);
    argv.push(promptArg);
    return argv;
  }

  private buildCodexResumeArgv(model: string | null): string[] {
    // Codex has `codex resume [SESSION_ID]`, but Shepherd does not yet persist the
    // Codex session id. `--last` is scoped by the Codex CLI's own resume selection
    // rules, so concurrent/non-isolated Codex sessions sharing a cwd can target the
    // most recent Codex session for that cwd rather than this exact Shepherd row.
    // Keep this visible until Codex spawn/ingest records a provider-native id.
    const argv = [
      "codex",
      "resume",
      "--last",
      "--no-alt-screen",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    if (model) argv.push("--model", model);
    return argv;
  }

  private buildClaudeResumeArgv(s: Session, trim: TrimDecision): string[] {
    const baseUrl = this.resolveSpawnBaseUrl(s.sandboxApplied ?? undefined, s.repoPath);
    const argv = [
      "claude",
      "--dangerously-skip-permissions",
      "--resume",
      s.claudeSessionId,
      ...trim.extraFlags,
      "--settings",
      spawnSettingsOverlay({
        ...trim.overlayOpts,
        hooks: { sessionId: s.id, baseUrl, token: config.token },
      }),
    ];
    this.pushModelFlag(argv, s.model);
    return argv;
  }

  private buildResumeArgv(s: Session, provider: AgentProvider, trim: TrimDecision): string[] {
    return provider === "codex"
      ? this.buildCodexResumeArgv(s.model)
      : this.buildClaudeResumeArgv(s, trim);
  }

  private resumeTarget(id: string): { session: Session; provider: AgentProvider } | null {
    const session = this.deps.store.get(id);
    if (!session || session.status === "archived") return null;

    const provider = session.agentProvider ?? "claude";
    if (provider === "claude" && !session.claudeSessionId) return null;

    return { session, provider };
  }

  private liveAgentFor(id: string): HerdrAgent | null {
    return (
      matchAgents(this.deps.store.list({ activeOnly: true }), this.deps.herdr.list()).get(id) ??
      null
    );
  }

  private adoptLiveResumeAgent(session: Session, agent: HerdrAgent): Session | null {
    if (agent.terminalId === session.herdrAgentId) return session;

    this.deps.store.update(session.id, { herdrAgentId: agent.terminalId });
    return this.deps.store.get(session.id);
  }

  private resumeRefusedByAutoGate(session: Session): boolean {
    const hold = session.auto ? this.resumeAutoHold(session) : null;
    if (!hold) return false;

    console.warn(`[sandbox] resume refused for ${session.id} (husk preserved): ${hold}`);
    return true;
  }

  private prepareResumeSpawn(session: Session, innerArgv: string[]): SpawnOutcome {
    return this.prepareSpawn(innerArgv, {
      sessionId: session.id,
      name: session.name,
      worktreePath: session.worktreePath,
      repoPath: session.repoPath,
      isolated: session.isolated,
      auto: session.auto,
      // Preserve spawn-time confinement: a session created with a stricter per-spawn
      // profile must NOT silently resume weaker (e.g. trusted) just because the repo
      // default is weaker. Legacy rows (null) fall back to repo-config resolution.
      profileOverride: session.sandboxApplied ?? undefined,
    });
  }

  private finishResumeSpawn(
    session: Session,
    outcome: Extract<SpawnOutcome, { ok: true }>,
  ): Session | null {
    this.deps.store.update(session.id, {
      herdrAgentId: outcome.terminalId,
      status: "running",
      lastState: "idle",
    });
    this.deps.store.setSandboxState(session.id, {
      applied: outcome.applied,
      degraded: outcome.degraded,
      egressApplied: outcome.egressApplied,
      egressDegraded: outcome.egressDegraded,
    });
    return this.deps.store.get(session.id);
  }

  /**
   * Resolve the per-spawn sandbox profile override for a create(), accounting for the
   * research downgrade: research needs OPEN web egress (web search / fetch + sub-agents),
   * which the autonomous profile's egress firewall would block. So when a research session
   * would otherwise resolve to the autonomous profile, downgrade it to standard for this
   * spawn (warning once). Otherwise the override is `input.sandboxProfile` unchanged.
   * Mirrors prepareSpawn's own resolveProfile(override, repoConfig.sandboxProfile,
   * config.sandboxDefaultProfile), using input.sandboxProfile as the override.
   */
  private researchSafeProfileOverride(
    input: CreateSessionInput,
    repoConfig: RepoConfig,
    sessionId: string,
  ): string | null | undefined {
    const effectiveProfile = resolveProfile(
      input.sandboxProfile,
      repoConfig.sandboxProfile,
      config.sandboxDefaultProfile,
    );
    if (input.research && effectiveProfile === "autonomous") {
      console.warn(
        `[sandbox] research ${sessionId}: downgrading autonomous → standard ` +
          `(research needs open web egress; the autonomous egress firewall would block web search)`,
      );
      return "standard";
    }
    return input.sandboxProfile;
  }

  /**
   * Resolve whether a create() spawns into the plan gate (#348): a session-level override
   * wins over the repo default. A research task never enters the plan gate — its deliverable
   * is a report PR / issue, not a planned-then-implemented code change — so force it off
   * (which also yields planPhase: null).
   */
  private resolvePlanGateOn(input: CreateSessionInput, repoConfig: RepoConfig): boolean {
    if (input.research) return false;
    return input.planGateEnabled ?? repoConfig.planGateEnabled;
  }

  /** Freshen the base ref: fetch the upstream tip so the new worktree always starts at the
   * latest upstream commit. For non-diverged branches with an upstream, resolved.baseRef is
   * the upstream sha; for diverged / no-upstream branches it falls back to the branch name.
   * Epic integration branches that exist only on origin are also resolved here.
   * resolved.baseRef may be a sha (fresh upstream tip when behind) or the branch name
   * (diverged / no upstream / up to date). Falls back to the named branch when the
   * impl returns nothing — fail-safe, never undefined. */
  private async resolveBaseRef(input: CreateSessionInput): Promise<string> {
    const resolved = await this.deps.worktree.ensureBaseRef(input.repoPath, input.baseBranch);
    const baseRef = resolved?.baseRef ?? input.baseBranch;
    console.info(
      `[create] base ${input.baseBranch}: behind ${resolved?.behind ?? 0}, ff ${resolved?.localFf ?? "none"}, basing on ${baseRef}`,
    );
    return baseRef;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const repoBasename = input.repoPath.split("/").filter(Boolean).at(-1) ?? "";
    const herdSlug = repoBasename ? slugifyManual(repoBasename) : undefined;
    const name = this.uniqueName(await this.deps.namer(input.prompt), herdSlug, input.repoPath);
    const baseRef = await this.resolveBaseRef(input);
    const wt = this.deps.worktree.create(input.repoPath, baseRef, name);
    // The worktree is created before the agent can start, so any failure past this
    // point (e.g. herdr `tab create` rejecting) would otherwise leave an orphan
    // worktree with no session row. Roll it back so a failed create leaves nothing.
    try {
      const claudeSessionId = randomUUID();
      // Pre-generate the session id so we can bake the exact queue endpoint into the spawn prompt
      // before the store row exists — the store.create() call below receives this id explicitly.
      const sessionId = randomUUID();

      const { promptArg, dropped: droppedImages } = await this.composePromptArg(
        input,
        wt.worktreePath,
      );
      const repoConfig = this.deps.store.getRepoConfig(input.repoPath);
      const agentProvider = input.agentProvider ?? config.defaultAgentProvider;
      // Plan gate (#348): when on, spawn into a PLANNING phase with a grill directive that
      // suppresses autopilot — interactive grills a present human, auto (drain) just writes the
      // plan. See resolvePlanGateOn for the override + research semantics.
      const planGateOn =
        agentProvider === "claude" ? this.resolvePlanGateOn(input, repoConfig) : false;
      const trim = await this.trimFor(input.auto);
      // Research needs OPEN web egress; a research session resolving to autonomous is
      // downgraded to standard for this spawn (see researchSafeProfileOverride). Resolved BEFORE
      // buildSpawnArgv so resolveSpawnBaseUrl bakes the URL matching the SAME profile prepareSpawn
      // will wrap with — buildSpawnArgv doesn't use the override otherwise, so reordering is safe.
      const profileOverride =
        agentProvider === "codex"
          ? "trusted"
          : this.researchSafeProfileOverride(input, repoConfig, sessionId);
      const baseUrl = this.resolveSpawnBaseUrl(profileOverride, input.repoPath);
      const argv =
        agentProvider === "codex"
          ? this.buildCodexSpawnArgv(promptArg, input.model)
          : this.buildSpawnArgv(
              input,
              claudeSessionId,
              sessionId,
              promptArg,
              planGateOn,
              wt.isolated,
              trim,
              baseUrl,
            );
      // Auto-refuse surfaces as a throw so the create() caller (route 4xx / drain catch) sees it.
      const outcome = this.prepareSpawnOrThrow(argv, {
        sessionId,
        name,
        worktreePath: wt.worktreePath,
        repoPath: input.repoPath,
        isolated: wt.isolated,
        auto: input.auto,
        profileOverride,
      });
      const session = this.deps.store.create({
        id: sessionId,
        name,
        prompt: input.prompt, // store the original user text, not the argv-augmented version
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: wt.branch,
        worktreePath: wt.worktreePath,
        isolated: wt.isolated,
        herdrSession: config.herdrSession,
        herdrAgentId: outcome.terminalId,
        sandboxApplied: outcome.applied,
        sandboxDegraded: outcome.degraded,
        egressApplied: outcome.egressApplied,
        egressDegraded: outcome.egressDegraded,
        claudeSessionId: agentProvider === "claude" ? claudeSessionId : "",
        agentProvider,
        model: input.model,
        auto: input.auto ?? false,
        issueNumber: input.issueRef?.number ?? null,
        planGateEnabled: agentProvider === "claude" ? (input.planGateEnabled ?? null) : false,
        autopilotEnabled: agentProvider === "claude" ? (input.autopilotEnabled ?? null) : false,
        planPhase: planGateOn ? "planning" : null,
        research: input.research ?? false,
        mergeTrainPrs: input.mergeTrainPrs,
      });
      // Attended sessions stay unapproved until a human clicks Approve in the UI.
      // Autopilot sessions are pre-approved so the agent can begin executing immediately
      // after authoring the queue without waiting for a human gate that will never come.
      if (shouldPreApproveBuildQueue(repoConfig, session, input.research))
        this.deps.store.setBuildQueueApproved(sessionId, true, "auto");
      // An attached image was lost before spawn (staged upload swept after 24h). The session
      // started without it; surface that to the operator as a toast — they can relaunch with
      // the image re-attached if it was essential. Emitted after the store row exists so the
      // UI can map the toast to the session.
      if (droppedImages > 0)
        this.deps.events?.emit("session:uploads-dropped", { id: sessionId, count: droppedImages });
      this.scheduleRefine(session, herdSlug);
      this.#maybeRegisterTrain(session, input);
      return session;
    } catch (e) {
      // best-effort rollback; surface the original failure, not any cleanup error
      if (wt.isolated) {
        try {
          this.deps.worktree.remove(wt.worktreePath, {
            branch: wt.branch,
            baseBranch: input.baseBranch,
          });
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
  }

  /**
   * Copy an original session's staged uploads into the repo staging dir with fresh
   * filenames (extension preserved) so create() lands them in the new worktree like
   * New Task. Copy-not-move keeps the original recoverable on a spawn failure. Returns
   * the new staged paths (empty when the original has no uploads dir).
   */
  private copyOriginalUploads(worktreePath: string): string[] {
    const srcDir = worktreeUploadsDir(worktreePath);
    if (!existsSync(srcDir)) return [];
    const stage = stagingDir(config.repoRoot);
    mkdirSync(stage, { recursive: true });
    const copied: string[] = [];
    for (const name of readdirSync(srcDir)) {
      const src = join(srcDir, name);
      if (!statSync(src).isFile()) continue;
      const ext = extname(name).replace(/^\./, "");
      const dest = join(stage, uploadFilename(ext));
      copyFileSync(src, dest);
      copied.push(dest);
    }
    return copied;
  }

  /**
   * Spawn a fresh replacement for an existing task, carrying its prompt and all
   * per-task settings — including the spawn-baked ones that can't be changed after
   * the fact (model, repoPath, baseBranch, planGateEnabled) plus the runtime
   * toggles (autopilot, auto-merge). Owns ONLY the spawn + override copy: it emits
   * no events, never archives the original, and does not resolve forge/issues —
   * those are the route handler's job. Always `auto: false` (relaunch is an
   * explicit operator action).
   *
   * `overrides` is an optional bag applied over the original (absent field keeps the
   * original's value; a present one — incl. explicit `null` — replaces it), letting a
   * caller relaunch into a DIFFERENT repo while carrying prompt/model/base-branch
   * forward. Image handling forks on whether overrides are present:
   *   - quick relaunch (`overrides == null`) → the original's uploads are auto-carried
   *     (copied into staging), byte-for-byte the original spawn.
   *   - relaunch WITH overrides → `overrides.images` is used VERBATIM and the original's
   *     uploads are NOT auto-carried. The composer is the single source of truth here: it
   *     seeds the carried originals (via `stageRelaunchImages`) into the override list and
   *     the operator edits that list, so re-merging server-side would double the images.
   *
   * On the quick-relaunch branch, the original's uploaded images are COPIED (not
   * moved) into staging and passed to `create`, which lands them in the new
   * worktree — so a spawn failure here
   * leaves the original's images intact on disk (the originals are reclaimed only
   * when the original's worktree is torn down by the route, after a successful
   * spawn). On any error AFTER `create`, the just-created session is best-effort
   * torn down and the error rethrown, so no orphaned new session leaks.
   */
  async relaunch(
    originalId: string,
    issueRef?: IssueRef,
    overrides?: RelaunchOverrides,
  ): Promise<Session> {
    const s = this.deps.store.get(originalId);
    if (!s || s.status === "archived")
      throw new Error(`cannot relaunch ${originalId}: missing or archived`);

    // Image handling forks on whether overrides are present:
    //   - quick relaunch (no overrides) → auto-carry the original's uploads, copied (not
    //     moved) into staging so create() can land them in the new worktree like New Task,
    //     with the originals staying recoverable on a spawn failure. Cap at MAX_IMAGES and
    //     warn on drop rather than silently overflowing the spawn prompt.
    //   - relaunch WITH overrides → use overrides.images VERBATIM and do NOT auto-carry.
    //     The composer already seeded the carried originals into overrides.images (via
    //     stageRelaunchImages) and the operator edited that list, so it is authoritative;
    //     re-merging here would double the carried images.
    let images: string[];
    if (overrides == null) {
      const copiedOriginalImages = this.copyOriginalUploads(s.worktreePath);
      images = copiedOriginalImages.slice(0, MAX_IMAGES);
      if (copiedOriginalImages.length > images.length)
        console.warn(
          `[relaunch] ${originalId}: ${copiedOriginalImages.length} images exceed cap ${MAX_IMAGES}; dropped ${copiedOriginalImages.length - images.length}`,
        );
    } else {
      images = overrides.images ?? [];
    }

    // Apply overrides over the original: an ABSENT field keeps the original's value;
    // a PRESENT one (including explicit `null` for model/planGateEnabled) replaces it.
    const input: CreateSessionInput = {
      repoPath: overrides?.repoPath ?? s.repoPath,
      baseBranch: overrides?.baseBranch ?? s.baseBranch,
      prompt: overrides?.prompt ?? s.prompt,
      model: pickOverride(overrides?.model, s.model),
      planGateEnabled: pickOverride(overrides?.planGateEnabled, s.planGateEnabled),
      // Carry autopilot at spawn time (NOT redundant with the setAutopilotState copy below):
      // create()'s build-queue pre-approval reads the session's effective autopilot and is never
      // re-evaluated after, so an autopilot-off original (e.g. a merge-train driver) must be off
      // here too or a relaunch under an autopilot-on repo would wrongly auto-approve its queue.
      autopilotEnabled: s.autopilotEnabled,
      research: pickOverride(overrides?.research, s.research),
      images,
      issueRef,
      auto: false,
    };
    const newSession = await this.create(input);

    try {
      // Copy runtime-toggleable overrides so the replacement matches the original's
      // CURRENT state, not just spawn-time defaults.
      this.deps.store.setAutopilotState(newSession.id, { enabled: s.autopilotEnabled });
      this.deps.store.setAutoMergeState(newSession.id, { enabled: s.autoMergeEnabled });
    } catch (e) {
      // best-effort teardown so no orphaned new session leaks alongside the intact original
      try {
        await this.archive(newSession.id);
      } catch {
        /* ignore cleanup error; surface the original failure */
      }
      throw e;
    }

    // Re-fetch AFTER the override writes so the returned session reflects them.
    return this.deps.store.get(newSession.id)!;
  }

  /**
   * Stage an original session's uploaded images for a relaunch-WITH-overrides composer
   * to seed. Copies (not moves) the original's worktree uploads into the repo staging dir
   * — like the quick-relaunch branch and New Task — and returns the staged path plus its
   * basename for each, capped at MAX_IMAGES so the UI never seeds more chips than a spawn
   * accepts. The copies are recoverable on disk; relaunch() then takes the (possibly
   * operator-edited) list back verbatim, so there is no server-side re-merge.
   *
   * Each open copies fresh into staging, so a cancelled open or a removed chip orphans
   * its copies. Before staging, we reclaim staged uploads past the TTL (the same sweep the
   * server runs at startup, over the shared staging dir) so repeated opens don't accumulate.
   */
  stageRelaunchImages(originalId: string): { path: string; name: string }[] {
    const s = this.deps.store.get(originalId);
    if (!s || s.status === "archived")
      throw new Error(`cannot stage relaunch images for ${originalId}: missing or archived`);
    sweepStaging(config.repoRoot, STAGING_TTL_MS, Date.now());
    const paths = this.copyOriginalUploads(s.worktreePath).slice(0, MAX_IMAGES);
    return paths.map((p) => ({ path: p, name: basename(p) }));
  }

  /**
   * Derive a herdr-unique agent name from `base`. The namer maps a prompt to a name
   * deterministically, so resubmitting a similar prompt yields the same base — and herdr
   * rejects a second agent with a name already in use (`agent_name_taken`), which would
   * otherwise surface as an opaque create 500. Suffixing past live agents avoids the clash;
   * the chosen name also drives the worktree path and branch, so they stay collision-free too.
   *
   * When a collision occurs and `herd` (the slugified repo basename) is provided, resolution
   * prefers a herd-qualified name (`${base}-${herd}`) before falling back to numeric suffixes.
   * This makes concurrent sessions on different repos self-distinguishing at a glance
   * (`fix-login-myapp` vs `fix-login-otherapp`) and keeps numeric suffixes as a last resort
   * for sessions inside the same herd. If no usable herd is given, the original numeric
   * linear scan (`${base}-2`, `-3`, …) is used unchanged.
   *
   * The composed `base-herd` string is capped at 60 characters (trimming any trailing dash)
   * to keep branch/worktree paths sane, matching the 60-char convention used by slugifyManual.
   *
   * When `repoPath` is provided, a candidate is also rejected when its `shepherd/<candidate>`
   * branch already exists in the repo — not just when a live herdr agent owns the name. The
   * namer is deterministic, so relaunching a task from the same issue yields the same base; a
   * prior session's branch persists whenever it wasn't merged (`pruneMergedBranch` deletes only
   * merged branches). Without the branch check the new worktree would collide on `git worktree
   * add -b shepherd/<base>` and fail fatally. Pre-empting it here keeps the display name, herdr
   * agent name, branch, and worktree path all in sync on the suffixed value.
   */
  private uniqueName(base: string, herd?: string, repoPath?: string): string {
    const liveNames = new Set(
      this.deps.herdr
        .list()
        .map((a) => a.name)
        .filter(Boolean),
    );
    // A candidate is taken if a live agent owns the name OR (when repoPath is given) the
    // matching branch already exists. Both are cheap; branchExists is a bounded `git rev-parse`.
    const isTaken = (candidate: string): boolean =>
      liveNames.has(candidate) ||
      (!!repoPath && this.deps.worktree.branchExists(repoPath, `shepherd/${candidate}`));

    if (!isTaken(base)) return base;

    if (herd) {
      // Cap at 60 chars (matching slugifyManual's convention). If base is already 59–60 chars
      // the herd may be truncated away entirely; numeric fallback below still produces a valid name.
      const composed = `${base}-${herd}`.slice(0, 60).replace(/-+$/, "");
      if (!isTaken(composed)) return composed;
      for (let i = 2; ; i++) {
        const candidate = `${composed}-${i}`;
        if (!isTaken(candidate)) return candidate;
      }
    }

    // No usable herd — fall back to the original numeric scan.
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!isTaken(candidate)) return candidate;
    }
  }

  /** Kick off the background name refine without blocking create(). No-op when disabled. */
  private scheduleRefine(session: Session, herd?: string): void {
    if (!config.llmNaming || !this.deps.refineName) return;
    // Deterministic-first (issue #692): skip the background Haiku refine only when the
    // heuristic captured the full distinctive subject — nothing was dropped by the 4-word cap.
    // Long prompts whose distinctive words overflow the cap (truncated=true) still refine.
    // Bounded quality trade (strong ≠ provably optimal), not zero-loss; weaker names still refine.
    if (isHeuristicNameStrong(session.prompt)) return;
    void this.refineNameInBackground(session, herd).catch((err) =>
      console.warn(`[namer] refine failed for ${session.id}:`, err),
    );
  }

  /**
   * Ask the LLM namer to comprehend the prompt, then — if it yields a *different*,
   * collision-resolved slug — rename the session (display name always; local branch
   * only while nothing has been committed yet) and relabel the herdr agent/tab.
   * Emits session:renamed so every client patches the row live.
   */
  private async refineNameInBackground(session: Session, herd?: string): Promise<void> {
    const raw = await this.deps.refineName!({
      taskText: session.prompt,
      label: `name ${session.desig}`,
    });
    if (!raw) return;
    const slug = this.uniqueName(raw, herd);
    if (slug === session.name) return;
    // Don't clobber a manual rename that landed during the (up-to-60s) refine window:
    // re-read the row and bail if its name no longer matches the snapshot we started
    // from — a manual rename is the user's intent and outranks the background guess.
    const current = this.deps.store.get(session.id);
    if (!current || current.name !== session.name) return;
    // Move the git branch too, but only inside the "nothing committed yet" window AND
    // when `shepherd/<slug>` is free. `uniqueName` de-dupes against live herdr agent
    // names, not branches, so a leftover branch from an archived session could still
    // collide — and `git branch -m` onto an existing name throws. On collision (or a
    // committed branch) we fall back to a display-only rename: the comprehended name
    // still shows; the branch just stays on the heuristic slug.
    const safe =
      session.isolated &&
      !!session.branch &&
      !this.deps.worktree.branchExists(session.repoPath, `shepherd/${slug}`) &&
      this.deps.worktree.commitsAhead(session.repoPath, session.baseBranch, session.branch) === 0;
    // The branchExists pre-check narrows the window, but a branch can still appear
    // between it and `git branch -m` (concurrent create, archived-branch cleanup) —
    // rename() moves the branch before updating the row, so a throw would abandon the
    // refine and lose the better name. Retry display-only so the degradation is airtight.
    let updated: Session | null;
    try {
      updated = this.rename(session.id, slug, { renameLocalBranch: safe });
    } catch {
      updated = this.rename(session.id, slug, { renameLocalBranch: false });
    }
    if (!updated) return;
    this.deps.herdr.relabel(session.herdrAgentId, slug);
    this.deps.events?.emit("session:renamed", {
      id: updated.id,
      name: updated.name,
      branch: updated.branch,
    });
  }

  /**
   * Bring a finished session back: spawn the provider's resume command in its
   * still-present worktree so the whole conversation is restored and steerable
   * again. Re-points the session at the new herdr agent and flips it back to running.
   *
   * Returns the updated session, or null when it can't be resumed:
   *  - unknown id, or archived (its worktree was already removed), or
   *  - a Claude/pre-feature session with no pinned claude session id to resume.
   * If the herdr agent is still live (a "done" session that's merely idle at the
   * prompt), there's nothing to respawn — the current session is handed back so the
   * caller just re-attaches, avoiding a duplicate provider process.
   *
   * `force` overrides that re-use: it tears down whatever agent currently backs the
   * worktree and spawns a fresh provider resume regardless. This is the explicit
   * "bring agent back" action (header / card-menu button) for the case the re-use
   * path can't see — the provider exited but its herdr tab survived as a bare shell, so the
   * agent still lists as live (idle) and a plain resume would only re-adopt the shell.
   *
   * We force unconditionally rather than only on a detected husk because herdr ≥0.6
   * `agent list` exposes no command/liveness field, so a husk shell and an idle
   * provider are indistinguishable here (see ui canResume). The tradeoff: if invoked on
   * a genuinely-live idle agent it respawns one needlessly, resetting that pane's
   * terminal scrollback — but provider resume restores the FULL conversation, so no work is
   * lost, and the control is only surfaced/clicked when the user believes they're
   * stranded. Guaranteeing the husk case works (always respawn) beats preserving
   * scrollback in the rare misclick-on-live-claude case.
   */
  async resume(id: string, opts: { force?: boolean } = {}): Promise<Session | null> {
    const target = this.resumeTarget(id);
    if (!target) return null;

    const { session, provider } = target;
    const agent = this.liveAgentFor(id);
    if (agent && !opts.force) {
      // Already live (idle at the prompt, or restored by a herdr restart under a new
      // terminalId). Adopt the fresh id if it drifted; never spawn a second claude.
      return this.adoptLiveResumeAgent(session, agent);
    }

    // Re-check the auto-gate BEFORE tearing down the existing husk — a refused resume
    // must not kill a live agent (mirrors drain's pre-check). So a mid-flight profile or
    // backend change leaves the running session intact rather than stopping it dead.
    // prepareSpawn re-checks below (defense in depth); this just guards the teardown.
    if (this.resumeRefusedByAutoGate(session)) return null;

    // Same trim as the fresh-spawn path (buildSpawnArgv) — a resumed auto session must
    // keep the slim context, not silently regrow the skill catalog + plugin hooks.
    const trim = await this.trimFor(session.auto);
    // Forced respawn over a live agent: close the stale husk tab first so it doesn't
    // leak alongside the fresh one. (No-op when the agent is already gone.)
    if (agent) this.deps.herdr.stop(agent.terminalId);

    const outcome = this.prepareResumeSpawn(session, this.buildResumeArgv(session, provider, trim));
    if (!outcome.ok) {
      // Resume's "can't resume" contract: callers (autopilot/automerge) `if(!await resume)` skip,
      // server returns 409 — so an auto-refused resume resolves null rather than throwing.
      console.warn(`[sandbox] resume refused for ${session.id}: ${outcome.holdReason}`);
      return null;
    }
    return this.finishResumeSpawn(session, outcome);
  }

  /**
   * Rename a session to `slug`. Always updates the display name. When
   * `renameLocalBranch` is set (and the session is isolated with a branch), also
   * runs `git branch -m shepherd/<old> shepherd/<slug>` and re-points `branch`.
   * The caller (server) decides `renameLocalBranch`: false for a display-only rename
   * when an open PR can't be retargeted, true otherwise. Returns the updated session,
   * or null for an unknown id. The git rename may throw on a name clash — the caller
   * pre-checks and surfaces that as a conflict.
   */
  /** Whether a local branch already exists — the server's pre-flight check before a rename. */
  branchExists(repoPath: string, branch: string): boolean {
    return this.deps.worktree.branchExists(repoPath, branch);
  }

  /**
   * Reconcile a session's stored branch with the one actually checked out in its
   * worktree. An agent that runs `git checkout -b` / `git branch -m` renames the
   * branch out from under us, so the stored `branch` goes stale and PR detection
   * (which queries `gh pr list --head <branch>`) silently misses the opened PR.
   * Called by the PR poller on a "no PR found" miss. When the live branch differs,
   * adopt it (re-point `branch`) — that alone is what restores PR recognition.
   * Returns the adopted branch (so the poller can re-query), or null when nothing
   * changed / it can't be determined.
   *
   * The display `name` follows only when it still trivially mirrors the *old* branch
   * (i.e. was auto-derived). A name that already diverged is a chosen name — a manual
   * rename or an LLM refine — and outranks a raw branch slug, the same precedence
   * `refineNameInBackground` enforces. When it does follow, it's de-duped through
   * `uniqueName` like the other automatic rename paths so it can't clash with a
   * sibling's tab label.
   */
  syncWorktreeBranch(id: string): string | null {
    const s = this.deps.store.get(id);
    if (!s || !s.isolated || !s.branch) return null;
    const live = this.deps.worktree.currentBranch(s.worktreePath);
    if (!live || live === s.branch) return null;
    const nameMirrorsBranch = s.name === s.branch.replace(/^shepherd\//, "");
    const label = nameMirrorsBranch ? this.uniqueName(live.replace(/^shepherd\//, "")) : null;
    this.deps.store.update(id, label ? { name: label, branch: live } : { branch: live });
    if (label) {
      try {
        this.deps.herdr.relabel(s.herdrAgentId, label);
      } catch {
        /* tab may be gone — branch adoption still stands */
      }
    }
    this.deps.events?.emit("session:renamed", { id, name: label ?? s.name, branch: live });
    return live;
  }

  rename(id: string, slug: string, opts: { renameLocalBranch: boolean }): Session | null {
    const s = this.deps.store.get(id);
    if (!s) return null;
    const willRenameBranch = opts.renameLocalBranch && s.isolated && !!s.branch;
    const newBranch = willRenameBranch ? `shepherd/${slug}` : s.branch;
    if (willRenameBranch && s.branch) {
      this.deps.worktree.renameBranch(s.repoPath, s.branch, newBranch as string);
    }
    this.deps.store.update(id, { name: slug, branch: newBranch });
    return this.deps.store.get(id);
  }

  /**
   * Steer a session's live PTY (human-style): deliver the text as a bracketed paste,
   * then submit it with a carriage return.
   *
   * The wrap is load-bearing for multi-line steers (e.g. a pasted-in critic review).
   * herdr does NOT bracket-wrap injected text, and back-to-back `send`s coalesce into a
   * single PTY read — so a multi-line blob with a trailing "\r" reaches Claude Code as
   * one chunk, trips its paste heuristic, and the CR is swallowed as just another
   * newline: message typed-but-unsent. (Single-line steers escaped this because no
   * embedded "\n" trips the heuristic — which is why short steers worked and reviews
   * didn't.) Wrapping the text in the bracketed-paste markers (ESC[200~ … ESC[201~)
   * gives an explicit paste-end, so the following CR is unambiguously Enter regardless
   * of read boundaries — deterministic, no timing guesswork. Strip any stray paste
   * markers from the payload first: a leaked end-marker would close the paste early
   * (turning the rest into live keystrokes), and a leaked start-marker is benign but
   * dropped for symmetry. Returns false when the session is unknown OR its pane is dead
   * (claude exited / terminal reaped) — a live store row can still back a dead pane,
   * which would make herdr.send throw. The up-front liveness check keeps reply an honest,
   * non-throwing boolean for human steers, and hands the auto-address loop a clean
   * "not delivered" instead of relying on it to catch the throw downstream.
   */
  reply(id: string, text: string): boolean {
    return this.replyToLive(id, text, this.liveTerminalIds());
  }

  /**
   * Steer the agent for session `id` to start its dev server with `command` running
   * in the background. The agent's PTY is a live CLI session — we can't spawn processes
   * ourselves, so we deliver a directive asking the agent to do it. Returns false for
   * an unknown id or a dead pane (same semantics as reply()).
   */
  startPreview(id: string, command: string): boolean {
    const s = this.deps.store.get(id);
    if (!s) return false;
    return this.reply(id, PREVIEW_START_STEER(command, s.agentProvider ?? "claude"));
  }

  /**
   * Stop the previewed dev server for session `id` by SIGNALLING its process to
   * terminate. UNLIKE startPreview (which steers the agent to *start* its dev
   * server — Shepherd can't start it itself), this really signals the process,
   * because Shepherd can find the worktree process listening on the dev port.
   *
   * `killed` is a signals-SENT count, NOT a death confirmation (a process may
   * ignore the signal or take time to exit). This method does NOT release the
   * preview listener — teardown happens via the poller sweep when the port stops
   * listening (that port-gone event is the only real "RAM-freed" signal). Idle-stop
   * passes "SIGTERM" then escalates to "SIGKILL"; force-stop passes "SIGKILL".
   *
   * Returns:
   *  - { result: "not_found", killed: 0 } — unknown id, or deps not wired.
   *  - { result: "not_bound", killed: 0 } — no live preview for this session.
   *  - { result: "stopped", killed } — signal dispatched to `killed` process(es).
   */
  stopPreview(
    id: string,
    signal: NodeJS.Signals = "SIGTERM",
  ): { result: "stopped" | "not_bound" | "not_found"; killed: number } {
    const s = this.deps.store.get(id);
    if (!s || !this.deps.reaper || !this.deps.preview) return { result: "not_found", killed: 0 };
    const devPort = this.deps.preview.devPortFor(id);
    if (devPort == null) return { result: "not_bound", killed: 0 };
    const killed = this.deps.reaper.stopListenersOnPort(s.worktreePath, devPort, signal);
    return { result: "stopped", killed };
  }

  /**
   * Retry a set of usage-halted sessions. For each id:
   *  - If its pane is live (herdr still lists it) → steer with `continueText` so the
   *    agent can continue from where it stopped (live idle/blocked state).
   *  - Otherwise → `resume(id)` spawns a fresh provider-resume pane.
   * On any success the haltReason flag is cleared so the UI badge disappears.
   * The steer text is supplied by the caller (localized client-side) — the server
   * stays i18n-agnostic, exactly like broadcast.
   */
  async retryHalted(
    ids: string[],
    continueText: string,
  ): Promise<{ resumed: number; steered: number; total: number }> {
    const live = this.liveTerminalIds();
    let resumed = 0;
    let steered = 0;
    for (const id of ids) {
      const s = this.deps.store.get(id);
      if (!s) continue;
      let succeeded = false;
      if (live.has(s.herdrAgentId)) {
        if (this.replyToLive(id, continueText, live)) {
          steered++;
          succeeded = true;
        }
      } else {
        if (await this.resume(id)) {
          resumed++;
          succeeded = true;
        }
      }
      if (succeeded) {
        // Clear immediately AND push it so the ⟳ chip / "halted" badge / RetryDialog
        // preselect drop at once and a re-fire can't re-steer an already-resumed session
        // — don't wait for the poller's working-transition clear to catch up.
        this.deps.store.setHaltReason(id, null, null);
        this.deps.events?.emit("session:halt", { id, haltReason: null, haltedAt: null });
      }
    }
    return { resumed, steered, total: ids.length };
  }

  /** Fan a steer out to many sessions (human-style), classifying the outcome per target so
   *  the operator gets honest feedback instead of a flat "sent N". Lists herdr's live agents
   *  ONCE up front (both the live id set AND each agent's status) rather than per id, so a
   *  wide fan-out doesn't spawn one blocking `herdr agent list` per target. Each live target's
   *  steer is delivered identically to a single reply (delivery is unchanged); the count it
   *  lands in just reflects the agent's status at send time:
   *   - delivered: a live agent that is NOT `working` (idle/blocked/done) — acts on the steer ~now.
   *   - queued:    a live `working` agent — Claude Code queues the steer; it acts after the
   *                current turn ends (correct behavior, but invisible immediately — the reason a
   *                busy-herd broadcast looked like a no-op).
   *   - offline:   unknown id or dead pane — the steer wasn't delivered.
   *  `delivered + queued + offline === total`. */
  broadcast(
    ids: string[],
    text: string,
  ): { delivered: number; queued: number; offline: number; total: number } {
    let agents: HerdrAgent[];
    try {
      agents = this.deps.herdr.list();
    } catch {
      agents = []; // herdr unreachable → every target is offline (the steer can't land)
    }
    const live = new Set(agents.map((a) => a.terminalId));
    const statusByTerminal = new Map(agents.map((a) => [a.terminalId, a.agentStatus]));
    let delivered = 0;
    let queued = 0;
    let offline = 0;
    for (const id of ids) {
      const s = this.deps.store.get(id);
      if (!s || !live.has(s.herdrAgentId)) {
        offline++; // unknown id or dead pane — the steer can't land
        continue;
      }
      this.sendSteerTo(s, text);
      if (statusByTerminal.get(s.herdrAgentId) === "working") queued++;
      else delivered++;
    }
    return { delivered, queued, offline, total: ids.length };
  }

  /**
   * Fleet-wide emergency stop: interrupt every live, actively-working agent at once.
   * Sends a single ESC — the Claude Code interrupt key — to each pane whose herdr
   * agent reports `working`, halting the current turn WITHOUT clearing its input or
   * quitting it (a lone ESC, no bracketed paste, no trailing CR — the opposite of a
   * steer). Idle / blocked / done agents, dead panes, archived sessions and the
   * ephemeral usage probe are all left untouched: only ACTIVE sessions are matched
   * against the live agent set (so the probe — never a stored session — and archived
   * rows fall out), and of those only the ones reporting `working` are hit. Auto-spawned
   * (drain) sessions are included BY DESIGN — a misfiring autopilot is exactly what this
   * stops. Lists herdr's agents ONCE up front (like broadcast) so a wide fan-out makes a
   * single `agent list` call, not one per target. Emits `halt:done {halted}` so every
   * connected operator sees the reach.
   *
   * Throws (→ HTTP 500 → the UI surfaces halt_failed + Retry) when herdr can't even be
   * listed: a swallowed failure would emit a success-looking `halt:done {halted:0}`,
   * indistinguishable from "nothing was working" — a silent no-op at the worst moment.
   */
  haltAll(): { halted: number } {
    const agents = this.deps.herdr.list(); // let a herdr-unreachable error propagate
    const sessions = this.deps.store.list({ activeOnly: true });
    let halted = 0;
    for (const agent of matchAgents(sessions, agents).values()) {
      if (agent?.agentStatus !== "working") continue;
      // Best-effort: a pane that died between `list` and `send` (or any single send
      // throwing) must NOT abort the sweep — keep interrupting the rest. Count only the
      // interrupts that actually landed; best-effort reach is the point of an e-stop.
      try {
        this.deps.herdr.send(agent.terminalId, "\x1b");
        halted++;
      } catch {
        /* dead / raced pane — skip it, the herd-wide stop carries on */
      }
    }
    const result = { halted };
    this.deps.events?.emit("halt:done", result);
    return result;
  }

  /** Terminal ids herdr currently lists as live. Empty when herdr can't be reached, so
   *  callers treat an unlisted agent as a dead pane (the steer won't land). */
  private liveTerminalIds(): Set<string> {
    try {
      return new Set(this.deps.herdr.list().map((a) => a.terminalId));
    } catch {
      return new Set();
    }
  }

  /** Steer one session against a pre-fetched live set. False on unknown id or dead pane. */
  private replyToLive(id: string, text: string, live: Set<string>): boolean {
    const s = this.deps.store.get(id);
    if (!s || !live.has(s.herdrAgentId)) return false; // unknown, or live-in-store / dead-pane
    this.sendSteerTo(s, text);
    return true;
  }

  /** Deliver a human-style steer to an already-resolved, live session: record the reply
   *  signal, then bracket-paste the text and submit with a CR. Single source for the send
   *  used by replyToLive (reply/retry) and broadcast (which resolves the session itself so
   *  it can classify the outcome without a second store lookup). */
  private sendSteerTo(s: Session, text: string): void {
    this.deps.store.addSignal({
      repoPath: s.repoPath,
      sessionId: s.id,
      kind: "reply",
      payload: text,
    });
    const PASTE_START = "\x1b[200~";
    const PASTE_END = "\x1b[201~";
    const safe = text.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
    this.deps.herdr.send(s.herdrAgentId, `${PASTE_START}${safe}${PASTE_END}`);
    this.deps.herdr.send(s.herdrAgentId, "\r");
  }

  /**
   * Toggle the manual "ready to merge" flag (parked / done). Persists it and
   * pushes the change live so every client patches the row without a refetch.
   */
  setReadyToMerge(id: string, ready: boolean): void {
    this.deps.store.update(id, { readyToMerge: ready });
    this.deps.events?.emit("session:ready", { id, ready });
  }

  /**
   * Shared phase→executing transition: flip planPhase to "executing" and push the change live.
   * Used by both the Go release (releasePlanGate) and the PR auto-advance (advanceToExecutionOnPr).
   * Callers are responsible for their own guards before calling this.
   */
  #enterExecution(id: string): void {
    this.deps.store.setPlanPhase(id, "executing");
    this.deps.events?.emit("session:plangate", { id, planPhase: "executing" });
  }

  /**
   * The "Go" gate: release an APPROVED planning session into autonomous execution. Strict —
   * only transitions when the session is in the planning phase AND its plan gate is approved
   * (the reviewer signed off). Flips planPhase → "executing", steers the agent to implement the
   * approved plan, and emits session:plangate so clients update. Returns false (no-op) when the
   * session is unknown, not planning, or not yet approved. Used by the /go route (interactive)
   * and by PlanGateService for an auto session's auto-release on approval.
   */
  releasePlanGate(id: string): boolean {
    const s = this.deps.store.get(id);
    if (!s || s.planPhase !== "planning") return false;
    if (!this.deps.store.getPlanGate(id)?.approved) return false;
    this.#enterExecution(id);
    const { draftMode } = this.deps.store.getRepoConfig(s.repoPath);
    this.reply(id, planGoSteer(draftMode));
    return true;
  }

  /**
   * Auto-advance a manually-driven (or otherwise un-released) planning session into execution
   * once a PR appears. When the operator reviews the plan then steers the agent instead of
   * clicking Go, the agent writes code and opens a PR while planPhase is still "planning" —
   * leaving the plan-gate badge latched and making autopilot stand down (autopilot.ts eligible()
   * suppresses planning sessions). This method detects that case: called when a PR is observed
   * for a still-planning session, it flips planPhase → "executing" so the plan gate yields and
   * autopilot stops standing down.
   *
   * Critically, it does NOT send PLAN_GO_STEER — the agent already executed; steering it to
   * "implement the approved plan" would be wrong (the plan may not even be approved). Its caller
   * mirrors autopilot's hasPr non-"none" semantics (open/merged/closed) so the two don't drift.
   *
   * Returns true when a real transition occurred (planPhase was "planning" and is now "executing"),
   * false when the session is unknown or not in the planning phase (idempotent no-op).
   */
  advanceToExecutionOnPr(id: string): boolean {
    const s = this.deps.store.get(id);
    if (!s || s.planPhase !== "planning") return false;
    this.#enterExecution(id);
    return true;
  }

  /**
   * Register a launched merge train as LIVE (the train session owns it). `repoPath`
   * scopes which active sessions a reconcile may mark; `prNumbers` is the scoped
   * queue (the PR numbers the train will land). A train is "running" iff it has a
   * `#liveTrains` entry. Immediately reconciles, so any session already holding a
   * selected open PR is marked on launch; the rest are marked as their PRs open
   * (via subsequent `reconcileTrainMarks` driven by `session:git`). `now` injectable.
   */
  /**
   * Launch-time merge-train trigger: when `create` spawned a train session (a
   * non-empty `mergeTrainPrs`), register the train so its scoped PRs are tracked in
   * `#liveTrains` and any already-open participant session is marked immediately
   * (reconcileTrainMarks runs inside registerTrain). Empty/absent → no train.
   */
  #maybeRegisterTrain(session: Session, input: CreateSessionInput): void {
    if (input.mergeTrainPrs && input.mergeTrainPrs.length > 0)
      this.registerTrain(session.id, session.repoPath, input.mergeTrainPrs);
  }

  registerTrain(
    trainId: string,
    repoPath: string,
    prNumbers: number[],
    now: number = Date.now(),
  ): void {
    this.#liveTrains.set(trainId, {
      repoPath,
      prNumbers: new Set(prNumbers),
      registeredAt: now,
    });
    this.reconcileTrainMarks(trainId, now);
  }

  /**
   * Server-derived participant marking: for each live train (the one `trainId`, or
   * all when omitted), mark every ACTIVE same-repo session whose live PR is OPEN and
   * whose number is in the train's scoped queue. Reads the live PR snapshot via
   * `deps.prSnapshot` (empty when unwired). The train session itself is never marked,
   * and an already-marked session is left alone (idempotent — `markTrainMember`
   * re-guards). Drives both the launch-time reconcile and the per-`session:git`
   * one (a PR that opens later is picked up the next time this runs). `now` injectable.
   */
  reconcileTrainMarks(trainId?: string, now: number = Date.now()): void {
    const targets = this.#resolveReconcileTargets(trainId);
    if (targets.length === 0) return;
    const snap = this.deps.prSnapshot?.() ?? {};
    for (const tid of targets) {
      const train = this.#liveTrains.get(tid)!;
      for (const s of this.deps.store.list({ activeOnly: true })) {
        const prNumber = this.#matchedOpenPrNumber(s, tid, train, snap);
        if (prNumber !== null) this.markTrainMember(tid, s.id, prNumber, now);
      }
    }
  }

  /** The PR numbers currently scoped by any live merge train (the union of every live
   *  train's `prNumbers`), deduped + sorted. Empty when no train is live. Cheap + sync —
   *  reads only the in-memory `#liveTrains` map, no forge round-trip. The Herd Rundown
   *  folds this in as the train's queued set. */
  liveTrainPrs(): number[] {
    const prs = new Set<number>();
    for (const t of this.#liveTrains.values()) for (const n of t.prNumbers) prs.add(n);
    return [...prs].sort((a, b) => a - b);
  }

  /** The live trains a reconcile targets: the one `trainId` (if live), or all live. */
  #resolveReconcileTargets(trainId?: string): string[] {
    if (trainId === undefined) return [...this.#liveTrains.keys()];
    return this.#liveTrains.has(trainId) ? [trainId] : [];
  }

  /**
   * The open PR number that makes `session` a fresh member of `train`, or null when
   * it doesn't qualify: it IS the train, is a different repo, is already marked, or
   * its live PR isn't OPEN / not in the train's scoped queue.
   */
  #matchedOpenPrNumber(
    session: Session,
    trainId: string,
    train: { repoPath: string; prNumbers: Set<number> },
    snap: Record<string, GitState>,
  ): number | null {
    if (session.id === trainId) return null; // never mark the train itself
    if (session.repoPath !== train.repoPath) return null;
    if (session.mergingSince !== null) return null; // already marked
    const g = snap[session.id];
    if (g?.state === "open" && g.number != null && train.prNumbers.has(g.number)) {
      return g.number;
    }
    return null;
  }

  /**
   * Stamp one session as a member of a live train and register it with the
   * completion tracker. Idempotent and guarded: a no-op when the session IS the
   * train, when the train is no longer live (a `session:git` after archive must not
   * resurrect a member), when the session is unknown, or when already marked. The
   * tracker entry is lazily created on the FIRST marked member, so a train whose PRs
   * never open creates no entry. `now` injectable.
   */
  markTrainMember(
    trainId: string,
    sessionId: string,
    prNumber: number,
    now: number = Date.now(),
  ): void {
    if (sessionId === trainId) return;
    const live = this.#liveTrains.get(trainId);
    if (!live) return; // train not live → no resurrection
    const s = this.deps.store.get(sessionId);
    if (!s || s.mergingSince !== null) return; // unknown or already marked
    this.deps.store.update(sessionId, {
      mergingSince: now,
      mergingTrainId: trainId,
      mergingPrNumber: prNumber,
    });
    this.deps.events?.emit("session:merging", { id: sessionId, since: now, trainId });
    this.#memberToTrain.set(sessionId, trainId);
    let entry = this.#trainOffers.get(trainId);
    if (!entry) {
      entry = {
        repoPath: live.repoPath,
        merged: false,
        archived: false,
        awaitingSince: null,
        members: new Set<string>(),
      };
      this.#trainOffers.set(trainId, entry);
    }
    entry.members.add(sessionId);
  }

  /** Clear one session's merge-train mark. No-op (no event) when not marked. */
  clearMerging(id: string): void {
    const s = this.deps.store.get(id);
    if (!s || s.mergingSince === null) return;
    this.deps.store.update(id, {
      mergingSince: null,
      mergingTrainId: null,
      mergingPrNumber: null,
    });
    this.deps.events?.emit("session:merging", { id, since: null, trainId: null });
  }

  /**
   * A queue member's PR resolved (`session:git` merged/closed). Replaces the bare
   * per-member `clearMerging` call: clears the UI mark exactly as before, then
   * credits the completion tracker. Credit is keyed by `#memberToTrain` (NOT the
   * session's `mergingTrainId`, which archive may already have nulled).
   *
   * A merge only counts toward the offer when the session is `isolated` — a
   * non-isolated session works in the canonical clone, so its fast-forward would
   * always report `wrong_branch` (mirrors the parent feature's guard). We read
   * `isolated`/`trainId` before clearing, since the mark must be cleared either way.
   * Emits only via the LATE-CREDIT path: if the train already archived awaiting a
   * merge, this credit completes it. A credit while the train is still live never
   * emits — the offer fires on run completion, not first merge.
   */
  resolveMerging(id: string, didMerge: boolean): void {
    const isolated = this.deps.store.get(id)?.isolated ?? false;
    this.clearMerging(id);
    const trainId = this.#memberToTrain.get(id);
    if (trainId === undefined) return; // untracked → behaves exactly like the old clearMerging
    const entry = this.#trainOffers.get(trainId);
    this.#memberToTrain.delete(id);
    if (!entry) return;
    entry.members.delete(id);
    entry.merged ||= didMerge && isolated;
    if (entry.archived && entry.merged) this.#finalizeTrain(trainId, entry.repoPath);
  }

  /**
   * The train session was archived (run complete). Clear any of its members still
   * marked (unchanged), then drive the offer. If a merge was already credited →
   * emit + finalize now. Else DEFER: mark the entry archived and fast-poll each
   * still-tracked member via `refreshPr` so a poller-gated merge surfaces within
   * seconds and routes through `resolveMerging` → late-credit emit. A deferred
   * entry whose late credit never arrives is reclaimed by `sweepStaleMerging` with
   * no emit, `MERGE_STALE_MS` after this archive — the await window starts HERE, so
   * it is independent of how long the run itself took (a slow/long run is never
   * reclaimed mid-flight; only the post-archive wait is bounded). `now` injectable.
   */
  clearMergingForTrain(trainId: string, now: number = Date.now()): void {
    // Drop the live-train entry FIRST (unconditionally, even with no #trainOffers
    // entry) — the train has stopped running, so a later `session:git` reconcile
    // must not re-mark a member against it.
    this.#liveTrains.delete(trainId);
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingTrainId === trainId) this.clearMerging(s.id);
    }
    const entry = this.#trainOffers.get(trainId);
    if (!entry || entry.archived) return; // untracked, or a repeat archive → keep the await window monotonic
    entry.archived = true;
    entry.awaitingSince = now; // start the post-archive await window (only awaiting entries are swept)
    if (entry.merged) {
      this.#finalizeTrain(trainId, entry.repoPath);
      return;
    }
    for (const id of entry.members) this.deps.refreshPr?.(id);
  }

  /** Emit `mergetrain:landed` once (caller has decided merged) and drop all tracker state. */
  #finalizeTrain(trainId: string, repoPath: string): void {
    this.deps.events?.emit("mergetrain:landed", { repoPath });
    const entry = this.#trainOffers.get(trainId);
    if (entry) for (const id of entry.members) this.#memberToTrain.delete(id);
    this.#trainOffers.delete(trainId);
  }

  /**
   * Liveness-based reclaim: marks live with their train, never on a flat age. Runs
   * three ordered phases each call (order matters — A feeds B and C):
   *  A. Deregister crashed/gone live trains. A train whose session is missing or
   *     archived, or whose last activity (`max(registeredAt, updatedAt)`) is past
   *     TRAIN_TRACKER_MAX_MS, is dropped from `#liveTrains`. Last-activity-keyed so a
   *     slow-but-alive train (still touching its row) is never ceiled mid-run.
   *  B. Clear member marks whose train is no longer live — a mark is released exactly
   *     when its train stops running (cleanly via clearMergingForTrain, or via A's
   *     deregistration here in the same sweep). No standalone age TTL.
   *  C. Reclaim `#trainOffers` entries, both no-emit (fail-safe no-offer):
   *     - AWAITING (archived, awaiting a late credit): once the post-archive window
   *       (MERGE_STALE_MS, #426) lapses — preserved exactly.
   *     - LIVE-CRASH ORPHAN (awaitingSince null, train no longer live): A having just
   *       dropped a crashed train, its still-live entry is reclaimed here. The
   *       awaitingSince-null gate keeps a cleanly-archived entry on the AWAITING path.
   * `now` injectable for tests.
   */
  sweepStaleMerging(now: number = Date.now()): void {
    // Three ordered phases — A feeds B and C, so the A→B→C ordering MUST be preserved.
    this.#deregisterInactiveTrains(now);
    this.#releaseNonLiveMarks();
    this.#reclaimStaleTrainOffers(now);
  }

  /**
   * Phase A: Deregister crashed/gone trains (release them before clearing member
   * marks). A train whose session is missing or archived, or whose last activity
   * (`max(registeredAt, updatedAt)`) is past TRAIN_TRACKER_MAX_MS, is dropped from
   * `#liveTrains`. Last-activity-keyed so a slow-but-alive train (still touching its
   * row) is never ceiled mid-run. `now` injectable.
   */
  #deregisterInactiveTrains(now: number): void {
    for (const [trainId, lt] of this.#liveTrains) {
      const ts = this.deps.store.get(trainId);
      if (!ts || ts.archivedAt != null) {
        this.#liveTrains.delete(trainId);
        continue;
      }
      const lastActive = Math.max(lt.registeredAt, ts.updatedAt);
      if (now - lastActive > TRAIN_TRACKER_MAX_MS) this.#liveTrains.delete(trainId);
    }
  }

  /**
   * Phase B: Clear a member mark exactly when its train is no longer live — released
   * cleanly (via clearMergingForTrain) or via phase A's deregistration in the same
   * sweep. No standalone age TTL.
   */
  #releaseNonLiveMarks(): void {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingSince === null) continue;
      if (s.mergingTrainId === null || !this.#liveTrains.has(s.mergingTrainId)) {
        this.clearMerging(s.id);
      }
    }
  }

  /**
   * Phase C: Reclaim `#trainOffers` entries directly (NOT via activeOnly, which
   * excludes archived trains), both no-emit (fail-safe no-offer):
   *  - AWAITING (archived, awaiting a late credit): once the post-archive window
   *    (MERGE_STALE_MS, #426) lapses — preserved exactly.
   *  - LIVE-CRASH ORPHAN (awaitingSince null, train no longer live): A having just
   *    dropped a crashed train, its still-live entry is reclaimed here. The
   *    awaitingSince-null gate keeps a cleanly-archived entry on the AWAITING path.
   * `now` injectable.
   */
  #reclaimStaleTrainOffers(now: number): void {
    for (const [trainId, entry] of this.#trainOffers) {
      const awaitingStale =
        entry.awaitingSince !== null && now - entry.awaitingSince > MERGE_STALE_MS;
      const liveCrashOrphan = entry.awaitingSince === null && !this.#liveTrains.has(trainId);
      if (awaitingStale || liveCrashOrphan) {
        for (const id of entry.members) this.#memberToTrain.delete(id);
        this.#trainOffers.delete(trainId);
      }
    }
  }

  /** Leftover subprocesses/proxies that would survive this session's close; [] when none. */
  leftovers(id: string): Leftover[] {
    const s = this.deps.store.get(id);
    if (!s || !this.deps.reaper) return [];
    return this.deps.reaper.detect(s);
  }

  /** Attribute the effectiveness reward for a terminating session: every rule injected
   *  into it counts as one "pull" (injectedCount++ / lastUsedAt), and a terminal-good
   *  outcome additionally counts as a help (helpfulCount++). Counting both here keeps the
   *  help-rate numerator and denominator on the same population (only sessions that reached
   *  a terminal outcome). Best-effort: must never throw past teardown. */
  private attributeLearningReward(s: Session): void {
    try {
      const ids = this.deps.store.takeSessionInjectedLearnings(s.id);
      if (ids.length === 0) return;
      const good = isGoodOutcome(
        this.deps.store.getReview(s.id),
        this.deps.store.countSessionBlockingSignals(s.id),
      );
      this.deps.store.attributeInjected(ids, { good });
    } catch (err) {
      console.warn(`[learnings] reward attribution failed for ${s.id}:`, err);
    }
  }

  /**
   * Close a session: optionally terminate selected leftovers first, then stop the
   * agent, remove the worktree, and archive the row. `reapKeys` are leftover keys
   * the operator chose to kill; we re-detect and intersect by key so a stale/forged
   * client selection can never make us kill an arbitrary pid. Returns the number of
   * leftovers actually reaped (the intersection), so bulk callers can report a count
   * that reflects what was killed rather than what was requested.
   */
  async archive(id: string, reapKeys?: string[]): Promise<number> {
    const s = this.deps.store.get(id);
    if (!s) return 0;
    let reaped = 0;
    if (reapKeys?.length && this.deps.reaper) {
      const want = new Set(reapKeys);
      const hit = this.deps.reaper.detect(s).filter((l) => want.has(l.key));
      this.deps.reaper.reap(hit);
      reaped = hit.length;
    }
    this.deps.herdr.stop(s.herdrAgentId); // stop the live claude agent so it doesn't leak
    // Best-effort pre-teardown hook (recap generation): the recap generator reads the
    // worktree to build its prompt, so it MUST run while the worktree still exists.
    // Race a 15s timeout so a stuck git can never permanently stall teardown / the merge
    // train, and swallow any rejection — recap must never block teardown.
    if (this.deps.beforeArchive) {
      const timeoutMs = this.deps.beforeArchiveTimeoutMs ?? 15_000;
      try {
        await Promise.race([
          this.deps.beforeArchive(s),
          new Promise<void>((r) => setTimeout(r, timeoutMs)),
        ]);
      } catch {
        /* best-effort: recap must never block teardown */
      }
    }
    if (s.isolated)
      this.deps.worktree.remove(s.worktreePath, { branch: s.branch, baseBranch: s.baseBranch });
    // Stop the drop-watcher before removing the temp dir so it can't read a torn-down path.
    this.deps.egressWatcher?.stop(id);
    // Best-effort: drop this session's egress config dir (incl. dns.log). The agent is
    // stopped above, so nothing still tails it. No-op when the session never had egress on.
    removeEgressTmp(id);
    this.attributeLearningReward(s);
    this.deps.store.archive(id);
    return reaped;
  }

  /**
   * Startup reconcile: remove any orphaned `shepherd-egress/<id>` temp dir whose id is
   * not a currently live (non-archived) session — bounds unbounded growth from teardown
   * removals missed across a crash/restart. Best-effort (never throws). Call once at
   * server boot. A live session's dir (incl. its dns.log) is preserved.
   */
  sweepEgressTmp(): void {
    const live = this.deps.store.list({ activeOnly: true }).map((s) => s.id);
    sweepEgressTmp(live);
  }

  /**
   * Bulk-close sessions ("clear all merged"). Each session's leftover subprocesses
   * are auto-detected and reaped before its teardown — unlike the single-session
   * close (which asks per-process), bulk clear terminates them all so a landed
   * session can't leave a dev server orphaned. Returns the ids actually archived
   * (missing ones are skipped) and the total leftovers terminated — counted from
   * what `archive` actually reaped, so the number never overstates. The caller must
   * restrict `ids` to a safe set (e.g. merged-only) — this archives what it's given.
   *
   * One session's teardown failing (e.g. `worktree.remove` throwing) must not abort
   * the rest, so each is isolated: a failed id is skipped and left out of `cleared`,
   * so the caller emits archived events for exactly the rows that really went away.
   */
  async archiveMany(ids: string[]): Promise<{ cleared: string[]; leftovers: number }> {
    const cleared: string[] = [];
    let leftovers = 0;
    for (const id of ids) {
      const s = this.deps.store.get(id);
      if (!s) continue;
      const keys = this.deps.reaper?.detect(s).map((l) => l.key) ?? [];
      try {
        leftovers += await this.archive(id, keys); // count what was reaped, not what was detected
        cleared.push(id);
      } catch {
        // skip this one; its row stays active and gets no archived event
      }
    }
    return { cleared, leftovers };
  }
}
