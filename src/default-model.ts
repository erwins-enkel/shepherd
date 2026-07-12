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

import {
  AGENT_PROVIDERS,
  CODEX_MODELS,
  CODEX_MODEL_RE,
  type AgentProvider,
  MODELS,
  MODELS_BY_PROVIDER,
} from "./types";
import { normalizeEffort } from "./default-effort";

const SETTING_VALUES = new Set<string>(["auto", "default", ...MODELS]);
const CLAUDE_MODEL_VALUES = new Set<string>(MODELS);
const CODEX_MODEL_VALUES = new Set<string>(CODEX_MODELS);

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
 * Spawn-time fallback: when fable is globally unavailable, an explicit
 * `fable` request runs Opus with 1M context instead. Capability-faithful
 * substitute (fable is for the longest-horizon work; plain opus caps at 200K).
 * Pure — callers do the logging.
 */
export function spawnModelForAvailability(
  model: string | null,
  fableAvailable: boolean,
): string | null {
  return model === "fable" && !fableAvailable ? "opus[1m]" : model;
}

/** True when `model` is a valid explicit model alias for `provider`.
 *
 * Codex accepts safe future-looking aliases so Shepherd can work with a newer installed CLI before
 * the curated list is updated, but known Claude aliases are excluded from that free-form path.
 */
export function modelCompatibleWithProvider(
  model: string | null,
  provider: AgentProvider,
): boolean {
  if (model === null) return true;
  if (provider === "claude") return CLAUDE_MODEL_VALUES.has(model);
  return (
    CODEX_MODEL_VALUES.has(model) || (CODEX_MODEL_RE.test(model) && !CLAUDE_MODEL_VALUES.has(model))
  );
}

/** Clamp a stored model to the target provider's value space. Used when an existing task changes
 * provider after its model was already validated for the original provider. */
export function modelForProviderOrDefault(
  model: string | null,
  provider: AgentProvider,
): string | null {
  return modelCompatibleWithProvider(model, provider) ? model : null;
}

/**
 * Normalize a fableAvailable setting value (env string, store string, or boolean)
 * to a boolean, or null if unrecognized. Accepts: true/"true"/"1" → true;
 * false/"false"/"0" → false; anything else → null.
 */
export function normalizeFableAvailable(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
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

/** How the operator's Codex CLI is authenticated. Some Codex models are rejected (HTTP 400) under
 *  a ChatGPT-account login but work with an API key, so a role/main spawn resolution must know the
 *  auth mode to avoid pinning a doomed model. `unknown` = undetermined (missing/unreadable
 *  `~/.codex/auth.json`, or a non-Codex host) → fail-open, never clamp. Detected structurally in
 *  `src/codex-auth.ts` (tokens present + no API key ⇒ chatgpt), not by any single JSON field. */
export type CodexAuthMode = "chatgpt" | "apikey" | "unknown";

/** Codex models known to be rejected (HTTP 400 "… not supported when using Codex with a ChatGPT
 *  account") under a ChatGPT-account login. Deliberately a BLOCKLIST of empirically-confirmed bad
 *  models, not an allowlist: fail-open, so a new/unknown model is never wrongly blocked. Extend as
 *  more are confirmed; `src/codex-auth.ts`'s pane-tail capture makes a not-yet-listed one
 *  diagnosable rather than silent. */
export const CHATGPT_INCOMPATIBLE_CODEX_MODELS = new Set<string>(["gpt-5.3-codex"]);

/** Auth-aware model clamp, orthogonal to {@link modelCompatibleWithProvider} (which stays a pure
 *  model↔provider check). Returns `null` — "drop the --model flag, use the provider's own default"
 *  — only for a Codex model that a ChatGPT-account login is known to reject; otherwise the model is
 *  returned unchanged. `unknown`/`apikey` never clamp (fail-open). Pure. */
export function clampCodexModelForAuth(
  model: string | null,
  provider: AgentProvider,
  authMode: CodexAuthMode,
): string | null {
  if (
    provider === "codex" &&
    authMode === "chatgpt" &&
    model !== null &&
    CHATGPT_INCOMPATIBLE_CODEX_MODELS.has(model)
  )
    return null;
  return model;
}

/** A resolved per-role spawn environment: which CLI to launch, which model flag (null = the
 *  provider's own default, no --model), and which effort flag (null/undefined = no --effort).
 *  `effort` is OPTIONAL — several call sites fall back to a `{ provider, model }` literal without
 *  it (recap.ts, plan-gate.ts, review.ts, standalone-critic.ts, doc-agent.ts). */
export interface RoleEnvironment {
  provider: AgentProvider;
  model: string | null;
  effort?: string | null;
}

/** Normalize a per-role CLI SETTING to "inherit" | <AgentProvider>, or null if unrecognized.
 *  "inherit" (the default) means the role follows the global defaultAgentProvider + defaultModel. */
export function normalizeRoleCli(value: unknown): "inherit" | AgentProvider | null {
  if (value === "inherit") return "inherit";
  return (AGENT_PROVIDERS as readonly unknown[]).includes(value) ? (value as AgentProvider) : null;
}

// Union of every provider's model aliases — the role MODEL token is validated against this plus
// "default" (the cli/model pairing is enforced in the UI; the resolver clamps any mismatch).
const ALL_PROVIDER_MODELS = new Set<string>(Object.values(MODELS_BY_PROVIDER).flat());

/** Normalize a per-role MODEL token to "default" | <any provider alias>, or null if unrecognized.
 *  "default" means "the provider's own default" (no --model flag). */
export function normalizeRoleModelToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "default") return "default";
  return ALL_PROVIDER_MODELS.has(value) ? value : null;
}

