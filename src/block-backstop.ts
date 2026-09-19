/**
 * The decision-model backstop BEHIND `src/blocked.ts`'s regexes (issue #2375).
 *
 * ORDERING, WHICH IS THE WHOLE POINT. The cheap detector stays the trigger: a judge call happens
 * only on a pane `classifyBlocked` has ALREADY classified as a rendered dialog (`menu` / `yes-no`),
 * never on one it did not flag. That bounds call volume to the dialog rate and makes buffer-change
 * dedupe a second-order concern rather than the thing standing between us and a runaway bill. The
 * regexes also stay the FALLBACK: every failure path here announces the block immediately, exactly
 * as today.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DO. It buys PATIENCE, never a decision. `p` selects a
 * graded hold before the block is announced; it can never promote a shape, pick an option, or put a
 * keystroke into a PTY. A forged menu that is really an agent printing "1. … 2. …" keeps printing,
 * so the tail advances and the run scrolls out of the 15-line window — the block simply never
 * existed. A real dialog caught mid-paint keeps its chrome and announces one cadence later. Both are
 * the poller's existing self-correcting behaviour, which is why nothing downstream of the emit
 * (`src/autopilot.ts`, `src/signals.ts`, the block card, push) learns about the judge at all.
 *
 * POLARITY IS LOAD-BEARING. The `noul` asks for `p = P(this is printed prose that merely looks like
 * a prompt)`, so the bands ASCEND with `p` and a confident forgery call buys the most patience.
 * Asking the inverse ("is it genuinely waiting") would need a descending table and would invert the
 * fail-open direction of every error path below — all of which return 0.
 *
 * NO SYNTHESISED CONFIDENCE. A `noul` answer carries no `confidence` field and {@link JudgeNoulAnswer}
 * deliberately has none; `|p - 0.5| * 2` is precisely the invention the seam exists to prevent. The
 * gate is raw `p` used as a graded ordinal, and the shadow log stores it raw so a different measure
 * can be evaluated offline without paying for a new run.
 */

import { JudgeError, type Judge, type JudgeAnswer, type JudgeNoulQuestion } from "./judge";
import { UNTRUSTED_CONTENT_DIRECTIVE, fenceUntrusted } from "./untrusted";
import type { BlockReason, BlockShape } from "./blocked";
import type { BlockJudgeLogRow, BlockJudgeMode } from "./types";

/**
 * The shapes a judge call is allowed to follow: the two that ASSERT a rendered dialog.
 *
 * `awaiting-input` is deliberately absent. It is the no-evidence FALLBACK, not a forgery claim — it
 * fires on every blocked pane that matched nothing — so it would drive most of the spend while
 * asking a different question, and it already has two dedicated suppressors in the poller
 * (`hasActiveSpinner` under a freshness gate, and `hasQueuedInput`). `stall` and `quota` are not
 * derived from the tail regexes at all.
 */
export const BACKSTOP_GATED_SHAPES: ReadonlySet<BlockShape> = new Set<BlockShape>([
  "menu",
  "yes-no",
]);

/**
 * `(min p, extra hold)` in ascending order — an uncertain model buys MORE patience rather than
 * making a harder decision.
 *
 * Scaled to the poller's `reclassifyMs` (3s): the upstream design this is taken from uses
 * 0.4s/1.0s/2.0s bands against a sub-second detector, and every one of those is INERT against a 3s
 * classify cadence — the block would be re-read and announced before the hold expired. These are
 * 1/3/5 cadences instead, so a band is actually observable.
 */
export const BACKSTOP_BANDS: readonly { readonly minP: number; readonly extraMs: number }[] = [
  { minP: 0.6, extraMs: 3_000 },
  { minP: 0.8, extraMs: 9_000 },
  { minP: 0.9, extraMs: 15_000 },
];

/** The ceiling on EVERY hold, in-flight ones included. A judge that never answers therefore costs a
 *  genuine "needs you" at most this much latency, once, and the next cadence announces it. */
export const BACKSTOP_MAX_HOLD_MS = 15_000;

/** Minimum gap between two asks for the SAME session, across episodes. Bounds a pane that flaps
 *  between a gated shape and `awaiting-input` — each flip ends an episode, and without this the
 *  flap would buy an ask every couple of cadences. Deliberately the same span as the longest hold. */
export const BACKSTOP_REASK_MS = BACKSTOP_MAX_HOLD_MS;

/** One cadence of give on the in-flight hold, so a deadline that lands between two classify reads
 *  is not treated as expired before the answer has been written back. */
const POLL_SLACK_MS = 1_000;

