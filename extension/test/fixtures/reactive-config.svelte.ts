import { DEFAULT_CONFIG } from "../../src/lib/config";
import type { CaptureConfig, RoutingRule } from "../../src/lib/types";

// A genuine deeply-reactive $state proxy, mirroring how Options.svelte holds the
// settings form — so a test can exercise the real persistConfig snapshot path
// (a plain object can't stand in for the proxy this guards against).
export function reactiveConfig(rules: RoutingRule[]): CaptureConfig {
  // `$state(...)` must initialize a declaration (compiler restriction), so bind
  // it to a local before returning the proxy.
  const config = $state<CaptureConfig>({ ...DEFAULT_CONFIG, routingRules: rules });
  return config;
}
