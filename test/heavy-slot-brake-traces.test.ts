import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultHeavySlotBudget } from "../src/heavy-slot-core";
import {
  metrics,
  replay,
  type ReplayMetrics,
  type Trace,
} from "../scripts/pressure-calibration/core";

// Measured memory-pressure traces (#3589) replayed through the real brake with the shipped
// defaults. Each fixture is one calibration run on an isolated runner (5 s ticks, as the service
// sweeps), labelled with the unhealthy episodes its interactive probe saw. Provenance and method:
// docs/verification/pressure-brake-3589.md.

const DIR = join(import.meta.dir, "fixtures", "heavy-slot-brake-traces");
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map(
    (f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Trace & { expected: ReplayMetrics },
  );

test("measured traces are present", () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(2);
});

for (const trace of fixtures) {
  describe(`brake on measured trace ${trace.label}`, () => {
    const budget = defaultHeavySlotBudget({ cpus: trace.cpus, memTotalBytes: trace.memTotalBytes });
    const engaged = replay(trace.ticks, budget);
    const m = metrics(trace, engaged);

    test("engages at or before every unhealthy episode", () => {
      expect(m.covered).toBe(trace.episodes.length);
    });

    test("holds back at least as many jobs headed into an episode as at calibration", () => {
      expect(m.held).toBeGreaterThanOrEqual(trace.expected.held);
    });

    test("holds back no more harmless jobs, and flaps no more, than at calibration", () => {
      expect(m.blocked).toBeLessThanOrEqual(trace.expected.blocked);
      expect(m.flaps).toBeLessThanOrEqual(trace.expected.flaps);
    });

    test("lets go only after the hold, and is off once the load is gone", () => {
      const over = trace.ticks.map(
        (k) =>
          (k.availableBytes !== null && k.availableBytes < budget.minAvailableBytes) ||
          (k.psiFullAvg10 !== null && k.psiFullAvg10 > budget.psiFullMax),
      );
      engaged.forEach((on, k) => {
        if (k === 0 || on || !engaged[k - 1]) return;
        const lastOver = over.slice(0, k).lastIndexOf(true);
        expect(trace.ticks[k]!.t - trace.ticks[lastOver]!.t).toBeGreaterThanOrEqual(
          budget.releaseHoldMs,
        );
      });
      // A trace cut off by the runner dying under pressure never sees the load go away.
      const lastOver = over.lastIndexOf(true);
      const calmFor = lastOver < 0 ? Infinity : trace.ticks.at(-1)!.t - trace.ticks[lastOver]!.t;
      if (calmFor > budget.releaseHoldMs) expect(engaged.at(-1)).toBe(false);
    });
  });
}
