// Pure display logic for the Readiness "Forge settings" section (#3106) — out of the .svelte
// file so it's unit-testable without a DOM. Check values come verbatim from the server.
import type { ForgeCheck } from "#lib/types.js";

/** Localized words a value renders with. */
export interface ValueWords {
  on: string;
  off: string;
  none: string;
  unknown: string;
}

/** One side (current or target) of a check as display text. Lists (merge methods, check
 *  contexts) are verbatim identifiers; booleans become on/off. */
export function formatValue(v: ForgeCheck["current"], w: ValueWords): string {
  if (v === null) return w.unknown;
  if (typeof v === "boolean") return v ? w.on : w.off;
  return v.length ? v.join(", ") : w.none;
}

/** Lock key for one in-flight Apply: per repo + check, so a repo switch never disables
 *  another repo's buttons. */
export function applyKey(repoPath: string, id: ForgeCheck["id"]): string {
  return `${repoPath}\u0000${id}`;
}
