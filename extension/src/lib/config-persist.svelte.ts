import { saveConfig } from "./config";
import type { CaptureConfig } from "./types";

/**
 * Persist a reactive `$state` config, snapshotting it to plain data first.
 *
 * Components MUST route saves through here rather than calling `saveConfig`
 * with a raw `$state` proxy: a deeply-reactive proxy array (routingRules)
 * degrades across chrome.storage's serializer so it reads back as a non-array,
 * and `loadConfig`'s `Array.isArray` guard then wipes it (see `saveConfig`).
 * `$state.snapshot` produces a detached plain copy that survives.
 *
 * This lives in a rune module (not `config.ts`) so the snapshot is exercised by
 * a unit test — the alternative, an inline `$state.snapshot` in the component,
 * is untestable without a DOM harness and silently re-breakable.
 */
export async function persistConfig(config: CaptureConfig): Promise<void> {
  await saveConfig($state.snapshot(config));
}
