import type { SessionStore } from "./store";
import type { Session, AutopilotVerdict } from "./types";
import type { BlockReason } from "./blocked";
import type { GitState } from "./forge/types";
import { effectiveAutopilot } from "./effective-autopilot";

/**
 * Agent-facing steer templates. NOT UI chrome — never i18n'd (they are typed into the
 * agent's PTY, which is an English Claude Code session). Shepherd owns this text; the
 * classifier never authors pane input, so an untrusted tail can't inject a steer.
 */
export const PROCEED_STEER = [
  "You're in autopilot. Don't stop to ask whether to write specs, plans, or to start",
  "implementing — make a reasonable decision yourself and keep going. Drive the work all",
  "the way to an open pull request. Only stop to ask if you hit a genuine product or",
  "requirements decision that only the user can make.",
].join("\n");

export const OPEN_PR_STEER = [
  "You're in autopilot and you've stopped, but there's no pull request yet. Commit your",
  "work, push the branch, and open a PR (gh pr create). If something genuinely blocks that,",
  "say specifically what you need.",
].join("\n");

export const CI_FIX_STEER = [
  "You're in autopilot and CI is failing on your open pull request. The critic won't review a",
  "red PR, so this is on you: inspect the failing checks (`gh pr checks`, `gh run view --log-failed`),",
  "fix the root cause, and push. Don't stop to ask — only surface if it's a genuine blocker you",
  "can't resolve, and then say exactly what you need.",
].join("\n");

/** Steers autopilot will only consider for these block shapes. menu/stall always surface. */
const STEERABLE_SHAPES = new Set(["awaiting-input", "yes-no"]);

export interface AutopilotDeps {
  store: Pick<SessionStore, "get" | "getRepoConfig" | "setAutopilotState" | "setAutoMergeState">;
  /** Classify why an agent stopped (src/autopilot-llm.classifyStop, pre-bound to herdr+model). */
  classify: (tail: string[], taskPrompt: string, label: string) => Promise<AutopilotVerdict>;
  /** Steer text into the session's live PTY (SessionService.reply). false = didn't land. */
  steer: (id: string, text: string) => boolean;
  /** Resume an exited session so it can be steered (SessionService.resume). truthy = ok. */
  resume: (id: string) => unknown;
  /** Whether the session's herdr pane is currently live. */
  paneAlive: (id: string) => boolean;
  /** Visible terminal tail for a session (herdr.read → tailLines). */
  readTail: (id: string) => string[];
  /** Whether the session already has a PR in any state (open/merged/closed). True → autopilot
   *  stands down (open = critic territory; merged/closed = pre-PR mission over). */
  hasPr: (id: string) => boolean;
  /** Whether this session is in full-auto (autopilot ∧ auto-merge). When true, autopilot does
   *  NOT stand down at PR-open — it keeps unblocking procedural gates so a rebase can finish. */
  fullAuto: (id: string) => boolean;
  /** Kick a fresh PR-status poll (best-effort, fire-and-forget). Called when a session settles
   *  so the `hasPr` snapshot — which otherwise lags on a ~120s cadence — catches a PR the
   *  agent just opened before autopilot redundantly steers it to open one. */
  refreshPr?: (id: string) => void;
  /** Fired when autopilot hands a session back for a genuine question / step-cap. */
  onPause: (id: string, question: string) => void;
  /** Fired when autopilot marks a session complete (non-PR deliverable done). */
  onComplete?: (id: string, summary: string) => void;
  /** Fired after any autopilot-field mutation (pause / clear) so the wiring can emit a live event. */
  onState?: (id: string) => void;
  stepCap?: number;
}

const DEFAULT_STEP_CAP = 10;
/** Shown when the runaway guard trips rather than a classifier question. */
const CAP_MESSAGE = "Autopilot reached its step limit without opening a PR — over to you.";
/** Generic hand-back text when a question/unknown verdict carries no summary of its own. */
const SURFACE_MESSAGE = "Autopilot paused for your input.";
/** Non-alarming hand-back text when a `complete` verdict carries no summary of its own. */
const COMPLETE_MESSAGE = "Autopilot finished — task complete, nothing to open as a PR.";

export class AutopilotService {
  // Re-entrancy guard: classify() is async, so a second event for the same session must
  // not start a second spawn (mirrors ReviewService.starting).
  private pending = new Set<string>();
  // Post-PR CI-red recovery state (onGit). `openSeen` fires the critic handoff (pause-clear +
  // budget reset) exactly once per PR-open, so the 120s git poll doesn't keep zeroing the
  // step budget the CI-fix loop is spending. `ciNudged` maps a session to the head SHA we last
  // steered for a red CI, so a still-failing head isn't re-nudged every poll — only a fresh
  // push (new head) that still fails earns another steer.
  private openSeen = new Set<string>();
  private ciNudged = new Map<string, string>();
  private stepCap: number;