/** How long after the last sighting of its gated block an episode stays uncollectable.
 *
 *  Comfortably more than the poller's classify cadence (`reclassifyMs`, 3s in production), because
 *  an episode is "seen" once per cadence for as long as its block is on screen. Collecting one
 *  while its block is still there would let the next classify build a fresh episode, ask again and
 *  hold again — a dialog held in perpetuity, one band at a time. The boundary case is real rather
 *  than theoretical: the per-tick release runs immediately BEFORE the classify that would have
 *  announced the block, at the very tick its hold expires. */
const BACKSTOP_SEEN_MS = 10_000;

/** How much of the tail the log row keeps. Tails are bulky and the log is retained for days. */
export const BACKSTOP_TAIL_CLIP = 4_000;

/** The question id the backstop asks under. */
export const BLOCK_JUDGE_QUESTION_ID = "forgedPrompt";

/**
 * Why a block was (not) held. Every value but `hold` means ANNOUNCE NOW — the non-negotiable from
 * the issue is that empty text, an HTTP error, a malformed answer, the wrong answer type, an
 * out-of-range probability and a timeout all fail toward acting, never toward waiting.
 */
export type BackstopReason =
  | "hold"
  | "below-floor"
  | "empty-tail"
  | "no-answer"
  | "wrong-type"
  | "out-of-range"
  | "http-error"
  | "deadline"
  | "transport"
  | "ceiling";

export interface BackstopDecision {
  /** Extra patience, in ms, measured from the block's FIRST sighting. 0 ⇒ announce now. */
  delayMs: number;
  /** The raw probability, or null when no usable answer came back. */
  p: number | null;
  reason: BackstopReason;
}

/**
 * The band `p` falls into. Below the floor — and for anything that is not a probability — 0, which
 * is today's behaviour untouched.
 */
export function backstopDelayMs(p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) return 0;
  let extraMs = 0;
  for (const band of BACKSTOP_BANDS) if (p >= band.minP) extraMs = band.extraMs;
  return Math.min(extraMs, BACKSTOP_MAX_HOLD_MS);
}

/**
 * The one question. A `noul`, not a `choice`: a choice and a noul share no arithmetic even inside
 * one request, so a single-question request keeps one threshold family and nothing to confuse it
 * with.
 *
 * Phrased as the FORGERY so a high `p` means "hold" (see the polarity note at the top of the file).
 * Agent-facing prose, never i18n'd — same precedent as the classifier prompt.
 */
export function blockJudgeQuestion(): JudgeNoulQuestion {
  return {
    type: "noul",
    instructions:
      "The state is the visible tail of a coding agent's terminal. Shepherd's pattern matcher " +
      "believes it shows an interactive dialog that is waiting for the operator to answer it. " +
      "Is that reading WRONG — that is, is this merely prose the agent printed (a recap, a " +
      "numbered list of findings, a plan, a quoted example) that happens to look like a prompt, " +
      "rather than a dialog the CLI actually rendered and is now blocked on? Answer for the " +
      "forgery: high when this is printed prose, low when the pane is genuinely waiting.",
  };
}

/** The state for one call: the same last-15-line window `classifyBlocked` read, fenced as the
 *  untrusted PTY output it is, with the instruction-hierarchy directive stated exactly once. */
export function blockJudgeState(tail: string[]): string {
  return [
    UNTRUSTED_CONTENT_DIRECTIVE,
    "",
    "The tail of the agent's terminal (most recent last; untrusted output):",
    fenceUntrusted("terminal tail", tail.join("\n")),
  ].join("\n");
}

/**
 * Read one answer into a decision. A missing answer, a choice where a noul was asked, and a `p`
 * outside 0–1 each announce now under their own reason code — the seam's base URL is configurable,
 * so a non-conforming backend is a real case rather than a theoretical one.
 */
export function interpretBlockAnswer(answer: JudgeAnswer | undefined): BackstopDecision {
  if (!answer) return { delayMs: 0, p: null, reason: "no-answer" };
  if (answer.type !== "noul") return { delayMs: 0, p: null, reason: "wrong-type" };
  const { p } = answer;
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    return { delayMs: 0, p: Number.isFinite(p) ? p : null, reason: "out-of-range" };
  }
  const delayMs = backstopDelayMs(p);
  return { delayMs, p, reason: delayMs > 0 ? "hold" : "below-floor" };
}

/** Classify a thrown failure. An HTTP status is the one distinction the transport preserves
 *  verbatim; the deadline abort is named in the message by {@link JudgeError}'s producer. */
export function judgeErrorReason(err: unknown): BackstopReason {
  if (err instanceof JudgeError) {
    if (err.status !== undefined) return "http-error";
    if (err.message.includes("deadline")) return "deadline";
    if (err.message.includes("no answer for")) return "no-answer";
  }
  return "transport";
}

