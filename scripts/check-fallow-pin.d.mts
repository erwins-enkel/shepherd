// Types for the node-run fallow-pin gate (scripts/check-fallow-pin.mjs). The gate stays
// plain .mjs so `node scripts/check-fallow-pin.mjs` works as a CLI in any context (the
// package script, the pre-push gates lane, PR hygiene); this declaration only exists so
// its TypeScript importer — test/check-fallow-pin.test.ts — gets real types instead of
// `any`. Mirrors scripts/check-model-mirror.d.mts's role.

/** How a site names the pin: a `fallow@<semver>` invocation, or the TS constant. */
export type PinKind = "invocation" | "declaration";

/** One place the pinned version is written out. */
export interface PinRef {
  kind: PinKind;
  /** The semver as written, prerelease/build tails included. */
  version: string;
  /** 1-based line within the file. */
  line: number;
  /** Repo-relative path. Set by `scanTree`; absent from `extractPinRefs` output. */
  file?: string;
}

/** Why a comparison failed, or null when it did not. */
export type PinFailure = "no-canonical" | "no-invocations" | "drift";

export interface PinResult {
  /** True when every reference names `canonical`. */
  ok: boolean;
  reason: PinFailure | null;
  /** The version parsed from `FALLOW_VERSION`, or null when it could not be parsed. */
  canonical: string | null;
  /** References whose version differs from `canonical`. Empty unless `reason` is "drift". */
  mismatches: PinRef[];
  invocations: number;
  declarations: number;
  /** Distinct files contributing at least one reference. */
  files: number;
}

/** The file holding `FALLOW_VERSION` — the canonical every other site is compared to. */
export const CANONICAL_REL: string;

/** Every pin reference in one file's text, sorted by line. */
export function extractPinRefs(source: string): PinRef[];

/** The version `FALLOW_VERSION` is declared as, or null when it cannot be parsed. */
export function extractCanonicalVersion(source: string): string | null;

/** Compare every reference against the canonical, as structured data. */
export function comparePins(canonical: string | null, refs: PinRef[]): PinResult;

/** `process.env` minus git's repo-local variables (GIT_DIR, GIT_INDEX_FILE, …). */
export function gitEnv(): NodeJS.ProcessEnv;

/** Scan every file git tracks under `root`; each ref carries its repo-relative `file`. */
export function scanTree(root: string, env?: NodeJS.ProcessEnv): PinRef[];
