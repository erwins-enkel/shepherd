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
  HerdDigest,
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
} from "$lib/types";

/** Mirrors `RepoConfigResponse` from `$lib/api` (`RepoConfig` + optimistic-automation
 *  fields) without importing api.ts from the seed layer — keeps seed.ts import-clean. */
export type DemoRepoConfig = RepoConfig & {
  automationConfirmed?: boolean;
  automationRowExists?: boolean;
};

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
  herdDigest: HerdDigest | null;
  upNext: UpNextSnapshot | null;
  steers: Steer[];
  projectIcons: ProjectIcons;
  pendingLearnings: Learning[];
}
