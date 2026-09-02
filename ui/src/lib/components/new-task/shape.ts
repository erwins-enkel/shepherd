// Pure logic for the New Task "shape this" round (issue #2158) — kept out of the .svelte file so
// it's unit-testable without a DOM. The round itself (the transient agent, the brief composition)
// runs on the server; these helpers only decide when the control is offered and how a failure reads.

/** Why the Shape control is unavailable, or null when it can run. */
export type ShapeBlocker = "empty_prompt" | "no_repo" | "wrong_mode" | "running";

export interface ShapeAvailability {
  promptEmpty: boolean;
  repoResolved: boolean;
  /** The New Task mode. Shaping produces a code-task brief: research has no brief, and epic mode
   *  already has its own (richer) shaping flow. */
  mode: "code" | "research" | "epic";
  running: boolean;
}

export function shapeBlocker(i: ShapeAvailability): ShapeBlocker | null {
  if (i.running) return "running";
  if (i.mode !== "code") return "wrong_mode";
  if (!i.repoResolved) return "no_repo";
  if (i.promptEmpty) return "empty_prompt";
  return null;
}

/** The stable error slugs `/api/shape` returns (mirrors ShapeError in src/task-shape.ts). */
export const SHAPE_ERRORS = ["empty-prompt", "spawn-failed", "timeout", "unavailable"] as const;
export type ShapeErrorKey = (typeof SHAPE_ERRORS)[number];

/**
 * Map a server error slug to the key half of its message. Unknown slugs (a newer server, a proxy
 * error page) collapse to "timeout" — the round produced nothing either way, and a generic
 * "something went wrong" would tell the operator less than "it didn't finish in time".
 */
/** Everything the round can fail at, from the operator's side: the server's slugs plus "compose" —
 *  the brief step, which runs after the questions are answered and has its own copy. */
export type ShapeFailure = ShapeErrorKey | "compose";

export function shapeErrorKey(error: string): ShapeErrorKey {
  return (SHAPE_ERRORS as readonly string[]).includes(error) ? (error as ShapeErrorKey) : "timeout";
}
