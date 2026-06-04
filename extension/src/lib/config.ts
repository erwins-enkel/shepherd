import type { CaptureConfig } from "./types";

const KEY = "captureConfig";

export const DEFAULT_CONFIG: CaptureConfig = {
  baseUrl: "http://localhost:7330",
  token: "",
  repoPath: "",
  baseBranch: "main",
  model: "default",
  signals: { screenshot: true, console: false, network: false, a11y: false },
};

/** Load config from chrome.storage.local, merged over defaults (signals deep-merged). */
export async function loadConfig(): Promise<CaptureConfig> {
  const got = await chrome.storage.local.get(KEY);
  const stored = (got[KEY] as Partial<CaptureConfig>) ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    signals: { ...DEFAULT_CONFIG.signals, ...(stored.signals ?? {}) },
  };
}

/** Persist config (local only — never synced; holds the token). */
export async function saveConfig(config: CaptureConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}

/** True once the minimum required fields for a spawn are present. */
export function isConfigured(config: CaptureConfig): boolean {
  return config.baseUrl.trim() !== "" && config.repoPath.trim() !== "";
}