/**
 * Resolve a per-ROLE environment (plan reviewer, PR critic, recap, doc-agent, namer, autopilot)
 * to the CLI provider + spawn-ready model flag for a role spawn.
 *
 * Role SETTING space is a TRIPLE: `roleCli` ∈ "inherit" | <AgentProvider>; `roleModel` ∈
 * "default" | <alias>; `roleEffort` ∈ "default" | <EFFORTS tier>.
 *   - cli "inherit" (or unset/invalid) → follow the global defaultAgentProvider + defaultModel.
 *   - cli <provider> → that provider; model "default" → null (provider default); model <alias> →
 *     the alias, clamped to null if it doesn't belong to the chosen provider (stale pairing guard).
 *   - effort → `normalizeEffort(roleEffort)`: "default"/invalid → null (no --effort flag, the role's
 *     natural default), a tier passes through (the Codex xhigh/max clamp is applied later, at the
 *     argv boundary in `effortForSpawn`). Effort is orthogonal to the cli/model pair.
 * fable → opus[1m] substitution (spawnModelForAvailability) applies when fable is unavailable.
 */
export function resolveRoleEnvironment(
  roleCli: string | null | undefined,
  roleModel: string | null | undefined,
  globalProvider: AgentProvider,
  globalModelSetting: string,
  fableAvailable: boolean,
  roleEffort: string | null | undefined,
  codexAuthMode: CodexAuthMode = "unknown",
): RoleEnvironment {
  const effort = normalizeEffort(roleEffort);
  const cli = normalizeRoleCli(roleCli);
  if (cli === null || cli === "inherit") {
    // Clamp the global default too — a codex global default can itself be chatgpt-incompatible.
    const model = spawnModelForAvailability(drainSpawnModel(globalModelSetting), fableAvailable);
    return {
      provider: globalProvider,
      model: clampCodexModelForAuth(model, globalProvider, codexAuthMode),
      effort,
    };
  }
  const token = normalizeRoleModelToken(roleModel) ?? "default";
  if (token === "default") return { provider: cli, model: null, effort };
  // Clamp: the stored model must belong to the chosen provider, else fall back to its default.
  if (!modelCompatibleWithProvider(token, cli)) return { provider: cli, model: null, effort };
  const model = spawnModelForAvailability(token, fableAvailable);
  // Auth-aware clamp: a codex model rejected by a ChatGPT-account login falls back to its default.
  return { provider: cli, model: clampCodexModelForAuth(model, cli, codexAuthMode), effort };
}

/** Args for {@link resolveRoleEnvWithAuth} — the per-role setting triple plus the global fallback. */
export interface RoleEnvArgs {
  roleCli: string | null | undefined;
  roleModel: string | null | undefined;
  globalProvider: AgentProvider;
  globalModelSetting: string;
  fableAvailable: boolean;
  roleEffort: string | null | undefined;
}

/** Testable role-env seam: reads the Codex auth mode via the INJECTED `readAuth` thunk and feeds it
 *  into {@link resolveRoleEnvironment}. This is the unit the wiring in `src/index.ts` delegates to,
 *  so the auth-read → resolve → clamp path is coverable without booting the server. */
export function resolveRoleEnvWithAuth(
  args: RoleEnvArgs,
  readAuth: () => CodexAuthMode,
): RoleEnvironment {
  return resolveRoleEnvironment(
    args.roleCli,
    args.roleModel,
    args.globalProvider,
    args.globalModelSetting,
    args.fableAvailable,
    args.roleEffort,
    readAuth(),
  );
}
