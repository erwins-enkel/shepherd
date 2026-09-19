// Unit tests for the nightly drift gate (`scripts/eval-drift.ts`, issue #2377).
//
// HERMETIC: every test builds a report literal. No key, no network, no fixture run — the whole
// point of the gate being a pure function of (report, baseline).

import { describe, expect, test } from "bun:test";

import { DETAIL_MODEL_KEY } from "../scripts/eval-core";
import {
  ACCURACY_TOLERANCE,
  COVERAGE_TOLERANCE,
  FLIP_RATE_CEILING,
  accuracyOf,
  answeringModels,
  captureBaseline,
  coverageOf,
  driftCheck,
  fixtureFlip,
  flipRate,
  formatDrift,
  parseBaseline,
  parseReport,
  type DriftBaseline,
  type Report,
  type ReportFixture,
} from "../scripts/eval-drift";

const MODEL = "jev-1.13.0";

function fixture(over: Partial<ReportFixture> & { id: string }): ReportFixture {
  return {
    gating: true,
    trials: 5,
    counts: { gate: 5, question: 0, unknown: 0 },
    correct: 5,
    uncovered: 0,
    trialDetails: Array.from({ length: over.trials ?? 5 }, () => ({
      kind: { type: "choice", choice: "gate" },
      [DETAIL_MODEL_KEY]: MODEL,
    })),
    ...over,
  };
}

function report(over: Partial<Report> = {}): Report {
  return {
    model: MODEL,
    backend: "jev",
    decision: { pass: true, failures: [] },
    results: [fixture({ id: "gate-commit-now" }), fixture({ id: "ambiguous-unknown" })],
    ...over,
  };
}

/** The condition the gate reached, by id — the shape every assertion below reads. */
function statusOf(result: ReturnType<typeof driftCheck>, id: string): string {
  return result.conditions.find((c) => c.id === id)?.status ?? "absent";
}

describe("parseReport", () => {
  test("rejects a report that is not one", () => {
    expect(() => parseReport({})).toThrow(/no model/);
    expect(() => parseReport({ model: "m", backend: "jev" })).toThrow(/no decision/);
  });

  test("rejects a report predating the coverage tally rather than assuming full coverage", () => {
    const stale = report();
    delete (stale.results[0] as Partial<ReportFixture>).uncovered;
    expect(() => parseReport(stale)).toThrow(/predates the coverage tally/);
  });

  test("accepts a current report", () => {
    expect(parseReport(report()).backend).toBe("jev");
  });
});

describe("measures", () => {
  test("accuracy and coverage are trial-weighted", () => {
    const fixtures = [
      { trials: 9, correct: 9, uncovered: 0 },
      { trials: 1, correct: 0, uncovered: 1 },
    ];
    expect(accuracyOf(fixtures)).toBeCloseTo(0.9, 10);
    expect(coverageOf(fixtures)).toBeCloseTo(0.9, 10);
  });

  test("an empty set is 0, not NaN", () => {
    expect(accuracyOf([])).toBe(0);
    expect(coverageOf([])).toBe(0);
  });

  test("fixtureFlip is the fraction of answers that changed", () => {
    const before = { trials: 5, counts: { gate: 5, question: 0 } };
    expect(fixtureFlip(before, { trials: 5, counts: { gate: 5, question: 0 } })).toBe(0);
    expect(fixtureFlip(before, { trials: 5, counts: { gate: 4, question: 1 } })).toBeCloseTo(
      0.2,
      10,
    );
    expect(fixtureFlip(before, { trials: 5, counts: { gate: 0, question: 5 } })).toBeCloseTo(1, 10);
  });

  test("fixtureFlip normalises, so a changed trial count is not drift", () => {
    expect(
      fixtureFlip({ trials: 5, counts: { gate: 5 } }, { trials: 9, counts: { gate: 9 } }),
    ).toBe(0);
  });

  test("fixtureFlip counts a label only one side has", () => {
    expect(
      fixtureFlip(
        { trials: 4, counts: { gate: 4 } },
        { trials: 4, counts: { gate: 3, finished: 1 } },
      ),
    ).toBeCloseTo(0.25, 10);
  });

  test("flipRate names the fixtures that moved and ignores ones the baseline lacks", () => {
    const baseline = captureBaseline(report());
    const moved = report({
      results: [
        fixture({ id: "gate-commit-now", counts: { gate: 3, question: 2, unknown: 0 } }),
        fixture({ id: "ambiguous-unknown" }),
        fixture({ id: "brand-new" }),
      ],
    });
    const flip = flipRate(baseline, moved.results);
    expect(flip.moved).toEqual(["gate-commit-now"]);
    // 0.4 on one of two baselined fixtures, each 5 trials.
    expect(flip.rate).toBeCloseTo(0.2, 10);
  });

  test("answeringModels reads the reserved detail key and de-duplicates", () => {
    expect(answeringModels(report())).toEqual([MODEL]);
    expect(answeringModels(report({ results: [fixture({ id: "a", trialDetails: [] })] }))).toEqual(
      [],
    );
  });
});

