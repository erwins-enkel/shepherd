import type { CaptureConfig } from "./types";
import type { SignalToggles } from "./signals";

const KEY = "captureConfig";

export const DEFAULT_CONFIG: CaptureConfig = {
  baseUrl: "http://localhost:7330",
  token: "",
  repoPath: "",
  baseBranch: "main",
  model: "default",
  signals: { screenshot: true, console: false, network: false, a11y: false },
  routingRules: [],
};

/** Load config from chrome.storage.local, merged over defaults (signals deep-merged). */
export async function loadConfig(): Promise<CaptureConfig> {
  const got = await chrome.storage.local.get(KEY);
  const stored = (got[KEY] as Partial<CaptureConfig>) ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    // Only spread a real object over the signal defaults; a stored non-object
    // (corrupt/legacy data) can't throw but would spread garbage keys (e.g. a
    // string → {0:"…"}). Symmetric with the routingRules coercion below.
    signals: {
      ...DEFAULT_CONFIG.signals,
      ...(stored.signals && typeof stored.signals === "object" && !Array.isArray(stored.signals)
        ? stored.signals
        : {}),
    },
    // routingRules is the single source consumers iterate (resolveRepo, the
    // options `{#each}`). A spread leaves a stored non-array (corrupt/legacy
    // data) in place — `??` only catches null/undefined — which would crash the
    // popup's effectiveRepo derived with "is not iterable". Coerce to an array.
    routingRules: Array.isArray(stored.routingRules) ? stored.routingRules : [],
  };
}

/**
 * Persist config (local only — never synced; holds the token). Callers in a
 * Svelte component MUST pass a plain object ($state.snapshot(config)), never a
 * raw $state proxy — a proxied array won't survive chrome.storage's structured
 * clone and loadConfig's Array.isArray guard would wipe it.
 */
export async function saveConfig(config: CaptureConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}

/**
 * Persist only the signal toggles, leaving every other field at its last-saved
 * value. The options Signals section uses this so flipping a signal doesn't flush
 * unsaved edits to the other fields (base URL, token, repo path, …) as a side
 * effect — those persist only when the user clicks Save.
 */
export async function saveSignals(signals: SignalToggles): Promise<void> {
  const stored = await loadConfig();
  await saveConfig({ ...stored, signals });
}

/** True once the minimum required fields for a spawn are present. */
export function isConfigured(config: CaptureConfig): boolean {
  return config.baseUrl.trim() !== "" && config.repoPath.trim() !== "";
}
