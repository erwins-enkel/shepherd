/**
 * Up Next readiness (#2535) — the ONE definition of what the judge is asked about an issue, shared
 * by the eval (`scripts/eval-up-next-readiness.ts`) and production (`src/up-next-readiness.ts`) so
 * the thing measured is the thing shipped.
 *
 * LEAF MODULE: types-only imports, no I/O. The question is a single `noul` — "could an agent start
 * this unattended and finish it in one PR?" — and the answer is only ever used through {@link band},
 * so a small score wobble between refreshes never reshuffles the list.
 */

import { createHash } from "node:crypto";
import type { JudgeNoulQuestion } from "./judge";

export type ReadinessBand = "ready" | "maybe" | "notReady";

/** `p` at or above this ⇒ ready. The #2535 sweep found 0.5–0.6 / 0.2–0.4 equivalent; ≥0.7 lost lift. */
export const READY_AT = 0.6;
/** `p` below this ⇒ not ready. See {@link READY_AT}. */
export const NOT_READY_BELOW = 0.3;

/** Sort rank per band — ready first. A missing score ranks as `maybe`. */
export const BAND_RANK: Record<ReadinessBand, number> = { ready: 0, maybe: 1, notReady: 2 };

/** What the judge sees about one row. For an epic unit this is the next-actionable CHILD — what
 *  Start launches — never the parent. */
export interface ReadinessInput {
  title: string;
  body: string;
  labels: string[];
}

const BODY_CLIP = 4000;

function normLabels(labels: string[]): string[] {
  return [...new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean))].sort();
}

/** The state blob. Title leads (the model anchors on what it reads first), labels next, the body
 *  last and clipped so one enormous issue cannot dominate the payload. */
export function readinessState(item: ReadinessInput): string {
  const parts = [`Issue title: ${item.title.trim().slice(0, 300)}`];
  const labels = normLabels(item.labels);
  if (labels.length > 0) parts.push(`Labels: ${labels.join(", ")}`);
  const body = item.body.trim();
  parts.push(body ? `Issue body:\n${body.slice(0, BODY_CLIP)}` : "Issue body: (empty)");
  return parts.join("\n\n");
}

/**
 * The question — deliberately WITHOUT `criteria`. The #2535 eval pre-registered four variants; the
 * one with criteria spelling out the "no" reasons (vague / needs a decision / too big / blocked, now
 * `v1` in `scripts/eval-up-next-readiness-variants.ts`) read detailed issues that merely MENTION a
 * decision or a dependency as not ready, and separated worse than this bare instruction on every
 * split. Adding criteria back is a change to re-measure, not a clarity fix.
 */
export const READINESS_QUESTION: JudgeNoulQuestion = {
  type: "noul",
  instructions:
    "A coding agent could start this issue unattended right now and finish it in a single pull request.",
};

/** Cache key: model + normalized content. A model re-pin rescores everything; a label reorder or
 *  case change does not. */
export function readinessHash(model: string, item: ReadinessInput): string {
  return createHash("sha256")
    .update(JSON.stringify([model, item.title.trim(), item.body.trim(), normLabels(item.labels)]))
    .digest("hex");
}

export function band(
  p: number | null,
  readyAt: number = READY_AT,
  notReadyBelow: number = NOT_READY_BELOW,
): ReadinessBand {
  if (p === null) return "maybe";
  if (p >= readyAt) return "ready";
  if (p < notReadyBelow) return "notReady";
  return "maybe";
}

/** A missing, off-shape or out-of-range answer is null — the caller keeps today's order for it. */
export function interpretReadiness(
  answer: { type?: string; p?: unknown } | undefined,
): number | null {
  if (!answer || answer.type !== "noul") return null;
  const p = answer.p;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return p;
}
