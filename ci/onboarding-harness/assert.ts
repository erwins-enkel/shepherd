import type { DiagnosticsSnapshot } from "../../src/types";
import type { DetectionResult, ExpectedCheck } from "./types";

/** Pure: does the captured snapshot flag every expected check at its expected
 *  state? Any mismatch (wrong state, or check absent) is a detection gap. */
export function assertDetection(
  snapshot: DiagnosticsSnapshot,
  scenarioId: string,
  expected: ExpectedCheck[],
): DetectionResult {
  const byId = new Map(snapshot.checks.map((c) => [c.id, c.state]));
  const misses: DetectionResult["misses"] = [];
  for (const e of expected) {
    const got = byId.get(e.id) ?? "absent";
    if (got !== e.state) misses.push({ id: e.id, want: e.state, got });
  }
  return { scenarioId, detected: misses.length === 0, misses };
}