describe("captureBaseline", () => {
  test("round-trips, and its own report then checks clean", () => {
    const run = report();
    const baseline = parseBaseline(JSON.parse(JSON.stringify(captureBaseline(run))));
    expect(baseline.model).toBe(MODEL);
    expect(Object.keys(baseline.fixtures).sort()).toEqual(["ambiguous-unknown", "gate-commit-now"]);
    const result = driftCheck(run, baseline);
    expect(result.pass).toBe(true);
    expect(result.conditions.every((c) => c.status === "pass")).toBe(true);
  });

  test("falls back to the requested model when the backend records none", () => {
    const run = report({ results: [fixture({ id: "a", trialDetails: [] })] });
    expect(captureBaseline(run).model).toBe(MODEL);
  });

  test("parseBaseline rejects a blob that is not one", () => {
    expect(() => parseBaseline({ version: 2 })).toThrow(/version\/model/);
    expect(() => parseBaseline({ version: 1, model: "m" })).toThrow(/no fixtures/);
  });
});

describe("driftCheck", () => {
  const baseline = captureBaseline(report());

  test("condition 1 is restated from the eval's own verdict, with no figures", () => {
    const missed = report({ decision: { pass: false, failures: ["de-gate-commit"] } });
    const result = driftCheck(missed, baseline);
    expect(statusOf(result, "floor")).toBe("fail");
    expect(result.pass).toBe(false);
    expect(formatDrift(result, missed)).toContain("de-gate-commit");
  });

  test("condition 2 fires only past the tolerance", () => {
    // 2/10 correct lost = -0.2, well past 0.02.
    const worse = report({
      results: [
        fixture({ id: "gate-commit-now", correct: 3 }),
        fixture({ id: "ambiguous-unknown" }),
      ],
    });
    expect(statusOf(driftCheck(worse, baseline), "accuracy")).toBe("fail");

    // One trial in ten is 0.1 — also past it; the tolerance exists for rounding, not for a miss.
    const better = report({
      results: [
        fixture({ id: "gate-commit-now", correct: 5 }),
        fixture({ id: "ambiguous-unknown", correct: 5 }),
      ],
    });
    expect(statusOf(driftCheck(better, baseline), "accuracy")).toBe("pass");
    expect(ACCURACY_TOLERANCE).toBeGreaterThan(0);
  });

  test("condition 3 catches coverage falling while every answer stays right", () => {
    // Two of ten trials escalated; accuracy on what came back is untouched.
    const escalating = report({
      results: [
        fixture({ id: "gate-commit-now", uncovered: 2 }),
        fixture({ id: "ambiguous-unknown" }),
      ],
    });
    const result = driftCheck(escalating, baseline);
    expect(statusOf(result, "coverage")).toBe("fail");
    expect(statusOf(result, "accuracy")).toBe("pass");
    expect(result.pass).toBe(false);
    expect(COVERAGE_TOLERANCE).toBeGreaterThan(0);
  });

  test("coverage inside the tolerance passes", () => {
    const blip = report({
      results: [
        fixture({ id: "gate-commit-now", uncovered: 1 }),
        fixture({ id: "ambiguous-unknown" }),
      ],
    });
    expect(statusOf(driftCheck(blip, baseline), "coverage")).toBe("pass");
  });

  test("the flip rate catches churn that nets out to the same accuracy", () => {
    // A baseline that is NOT perfect, so churn has somewhere to net out TO.
    const before = report({
      results: [
        fixture({
          id: "gate-commit-now",
          counts: { gate: 3, question: 2, unknown: 0 },
          correct: 3,
        }),
        fixture({
          id: "ambiguous-unknown",
          counts: { gate: 0, question: 0, unknown: 5 },
          correct: 5,
        }),
      ],
    });
    // The two fixtures swap places: 8/10 correct before, 8/10 after, and every distribution moved.
    const churned = report({
      results: [
        fixture({
          id: "gate-commit-now",
          counts: { gate: 5, question: 0, unknown: 0 },
          correct: 5,
        }),
        fixture({
          id: "ambiguous-unknown",
          counts: { gate: 2, question: 0, unknown: 3 },
          correct: 3,
        }),
      ],
    });
    const result = driftCheck(churned, captureBaseline(before));
    expect(statusOf(result, "accuracy")).toBe("pass");
    expect(statusOf(result, "flip-rate")).toBe("fail");
    expect(result.pass).toBe(false);
    expect(FLIP_RATE_CEILING).toBeGreaterThan(0);
  });

  test("condition 4 fires when something other than the pinned model answered", () => {
    const repointed = report({
      results: [
        fixture({
          id: "gate-commit-now",
          trialDetails: [{ kind: { choice: "gate" }, [DETAIL_MODEL_KEY]: "jev-1.14.0" }],
        }),
      ],
    });
    const result = driftCheck(repointed, baseline);
    expect(statusOf(result, "model-pin")).toBe("fail");
    expect(formatDrift(result, repointed)).toContain("jev-1.14.0");
  });

  test("condition 4 fires when the baseline was captured against another model", () => {
    const older: DriftBaseline = { ...baseline, model: "jev-1.12.0" };
    expect(statusOf(driftCheck(report(), older), "model-pin")).toBe("fail");
  });

  test("condition 4 is skipped, not passed, on a backend recording no model", () => {
    const anthropic = report({
      backend: "anthropic",
      model: "claude-haiku-4-5",
      results: [fixture({ id: "gate-commit-now", trialDetails: undefined })],
    });
    expect(statusOf(driftCheck(anthropic, null), "model-pin")).toBe("skipped");
  });

  test("no baseline is the bootstrapping state: skipped, warned, still green", () => {
    const result = driftCheck(report(), null);
    expect(result.pass).toBe(true);
    for (const id of ["accuracy", "coverage", "flip-rate", "baseline"]) {
      expect(statusOf(result, id)).toBe("skipped");
    }
    expect(statusOf(result, "model-pin")).toBe("pass");
    expect(formatDrift(result, report())).toContain("NOT checked");
  });

  test("a stale baseline FAILS and names what moved, rather than quietly retiring the gate", () => {
    const grown = report({
      results: [
        fixture({ id: "gate-commit-now" }),
        fixture({ id: "ambiguous-unknown" }),
        fixture({ id: "de-gate-commit" }),
      ],
    });
    const result = driftCheck(grown, baseline);
    expect(statusOf(result, "baseline")).toBe("fail");
    expect(result.pass).toBe(false);
    // The baseline-relative conditions cannot be trusted against a moved fixture set.
    for (const id of ["accuracy", "coverage", "flip-rate"]) {
      expect(statusOf(result, id)).toBe("skipped");
    }
    const text = formatDrift(result, grown);
    expect(text).toContain("de-gate-commit");
    expect(text).toContain("--capture");
  });

  test("only gating fixtures decide; a baseline fixture moving does not", () => {
    const base = captureBaseline(
      report({
        results: [
          fixture({ id: "gate-commit-now" }),
          fixture({ id: "gate-spec-first", gating: false }),
        ],
      }),
    );
    const moved = report({
      results: [
        fixture({ id: "gate-commit-now" }),
        fixture({
          id: "gate-spec-first",
          gating: false,
          counts: { gate: 0, question: 5, unknown: 0 },
          correct: 0,
          uncovered: 3,
        }),
      ],
    });
    const result = driftCheck(moved, base);
    expect(result.pass).toBe(true);
  });
});

