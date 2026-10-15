// Pure display logic for the Readiness "Framework majors" section (#3113) — out of the .svelte
// file so it's unit-testable without a DOM. Rows come verbatim from the server.
import type { DriftRow, FrameworkDrift } from "#lib/types.js";

/** Packages a major (or 0.x minor) behind the registry's current stable line. */
export function behindRows(d: FrameworkDrift): DriftRow[] {
  return d.rows.filter((r) => r.state === "behind");
}

/** The epic hint shows when an upgrade would collide with epic work in flight. */
export function hasEpicWork(d: FrameworkDrift): boolean {
  return d.runningEpic !== null || d.epicBranches.length > 0;
}

/** `installed → target (latest)` for a row behind, `installed (latest)` when current, and
 *  `installed · unknown` when the registry lookup failed. */
export function lineLabel(r: DriftRow, unknown: string): string {
  if (r.latest === null || r.target === null) return `${r.installed} · ${unknown}`;
  if (r.state === "behind") return `${r.installed} → ${r.target} (${r.latest})`;
  return `${r.installed} (${r.latest})`;
}
