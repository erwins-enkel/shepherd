import type { SessionStore } from "./store";
import type { Session, AutopilotVerdict } from "./types";
import type { BlockReason } from "./blocked";
import type { GitState } from "./forge/types";
import { effectiveAutopilot } from "./effective-autopilot";
import { DRAFT_PR_NOTE } from "./service";

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

/** Proceed steer for a RESEARCH session in autopilot — like PROCEED_STEER but with NO
 *  pull-request framing; research delivers a report PR or a GitHub issue, never a code PR. */
export const RESEARCH_PROCEED_STEER = [
  "You're in autopilot on a research task. Don't stop to ask whether to proceed —",
  "make a reasonable decision yourself and keep going. Finish by delivering your research",
  "report PR or a GitHub issue. Only stop to ask if you hit a genuine product or",
  "requirements decision that only the user can make.",
].join("\n");

/** Agent-facing directive injected into an epic child's spawn prompt: its PR must target the
 *  epic integration branch, not the default branch. Shepherd owns this text (never i18n'd). */
export function epicBaseDirective(baseBranch: string): string {
  return [
    `This task is part of an epic. When you open the pull request, it MUST target the epic`,
    `integration branch \`${baseBranch}\` as its base — open it with`,
    `\`gh pr create --base ${baseBranch} ...\`. Do NOT open it against the default branch.`,
  ].join(" ");
}

/** Returns the open-PR steer for a session whose PR base is `baseBranch`, appending the
 *  draft-mode note when `draftMode` is true. The explicit `--base` keeps a session that opens
 *  its PR from the steer (rather than proactively) targeting the right branch — load-bearing for
 *  epic children whose base is the integration branch, harmless/correct for regular sessions
 *  (base = default branch). */
export function openPrSteer(draftMode: boolean, baseBranch: string): string {
  const steer = [
    "You're in autopilot and you've stopped, but there's no pull request yet. Commit your",
    `work, push the branch, and open a PR (gh pr create --base ${baseBranch}). If something`,
    "genuinely blocks that, say specifically what you need.",
  ].join("\n");
  return draftMode ? `${steer} ${DRAFT_PR_NOTE}` : steer;
}

export const CI_FIX_STEER = [
  "You're in autopilot and CI is failing on your open pull request. The critic won't review a",
  "red PR, so this is on you: inspect the failing checks (`gh pr checks`, `gh run view --log-failed`),",
  "fix the root cause, and push. Don't stop to ask — only surface if it's a genuine blocker you",
  "can't resolve, and then say exactly what you need.",
].join("\n");

/** Agent-facing steer when a drain session reports complete but produced NO diff and NO PR. NOT UI
 *  chrome — typed into the agent PTY, never i18n'd (Shepherd owns this text). */
export const EMPTY_COMPLETION_STEER = [
  "You're in autopilot and you reported the task complete, but there's no committed diff against the",
  "base branch and no pull request — nothing was actually produced. Either do the work and commit it",
  "(then open a PR if the task calls for one), or if the task genuinely required no code change, say",
  "precisely why so a human can confirm.",
].join("\n");

/** Hand-back text when the empty-completion gate gives up after its one re-prompt and routes the
 *  session to a human. Plain English, mirrors CAP_MESSAGE/COMPLETE_MESSAGE (stored as the
 *  autopilotQuestion hand-back summary). */
export const EMPTY_COMPLETION_MESSAGE =
  "Autopilot reported the task complete but produced no changes and no PR — over to you.";

/** Steers autopilot will only consider for these block shapes. menu/stall always surface. */
const STEERABLE_SHAPES = new Set(["awaiting-input", "yes-no"]);