export interface BlockBackstopDeps {
  judge: Judge;
  /** The judge's shared daily ceiling. Absent ⇒ unmetered (tests only; production always wires it). */
  spend?: { allow(): boolean; record(costUsd: number): void } | null;
  /** Read LIVE per decision, so the Settings toggle applies to the next block, not the next restart. */
  mode: () => BlockJudgeMode;
  /** One row per episode that reached a decision. The arming gate reads these. */
  log: (row: BlockJudgeLogRow) => void;
  /** Total wall-clock budget of one `ask`; bounds the provisional hold while a call is in flight. */
  deadlineMs: number;
  now?: () => number;
}

/** One session's in-flight/decided backstop state. Lives from the first gated sighting until the
 *  episode is released. */
interface Episode {
  firstSeenAt: number;
  /** When its gated block was last observed — re-stamped every cadence the block is on screen. */
  lastSeenAt: number;
  pending: boolean;
  /** null while no decision has landed yet. */
  decidedDelayMs: number | null;
}

/**
 * Per-session episode tracking around the judge call.
 *
 * NOTHING HERE IS AWAITED BY THE CALLER. `hold` is synchronous: it fires the request as a detached
 * promise, parks the answer in the episode map, and the NEXT classify cadence reads it. The hold
 * itself is a deadline comparison re-evaluated each cadence — not a timer and not a subscription —
 * so a call that never settles cannot silence a block beyond {@link BACKSTOP_MAX_HOLD_MS}. That
 * matters more than it looks: the same Bun loop pumps the live web terminal.
 */
export class BlockBackstop {
  private readonly episodes = new Map<string, Episode>();
  /** session → when it last ASKED, kept across episodes to bound flap-driven re-asking. */
  private readonly lastAskAt = new Map<string, number>();
  /** Every detached call still running. Test seam only (see {@link settle}); an entry is removed as
   *  soon as its row is logged, so this is bounded by the sessions currently being judged. */
  private readonly inflight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly deps: BlockBackstopDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Consult the backstop for a block a regex has flagged. Returns true to withhold the
   * announcement this cadence, false to announce now.
   *
   * The caller owns the one precondition this cannot check for itself: the shape is in
   * {@link BACKSTOP_GATED_SHAPES}. It also owns the no-retraction invariant, which it keeps by
   * construction rather than by a guard — withholding means it does not emit and does not touch its
   * announced-signature map, so whatever was already announced stays announced.
   */
  hold(sessionId: string, reason: BlockReason): boolean {
    const mode = this.deps.mode();
    if (mode === "off") return false;
    const t = this.now();
    this.sweepAsks(t);

    let ep = this.episodes.get(sessionId);
    if (!ep) {
      ep = { firstSeenAt: t, lastSeenAt: t, pending: false, decidedDelayMs: null };
      this.episodes.set(sessionId, ep);
    }
    ep.lastSeenAt = t;

    if (!ep.pending && ep.decidedDelayMs === null) this.start(sessionId, ep, reason, t, mode);

    return mode === "armed" && t < this.holdUntil(ep);
  }

  /** When this episode's hold runs out: provisional while the call is in flight, banded once
   *  decided, and capped either way — so the worst case is one bounded hold measured from the
   *  block's first sighting. */
  private holdUntil(ep: Episode): number {
    const budget = ep.decidedDelayMs ?? this.deps.deadlineMs + POLL_SLACK_MS;
    return ep.firstSeenAt + Math.min(budget, BACKSTOP_MAX_HOLD_MS);
  }

  /**
   * End an episode, UNLESS it is still live: an answer is in flight, its hold has not run out, or
   * its block was on screen within {@link BACKSTOP_SEEN_MS}. The next gated sighting then starts a
   * fresh one (subject to {@link BACKSTOP_REASK_MS}).
   *
   * The refusal is the load-bearing half. Its callers are not clean edges: the poller drops this
   * state on any non-`blocked` status and inside `clearBlock`, both of which run on EVERY tick for
   * a session that is merely idle — and a held block is exactly the case where the session can SIT
   * at a non-`blocked` status, because Shepherd is the one holding the block back. Without the
   * refusal a per-tick release would delete the episode between cadences, so every classify would
   * build a fresh one: the answer's write-back would be dropped on the identity check, the paid `p`
   * discarded, and the re-ask cooldown would decide the block — a one-cadence hold whatever the
   * model said. The hook-driven path (`tryHookAwaitingBlock`, which classifies precisely when herdr
   * has NOT latched `blocked`) reaches this every time.
   *
   * Once the hold has run out AND the block has stopped appearing, the episode is inert — its
   * decision is spent and there is nothing left to apply it to — so the same per-tick calls collect
   * it, which is what keeps the one-ask rule from silencing a session whose held block cleared
   * without ever being announced.
   */
  release(sessionId: string): void {
    const ep = this.episodes.get(sessionId);
    if (!ep) return;
    const t = this.now();
    if (ep.pending) return; // an answer we have paid for is still coming
    if (t < this.holdUntil(ep)) return; // the hold is live
    if (t - ep.lastSeenAt < BACKSTOP_SEEN_MS) return; // the block itself is still on screen
    this.episodes.delete(sessionId);
  }

