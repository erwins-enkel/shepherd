import { DEFAULT_CONFIG } from "../../src/lib/config";
import type { CaptureConfig, RoutingRule } from "../../src/lib/types";

// A genuine deeply-reactive $state proxy, mirroring how Options.svelte holds the
// settings form. Used to reproduce the structured-clone persistence bug that a
// plain object cannot exercise.
export function reactiveConfig(rules: RoutingRule[]): CaptureConfig {
  // `$state(...)` must initialize a declaration (compiler restriction), so bind
  // it to a local before returning the proxy.
  const config = $state<CaptureConfig>({ ...DEFAULT_CONFIG, routingRules: rules });
  return config;
}

// The snapshot Options.svelte takes before persisting.
export function snapshotConfig(config: CaptureConfig): CaptureConfig {
  return $state.snapshot(config) as CaptureConfig;
}
