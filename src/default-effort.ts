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
 * Explicit tiers pass through unchanged. The CLI decides whether the resolved model supports
 * the requested tier; Shepherd never silently downgrades the operator's choice.
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
 * The argv-build seam: normalize a resolved effort tier, or return null to emit no flag.
 * Pure; the argv builders format the actual flag
 * (`--effort <tier>` for Claude, `-c model_reasoning_effort=<tier>` for Codex).
 *
 * Null / unrecognised values emit no flag. Known tiers pass through unchanged.
 */
export function effortForSpawn(effort: string | null): string | null {
  return normalizeEffort(effort);
}

/** Provider-level effort options. Model-specific Codex subsets live in the UI picker. */
export function effortsForProvider(provider: AgentProvider): readonly string[] {
  return provider === "claude" ? EFFORTS.filter((e) => e !== "ultra") : EFFORTS;
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