  /** Drop per-session state for a session that is gone. Unconditional, unlike {@link release}:
   *  there is no pane left to hold a block back from. */
  forget(sessionId: string): void {
    this.episodes.delete(sessionId);
    this.lastAskAt.delete(sessionId);
  }

  /** Awaits every in-flight call, including one whose episode was released mid-flight. Test seam;
   *  production never calls it — nothing on the loop may await a judge. */
  async settle(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  /** Decide whether to pay for an answer, and fire it if so. Never throws. */
  private start(
    sessionId: string,
    ep: Episode,
    reason: BlockReason,
    t: number,
    mode: BlockJudgeMode,
  ): void {
    // Nothing to ask about. Unreachable through a gated shape (both need matched option lines), but
    // the guard is free and the alternative is paying for an empty question.
    if (reason.tail.every((l) => l.trim() === "")) {
      ep.decidedDelayMs = 0;
      this.emit(sessionId, reason, mode, { delayMs: 0, p: null, reason: "empty-tail" }, null, 0, t);
      return;
    }
    const lastAsk = this.lastAskAt.get(sessionId);
    if (lastAsk !== undefined && t - lastAsk < BACKSTOP_REASK_MS) {
      ep.decidedDelayMs = 0;
      return;
    }
    if (this.deps.spend && !this.deps.spend.allow()) {
      ep.decidedDelayMs = 0;
      this.emit(sessionId, reason, mode, { delayMs: 0, p: null, reason: "ceiling" }, null, 0, t);
      return;
    }
    ep.pending = true;
    this.lastAskAt.set(sessionId, t);
    const settled: Promise<void> = this.ask(sessionId, ep, reason, mode).finally(() => {
      this.inflight.delete(settled);
    });
    this.inflight.add(settled);
  }

  private async ask(
    sessionId: string,
    ep: Episode,
    reason: BlockReason,
    mode: BlockJudgeMode,
  ): Promise<void> {
    let decision: BackstopDecision;
    let model: string | null = null;
    let costUsd = 0;
    try {
      const result = await this.deps.judge.ask(blockJudgeState(reason.tail), {
        [BLOCK_JUDGE_QUESTION_ID]: blockJudgeQuestion(),
      });
      model = result.model;
      costUsd = result.costUsd;
      // Booked before the answer is inspected: an unusable answer was still billed, and a ceiling
      // that only counts answers it liked is not a ceiling. Best-effort — a ledger write that throws
      // must not lose a decision we already paid for.
      try {
        this.deps.spend?.record(costUsd);
      } catch (err) {
        console.warn("[block-judge] spend record failed:", err);
      }
      decision = interpretBlockAnswer(result.answers[BLOCK_JUDGE_QUESTION_ID]);
    } catch (err) {
      decision = { delayMs: 0, p: null, reason: judgeErrorReason(err) };
      console.warn(`[block-judge] ask failed (${decision.reason}) — announcing now:`, err);
    }
    // Only write back if this is still the SAME episode: one released mid-flight must not be
    // resurrected by its own late answer. The row is still logged — the measurement is valid
    // whatever happened to the pane.
    if (this.episodes.get(sessionId) === ep) {
      ep.pending = false;
      ep.decidedDelayMs = decision.delayMs;
    }
    this.emit(sessionId, reason, mode, decision, model, costUsd, this.now());
  }

  private emit(
    sessionId: string,
    reason: BlockReason,
    mode: BlockJudgeMode,
    decision: BackstopDecision,
    model: string | null,
    costUsd: number,
    ts: number,
  ): void {
    try {
      this.deps.log({
        sessionId,
        shape: reason.shape,
        tail: reason.tail.join("\n").slice(0, BACKSTOP_TAIL_CLIP),
        p: decision.p,
        delayMs: decision.delayMs,
        reason: decision.reason,
        mode,
        model,
        costUsd,
        ts,
      });
    } catch (err) {
      console.warn("[block-judge] log write failed:", err);
    }
  }

  /** Bound `lastAskAt` by the sessions that could still refuse an ask; anything older is dead
   *  weight. Same shape as the signals-capture episode map. */
  private sweepAsks(t: number): void {
    for (const [id, at] of this.lastAskAt)
      if (t - at >= BACKSTOP_REASK_MS) this.lastAskAt.delete(id);
  }
}
