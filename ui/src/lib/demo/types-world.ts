// The single object graph the demo world holds. Every field is typed against the
// real `$lib/types` domain shapes — NEVER a parallel shape — so `tsc` validates the
// seed against exactly what the live UI consumes. `state.ts` deep-clones one of
// these on every `reset()`; `seed.ts` builds a fresh, internally-consistent one.

import type {
  Session,
  GitState,
  SessionActivity,
  SubagentEntry,
  HoldReason,
  Epic,
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
  ActivityEntry,
  DiffResult,
  ScratchListing,
  SessionUsage,
  SlashCommand,
  RepoConfig,
  PostMergeSteps,
  RepoEntry,
  Issue,
  DirListing,
} from "$lib/types";

/** Mirrors `RepoConfigResponse` from `$lib/api` (`RepoConfig` + optimistic-automation
 *  fields) without importing api.ts from the seed layer — keeps seed.ts import-clean. */
export type DemoRepoConfig = RepoConfig & {
  automationConfirmed?: boolean;
  automationRowExists?: boolean;
};

/** Mirrors `BranchList` from `$lib/api` for the same reason `DemoRepoConfig` mirrors
 *  `RepoConfigResponse`: the seed layer stays import-clean of api.ts. */
export interface DemoBranchList {
  branches: string[];
  current: string | null;
  default: string | null;
}

/** The complete seeded demo world — one dataset per bootstrap/lens GET. */
export interface DemoWorld {
  // ── core herd ──────────────────────────────────────────────────────────
  sessions: Session[];
  gitStates: Record<string, GitState>;
  activityStates: Record<string, SessionActivity>;
  claudeAliveStates: Record<string, boolean>;
  workingBlockedStates: Record<string, boolean>;
  holdStates: Record<string, HoldReason>;
  subagentStates: Record<string, SubagentEntry[]>;
  previewStates: Record<string, { previewPort: number | null; serve?: "ok" | "failed" }>;

  // ── session-detail tabs (per-session GETs, Task 8 sibling audit) ─────────
  /** GET /api/sessions/done (Done lens) — archived sessions, distinct from `sessions`. */
  doneSessions: Session[];
  /** GET /api/sessions/:id/activity (Activity tab). */
  activityEntries: Record<string, ActivityEntry[]>;
  /** GET /api/sessions/:id/diff (Diff tab + Activity tab's file-tree section). */
  diffs: Record<string, DiffResult>;
  /** GET /api/sessions/:id/scratchpad (Files tab, root listing only). */
  scratchpad: Record<string, ScratchListing>;
  /** GET /api/sessions/:id/usage (per-session token usage badge). */
  sessionUsage: Record<string, SessionUsage>;
  /** GET /api/repo-config?repo= (automation flags — gates the Build Queue panel + pill). */
  repoConfig: Record<string, DemoRepoConfig>;
  /** GET /api/commands?repo= (slash-command link provider). */
  slashCommands: Record<string, SlashCommand[]>;
  /** GET /api/todo?repo= (To-Do tab gate). */
  todo: Record<string, { exists: boolean; content: string }>;
  /** GET /api/manual-steps/outstanding (Owed lens) — durable post-merge step records. */
  postMergeSteps: PostMergeSteps[];
  /** GET /api/fs/dirs?path= (Settings → Workspace repo-root picker), keyed by the browsed
   *  path. Only the nodes on the way to `settings.repoRoot` are seeded; anything else gets an
   *  empty-but-valid listing from the getter. */
  dirs: Record<string, DirListing>;

  // ── New Task flow (#1800) ───────────────────────────────────────────────
  // Every GET the New Task dialog fires as it opens. These are NOT optional polish:
  // `api.ts` types each response's array field as non-optional, so a `{}` fallthrough
  // assigns `undefined` into a `$state` array and the next `$derived` over it throws
  // INSIDE Svelte's flush — which aborts the whole batch and silently kills unrelated
  // DOM and effects elsewhere in the app. That is the #1800 crash; see repos.svelte.ts.
  /** GET /api/repos — the repo index behind `repos.svelte.ts` and the New Task picker. */
  repos: RepoEntry[];
  /** GET /api/branches?repo= — local branches + current/default, per repo path. */
  branches: Record<string, DemoBranchList>;
  /** GET /api/issues?repo= — open forge issues, per repo path. */
  issues: Record<string, Issue[]>;

  // ── ambient status ─────────────────────────────────────────────────────
  usage: UsageLimitsResponse;
  update: UpdateStatus;
  herdrUpdate: HerdrUpdateStatus;
  codexUpdate: CodexUpdateStatus;
  starPrompt: StarPromptStatus;
  drain: DrainStatus[];
  autoMerge: AutoMergeStatus[];

  // ── lenses / drawers ───────────────────────────────────────────────────
  completedEpics: CompletedEpic[];
  epics: Epic[];
  settings: Settings;
  plugins: PluginInfo[];
  diagnostics: DiagnosticsSnapshot;
  backlog: BacklogPayload;
  buildQueues: Record<string, BuildQueue>;
  held: HeldTask[];
  recaps: Record<string, Recap>;
  reviews: Record<string, ReviewVerdict>;
  planGates: Record<string, PlanGate>;
  upNext: UpNextSnapshot | null;
  steers: Steer[];
  projectIcons: ProjectIcons;
  pendingLearnings: Learning[];
}