export interface AutopilotDeps {
  store: Pick<
    SessionStore,
    "get" | "list" | "getRepoConfig" | "setAutopilotState" | "setAutoMergeState"
  >;
  /** Classify why an agent stopped (src/autopilot-llm.classifyStop, pre-bound to herdr+model). */
  classify: (tail: string[], taskPrompt: string, label: string) => Promise<AutopilotVerdict>;
  /** Steer text into the session's live PTY (SessionService.reply). false = didn't land. */
  steer: (id: string, text: string) => boolean;
  /** Resume an exited session so it can be steered (SessionService.resume, async — the
   *  awaited result decides). truthy resolved value = ok. */
  resume: (id: string) => unknown;
  /** Whether the session's herdr pane is currently live. */
  paneAlive: (id: string) => boolean;
  /** Visible terminal tail for a session (herdr.read → tailLines). */
  readTail: (id: string) => string[];
  /** Whether the session already has a PR in any state (open/merged/closed). True → autopilot
   *  stands down (open = critic territory; merged/closed = pre-PR mission over). */
  hasPr: (id: string) => boolean;
  /** Deterministic completion verifier: true when the session's branch has a committed diff vs its
   *  base (no LLM, no fetch). Paired with hasPr to answer "did anything happen" before autopilot
   *  accepts a `complete` verdict for a drain session. */
  hasDiff: (id: string) => Promise<boolean>;
  /** Register a lightweight (local) session's pseudo-PR server-side. Replaces the forge-mode
   *  open-a-PR steer for a `lightweight` repo: the agent has no `gh`, so the deliberate
   *  completion barrier runs here instead of being typed into the PTY. Best-effort — the
   *  wiring guards a rejection so a failure never crashes the autopilot tick. */
  openLocalPr: (id: string) => Promise<void>;
  /** The cached PR snapshot for a session (the PR poller's last poll), or null when there is
   *  none. The recurring tick reads this directly — NOT off a `session:git` emit — so it can
   *  re-engage an idle agent stuck on an UNCHANGED open+red head, the case the event-driven
   *  `onGit`/`considerCi` path structurally cannot reach (the poller only emits on a state change). */
  prGit: (id: string) => GitState | null;
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
/** Shown when the pre-PR runaway guard trips rather than a classifier question. */
const CAP_MESSAGE = "Autopilot reached its step limit without opening a PR — over to you.";
/** Hand-back when the post-PR CI-fix loop exhausts its step budget. Distinct from CAP_MESSAGE:
 *  on the CI path a PR is already open, so "without opening a PR" would be wrong. */
export const CI_CAP_MESSAGE =
  "Autopilot couldn't get CI green after repeated attempts — over to you.";
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
  // steered for a red CI: onGit/considerCi handles only red-CI STATE CHANGES (none→red, and a
  // new-but-still-red head after a push), so a still-failing UNCHANGED head isn't re-nudged on
  // every poll. Sustained idle re-engagement on that unchanged red head — which onGit cannot
  // deliver (the poller emits no `session:git` without a state change) — is owned by tick().
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

  /** Empty-completion handler (#1009): the session reported complete with no diff and no PR. Re-prompt
   *  the agent exactly once (bounded by the persisted completionRepromptCount), then hand it to a
   *  human rather than silently filing it as done. */
  private async handleEmptyCompletion(s: Session): Promise<void> {
    if (s.completionRepromptCount >= 1) {
      this.pause(s, EMPTY_COMPLETION_MESSAGE); // re-prompt already spent → needs-human
      return;
    }
    this.deps.store.setAutopilotState(s.id, { completionReprompt: s.completionRepromptCount + 1 });
    await this.driveSteer(s, EMPTY_COMPLETION_STEER);
  }

  /** Send `text` into the session, resuming an exited pane first. Returns whether the steer
   *  landed; does NOT bump the step (the caller decides whether the attempt counts). */
  private async sendSteer(s: Session, text: string): Promise<boolean> {
    if (!this.deps.paneAlive(s.id)) {
      // Exited pane: resume so there's something to steer. resume() resolves falsy when it
      // can't (archived / no pinned session id) — then there's nothing to do.
      if (!(await this.deps.resume(s.id))) return false;
    }
    return this.deps.steer(s.id, text);
  }

  /** Steer `text` into the session and bump the step on a landed steer. Best-effort —
   *  a dead/unreachable pane just doesn't count. */
  private async driveSteer(s: Session, text: string): Promise<void> {
    if (await this.sendSteer(s, text)) this.bump(s);
  }