describe("formatDrift redaction (MCA §2.3(f))", () => {
  // The whole output of this script lands in a PUBLIC workflow log. Deltas against the SECRET
  // baseline are safe; an accuracy or coverage LEVEL is not, and neither is a fraction like
  // "33/34" or a percentage — either one is an absolute figure about the Services.
  const failing = report({
    decision: { pass: false, failures: ["ambiguous-unknown"] },
    results: [
      fixture({ id: "gate-commit-now", correct: 1, uncovered: 3 }),
      fixture({
        id: "ambiguous-unknown",
        counts: { gate: 5, question: 0, unknown: 0 },
        correct: 0,
      }),
    ],
  });
  const runs: [string, Report, DriftBaseline | null][] = [
    ["clean", report(), captureBaseline(report())],
    ["no baseline", report(), null],
    ["failing", failing, captureBaseline(report())],
  ];

  for (const [name, run, baseline] of runs) {
    const result = driftCheck(run, baseline);
    const text = formatDrift(result, run);

    test(`${name}: no percentage and no n/m fraction anywhere`, () => {
      expect(text).not.toMatch(/\d\s*%/);
      expect(text).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
    });

    test(`${name}: the measured conditions report only deltas and tolerances`, () => {
      // Scanned per condition rather than over the whole text: the header and the model-pin line
      // legitimately carry a model id like `jev-1.13.0`, which is a version, not a figure.
      const measured = result.conditions.filter((c) =>
        ["accuracy", "coverage", "flip-rate"].includes(c.id),
      );
      for (const condition of measured) {
        for (const value of condition.detail.match(/[+-]?\d+\.\d+/g) ?? []) {
          const allowed =
            value.startsWith("+") ||
            value.startsWith("-") ||
            [ACCURACY_TOLERANCE, COVERAGE_TOLERANCE, FLIP_RATE_CEILING].includes(Number(value)) ||
            // The flip rate itself: a movement against the secret baseline, not a level.
            (condition.id === "flip-rate" && Number(value) >= 0 && Number(value) <= 1);
          expect(allowed).toBe(true);
        }
      }
    });

    test(`${name}: never prints an accuracy or coverage level`, () => {
      for (const condition of result.conditions) {
        expect(condition.detail).not.toMatch(/\baccuracy is\b|\bcoverage is\b/);
      }
    });
  }

  test("the header says the figures are relative", () => {
    expect(formatDrift(driftCheck(report(), null), report())).toContain("RELATIVE");
  });
});

test("a fixture PROMOTED to gating is staleness, not a silent change of what is compared", () => {
  // The id set is identical, so only the gating flag names it — and without that the deltas below
  // would be computed over a different set on each side.
  const before = captureBaseline(
    report({
      results: [
        fixture({ id: "gate-commit-now" }),
        fixture({ id: "gate-spec-first", gating: false }),
      ],
    }),
  );
  const promoted = report({
    results: [fixture({ id: "gate-commit-now" }), fixture({ id: "gate-spec-first", gating: true })],
  });
  const result = driftCheck(promoted, before);
  expect(result.conditions.find((c) => c.id === "baseline")?.status).toBe("fail");
  expect(result.pass).toBe(false);
  expect(formatDrift(result, promoted)).toContain("gating flag changed");
});

test("parseReport rejects a result missing the fields the conditions read", () => {
  const broken = report();
  delete (broken.results[0] as Partial<ReportFixture>).counts;
  expect(() => parseReport(broken)).toThrow(/gating\/correct\/counts/);
});
