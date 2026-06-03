import type { SessionStore } from "./store";
import type { Session, AutopilotVerdict } from "./types";
import type { BlockReason } from "./blocked";

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

/** Steers autopilot will only consider for these block shapes. menu/stall always surface. */
const STEERABLE_SHAPES = new Set(["awaiting-input", "yes-no"]);

export interface AutopilotDeps {
  store: Pick<SessionStore, "get" | "getRepoConfig" | "setAutopilotState">;
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
  /** Whether the session already has an open PR (critic territory → autopilot stands down). */
  hasOpenPr: (id: string) => boolean;
  /** Fired when autopilot hands a session back for a genuine question / step-cap. */
  onPause: (id: string, question: string) => void;
  stepCap?: number;
}

const DEFAULT_STEP_CAP = 10;
/** Shown when the runaway guard trips rather than a classifier question. */
const CAP_MESSAGE = "Autopilot reached its step limit without opening a PR — over to you.";
/** Generic hand-back text when a question/unknown verdict carries no summary of its own. */
const SURFACE_MESSAGE = "Autopilot paused for your input.";

export class AutopilotService {
  // Re-entrancy guard: classify() is async, so a second event for the same session must
  // not start a second spawn (mirrors ReviewService.starting).
  private pending = new Set<string>();
  private stepCap: number;

  constructor(private deps: AutopilotDeps) {
    this.stepCap = deps.stepCap ?? DEFAULT_STEP_CAP;
  }

  /** Resolve a session's effective autopilot opt-in: override wins; null inherits the repo. */
  private enabled(s: Session): boolean {
    if (s.autopilotEnabled !== null) return s.autopilotEnabled;
    return this.deps.store.getRepoConfig(s.repoPath).autopilotEnabled;
  }

  /** Shared eligibility gate. Returns the session when autopilot should act, else null. */
  private eligible(id: string): Session | null {
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived") return null;
    if (!this.enabled(s)) return null;
    if (s.autopilotPaused) return null; // already handed back; waits for operator
    if (this.deps.hasOpenPr(id)) return null; // PR exists → critic loop owns it
    if (this.pending.has(id)) return null; // a classify is already in flight
    return s;
  }

  /** Hand the session back. `question` is the already-resolved text (caller picks the
   *  right fallback — CAP_MESSAGE for the runaway guard, SURFACE_MESSAGE for a summary-less
   *  classifier verdict). */
  private pause(s: Session, question: string): void {
    this.deps.store.setAutopilotState(s.id, { paused: true, question });
    this.deps.onPause(s.id, question);
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
        this.driveSteer(s, OPEN_PR_STEER);
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
    let tail: string[] = [];
    try {
      tail = this.deps.readTail(id);
    } catch {
      // empty tail still classifies (→ likely "unknown" → surface), which is safe
    }
    await this.consider(id, tail, `autopilot ${id}`);
  }

  /** session:status "running" handler. A paused→running transition is the operator
   *  answering: clear the pause and refresh the step budget. Non-paused running is a no-op
   *  (autopilot's OWN gate-steers resume the agent — those must not reset the cap). */
  onStatus(id: string, status: string): void {
    if (status !== "running") return;
    const s = this.deps.store.get(id);
    if (!s || !s.autopilotPaused) return;
    this.deps.store.setAutopilotState(id, { paused: false, question: null, stepCount: 0 });
  }

  /** A PR opened → hand off to the critic loop. Clear pause + reset the step budget. */
  onPrOpen(id: string): void {
    const s = this.deps.store.get(id);
    if (!s) return;
    this.deps.store.setAutopilotState(id, { paused: false, question: null, stepCount: 0 });
  }
}
