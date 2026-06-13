/**
 * Server-side source of truth for the persisted default-model SETTING value space
 * and its mapping to a spawn flag.
 *
 * The SETTING space is: "auto" | "default" | <MODELS alias>.
 *   - "auto"    = no operator preference; the UI New-Task picker uses the client-side
 *                 Fable promo as its fallback, and drain falls back to no --model flag.
 *   - "default" = explicit "no --model flag" for both the picker and drain.
 *   - <alias>   = a specific model for both the picker and drain.
 *
 * The time-gated Fable promo is a SEPARATE, client-only New-Task-picker concern and
 * deliberately lives only in the UI (ui/src/lib/fable-promo.ts). Drain must NEVER
 * apply it — autonomous spawns must be deterministic and operator-controlled only.
 */

import { MODELS } from "./types";

const SETTING_VALUES = new Set<string>(["auto", "default", ...MODELS]);

// The per-repo override space is the global space plus an "inherit" sentinel,
// which means "no repo override — fall back to the global default setting".
const REPO_SETTING_VALUES = new Set<string>(["inherit", ...SETTING_VALUES]);

/**
 * Normalize an arbitrary value (env var, DB row, request body) to a valid
 * SETTING string, or null if the value is unrecognised / wrong type.
 * Accepted: "auto", "default", and each MODELS alias. Everything else → null.
 */
export function normalizeDefaultModelSetting(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SETTING_VALUES.has(value) ? value : null;
}

/**
 * Map a SETTING string to the spawn-ready model value passed to service.create().
 * "auto" and "default" both resolve to null (no --model flag).
 * Any model alias passes through unchanged.
 */
export function drainSpawnModel(setting: string): string | null {
  if (setting === "auto" || setting === "default") return null;
  return setting;
}

/**
 * Normalize a per-repo default-model override to a valid REPO SETTING string,
 * or null if unrecognised. Accepted: "inherit" plus everything the global
 * setting accepts ("auto", "default", each MODELS alias). "inherit" (the
 * default) means the repo defers to the global default.
 */
export function normalizeRepoDefaultModelSetting(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return REPO_SETTING_VALUES.has(value) ? value : null;
}

/**
 * Resolve the effective default-model SETTING for a repo: the repo override
 * unless it is "inherit" (or unset/invalid), in which case the global setting
 * wins. The result is a global-space SETTING string ("auto" | "default" |
 * <alias>) — pass it through drainSpawnModel to get a spawn flag.
 */
export function resolveDefaultModelSetting(
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
