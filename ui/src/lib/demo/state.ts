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
  ActivityEntry,
  DiffResult,
  ScratchListing,
  SessionUsage,
  SlashCommand,
  Leftover,
  PostMergeSteps,
} from "$lib/types";
import { bus } from "./bus";
import { buildSeed } from "./seed";
import type { DemoWorld, DemoRepoConfig } from "./types-world";

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
  /** GET /api/sessions/:id/leftovers — the demo never leaves real subprocesses running. */
  leftovers: (): Leftover[] => [],
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
