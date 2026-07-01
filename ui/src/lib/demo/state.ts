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
  PrStatus,
  WsEvent,
} from "$lib/types";
import { bus } from "./bus";
import { buildSeed } from "./seed";
import type { DemoWorld } from "./types-world";

// A canonical, never-mutated seed. Every `reset()` `structuredClone`s from THIS, so
// live mutations can never leak back into the seed and a reset always restores clean.
const SEED: DemoWorld = buildSeed();

let world: DemoWorld = structuredClone(SEED);

// Task 6: director registers reset hook here — `reset()` invokes each so the liveness
// engine can stop/restart its timers without state.ts importing director (no cycle).
const resetHooks: Array<() => void> = [];

function emit(ev: WsEvent): void {
  bus.emit(ev);
}

function find(id: string): Session | undefined {
  return world.sessions.find((s) => s.id === id);
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
  herdDigest: (): HerdDigest | null => world.herdDigest,
  upNext: (): UpNextSnapshot | null => world.upNext,
  steers: (): Steer[] => world.steers,
  projectIcons: (): ProjectIcons => world.projectIcons,
  pendingLearnings: (): Learning[] => world.pendingLearnings,

  /** Merged, non-archived session ids — for the "Clear merged" confirm modal.
   *  Matches `getMergedClearable()`'s `{ids, leftovers}` in api.ts exactly; the demo
   *  has no real leftover subprocesses, so the count is always 0. */
  mergedClearable: (): { ids: string[]; leftovers: number } => ({
    ids: world.sessions.filter((s) => world.gitStates[s.id]?.state === "merged").map((s) => s.id),
    leftovers: 0,
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

  /** Trigger an on-demand plan review — the reviewing latch lights up. */
  reviewPlan(id: string): void {
    emit({ event: "session:plangate-reviewing", data: { id, reviewing: true } });
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
