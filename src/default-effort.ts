/**
 * Server-side source of truth for the persisted reasoning-EFFORT setting value space and its
 * mapping to a spawn flag. Mirrors default-model.ts (the effort control is designed to track the
 * model control tier-for-tier), minus the promo/availability machinery effort has no analog for.
 *
 * The SETTING space is: "default" | <EFFORTS tier>.
 *   - "default" = no operator preference → no effort flag (the CLI's own default effort applies).
 *   - <tier>    = a specific effort for both the picker and drain.
 * There is no "auto" tier: effort has no time-gated promo fallback the way the model picker does.
 *
 * Argv-build translation (verified against the pinned CLIs in issue #1417's Phase-0 gate):
 *   - Claude 2.1.201 `--effort <low|medium|high|xhigh|max>` is LENIENT — it self-clamps/no-ops a
 *     tier the resolved model doesn't support (e.g. `--effort max --model haiku` runs clean), so
 *     Claude needs NO per-model capability map: pass the tier straight through.
 *   - Codex 0.142.5 `-c model_reasoning_effort=<minimal|low|medium|high>` has NO xhigh/max, so
 *     those two tiers clamp to `high` for Codex. `minimal` (below `low`) is not exposed.
 */

import { EFFORTS, type AgentProvider } from "./types";

const EFFORT_VALUES = new Set<string>(EFFORTS);
const SETTING_VALUES = new Set<string>(["default", ...EFFORTS]);

// The per-repo override space is the global space plus an "inherit" sentinel, which means
// "no repo override — fall back to the global default effort setting".
const REPO_SETTING_VALUES = new Set<string>(["inherit", ...SETTING_VALUES]);

/**
 * Normalize a per-session/per-request effort token to a valid EFFORTS tier, or null if the value
 * is unrecognised / wrong type (null = provider default, no effort flag).
 */
export function normalizeEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return EFFORT_VALUES.has(value) ? value : null;
}

/**
 * Normalize an arbitrary value (env var, DB row, request body) to a valid global SETTING string,
 * or null if unrecognised. Accepted: "default" and each EFFORTS tier. Everything else → null.
 */
export function normalizeDefaultEffortSetting(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SETTING_VALUES.has(value) ? value : null;
}

/**
 * Normalize a per-repo default-effort override to a valid REPO SETTING string, or null if
 * unrecognised. Accepted: "inherit" plus everything the global setting accepts. "inherit" (the
 * default) means the repo defers to the global default.
 */
export function normalizeRepoDefaultEffortSetting(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return REPO_SETTING_VALUES.has(value) ? value : null;
}

/**
 * Map a global-space SETTING string to the spawn-ready effort value passed to service.create().
 * "default" resolves to null (no effort flag); any tier passes through unchanged.
 */
export function drainSpawnEffort(setting: string): string | null {
  return setting === "default" ? null : setting;
}

/**
 * Resolve the effective default-effort SETTING for a repo: the repo override unless it is
 * "inherit" (or unset/invalid), in which case the global setting wins. The result is a global-space
 * SETTING string ("default" | <tier>) — pass it through drainSpawnEffort to get a spawn value.
 */
export function resolveDefaultEffortSetting(
  repoSetting: string | null | undefined,
  globalSetting: string,
): string {
  if (
    typeof repoSetting === "string" &&
    repoSetting !== "inherit" &&
    SETTING_VALUES.has(repoSetting)
  )
    return repoSetting;
  return globalSetting;
}

/**
 * The argv-build seam (the correctness boundary): translate a resolved effort tier into the value
 * emitted for `provider`, or null to emit no flag. Pure; the argv builders format the actual flag
 * (`--effort <tier>` for Claude, `-c model_reasoning_effort=<tier>` for Codex).
 *
 * - null / unrecognised → null (no flag).
 * - Claude → pass the tier through (the CLI self-clamps unsupported model tiers).
 * - Codex → clamp `xhigh`/`max` down to `high` (Codex's domain tops out at `high`).
 */
export function effortForSpawn(provider: AgentProvider, effort: string | null): string | null {
  if (effort === null || !EFFORT_VALUES.has(effort)) return null;
  if (provider === "codex") return effort === "xhigh" || effort === "max" ? "high" : effort;
  return effort;
}

/** The effort tiers a provider actually accepts — Claude: all; Codex: no xhigh/max. Used by the
 *  UI picker (via the client mirror) and available server-side for guards. */
export function effortsForProvider(provider: AgentProvider): readonly string[] {
  return provider === "codex" ? EFFORTS.filter((e) => e !== "xhigh" && e !== "max") : EFFORTS;
}

/**
 * Critic guardrail predicate (#1430): does a role-effort SETTING resolve BELOW the `high` tier?
 * Operates on the SETTING space ("default" | <tier>), NOT just tiers:
 *   - "default" → true. It emits no `--effort` flag, so the CLI's own native default applies, which
 *     is below `high` — exactly why config.ts seeds `criticEffort` to "high" (config.ts:606-609).
 *   - a tier below `high`'s EFFORTS index (low/medium) → true.
 *   - "high"/"xhigh"/"max" and any unrecognised string → false.
 * The critic is a rigor role; a below-high effort weakens PR review. Mirrored in
 * ui/src/lib/effort-guidance.ts (keep the two byte-identical in behavior).
 */
export function effortBelowHigh(setting: string): boolean {
  if (setting === "default") return true;
  const order: readonly string[] = EFFORTS;
  const idx = order.indexOf(setting);
  return idx !== -1 && idx < order.indexOf("high");
}
