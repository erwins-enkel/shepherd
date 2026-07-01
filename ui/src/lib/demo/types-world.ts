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
} from "$lib/types";

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
