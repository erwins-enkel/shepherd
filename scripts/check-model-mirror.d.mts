// Types for the node-run model-mirror gate (scripts/check-model-mirror.mjs). The
// gate stays plain .mjs so `node scripts/check-model-mirror.mjs` works as a CLI in
// any context (the package script, the pre-push gates lane, PR hygiene); this
// declaration only exists so its TypeScript importer — test/check-model-mirror.test.ts
// — gets real types instead of `any`. Mirrors scripts/next-version.d.mts's role.

/** Which side of the mirror a finding refers to. */
export type MirrorSide = "server" | "ui";

/** One constant's divergence. Empty arrays + false flags = that constant is fine. */
export interface MirrorDelta {
  /** The constant that diverged, e.g. "CLAUDE_MODELS". */
  constant: string;
  /** Sides whose array literal could not be parsed at all (fail-closed). */
  missingIn: MirrorSide[];
  /** Elements in src/types.ts but not ui/src/lib/types.ts. */
  onlyInServer: string[];
  /** Elements in ui/src/lib/types.ts but not src/types.ts. */
  onlyInUi: string[];
  /**
   * Membership matches but the sequences differ — a reorder, or (degenerately) a
   * differing number of duplicate entries. Only ever set when both `onlyIn*` are empty.
   */
  orderMismatch: boolean;
}

export interface MirrorResult {
  /** True when `deltas` is empty — the two files agree on every constant. */
  ok: boolean;
  deltas: MirrorDelta[];
}

/** Constants declared in both files that must stay element- and order-identical. */
export const MIRRORED_CONSTANTS: string[];

/**
 * String elements of `const <constName> = [ … ]`, or null when the literal cannot
 * be parsed (absent, unterminated, or holding no string elements).
 */
export function extractArrayLiteral(source: string, constName: string): string[] | null;

/** Compare every mirrored constant across the two sources, as structured deltas. */
export function compareMirror(
  serverSource: string,
  uiSource: string,
  constants?: string[],
): MirrorResult;
