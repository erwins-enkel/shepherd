import type { ComposeMode } from "#lib/keymap/types.js";
// Pure logic for the New Task "shape this" round (issue #2158) — kept out of the .svelte file so
// it's unit-testable without a DOM. The round itself (the transient agent, the brief composition)
// runs on the server; these helpers only decide when the control is offered and how a failure reads.

/** Why the Shape control is unavailable, or null when it can run. */
export type ShapeBlocker = "empty_prompt" | "no_repo" | "wrong_mode" | "running";

export interface ShapeAvailability {
  promptEmpty: boolean;
  repoResolved: boolean;
  /** The New Task mode; see {@link shapeOffered}. */
  mode: ComposeMode;
  running: boolean;
}

/** Whether a mode takes a shaped brief: a code task starts from it, and an epic-authoring session
 *  decomposes it. Research, plain and bootstrap tasks take none. The one rule for the Shape button,
 *  its blocker and the coaching hint that points at it. */
export function shapeOffered(mode: ComposeMode): boolean {
  return mode === "code" || mode === "epic";
}

export function shapeBlocker(i: ShapeAvailability): ShapeBlocker | null {
  if (i.running) return "running";
  if (!shapeOffered(i.mode)) return "wrong_mode";
  if (!i.repoResolved) return "no_repo";
  if (i.promptEmpty) return "empty_prompt";
  return null;
}

/** The stable error slugs `/api/shape` returns (mirrors ShapeError in src/task-shape.ts). */
export const SHAPE_ERRORS = ["empty-prompt", "spawn-failed", "timeout", "unavailable"] as const;
export type ShapeErrorKey = (typeof SHAPE_ERRORS)[number];

/** Everything the round can fail at, from the operator's side: the server's slugs plus "compose" —
 *  the brief step, which runs after the questions are answered and has its own copy. */
export type ShapeFailure = ShapeErrorKey | "compose";

/**
 * Map a server error slug to the key half of its message. Unknown slugs (a newer server, a proxy
 * error page) collapse to "timeout" — the round produced nothing either way, and a generic
 * "something went wrong" would tell the operator less than "it didn't finish in time".
 */
export function shapeErrorKey(error: string): ShapeErrorKey {
  return (SHAPE_ERRORS as readonly string[]).includes(error) ? (error as ShapeErrorKey) : "timeout";
}

// ── The wait while a round runs ──────────────────────────────────────────────────────────────
// The server reports nothing until the round is done (it polls for the agent's result file), so
// the card cannot show real progress. What it can show honestly is the clock: how long the round
// has run and how close it is to the deadline. Nothing here invents a phase the server never sent.

/** Mirrors the round's deadline (`timeoutMs` in src/task-shape.ts). The card only counts toward
 *  it; the server is what gives up. */
export const SHAPE_TIMEOUT_MS = 180_000;
/** From here the wait reads as long. */
const SHAPE_LONG_MS = 45_000;
/** From here the card counts down to the deadline and offers a way out. */
const SHAPE_CLOSING_MS = 150_000;

export type ShapeWait = "reading" | "long" | "closing";

export function shapeWait(elapsedMs: number): ShapeWait {
  if (elapsedMs >= SHAPE_CLOSING_MS) return "closing";
  if (elapsedMs >= SHAPE_LONG_MS) return "long";
  return "reading";
}

/** Time left before the server gives up, never negative. */
export function shapeRemainingMs(elapsedMs: number): number {
  return Math.max(0, SHAPE_TIMEOUT_MS - elapsedMs);
}

/** How many "good to know" hints the running panel cycles through. */
export const SHAPE_TIP_COUNT = 4;
const SHAPE_TIP_MS = 7_000;

/** Which hint shows: it advances by itself every 7 s, shifted by the operator's own paging
 *  (`offset`, which may be negative after paging back). */
export function shapeTipIndex(elapsedMs: number, offset: number): number {
  const auto = Math.floor(Math.max(0, elapsedMs) / SHAPE_TIP_MS);
  return (((auto + offset) % SHAPE_TIP_COUNT) + SHAPE_TIP_COUNT) % SHAPE_TIP_COUNT;
}

// ── Passive coaching (#4177) ─────────────────────────────────────────────────────────────────
// A judge-backed hint while the operator writes, and the verdict a Shape round returns.

/** Mirrors HINT_MIN_CHARS in src/prompt-coach-core.ts: shorter prompts are never sent. */
export const HINT_MIN_CHARS = 40;
/** How long the text must sit still before the hint is asked for. */
export const HINT_DEBOUNCE_MS = 1500;

export interface HintAvailability {
  prompt: string;
  repoResolved: boolean;
  mode: ComposeMode;
  /** No Shape round is running or showing — the hint shares its slot and points at it. */
  shapeIdle: boolean;
  /** The mobile layout renders no Shape control, so a hint pointing at it would mislead. */
  mobile: boolean;
}

/** Whether the coaching hint is worth asking for: only where Shape itself could run. */
export function hintApplies(i: HintAvailability): boolean {
  return (
    i.shapeIdle &&
    !i.mobile &&
    shapeOffered(i.mode) &&
    i.repoResolved &&
    i.prompt.trim().length >= HINT_MIN_CHARS
  );
}

const VERDICT_MISSING = ["symptom", "outcome", "acceptance"] as const;
export type VerdictMissing = (typeof VERDICT_MISSING)[number];

/** The verdict's known style, or null for an unknown one (a newer server) — no header then. */
export function verdictStyle(style: string): "prescribing" | "describing" | null {
  return style === "prescribing" || style === "describing" ? style : null;
}

/** The verdict's known `missing` entries in canonical order; an unknown one is dropped. */
export function verdictMissing(missing: readonly string[]): VerdictMissing[] {
  return VERDICT_MISSING.filter((k) => missing.includes(k));
}
