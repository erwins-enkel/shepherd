/**
 * Which Claude Code versions can actually spawn a given pinned Claude model.
 *
 * Claude Code validates `--model` against a catalog COMPILED INTO THE BINARY. A model newer than
 * the installed CLI is not a slow failure or a silent downgrade — it is a hard 400 that names the
 * version required:
 *
 *   API Error: 400 Claude Code 2.1.277 does not support this model;
 *              version 2.1.280 or newer is required.
 *
 * Shepherd cannot fix that for the operator (upgrading someone's CLI is not a thing it does behind
 * a button), but it CAN say so before every spawn dies — see the `claude_model_cli` DIAGNOSE row.
 *
 * Deliberately a SPARSE table of empirically-confirmed floors, the same shape as
 * `CHATGPT_INCOMPATIBLE_CODEX_MODELS`: an unlisted model has no floor and is never blocked. New
 * entries earn their place by being probed, not by being assumed — every value here was read out
 * of the CLI's own refusal.
 *
 * Leaf module (imports only `compareSemver`) so both the diagnostics service and its tests can
 * read it without pulling the server in.
 */

import { compareSemver } from "./semver";

/** Model alias → the lowest Claude Code version that carries it. Both the plain pinned id and its
 *  `[1m]` variant reach the API as the same wire model, so they share the floor. */
export const CLAUDE_MODEL_MIN_CLI: Readonly<Record<string, string>> = {
  "claude-opus-5-5": "2.1.280",
  "claude-opus-5-5[1m]": "2.1.280",
};

/** The version floor for `model`, or null when it has none (unknown, floating alias, or a model
 *  old enough that every supported CLI carries it). */
export function minCliFor(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  return CLAUDE_MODEL_MIN_CLI[model] ?? null;
}

/**
 * The FIRST of `models` the installed CLI is too old to spawn, or null when none is.
 *
 * One hit is all a caller needs: the remedy is the same single CLI upgrade however many configured
 * models are stale, so the advisory names one rather than reciting a list.
 *
 * FAIL-OPEN on every uncertainty: an unreadable/unparseable `installedVersion` (null) returns null
 * rather than warning about a version we never established, exactly as `verdictFor` stays silent
 * when it cannot compare. A model with no floor is never reported.
 *
 * Pure — the caller decides what to do with the result.
 */
export function modelNeedingNewerCli(
  models: readonly (string | null | undefined)[],
  installedVersion: string | null,
): { model: string; required: string } | null {
  if (!installedVersion) return null;
  for (const model of models) {
    const required = minCliFor(model);
    if (typeof model !== "string" || required === null) continue;
    if (compareSemver(installedVersion, required) < 0) return { model, required };
  }
  return null;
}
