// The single mutable in-memory demo world. `reset()` deep-clones a canonical seed
// into live state; getters return exactly what each `api.ts` caller consumes;
// mutators MUTATE the world and `bus.emit(...)` the matching typed `WsEvent`(s) so
// the live UI updates over the fake `/events` socket.

import type {
  Session,
  GitState,
  SessionActivity,
  SubagentEntry,
  HoldReason,
  Epic,
  EpicSummary,
  CompletedEpic,
  DrainStatus,
  AutoMergeStatus,
  BuildQueue,
  Recap,
  ReviewVerdict,
  PlanGate,
  UpNextSnapshot,
  BacklogPayload,
  Settings,
  PluginInfo,
  DiagnosticsSnapshot,
  HeldTask,
  Steer,
  ProjectIcons,
  Learning,
  UsageLimitsResponse,
  UpdateStatus,
  HerdrUpdateStatus,
  CodexUpdateStatus,
  StarPromptStatus,
  PrStatus,
  WsEvent,
  ActivityEntry,
  DiffResult,
  ScratchListing,
  SessionUsage,
  SlashCommand,
  Leftover,
  PostMergeSteps,
  RepoEntry,
  Issue,
  IssueFetchAttempt,
  CreateInput,
  StandardCreateInput,
  DirListing,
  AccessToken,
  PluginUpdatesStatus,
  PullRequest,
  WorkflowRun,
  WorkflowJob,
  ReadinessReport,
  RepoRoles,
  InstalledPlugin,
  DocAgentRun,
  UsageBreakdown,
  UsageTimeline,
  UsageRange,
  DeliveryMetrics,
  GithubRateLimit,
  PromptBudgetRecord,
  QueuedItem,
  ForgeKind,
} from "$lib/types";
import { bus } from "./bus";
import { buildSeed, mkSession } from "./seed";
import { DEMO_VIEWER } from "./seed-constants";
import type { DemoWorld, DemoRepoConfig, DemoBranchList } from "./types-world";

// A canonical, never-mutated seed. Every `reset()` `structuredClone`s from THIS, so
// live mutations can never leak back into the seed and a reset always restores clean.
// `/*#__PURE__*/` so Rollup treats these module-eval calls as side-effect-free and
// tree-shakes the whole demo tree out of the production bundle (it's referenced only
// inside the `if (__DEMO__)` guard, which DCEs to `if (false)` in prod).
const SEED: DemoWorld = /*#__PURE__*/ buildSeed();

let world: DemoWorld = /*#__PURE__*/ structuredClone(SEED);

// Task 6: director registers reset hook here — `reset()` invokes each so the liveness
// engine can stop/restart its timers without state.ts importing director (no cycle).
const resetHooks: Array<() => void> = [];

function emit(ev: WsEvent): void {
  bus.emit(ev);
}

function find(id: string): Session | undefined {
  return world.sessions.find((s) => s.id === id);
}

/** The server's recent-agent window, which the New Task picker names on its
 *  "recently worked on" group. Matches the seeded `recentAgentCount`s. */
const RECENT_REPO_WINDOW_DAYS = 14;

/** Next free `TASK-<n>` designation across live AND archived sessions, so a created
 *  session can never collide with a Done-lens row. */
function nextTaskNumber(): number {
  const used = [...world.sessions, ...world.doneSessions].map((s) =>
    Number(/^TASK-(\d+)$/.exec(s.desig)?.[1] ?? 0),
  );
  return Math.max(0, ...used) + 1;
}

/** A kebab session name from the prompt's first few words — the shape the real server's
 *  namer produces, without the LLM round-trip. */
function nameFromPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 3)
    .join("-");
  return slug || "new-task";
}

/** A clean-terminal create: a bare operator shell in the repo's MAIN checkout — no
 *  branch, no worktree, no agent, no prompt. */
