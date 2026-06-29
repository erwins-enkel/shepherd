/**
 * Single source of truth for api-key auth-mode SPAWN WIRING.
 *
 * Every transient/spawned `claude` Shepherd launches must, in `api-key` mode,
 * (1) obtain the key via an `apiKeyHelper` in its `--settings`, and (2) see NO
 * subscription login (`<claudeDir>/.credentials.json`) — else Claude's
 * interactive "Use custom API key?" prompt hangs the unattended pane.
 *
 * The credential is suppressed by ONE of two mechanisms depending on whether
 * the spawn is bwrap-wrapped (a membrane):
 *   - Membrane-wrapped: mask the credential file in place + RO-bind the helper,
 *     via the MembraneInputs fields {@link apiKeyMembraneFields} returns.
 *   - Never-membraned (plain herdr.start): point the spawn at a credential-less
 *     mirror config dir via the CLAUDE_CONFIG_DIR env {@link apiKeyPassthroughEnv}
 *     returns.
 *
 * The settings fragment {@link apiKeySettingsFragment} carries the helper in
 * BOTH cases. In subscription mode every helper here returns the empty/undefined
 * shape so callers spread/pass it for BYTE-FOR-BYTE-identical behavior.
 *
 * This module is the only place that reads `config.authMode` /
 * `config.authApiKeyHelperPath` for spawning — service.ts, review.ts,
 * plan-gate.ts, and the four never-membraned spawns (namer, classifier, recap,
 * distiller) all route through it so the wiring can't drift.
 */

import { homedir } from "node:os";
import { config } from "./config";
import type { AgentProvider } from "./types";
import { spawnAuthSettings } from "./auth-mode";
import { ensureApiKeyConfigDir } from "./auth-config-dir";

// Test seam: lets tests stub the (real-fs) config-dir provisioning so the suite never
// scribbles the developer's real ~/.shepherd. Production never sets this. Mirrors the
// resetBackendCache test seam in sandbox.ts.
let _provisionForTest: (() => string) | null = null;
export function __setApiKeyConfigDirProvisionForTest(fn: (() => string) | null): void {
  _provisionForTest = fn;
}

/** True when the operator selected api-key auth mode (regardless of whether a key is configured). */
export function isApiKeyMode(): boolean {
  return config.authMode === "api-key";
}

/** True when api-key mode is selected AND a helper path is configured (ready to bill an API key). */
export function isApiKeyConfigured(): boolean {
  return config.authMode === "api-key" && config.authApiKeyHelperPath !== null;
}

/**
 * Whether a transient role spawn must FAIL CLOSED for auth: Anthropic api-key mode is selected but
 * no key is configured, so a Claude spawn would silently bill the subscription. Provider-aware — a
 * non-Claude provider (e.g. Codex) authenticates through its own CLI, not the Anthropic key, so this
 * never gates it. One home for the gate shared by recap/critic/plan-gate/doc-agent/namer/autopilot.
 */
export function apiKeyFailClosed(provider: AgentProvider): boolean {
  return provider === "claude" && isApiKeyMode() && !isApiKeyConfigured();
}

/**
 * Fragment merged into a spawn's --settings JSON: `{apiKeyHelper}` in api-key
 * mode (configured), else `{}` (byte-for-byte identical for subscription).
 */
export function apiKeySettingsFragment(): { apiKeyHelper?: string } {
  return spawnAuthSettings(config.authMode, config.authApiKeyHelperPath);
}

/**
 * Membrane (bwrap) fields for a wrapped spawn: bind the helper RO + mask the
 * OAuth credential in place. Subscription → `{apiKeyHelperPath:null, maskCredentials:false}`.
 */
export function apiKeyMembraneFields(): {
  apiKeyHelperPath: string | null;
  maskCredentials: boolean;
} {
  const apiKey = config.authMode === "api-key";
  return { apiKeyHelperPath: apiKey ? config.authApiKeyHelperPath : null, maskCredentials: apiKey };
}

/**
 * CLAUDE_CONFIG_DIR env for a spawn that is NOT bwrap-wrapped (passthrough).
 * `wrapped` = is the spawn bwrap-wrapped (membrane masks the credential in place,
 * so no env override is needed there). Returns `undefined` in subscription mode
 * or when wrapped; in api-key passthrough mode it provisions + returns the
 * credential-less mirror config dir.
 */
export function apiKeyPassthroughEnv(wrapped: boolean): Record<string, string> | undefined {
  if (config.authMode !== "api-key" || wrapped) return undefined;
  const dir = _provisionForTest
    ? _provisionForTest()
    : ensureApiKeyConfigDir(homedir(), config.claudeDir);
  return { CLAUDE_CONFIG_DIR: dir };
}