  constructor(private deps: AutopilotDeps) {
    this.stepCap = deps.stepCap ?? DEFAULT_STEP_CAP;
  }

  /** Resolve a session's effective autopilot opt-in: override wins; null inherits the repo. */
  private enabled(s: Session): boolean {
    return effectiveAutopilot(s, this.deps.store.getRepoConfig(s.repoPath).autopilotEnabled);
  }

  /** Shared eligibility gate. Returns the session when autopilot should act, else null. A
   *  session still in its pre-execution planning phase is suppressed: the plan gate owns it
   *  (grill/plan), and autopilot must not classify its stop or drive it to a PR until the gate
   *  releases it into execution. */
  private eligible(id: string): Session | null {
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived") return null;
    if (s.planPhase === "planning") return null; // plan gate owns a planning session; autopilot stands down until it's released into execution
    if (!this.enabled(s)) return null;
    if (s.autopilotPaused) return null; // already handed back; waits for operator
    if (s.autopilotComplete) return null; // terminal: task delivered (non-PR), nothing to drive
    // A PR exists → autopilot normally stands down (critic territory). EXCEPTION: a full-auto
    // session keeps going past the PR so the merge train's rebase steers get unblocked. The
    // open-a-PR steer is still suppressed for any PR (see dispatch), so we never double-open.
    if (this.deps.hasPr(id) && !this.deps.fullAuto(id)) return null;
    if (this.pending.has(id)) return null; // a classify is already in flight
    return s;
  }

  /** Hand the session back. `question` is the already-resolved text (caller picks the
   *  right fallback — CAP_MESSAGE for the runaway guard, SURFACE_MESSAGE for a summary-less
   *  classifier verdict). */
  private pause(s: Session, question: string): void {
    this.deps.store.setAutopilotState(s.id, { paused: true, question });
    this.deps.onPause(s.id, question);
    this.deps.onState?.(s.id);
  }

  /** Mark the session complete — a clean terminal state for a non-PR deliverable. `summary`
   *  is the resolved hand-back text (caller supplies COMPLETE_MESSAGE when the verdict has
   *  none). Distinct from pause: it reads as "done", not "needs a decision". */
  private markComplete(s: Session, summary: string): void {
    this.deps.store.setAutopilotState(s.id, { complete: true, question: summary });
    this.deps.onComplete?.(s.id, summary);
    this.deps.onState?.(s.id);
  }

  private bump(s: Session): void {
    this.deps.store.setAutopilotState(s.id, { stepCount: s.autopilotStepCount + 1 });
  }

  /** Steer `text` into the session, resuming an exited pane first. Bumps the step on a
   *  landed steer. Returns nothing — best-effort; a dead/unreachable pane just doesn't count. */
  private driveSteer(s: Session, text: string): void {
    if (!this.deps.paneAlive(s.id)) {
      // Exited pane: resume so there's something to steer. resume() returns falsy when it
      // can't (archived / no pinned session id) — then there's nothing to do.
      if (!this.deps.resume(s.id)) return;
    }
    if (this.deps.steer(s.id, text)) this.bump(s);
  }

  private dispatch(s: Session, v: AutopilotVerdict): void {
    switch (v.kind) {
      case "gate":
        this.driveSteer(s, PROCEED_STEER);
        return;
      case "finished":
        if (this.deps.hasPr(s.id)) return; // PR already open → nothing to do (full-auto rebase is steered by the merge train)
        this.driveSteer(s, OPEN_PR_STEER);
        return;
      case "complete":
        this.markComplete(s, v.summary || COMPLETE_MESSAGE);
        return;
      default: // "question" | "unknown" → bias to surface
        this.pause(s, v.summary || SURFACE_MESSAGE);
    }
  }

  /** Core: classify a settled session's tail and act. `tail` is the terminal context. */
  private async consider(id: string, tail: string[], label: string): Promise<void> {
    const s = this.eligible(id);
    if (!s) return;
    if (s.autopilotStepCount >= this.stepCap) {
      this.pause(s, CAP_MESSAGE); // runaway guard
      return;
    }
    this.pending.add(id);
    let v: AutopilotVerdict;
    try {
      v = await this.deps.classify(tail, s.prompt, label);
    } finally {
      this.pending.delete(id);
    }
    // Re-check: the session may have changed (archived / toggled off / paused / PR opened)
    // during the classify await.
    const cur = this.eligible(id);
    if (!cur) return;
    this.dispatch(cur, v);
  }

  /** session:block handler. Only steerable shapes are eligible; menu/stall surface as-is. */
  async onBlock(id: string, block: BlockReason | null): Promise<void> {
    if (!block || !STEERABLE_SHAPES.has(block.shape)) return;
    await this.consider(id, block.tail, `autopilot ${id}`);
  }