  private async dispatch(s: Session, v: AutopilotVerdict): Promise<void> {
    switch (v.kind) {
      case "gate":
        await this.driveSteer(s, s.research ? RESEARCH_PROCEED_STEER : PROCEED_STEER);
        return;
      case "finished":
        if (this.deps.hasPr(s.id)) return; // PR already open → nothing to do (full-auto rebase is steered by the merge train)
        if (s.research) {
          // Research sessions never open a code PR — mark complete instead of steering open-a-PR.
          this.markComplete(s, v.summary || COMPLETE_MESSAGE);
          return;
        }
        if (this.deps.store.getRepoConfig(s.repoPath).repoMode === "lightweight") {
          // Lightweight repo: the agent has no `gh`, so register the pseudo-PR server-side
          // (the deliberate completion barrier) instead of steering `gh pr create`.
          await this.deps.openLocalPr(s.id);
          return;
        }
        await this.driveSteer(
          s,
          openPrSteer(this.deps.store.getRepoConfig(s.repoPath).draftMode, s.baseBranch),
        );
        return;
      case "complete": {
        // Pre-completion verification gate (#1009): for a DRAIN/auto session, don't accept "done"
        // unless something actually happened — a committed diff or an associated PR. The check is
        // deterministic (no LLM). Attended sessions are exempt: a non-code `complete` (issue
        // creation / one-off answer) is legitimate there and must not be false-flagged.
        if (s.auto && !this.deps.hasPr(s.id)) {
          const empty = !(await this.deps.hasDiff(s.id));
          // hasDiff is async — re-read the session and PR state after the await (it may have been
          // archived / toggled off, or a PR may have appeared during the await).
          const cur = this.deps.store.get(s.id);
          if (!cur || cur.status === "archived") return;
          if (empty && !this.deps.hasPr(cur.id)) {
            await this.handleEmptyCompletion(cur);
            return;
          }
          this.markComplete(cur, v.summary || COMPLETE_MESSAGE);
          return;
        }
        this.markComplete(s, v.summary || COMPLETE_MESSAGE);
        return;
      }
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
    await this.dispatch(cur, v);
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
    // Stuck-red full-auto: re-engage the CI-fix loop and stand down BEFORE classifying. The LLM
    // classifier could otherwise mark this idle red session complete/finished (silencing it AND
    // making the tick skip it, since complete/paused sessions are ineligible). Lower latency than
    // waiting for the next tick. reEngageCi returns true when it owned the session (steered/paused).
    if (this.reEngageCi(id)) return;
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
      completionReprompt: 0,
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
      completionReprompt: 0,
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

  /** Open PR + red CI → steer the task agent to fix it. The responsive FIRST-RESPONSE to a
   *  red-CI STATE CHANGE only (none→red, or a new-but-still-red head after a push): it's reachable
   *  solely via onGit, which the poller fires only on a state change, so it cannot re-fire on an
   *  unchanged red head — sustained idle re-engagement on that is owned by tick(). Synchronous (no
   *  classify needed: a red rollup is already an actionable verdict). The caller (onGit) has already
   *  checked existence / archive / enablement; here we gate on pause + per-head dedup and bound it
   *  by the same step cap as the gate loop.
   *  Merge-train stand-down: while the session is merge-train-marked (`mergingSince !== null`) the
   *  train owns it and is steering its own rebase — the CI-fix loop must not double-steer, so this
   *  returns immediately. The gate/classify path stays alive (so a procedural prompt won't stall
   *  the rebase); only this CI-fix entry point stands down. The mark is kept fresh by the 60s
   *  sweepStaleMerging. */
  private considerCi(s: Session, git: GitState): void {
    if (s.mergingSince !== null) return; // merge train owns this session; don't double-steer its rebase
    if (s.autopilotPaused) return; // already handed back; waits for operator
    if (this.pending.has(s.id)) return; // a classify (gate/done path) is mid-flight
    if (!git.headSha) return; // can't dedup a headless rollup → skip rather than spam
    if (this.ciNudged.get(s.id) === git.headSha) return; // already nudged this exact red head
    if (s.autopilotStepCount >= this.stepCap) {
      this.pause(s, CI_CAP_MESSAGE); // runaway guard — stop thrashing CI, surface to operator
      return;
    }
    this.ciNudged.set(s.id, git.headSha);
    // Fire-and-forget (the caller chain onGit→considerCi is sync). driveSteer's best-effort
    // only covers falsy returns, not throws — resume() can reject (herdr down on the
    // dead-pane path) and onGit's chain has no catch, so net rejections here.
    void this.driveSteer(s, CI_FIX_STEER).catch((err) =>
      console.warn("[autopilot] ci-fix steer:", err),
    );
  }

  /** Re-engage an idle full-auto session stuck on an open+red PR, or hand it back at the cap.
   *  This is the event-INDEPENDENT recovery: it reads the cached PR snapshot directly (prGit),
   *  so it works even when no `session:git` re-emits (unchanged red head). Returns true when it
   *  OWNED the session (re-engaged or paused), so onDone can short-circuit before classifying.
   *  Returns false for any ineligible session (no PR / green / pending / paused / complete /
   *  autopilot-off / non-full-auto), leaving it untouched.
   *  Merge-train stand-down: while the session is merge-train-marked (`mergingSince !== null`) the
   *  train owns it and steers its own rebase. We CLAIM ownership (return true) so onDone
   *  short-circuits BEFORE classify — but we do NOT steer/bump/pause. Returning true (not false) is
   *  load-bearing: a false return would let the LLM classifier run on a marked, stuck-red full-auto
   *  session and possibly mark it complete/paused, a terminal state that would SURVIVE the mark
   *  clearing (reEngageCi/considerCi/eligible all reject complete/paused), wedging the CI-fix loop
   *  shut. Claiming-but-not-acting leaves no state that outlives the mark, so the loop auto-resumes
   *  once the train clears it. The guard sits before the step-cap branch (which calls pause()) so a
   *  marked session is never paused either. The mark is kept fresh by the 60s sweepStaleMerging. */
  private reEngageCi(id: string): boolean {
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived") return false;
    if (s.mergingSince !== null) return true; // merge train owns this session: claim it so onDone short-circuits BEFORE classify, but don't steer/bump/pause — that state must not survive mark-clear
    if (!this.enabled(s)) return false;
    if (s.autopilotPaused) return false; // already handed back; waits for operator
    if (s.autopilotComplete) return false; // terminal
    if (this.pending.has(id)) return false; // a classify (onDone/onBlock) is mid-flight — its dispatch will act; don't race it
    if (!this.deps.fullAuto(id)) return false; // only full-auto owns the post-PR CI loop
    const git = this.deps.prGit(id);
    if (!git || git.state !== "open" || git.checks !== "failure") return false;
    // Cap check BEFORE any bump/steer: at the budget, hand back instead of thrashing CI.
    if (s.autopilotStepCount >= this.stepCap) {
      this.pause(s, CI_CAP_MESSAGE);
      return true;
    }
    // Count the attempt toward the cap regardless of whether the steer lands, so a
    // dead/unresumable pane still marches to the cap → guaranteed clean hand-back.
    // The only "agent is working" guard is the caller's status filter (tick's running/blocked
    // skip). A steer takes a moment to flip the agent to "running", so a tick (or an onDone
    // racing a just-fired considerCi steer) inside that gap can re-bump the same idle head: the
    // step budget can burn slightly faster than one attempt per idle episode. That's harmless
    // (the steer coalesces at the PTY) and bounded by the cap — it only ever hastens the clean
    // hand-back, never a silent hang.
    this.bump(s);
    void this.sendSteer(s, CI_FIX_STEER).catch((err) =>
      console.warn("[autopilot] ci re-engage steer:", err),
    );
    return true;
  }

  /** Recurring re-engagement sweep (driven by a ~30s setInterval in index.ts). Iterates all
   *  sessions and re-engages the idle ones stuck on a red PR. A timer fires regardless of events,
   *  so it is the one trigger that reliably re-fires while an agent idles on an UNCHANGED red head
   *  — the case onGit/considerCi provably cannot reach. Only the idle filter lives here (status
   *  done/idle, i.e. NOT running/blocked — mirrors the active grouping at poller.ts:314); all
   *  eligibility/red/full-auto checks live inside reEngageCi. */
  async tick(): Promise<void> {
    for (const s of this.deps.store.list()) {
      if (s.status === "archived") continue;
      if (s.status === "running" || s.status === "blocked") continue; // working — don't interrupt
      this.reEngageCi(s.id);
    }
  }
}