function terminalSession(num: number, repoPath: string): Session {
  return mkSession({
    id: `new-${num}`,
    desig: `TASK-${num}`,
    name: "terminal",
    repoPath,
    prompt: "",
    branch: null,
    worktreePath: repoPath,
    isolated: false,
    terminal: true,
    model: null,
    sandboxApplied: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** A normal agent session, carrying every choice the composer actually submitted —
 *  an absent field stays null/false rather than inventing a stronger choice. */
function agentSession(num: number, input: StandardCreateInput): Session {
  const name = nameFromPrompt(input.prompt);
  const id = `new-${num}`;
  return mkSession({
    id,
    desig: `TASK-${num}`,
    name,
    repoPath: input.repoPath,
    prompt: input.prompt,
    baseBranch: input.baseBranch,
    branch: `shepherd/${name}`,
    worktreePath: `${input.repoPath}/.worktrees/${id}`,
    agentProvider: input.agentProvider ?? "claude",
    model: input.model,
    effort: input.effort ?? null,
    planGateEnabled: input.planGateEnabled ?? null,
    // The server opens a plan-gated task in its planning phase; the gate's Go releases it.
    planPhase: input.planGateEnabled === true ? "planning" : null,
    autopilotEnabled: input.autopilotEnabled ?? null,
    research: input.research === true,
    epicAuthoring: input.epicAuthoring === true,
    sandboxApplied: input.sandboxProfile ?? "standard",
    issueNumber: input.issueRef?.number ?? null,
    issueUrl: input.issueRef?.url,
    status: "running",
    lastState: "working",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** A repo's forge slug, from the repo INDEX (`world.repos`) rather than a per-endpoint seed.
 *  Several endpoints report it (`/api/issues`, `/api/prs`, `/api/actions`, `/api/repo-web`,
 *  `/api/repo-collaborators`); deriving them all from one source means they cannot disagree
 *  about a repo. `null` for a path the index doesn't know — including a repo created
 *  in-session via `POST /api/projects`, which genuinely has no remote. */
function slugFor(repoPath: string): string | null {
  return world.repos.find((r) => r.path === repoPath)?.remoteSlug ?? null;
}

/** The forge web URL matching {@link slugFor}, or null when there is no slug. */
function webUrlFor(repoPath: string): string | null {
  const slug = slugFor(repoPath);
  return slug ? `https://github.com/${slug}` : null;
}

/** Parent of an absolute path, or null at the root — so an unseeded directory listing still
 *  offers a working "up" crumb in the picker. */
function parentDir(path: string): string | null {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  if (cut < 0) return null;
  return cut === 0 ? "/" : path.slice(0, cut);
}

export const demoState = {
  /** Deep-clone the canonical seed into live state, then fire reset hooks. */
  reset(): void {
    world = structuredClone(SEED);
    for (const cb of [...resetHooks]) cb();
  },

  /** Register a callback fired after every `reset()` (director wiring, Task 6). */
  onReset(cb: () => void): () => void {
    resetHooks.push(cb);
    return () => {
      const i = resetHooks.indexOf(cb);
      if (i >= 0) resetHooks.splice(i, 1);
    };
  },

  // ── getters (shaped to what api.ts callers expect) ───────────────────────
  sessions: (): Session[] => world.sessions,
  gitStates: (): Record<string, GitState> => world.gitStates,
  gitState: (id: string): GitState | null => world.gitStates[id] ?? null,
  activityStates: (): Record<string, SessionActivity> => world.activityStates,
  claudeAliveStates: (): Record<string, boolean> => world.claudeAliveStates,
  workingBlockedStates: (): Record<string, boolean> => world.workingBlockedStates,
  holdStates: (): Record<string, HoldReason> => world.holdStates,
  subagentStates: (): Record<string, SubagentEntry[]> => world.subagentStates,
  previewStates: (): Record<string, { previewPort: number | null; serve?: "ok" | "failed" }> =>
    world.previewStates,

  // ── session-detail tabs (Task 8 sibling audit) ──────────────────────────
  /** GET /api/sessions/done — archived sessions for the Done lens. */
  doneSessions: (): Session[] => world.doneSessions,
  /** GET /api/sessions/:id/activity — [] (never {}) when the session has no transcript seeded. */
  activityEntries: (id: string): ActivityEntry[] => world.activityEntries[id] ?? [],
  /** GET /api/sessions/:id/diff — a valid empty DiffResult (never {}) for an unseeded session. */
  diff: (id: string): DiffResult =>
    world.diffs[id] ?? {
      base: "main",
      baseRef: "origin/main",
      head: find(id)?.branch ?? null,
      fetchFailed: false,
      truncated: false,
      files: [],
    },
  /** GET /api/sessions/:id/scratchpad (root) — mirrors the real server's synthetic empty
   *  listing for a session whose scratchpad root doesn't exist yet. */
  scratchpadRoot: (id: string): ScratchListing =>
    world.scratchpad[id] ?? { path: "", parent: null, entries: [] },
  /** GET /api/sessions/:id/usage — a zeroed (never {}) record for an unseeded session.
   *  available:true — in the demo world the data source "exists", so zero is a true zero. */
  sessionUsage: (id: string): SessionUsage =>
    world.sessionUsage[id] ?? {
      available: true,
      source: "live",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      messageCount: 0,
      byModel: {},
    },
  /** GET /api/sessions/:id/leftovers — the demo never leaves real subprocesses running, and
   *  has no probes to be broken, so the empty list is trustworthy (`probesUnavailable: false`,
   *  matching a server with no reaper wired). */
  leftovers: (): { leftovers: Leftover[]; probesUnavailable: boolean } => ({
    leftovers: [],
    probesUnavailable: false,
  }),
  /** GET /api/sessions/:id/queue — the seeded queue if this session has one, else the same
   *  empty-but-valid record the real server returns for a session with no queue yet. */
  sessionBuildQueue: (id: string): BuildQueue =>
    world.buildQueues[id] ?? { sessionId: id, approved: false, steps: [] },
  /** GET /api/repo-config?repo= — automation flags; `{}` for an unrecognized repoPath (the
   *  UI treats a missing field as its documented default, same as an unconfigured repo). */
  repoConfig: (repoPath: string): DemoRepoConfig | Record<string, never> =>
    world.repoConfig[repoPath] ?? {},
  /** GET /api/commands?repo= — installed slash commands, [] for an unrecognized repoPath. */
  commands: (
    repoPath: string,
    provider: "claude" | "codex" = "claude",
  ): { commands: SlashCommand[] } => ({
    commands: (world.slashCommands[repoPath] ?? []).filter((c) =>
      (c.providers ?? ["claude"]).includes(provider),
    ),
  }),
  /** GET /api/todo?repo= — {exists:false} for an unrecognized repoPath. */
  todo: (repoPath: string): { exists: boolean; content: string } =>
    world.todo[repoPath] ?? { exists: false, content: "" },
  /** GET /api/manual-steps/outstanding (Owed lens) — only still-outstanding records. */
  outstandingManualSteps: (): PostMergeSteps[] =>
    world.postMergeSteps.filter((r) => r.clearedAt == null),

  // ── New Task flow (#1800) ───────────────────────────────────────────────
  /** GET /api/repos — the repo index behind `repos.svelte.ts` and the New Task picker. */
  repos: (): { repos: RepoEntry[]; recentWindowDays: number } => ({
    repos: world.repos,
    recentWindowDays: RECENT_REPO_WINDOW_DAYS,
  }),

  /** GET /api/branches?repo= — a valid empty list (never `{}`) for an unrecognized
   *  repoPath; `pickBaseBranch` then falls back to "main" exactly as it does against a
   *  server that can't read the repo. */
  branches: (repoPath: string): DemoBranchList =>
    world.branches[repoPath] ?? { branches: [], current: null, default: null },

  /** GET /api/branch-status?repo=&branch= — the demo's seeded bases are clean and in
   *  sync. An unseeded branch reports as neither local nor upstream, which is what the
   *  real server says about a branch it can't find. */
  branchStatus: (
    repoPath: string,
    branch: string,
  ): {
    behind: number;
    ahead: number;
    diverged: boolean;
    hasUpstream: boolean;
    localExists: boolean;
  } => {
    const known = world.branches[repoPath]?.branches.includes(branch) ?? false;
    return { behind: 0, ahead: 0, diverged: false, hasUpstream: known, localExists: known };
  },

  /** GET /api/issues?repo= — open issues, and a genuine zero (`error: null`, not a
   *  failure) for an unrecognized repoPath. `slug`/`webUrl` are derived from the repo
   *  index, so this can never disagree with `/api/repos`. */
  issues: (
    repoPath: string,
  ): {
    slug: string | null;
    webUrl: string | null;
    issues: Issue[];
    viewer: string | null;
    error: string | null;
    lightweight: boolean;
    attempts: IssueFetchAttempt[];
  } => {
    return {
      slug: slugFor(repoPath),
      webUrl: webUrlFor(repoPath),
      issues: world.issues[repoPath] ?? [],
      viewer: DEMO_VIEWER,
      error: null,
      lightweight: false,
      attempts: [],
    };
  },

  /** GET /api/fs/dirs?path= — the Settings → Workspace repo-root picker. An unseeded path
   *  answers an empty-but-valid listing (never `{}`: DirPicker reads `entries.length`) with a
   *  computed `parent`, so browsing into an unseeded directory still has a working "up". */
  dirs: (path: string): DirListing => {
    const p = path === "" ? world.settings.repoRoot : path;
    return world.dirs[p] ?? { path: p, display: p, parent: parentDir(p), entries: [] };
  },

  /** GET /api/access-tokens — the demo mints no machine tokens, so the empty list is a true
   *  zero. `{ tokens: [] }`, never `{}`: SettingsAccessPanel reads `tokens.length`. */
  accessTokens: (): { tokens: AccessToken[] } => ({ tokens: [] }),

  /** GET /api/plugin-update — the demo's seeded plugins are all current, so no update is
   *  offered. The `plugins` array must be present: Settings' `$derived` reads
   *  `pluginUpdates?.plugins.filter(...)`, and `{}` is truthy, so a missing field threw. */
  pluginUpdate: (): PluginUpdatesStatus => ({
    plugins: [],
    updateAvailable: false,
    checkedAt: Date.now(),
  }),

  // ── repo-scoped lenses (#2295) ──────────────────────────────────────────
  // Everything below was reaching the router's permissive `{}` tail. Each returns the
  // exact shape its `api.ts` caller consumes, and an UNRECOGNIZED repoPath gets a valid
  // empty value — never `{}` — because a repo created in-session (POST /api/projects)
  // has no fixtures but its panels still mount.

  /** GET /api/prs?repo= — the Backlog PRs tab. `slug`/`webUrl` come from the repo index,
   *  so the tab's "view on GitHub" link can never disagree with `/api/repos`. */
  pullRequests: (
    repoPath: string,
  ): { slug: string | null; webUrl: string | null; prs: PullRequest[] } => ({
    slug: slugFor(repoPath),
    webUrl: webUrlFor(repoPath),
    prs: world.pullRequests[repoPath] ?? [],
  }),

  /** GET /api/actions?repo= — the Backlog Actions tab. The three capability flags gate
   *  the tab's controls: both demo repos are GitHub, so a repo with fixtures can list
   *  runs and re-run/cancel them. An unknown repo reports no Actions support rather than
   *  an empty-but-capable tab, which is what the server says about a forge it can't read. */
  workflowRuns: (
    repoPath: string,
  ): {
    slug: string | null;
    webUrl: string | null;
    kind: ForgeKind | null;
    runs: WorkflowRun[];
    supportsActions: boolean;
    canRerun: boolean;
    canCancel: boolean;
  } => {
    const runs = world.workflowRuns[repoPath];
    return {
      slug: slugFor(repoPath),
      webUrl: webUrlFor(repoPath),
      kind: runs ? "github" : null,
      runs: runs ?? [],
      supportsActions: runs != null,
      canRerun: runs != null,
      canCancel: runs != null,
    };
  },

  /** GET /api/actions/history?repo=&workflowId= — prior runs of one workflow. */
  workflowHistory: (repoPath: string, workflowId: number): { runs: WorkflowRun[] } => ({
    runs: world.workflowHistory[repoPath]?.[workflowId] ?? [],
  }),

  /** GET /api/actions/run-jobs?repo=&runId= — one run's per-job breakdown. */
  runJobs: (repoPath: string, runId: number): { jobs: WorkflowJob[] } => ({
    jobs: world.runJobs[repoPath]?.[runId] ?? [],
  }),

  /** GET /api/readiness?repo= — the Backlog Readiness tab. An unseeded repo answers
   *  `applicable:false`, the server's own "matches no supported ecosystem" path, which the
   *  panel renders as an N/A baseline instead of a zero score it never measured. */
  readiness: (repoPath: string): ReadinessReport =>
    world.readiness[repoPath] ?? {
      applicable: false,
      ecosystem: null,
      score: 0,
      checks: [],
      hasAgentInstructions: false,
      hasIssueTemplates: false,
      claudeMd: "",
      issueTemplate: "",
    },

  /** GET /api/repo-roles?repo= — Settings → Automation's reviewer/merger handoff. */
  repoRoles: (repoPath: string): { roles: RepoRoles; me: string | null } => ({
    roles: world.repoRoles[repoPath] ?? { reviewer: null, merger: null },
    me: DEMO_VIEWER,
  }),

  /** GET /api/repo-collaborators?repo= — the logins the roles pickers offer.
   *  `collaboratorsUnavailable:false` is a true statement here: the demo forge answers, and
   *  the list really is complete — the flag exists to distinguish that from a 403 we papered
   *  over with an empty list. */
  repoCollaborators: (
    repoPath: string,
  ): {
    logins: string[];
    me: string | null;
    collaboratorsUnavailable: boolean;
    source?: "collaborators" | "assignees";
    repoSlug: string | null;
    isFork: boolean;
  } => ({
    logins: world.repoCollaborators[repoPath] ?? [],
    me: DEMO_VIEWER,
    collaboratorsUnavailable: false,
    source: "collaborators",
    repoSlug: slugFor(repoPath),
    isFork: false,
  }),

  /** GET /api/doc-agent/runs?repo= — doc-agent history. Genuinely empty and unreachable
   *  while `settings.docAgentEnabled` is false; shaped anyway (`runs` is assigned into a
   *  `$state` array) so flipping that setting on can't crash the Backlog. */
  docAgentRuns: (repoPath: string): { running: boolean; runs: DocAgentRun[] } => ({
    running: false,
    runs: world.docAgentRuns[repoPath] ?? [],
  }),

  /** GET /api/plugins/manage/installed — Settings → Plugins' folder list. Wrapped under
   *  `installed`: `getInstalledPlugins()` reads `body.installed`.
   *
   *  DERIVED from the same `world.plugins` that answers `/api/plugins`, not seeded
   *  separately. The manager unions the two by `id` and reports any LOADED plugin missing
   *  from this list as "removed, restart to unload" — so a second seed that merely looked
   *  plausible made the panel accuse the demo's own plugins of having been uninstalled. */
  installedPlugins: (): { installed: InstalledPlugin[] } => ({
    installed: world.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      ...(p.repository ? { repository: p.repository } : {}),
      folder: p.id, // the uninstall key — unique because plugin ids are
      loaded: true,
      disabled: false,
      broken: p.health !== "ok",
    })),
  }),

  /** GET /api/repo-web?repo= — the RepoSwitcher's forge link. Derived from the repo index
   *  rather than seeded, so it cannot drift from `/api/repos`. */
  repoWeb: (
    repoPath: string,
  ): { slug: string | null; webUrl: string | null; kind: ForgeKind | null } => {
    const slug = slugFor(repoPath);
    return { slug, webUrl: webUrlFor(repoPath), kind: slug ? "github" : null };
  },

  /** GET /api/drain/queue?repo= — the backlog issues behind a repo's `queued` count,
   *  fetched when the QueueStrip popover opens.
   *
   *  DERIVED from the seeded issues rather than seeded separately: an issue is queued when
   *  nothing has claimed it yet, which is the rule the real drain applies — so the popover
   *  can never offer work the herd is visibly already doing. Claimed means EITHER an epic
   *  child marked `claimed` OR a live session pointing at that issue; a session outside an
   *  epic is just as real a claim. An epic PARENT is excluded too: it is an umbrella, never
   *  drainable work. */
  drainQueue: (repoPath: string): QueuedItem[] => {
    const claimed = new Set<number>([
      ...world.epics.flatMap((e) => e.children.filter((c) => c.claimed).map((c) => c.number)),
      ...world.sessions.flatMap((s) => (s.issueNumber == null ? [] : [s.issueNumber])),
    ]);
    return (world.issues[repoPath] ?? [])
      .filter((i) => !claimed.has(i.number) && !i.labels.includes("epic"))
      .map((i) => ({ number: i.number, title: i.title, url: i.url }));
  },

  /** GET /api/issues/:number?repo= — the session card's hover issue preview.
   *  `getIssue()` is typed `Promise<Issue | null>`, and `{}` is NEITHER, so the preview
   *  used to render blank fields. Looked up in the SAME `world.issues` that answers
   *  `/api/issues`, so the peek and the list can never disagree. */
  issue: (repoPath: string, number: number): Issue | null =>
    (world.issues[repoPath] ?? []).find((i) => i.number === number) ?? null,

  // ── usage lens (#2295) ──────────────────────────────────────────────────
  // Single datasets with the requested `range` echoed back — see the RANGE note in
  // seed-usage.ts. The echo matters: `Usage.svelte` keys its monotonic request tokens off
  // the range it asked for, so a response must not claim a different one.

  /** GET /api/usage/breakdown?range= — the Spend + Overhead lenses. */
  usageBreakdown: (range: UsageRange): UsageBreakdown => ({ ...world.usageBreakdown, range }),

  /** GET /api/usage/timeline?range= — the per-hour heatmap. */
  usageTimeline: (range: UsageRange): UsageTimeline => ({ ...world.usageTimeline, range }),

  /** GET /api/usage/delivery?range= — the Delivery lens. */
  deliveryMetrics: (range: UsageRange): DeliveryMetrics => ({ ...world.deliveryMetrics, range }),

  /** GET /api/usage/github — REST/GraphQL/search rate-limit buckets. */
  githubRateLimit: (): GithubRateLimit => world.githubRateLimit,

  /** GET /api/prompt-budget — per-spawn assembled-directive breakdowns. Wrapped under
   *  `records`: `getPromptBudgets()` reads `body.records ?? []`, so a bare array is
   *  silently discarded and the lens shows its "nothing measured yet" empty state. */
  promptBudgets: (): { records: PromptBudgetRecord[] } => ({ records: world.promptBudgets }),

  /** GET /api/stranded — no session in the scenario is a restart-strand (the `false` entries in
   *  `claudeAliveStates` are plain husks). Must be an ARRAY: `setClaudeAlive` does `for…of` over
   *  it, and `{}` threw there before the liveness map was ever assigned. */
  stranded: (): string[] => [],

  usageLimits: (): UsageLimitsResponse => world.usage,
  update: (): UpdateStatus => world.update,
  herdrUpdate: (): HerdrUpdateStatus => world.herdrUpdate,
  codexUpdate: (): CodexUpdateStatus => world.codexUpdate,
  starPrompt: (): StarPromptStatus => world.starPrompt,
  drain: (): DrainStatus[] => world.drain,
  autoMerge: (): AutoMergeStatus[] => world.autoMerge,

  completedEpics: (): CompletedEpic[] => world.completedEpics,
  settings: (): Settings => world.settings,
  plugins: (): PluginInfo[] => world.plugins,
  diagnostics: (): DiagnosticsSnapshot => world.diagnostics,
  backlog: (): BacklogPayload => world.backlog,
  buildQueues: (): Record<string, BuildQueue> => world.buildQueues,
  held: (): HeldTask[] => world.held,
  recaps: (): Record<string, Recap> => world.recaps,
  reviews: (): Record<string, ReviewVerdict> => world.reviews,
  planGates: (): Record<string, PlanGate> => world.planGates,
  upNext: (): UpNextSnapshot | null => world.upNext,
  steers: (): Steer[] => world.steers,
  projectIcons: (): ProjectIcons => world.projectIcons,
  pendingLearnings: (): Learning[] => world.pendingLearnings,

  /** Merged, non-archived session ids — for the "Clear merged" confirm modal.
   *  Matches `getMergedClearable()`'s `{ids, leftovers, probesUnavailable}` in api.ts exactly;
   *  the demo has no real leftover subprocesses, so the count is always 0 — and no probes to
   *  be broken, so that 0 is trustworthy. */
  mergedClearable: (): { ids: string[]; leftovers: number; probesUnavailable: boolean } => ({
    ids: world.sessions.filter((s) => world.gitStates[s.id]?.state === "merged").map((s) => s.id),
    leftovers: 0,
    probesUnavailable: false,
  }),

  /** GET /api/epic — one epic by repo + parent issue number. */
  epic: (repoPath: string, parent: number): Epic | null =>
    world.epics.find((e) => e.repoPath === repoPath && e.parentIssueNumber === parent) ?? null,

  /** GET /api/epics — per-repo summaries + the set of child issue numbers. */
  epicSummaries: (repoPath: string): { epics: EpicSummary[]; subIssues: number[] } => {
    const epics = world.epics.filter((e) => e.repoPath === repoPath);
    const subIssues = epics.flatMap((e) => e.children.map((c) => c.number));
    return {
      epics: epics.map((e) => ({
        parentIssueNumber: e.parentIssueNumber,
        parentTitle: e.parentTitle,
        total: e.children.length,
        merged: e.children.filter((c) => c.state === "merged").length,
        status: e.run.status,
        source: e.source,
      })),
      subIssues,
    };
  },

  // ── mutators (called by the router; each emits WsEvent(s)) ───────────────

  /** Steer/reply: the agent picks the message up and resumes working. */
  reply(id: string, text: string): void {
    const s = find(id);
    if (!s) return;
    const activity: SessionActivity = {
      lastActivityTs: Date.now(),
      summary: text.slice(0, 60),
      recentTs: [...(world.activityStates[id]?.recentTs ?? []), Date.now()],
      recentErrTs: world.activityStates[id]?.recentErrTs ?? [],
    };
    world.activityStates[id] = activity;
    s.status = "running";
    s.lastState = "working";
    delete world.holdStates[id];
    emit({ event: "session:activity", data: { id, activity } });
    emit({ event: "session:hold", data: { id, hold: null } });
    emit({ event: "session:status", data: { id, status: "running" } });
  },

  /** Toggle a session's autopilot override. */
  setAutopilot(id: string, enabled: boolean | null): void {
    const s = find(id);
    if (!s) return;
    s.autopilotEnabled = enabled;
    emit({
      event: "session:autopilot",
      data: {
        id,
        paused: s.autopilotPaused,
        complete: s.autopilotComplete,
        question: s.autopilotQuestion,
        enabled,
      },
    });
  },

  /** Trigger an on-demand plan review — seeded plan gates simulate a reviewer, no gate is unavailable. */
  reviewPlan(id: string): "started" | "plan-unavailable" {
    if (!world.planGates[id]) return "plan-unavailable";
    // Carry a concrete non-null reviewer env so the in-flight "Reviewing…" button shows the real
    // CLI · model · effort triple in the demo/preview (reflecting the session's own env), not the
    // bare fallback — which is what makes the mobile-wrap behavior visible in the browser preview.
    const s = find(id);
    emit({
      event: "session:plangate-reviewing",
      data: {
        id,
        reviewing: true,
        env: {
          provider: s?.agentProvider ?? "claude",
          model: s?.model ?? "opus",
          effort: s?.effort ?? "high",
        },
      },
    });
    return "started";
  },

  /** Release an approved plan gate → the agent flips from planning to executing. */
  releasePlanGate(id: string): boolean {
    const s = find(id);
    const gate = world.planGates[id];
    if (!s || !gate?.approved) return false;
    s.planPhase = "executing";
    s.status = "running";
    delete world.holdStates[id];
    emit({ event: "session:plangate", data: { id, planPhase: "executing" } });
    emit({ event: "session:hold", data: { id, hold: null } });
    emit({ event: "session:status", data: { id, status: "running" } });
    return true;
  },

  /** Deliver operator answers to a plan's question form (planning agent steer). */
  answerPlanQuestions(id: string): { delivered: boolean } {
    const activity: SessionActivity = {
      lastActivityTs: Date.now(),
      summary: "answered plan questions",
      recentTs: [...(world.activityStates[id]?.recentTs ?? []), Date.now()],
      recentErrTs: world.activityStates[id]?.recentErrTs ?? [],
    };
    world.activityStates[id] = activity;
    emit({ event: "session:activity", data: { id, activity } });
    return { delivered: true };
  },

  /** Mark the session's PR as merging (director later lands it + posts a recap). */
  mergePr(id: string): PrStatus {
    const s = find(id);
    const git = world.gitStates[id];
    const since = Date.now();
    if (s) {
      s.mergingSince = since;
      s.mergingTrainId = id;
    }
    emit({ event: "session:merging", data: { id, since, trainId: id } });
    return git ?? { state: "open", checks: "success", deployConfigured: false };
  },

  closePr(id: string): PrStatus {
    const git = world.gitStates[id];
    if (!git) return { state: "none", checks: "none", deployConfigured: false };
    git.state = "closed";
    emit({ event: "session:git", data: { id, git } });
    return git;
  },

  /** Land a merging PR (director follow-up to {@link mergePr}): flip git → merged,
   *  clear the merging latch, mark the session done, and confirm the train landed. */
  landMerge(id: string): void {
    const s = find(id);
    const git = world.gitStates[id];
    if (git) git.state = "merged";
    if (s) {
      s.mergingSince = null;
      s.mergingTrainId = null;
      s.status = "done";
      s.lastState = "done";
      s.readyToMerge = true;
    }
    if (git) emit({ event: "session:git", data: { id, git } });
    emit({ event: "session:status", data: { id, status: "done" } });
    if (s) emit({ event: "mergetrain:landed", data: { repoPath: s.repoPath } });
  },

  /** Generate + insert the "recap appears" payoff for a session that just landed
   *  (director follow-up to {@link landMerge}, emits `session:recap`). Idempotent: a
   *  session that already has a recap (seeded, or from a prior land) keeps it
   *  unchanged rather than growing/duplicating — landing the same id twice is a
   *  no-op past the first call. Returns null only if the session no longer exists. */
  landRecap(id: string): Recap | null {
    const s = find(id);
    if (!s) return null;
    const existing = world.recaps[id];
    if (existing) return existing;
    const git = world.gitStates[id];
    const title = git?.title ?? s.name;
    const prNumber = git?.number ?? null;
    const now = Date.now();
    const recap: Recap = {
      sessionId: id,
      state: "ready",
      headSha: git?.headSha ?? "0000000",
      verdict: "ready",
      headline: prNumber ? `${title} — merged (PR #${prNumber})` : `${title} — merged`,
      body: `Landed on the default branch${prNumber ? ` via PR #${prNumber}` : ""}. ${s.prompt}`.trim(),
      openItems: [],
      changedFiles: [],
      spawnSessionId: `recap-${id}`,
      cwd: s.worktreePath,
      model: s.model,
      spawnedAt: now - 2 * 60_000,
      generatedAt: now,
      updatedAt: now,
    };
    world.recaps = { ...world.recaps, [id]: recap };
    return recap;
  },

  /** Spawn a session for the epic child the director just advanced to "running"
   *  (director follow-up to {@link approveEpicNext}). Emits `session:new`. */
  spawnEpicChild(repoPath: string, parent: number): Session | null {
    const epic = world.epics.find((e) => e.repoPath === repoPath && e.parentIssueNumber === parent);
    if (!epic) return null;
    const child = epic.children.find((c) => c.state === "running" && c.sessionId === null);
    if (!child) return null;
    const sid = `epic-${child.number}`;
    const session: Session = {
      ...world.sessions[0],
      id: sid,
      desig: `TASK-${child.number}`,
      name: child.title,
      prompt: child.body,
      repoPath,
      branch: `shepherd/epic-${child.number}`,
      worktreePath: `${repoPath}/.worktrees/${sid}`,
      status: "running",
      lastState: "working",
      readyToMerge: false,
      mergingSince: null,
      mergingTrainId: null,
      autopilotEnabled: null,
      planPhase: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    child.sessionId = sid;
    world.sessions = [...world.sessions, session];
    emit({ event: "session:new", data: session });
    return session;
  },

  /** Set the operator "ready to merge / parked" flag. */
  setReadyToMerge(id: string, ready: boolean): void {
    const s = find(id);
    if (!s) return;
    s.readyToMerge = ready;
    emit({ event: "session:ready", data: { id, ready } });
  },

  /** Approve the epic's next child so it spawns — flips the first eligible child to running. */
  approveEpicNext(repoPath: string, parent: number): Epic | null {
    const epic = world.epics.find((e) => e.repoPath === repoPath && e.parentIssueNumber === parent);
    if (!epic) return null;
    const next = epic.children.find((c) => c.state === "blocked" || c.state === "ready");
    if (next) next.state = "running";
    emit({ event: "epic:update", data: epic });
    return epic;
  },

  /** Spawn a held task → a fresh session joins the herd. */
  spawnHeld(id: string): Session | null {
    const idx = world.held.findIndex((h) => h.id === id);
    if (idx < 0) return null;
    const [task] = world.held.splice(idx, 1);
    const sid = `spawned-${id}`;
    const session: Session = {
      ...world.sessions[0],
      id: sid,
      desig: "TASK-NEW",
      name: `held-${id}`,
      prompt: task.input.prompt,
      repoPath: task.input.repoPath,
      baseBranch: task.input.baseBranch,
      branch: `shepherd/held-${id}`,
      worktreePath: `${task.input.repoPath}/.worktrees/${sid}`,
      status: "running",
      lastState: "running",
      readyToMerge: false,
      mergingSince: null,
      mergingTrainId: null,
      autopilotEnabled: task.input.autopilotEnabled ?? null,
      planPhase: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    world.sessions = [...world.sessions, session];
    emit({ event: "session:new", data: session });
    emit({ event: "held:changed", data: { count: world.held.length } });
    return session;
  },

  /** POST /api/sessions — the New Task create, and the clean-terminal create (the two
   *  arms of `CreateInput`). Mirrors `spawnHeld`: append a fully-defaulted Session and
   *  push it over the socket, so the herd rail and the Viewport pick it up exactly as
   *  they would from the real server. The session is deliberately thin — no seeded git
   *  state, diff or transcript — and every per-session GET already answers an unknown id
   *  with a valid empty record, so each tab renders its empty state instead of erroring. */
  createSession(input: CreateInput): Session {
    const num = nextTaskNumber();
    const session =
      input.terminal === true ? terminalSession(num, input.repoPath) : agentSession(num, input);
    world.sessions = [...world.sessions, session];
    emit({ event: "session:new", data: session });
    return session;
  },

  /** POST /api/projects — the New Project dialog.
   *
   *  Needs a real handler, unlike the Shape/Attach buttons that stay on the router's
   *  permissive tail: `NewProject.svelte` passes this response straight into
   *  `ondone(entry, …)` and the caller reads `entry.path`, so a `{ok:true}` body puts
   *  `undefined` there. The new repo has no branch/issue/config/lens fixtures, and every
   *  one of those getters already falls back to a valid empty value, so it degrades to an
   *  empty-but-working repo rather than a broken one. */
  createProject(name: string, owner: string, createRemote: boolean): RepoEntry {
    const path = `${world.settings.repoRoot.replace(/\/+$/, "")}/${name}`;
    const entry: RepoEntry = {
      name,
      path,
      realPath: path,
      display: path,
      lastUsedAt: Date.now(),
      // Only a repo the operator asked to publish gets a remote slug; a local-only project
      // has none, and every slug-derived link correctly reports null for it.
      ...(createRemote ? { remoteSlug: `${owner || DEMO_VIEWER}/${name}` } : {}),
    };
    world.repos = [...world.repos, entry];
    return entry;
  },

  /** Archive a session — it drops out of the live herd. */
  archiveSession(id: string): void {
    world.sessions = world.sessions.filter((s) => s.id !== id);
    delete world.gitStates[id];
    delete world.activityStates[id];
    delete world.holdStates[id];
    delete world.subagentStates[id];
    delete world.previewStates[id];
    emit({ event: "session:archived", data: { id } });
  },

  /** Apply one settings field (`PUT /api/settings` carries exactly one) and return the body the
   *  real server answers with. The server's `SETTING_PATCHES` handlers each echo only the field
   *  they own — and three of them answer with a different shape, which callers in `api.ts` are
   *  typed against, so the demo mirrors them field by field. Anything else echoes itself.
   *
   *  Unlike the server this never validates: the demo is a stub, and a 400 would only make the
   *  showcase worse. Changes live for the page load — `reset()` re-seeds the world on reload. */
  patchSettings(field: string, value: unknown): Record<string, unknown> {
    // The raw key never round-trips back to the client — the demo stores only the fact.
    if (field === "anthropicApiKey") {
      world.settings.hasApiKey = typeof value === "string" && value.trim().length > 0;
      return { hasApiKey: world.settings.hasApiKey };
    }
    (world.settings as unknown as Record<string, unknown>)[field] = value;
    if (field === "repoRoot") {
      world.settings.repoRootDisplay = String(value);
      return world.settings as unknown as Record<string, unknown>;
    }
    if (field === "authMode") return { authMode: value, hasApiKey: world.settings.hasApiKey };
    return { [field]: value };
  },

  /** Tick / un-tick one materialized post-merge step (Owed lens checkbox). Returns the
   *  updated record, or null if the session/step isn't found (mirrors the real 404). */
  setManualStepDone(sessionId: string, stepId: string, done: boolean): PostMergeSteps | null {
    const rec = world.postMergeSteps.find((r) => r.sessionId === sessionId);
    const step = rec?.steps.find((s) => s.id === stepId);
    if (!rec || !step) return null;
    step.doneAt = done ? Date.now() : null;
    rec.updatedAt = Date.now();
    return rec;
  },

  /** Dismiss a whole post-merge record (Owed lens "clear" button) — marks it cleared so
   *  it drops out of `outstandingManualSteps()`. Returns the updated record. */
  dismissManualSteps(sessionId: string): PostMergeSteps | null {
    const rec = world.postMergeSteps.find((r) => r.sessionId === sessionId);
    if (!rec) return null;
    rec.clearedAt = Date.now();
    rec.updatedAt = rec.clearedAt;
    return rec;
  },

  /** Acknowledge a session's manual operator steps (#1060) — stamp manualStepsAckedAt
   *  idempotently and emit session:manual-steps so the CTA clears (mirrors the server). */
  ackManualSteps(id: string): void {
    const s = find(id);
    if (!s) return;
    s.manualStepsAckedAt ??= Date.now(); // COALESCE — keep the first ack time
    emit({
      event: "session:manual-steps",
      data: { id, manualSteps: s.manualSteps, manualStepsAckedAt: s.manualStepsAckedAt },
    });
  },

  /** Archive every given id that's still merged (the server re-validates, same as
   *  the real API) — clears the herd's "Merged" group. Matches `clearMerged()`'s
   *  `{cleared, leftovers}` in api.ts; each archive emits its own `session:archived`. */
  clearMerged(ids: string[]): { cleared: string[]; leftovers: number } {
    const cleared: string[] = [];
    for (const id of ids) {
      if (world.gitStates[id]?.state === "merged" && find(id)) {
        this.archiveSession(id);
        cleared.push(id);
      }
    }
    return { cleared, leftovers: 0 };
  },
};