  /** session:status "done" handler — agent exited / idled. Read its tail and classify;
   *  a `finished` verdict drives it to a PR (resuming the pane if needed). */
  async onDone(id: string): Promise<void> {
    // Kick a PR refresh up front: an agent that just ran `gh pr create` then idled may not
    // be in the cached PR snapshot yet. Firing it here puts the poll in flight during the
    // (multi-second) classify spawn, so the post-classify eligible()/hasPr re-check in
    // consider() sees the fresh PR and stands down instead of redundantly steering "open a PR".
    this.deps.refreshPr?.(id);
    let tail: string[] = [];
    try {
      tail = this.deps.readTail(id);
    } catch {
      // empty tail still classifies (→ likely "unknown" → surface), which is safe
    }
    await this.consider(id, tail, `autopilot ${id}`);
  }

  /** session:status "running" handler. A paused→running or complete→running transition is the
   *  operator re-engaging the session: clear the hand-back and refresh the step budget. Running
   *  while neither paused nor complete is a no-op (autopilot's OWN gate-steers resume the agent —
   *  those must not reset the cap).
   *  Known limitation: a manual operator steer while the loop is active-but-NOT-paused also
   *  produces "running" and is indistinguishable from autopilot's own steer here, so it does
   *  NOT refresh the budget — a slight deviation from the design's "reset on manual intervene".
   *  The cap still resets on PR-open (onPrOpen) and on answering a pause, which covers the
   *  cases that matter; conflating the two would let the cap never bite. */
  onStatus(id: string, status: string): void {
    if (status !== "running") return;
    const s = this.deps.store.get(id);
    if (!s || (!s.autopilotPaused && !s.autopilotComplete)) return;
    this.deps.store.setAutopilotState(id, {
      paused: false,
      complete: false,
      question: null,
      stepCount: 0,
    });
    this.deps.store.setAutoMergeState(id, { rebaseCount: 0, rebaseHead: null });
    this.deps.onState?.(id);
  }

  /** The critic handoff: clear pause + complete + reset the step budget. Invoked once per PR-open
   *  by onGit (for a non-red PR) — the single place this transition is applied. */
  onPrOpen(id: string): void {
    const s = this.deps.store.get(id);
    if (!s) return;
    this.deps.store.setAutopilotState(id, {
      paused: false,
      complete: false,
      question: null,
      stepCount: 0,
    });
    this.deps.onState?.(id);
  }

  /** session:git handler. Two jobs, both keyed off the PR's live state:
   *  1. PR-open transition (none/closed → open): hand off to the critic loop once (onPrOpen).
   *  2. Open PR with FAILING CI: the dead zone — the critic only reviews a green PR and pre-PR
   *     autopilot has stood down (a PR exists), so nobody steers a red PR. Drive the task agent
   *     to fix its own CI. Replaces the old `if (open) onPrOpen` wiring in index.ts. */
  onGit(id: string, git: GitState): void {
    if (git.state !== "open") {
      // PR gone (none/merged/closed): drop the per-PR dedup so a future PR-open re-arms both
      // the handoff reset and the CI-fix nudge.
      this.openSeen.delete(id);
      this.ciNudged.delete(id);
      return;
    }
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived" || !this.enabled(s)) return;
    if (!this.openSeen.has(id)) {
      this.openSeen.add(id);
      // Critic handoff (the single handoff path: onPrOpen), once per PR-open — clear pause + reset
      // the step budget for the post-PR phase. Gated on NOT being paused: openSeen is in-memory,
      // so after a restart the first poll of an already-open PR re-enters here; a deliberate pause
      // (operator hand-back or a CI-fix cap pause, on a PR whose CI may since have gone green) must
      // survive that, not be silently cleared. A red PR is skipped for the same reason and keeps
      // its persisted CI-fix budget below.
      if (git.checks !== "failure" && !s.autopilotPaused) this.onPrOpen(id);
    }
    if (git.checks === "failure") this.considerCi(s, git);
  }

  /** Open PR + red CI → steer the task agent to fix it. Synchronous (no classify needed: a red
   *  rollup is already an actionable verdict). The caller (onGit) has already checked
   *  existence / archive / enablement; here we gate on pause + per-head dedup and bound it by
   *  the same step cap as the gate loop. */
  private considerCi(s: Session, git: GitState): void {
    if (s.autopilotPaused) return; // already handed back; waits for operator
    if (this.pending.has(s.id)) return; // a classify (gate/done path) is mid-flight
    if (!git.headSha) return; // can't dedup a headless rollup → skip rather than spam
    if (this.ciNudged.get(s.id) === git.headSha) return; // already nudged this exact red head
    if (s.autopilotStepCount >= this.stepCap) {
      this.pause(s, CAP_MESSAGE); // runaway guard — stop thrashing CI, surface to operator
      return;
    }
    this.ciNudged.set(s.id, git.headSha);
    this.driveSteer(s, CI_FIX_STEER);
  }
}
