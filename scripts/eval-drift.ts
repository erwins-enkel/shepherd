#!/usr/bin/env bun
// Nightly DRIFT GATE over a finished eval run (issue #2377).
//
// WHY THIS IS NOT "DID ACCURACY FALL". `docs/research/jev-ecosystem-scan.md` §2.2 records the shape
// `abhixhek/jevcal` arrived at, and it is better than a bare accuracy check in two ways that matter
// here:
//
//   - COVERAGE. More traffic escalating to the fallback is drift even when every answer that DID
//     come back was right. A pure accuracy gate misses it entirely, and it is the condition that
//     degrades first when a vendor starts rate-limiting or slowing down.
//   - THE PINNED VERSION. We pin `jev-1.13.0` precisely so a vendor re-point cannot arrive
//     disguised as an accuracy change. That pin is worth nothing unless something compares it
//     against the model that actually answered.
//
// Plus a FLIP RATE: the fraction of answers that changed against the baseline, which catches churn
// that nets out to the same accuracy.
//
// WHAT GATES WHERE. Condition 1 of that set — "accepted accuracy below target" — already exists and
// is stricter than jevcal's: `decide()` in `eval-core.ts` requires every gating fixture to be
// majority-correct AND gating accuracy to clear the pinned floor, with no tolerance. This file does
// not reimplement it; it RESTATES its verdict (pass/fail plus the failing fixture ids) so the CI
// log has one coherent summary, and owns conditions 2-4 and the flip rate.
//
// ── THE REDACTION RULE, WHICH IS EASY TO GET BACKWARDS ──
//
// TypeSafe's MCA §2.3(f) forbids publishing figures about the Services, and this repository is
// public — so is every line this script prints into a workflow log. The rule that follows:
//
//   - A delta against the BASELINE is safe. The baseline lives in a repo secret
//     (`JEV_EVAL_BASELINE`), never in the tree, so a delta discloses nothing absolute.
//   - A result measured against an IN-TREE CONSTANT (the accuracy floor) is reported as pass/fail
//     ONLY. The constant is public, so "0.03 below the floor" is an absolute figure written in
//     relative clothing.
//
// Nothing here prints an accuracy or a coverage level. `test/eval-drift.test.ts` asserts that.
//
// PURE + CLI: every condition is a function of (report, baseline). Tests build report literals —
// no key, no network, no fixture run.
//
// Usage:
//   bun run scripts/eval-drift.ts <report.json> --capture            # print a baseline blob
//   bun run scripts/eval-drift.ts <report.json> [--baseline <file>]  # check for drift
//
// With no `--baseline`, the blob is read from the `JEV_EVAL_BASELINE` environment variable. With
// neither, the baseline-dependent conditions are skipped (the bootstrapping state) rather than
// invented.

import { DETAIL_MODEL_KEY, EXIT } from "./eval-core";

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------

/**
 * NON-ZERO ON PURPOSE. The API rounds probabilities to two decimals and identical requests can
 * return different answers — near-determinism is not determinism, and #2364 watched confidence
 * drift marginally across identical requests. A zero-tolerance gate would flake nightly and then
 * be ignored, which is worse than no gate.
 *
 * The values are jevcal's, which were tuned on far more traffic than we have: a drop of more than
 * 0.02 in accuracy or 0.10 in coverage against the locked baseline. The flip-rate ceiling has no
 * upstream precedent, so it is set at 0.10 — roughly three of the gating trial set — loose enough
 * that rounding cannot reach it and tight enough that a genuine re-point cannot hide under it.
 */
export const ACCURACY_TOLERANCE = 0.02;
export const COVERAGE_TOLERANCE = 0.1;
export const FLIP_RATE_CEILING = 0.1;

// ---------------------------------------------------------------------------
// The report, as this script reads it
// ---------------------------------------------------------------------------

export interface ReportFixture {
  id: string;
  gating: boolean;
  trials: number;
  counts: Record<string, number>;
  correct: number;
  uncovered: number;
  trialDetails?: Record<string, unknown>[];
}

export interface Report {
  /** The model the run ASKED for — `run.model`, which is the pinned snapshot unless overridden. */
  model: string;
  backend: string;
  decision: { pass: boolean; failures: string[] };
  results: ReportFixture[];
}

/**
 * A tally the measures divide by or sum: a finite, non-negative number.
 *
 * Checked rather than assumed because of how the arithmetic FAILS. An absent or non-numeric tally
 * reduces a delta to `NaN`, and `NaN < -TOLERANCE` and `NaN > CEILING` are BOTH false — so every
 * condition reading it reports PASS off no data at all, and the nightly goes green on a gate that
 * measured nothing. There is no value to fall back to: a missing tally is a broken input, not a
 * zero.
 */
function validTally(value: unknown, min = 0): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min;
}

/** Every count must be a finite number for the same reason — `fixtureFlip` divides by them. */
function validCounts(counts: unknown): boolean {
  if (typeof counts !== "object" || counts === null) return false;
  return Object.values(counts as Record<string, unknown>).every((n) => validTally(n));
}

/** Read a `--json` report, rejecting anything whose shape the conditions below cannot trust.
 *  Throws rather than degrading: a silently half-read report would gate on half a measurement. */
export function parseReport(raw: unknown): Report {
  const report = raw as Partial<Report> | null;
  if (!report || typeof report.model !== "string" || typeof report.backend !== "string") {
    throw new Error("not an eval --json report: no model/backend");
  }
  const decision = report.decision as Report["decision"] | undefined;
  if (!decision || typeof decision.pass !== "boolean" || !Array.isArray(decision.failures)) {
    throw new Error("not an eval --json report: no decision");
  }
  if (!Array.isArray(report.results) || report.results.length === 0) {
    throw new Error("not an eval --json report: no results");
  }
  for (const fixture of report.results) {
    if (typeof fixture?.id !== "string" || typeof fixture.trials !== "number") {
      throw new Error("not an eval --json report: a result has no id/trials");
    }
    if (
      typeof fixture.gating !== "boolean" ||
      !validTally(fixture.correct) ||
      !validTally(fixture.trials, 1) ||
      !validCounts(fixture.counts)
    ) {
      throw new Error(
        `not an eval --json report: fixture "${fixture.id}" has no usable gating/trials/correct/counts`,
      );
    }
    if (typeof fixture.uncovered !== "number") {
      // The tally landed with this gate. A report without it predates #2377, and treating its
      // absence as "fully covered" would report a clean coverage condition off no data at all.
      throw new Error(
        `report predates the coverage tally (#2377): fixture "${fixture.id}" has no \`uncovered\`. ` +
          "Re-run the eval to produce a readable report.",
      );
    }
  }
  return report as Report;
}

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

/**
 * The LOCKED baseline, distilled from one run's report.
 *
 * Deliberately small, and deliberately NOT committed: `expected` labels are already in the tree, so
 * per-fixture answers published next to them make accuracy derivable — exactly what #2371 redacted.
 * It lives in the `JEV_EVAL_BASELINE` repo secret; `--capture` prints it for the operator.
 */
export interface DriftBaseline {
  version: 1;
  capturedAt: string;
  /** The model that ANSWERED at capture time, as the backend reported it. */
  model: string;
  fixtures: Record<
    string,
    {
      gating: boolean;
      trials: number;
      counts: Record<string, number>;
      correct: number;
      uncovered: number;
    }
  >;
}

export function captureBaseline(report: Report, now = new Date()): DriftBaseline {
  const fixtures: DriftBaseline["fixtures"] = {};
  for (const f of report.results) {
    fixtures[f.id] = {
      gating: f.gating,
      trials: f.trials,
      counts: f.counts,
      correct: f.correct,
      uncovered: f.uncovered,
    };
  }
  return {
    version: 1,
    capturedAt: now.toISOString(),
    // The answering model when one was recorded, else the requested one — so a baseline captured on
    // a backend that reports no model still pins something rather than an empty string.
    model: answeringModels(report)[0] ?? report.model,
    fixtures,
  };
}

export function parseBaseline(raw: unknown): DriftBaseline {
  const baseline = raw as Partial<DriftBaseline> | null;
  if (!baseline || baseline.version !== 1 || typeof baseline.model !== "string") {
    throw new Error("not a drift baseline: missing version/model");
  }
  if (!baseline.fixtures || typeof baseline.fixtures !== "object") {
    throw new Error("not a drift baseline: no fixtures");
  }
  // Validated ENTRY BY ENTRY, as strictly as `parseReport` validates a report — stricter, if
  // anything, because this is the one input on this path a human pastes by hand (the
  // `JEV_EVAL_BASELINE` secret) rather than one the harness generated. An entry missing a tally
  // does not weaken the gate, it SILENTLY RETIRES three of its conditions; see `validTally`.
  for (const [id, entry] of Object.entries(baseline.fixtures)) {
    const fixture = entry as Partial<DriftBaseline["fixtures"][string]> | null;
    if (
      !fixture ||
      typeof fixture.gating !== "boolean" ||
      !validTally(fixture.trials, 1) ||
      !validTally(fixture.correct) ||
      !validTally(fixture.uncovered) ||
      !validCounts(fixture.counts)
    ) {
      throw new Error(
        `drift baseline is malformed: fixture "${id}" has no usable gating/trials/correct/` +
          "uncovered/counts. Recapture it with `--capture` and update the JEV_EVAL_BASELINE secret.",
      );
    }
  }
  return baseline as DriftBaseline;
}

// ---------------------------------------------------------------------------
// The measures (all pure)
// ---------------------------------------------------------------------------

/** Trial-weighted accuracy over the given fixtures. */
export function accuracyOf(fixtures: { trials: number; correct: number }[]): number {
  const trials = fixtures.reduce((n, f) => n + f.trials, 0);
  if (trials === 0) return 0;
  return fixtures.reduce((n, f) => n + f.correct, 0) / trials;
}

/** Fraction of trials that produced a usable verdict on their first attempt — the eval's analogue
 *  of the traffic production does NOT escalate to the spawn. */
export function coverageOf(fixtures: { trials: number; uncovered: number }[]): number {
  const trials = fixtures.reduce((n, f) => n + f.trials, 0);
  if (trials === 0) return 0;
  return 1 - fixtures.reduce((n, f) => n + f.uncovered, 0) / trials;
}

/**
 * How much one fixture's answers moved, as TOTAL-VARIATION DISTANCE between the baseline and
 * current label distributions.
 *
 * Trials are unordered identical requests, so pairing trial 3 with trial 3 would measure nothing.
 * Both sides are normalised to proportions first, so changing `--trials` between runs does not
 * register as drift. The result is exactly "the fraction of answers that changed", in [0, 1].
 */
export function fixtureFlip(
  before: { trials: number; counts: Record<string, number> },
  after: { trials: number; counts: Record<string, number> },
): number {
  if (before.trials === 0 || after.trials === 0) return 0;
  const labels = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
  let total = 0;
  for (const label of labels) {
    total += Math.abs(
      (after.counts[label] ?? 0) / after.trials - (before.counts[label] ?? 0) / before.trials,
    );
  }
  return total / 2;
}

export interface FlipReport {
  rate: number;
  /** Ids whose distribution moved at all, worst first — the diagnosis, and relative by nature. */
  moved: string[];
}

/** Current-trial-weighted mean flip over the fixtures present in both sides. PURE. */
export function flipRate(baseline: DriftBaseline, fixtures: ReportFixture[]): FlipReport {
  let weighted = 0;
  let trials = 0;
  const moved: { id: string; flip: number }[] = [];
  for (const fixture of fixtures) {
    const before = baseline.fixtures[fixture.id];
    if (!before) continue;
    const flip = fixtureFlip(before, fixture);
    weighted += flip * fixture.trials;
    trials += fixture.trials;
    if (flip > 0) moved.push({ id: fixture.id, flip });
  }
  moved.sort((a, b) => b.flip - a.flip || a.id.localeCompare(b.id));
  return { rate: trials === 0 ? 0 : weighted / trials, moved: moved.map((m) => m.id) };
}

/** The distinct models that ANSWERED, as the backend reported them per trial. Empty on a backend
 *  that records none (the Anthropic leg), which the pin condition reads as "not checkable". PURE. */
export function answeringModels(report: Report): string[] {
  const models = new Set<string>();
  for (const fixture of report.results) {
    for (const detail of fixture.trialDetails ?? []) {
      const model = detail[DETAIL_MODEL_KEY];
      if (typeof model === "string" && model !== "") models.add(model);
    }
  }
  return [...models].sort();
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type ConditionStatus = "pass" | "fail" | "skipped";

export interface DriftCondition {
  id: "floor" | "accuracy" | "coverage" | "flip-rate" | "model-pin" | "baseline";
  status: ConditionStatus;
  /** RELATIVE only — a delta against the secret baseline, a fixture id, or a verdict. Never an
   *  accuracy or coverage level. */
  detail: string;
}

export interface DriftResult {
  pass: boolean;
  conditions: DriftCondition[];
}

function signed(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`;
}

/** Condition 1, restated from the eval's own verdict. Pass/fail and fixture ids only: the floor is
 *  an in-tree constant, so any delta against it would disclose the absolute. */
function floorCondition(report: Report): DriftCondition {
  if (report.decision.pass) {
    return { id: "floor", status: "pass", detail: "gating set holds against the pinned floor" };
  }
  const failures = report.decision.failures;
  return {
    id: "floor",
    status: "fail",
    detail:
      "the eval's own gate failed" +
      (failures.length > 0
        ? ` — below majority: ${failures.join(", ")}`
        : " on the accuracy floor"),
  };
}

/** Condition 4. Two ways the pin can be wrong: the run was answered by something other than the
 *  model it asked for, or the baseline was captured against a different one. */
function modelPinCondition(report: Report, baseline: DriftBaseline | null): DriftCondition {
  const answered = answeringModels(report);
  if (answered.length === 0) {
    return {
      id: "model-pin",
      status: "skipped",
      detail: `the ${report.backend} backend records no answering model — nothing to compare`,
    };
  }
  const wrong = answered.filter((model) => model !== report.model);
  if (wrong.length > 0) {
    return {
      id: "model-pin",
      status: "fail",
      detail: `asked for ${report.model}, answered by ${wrong.join(", ")} — the thresholds were not tuned against it`,
    };
  }
  if (baseline && baseline.model !== report.model) {
    return {
      id: "model-pin",
      status: "fail",
      detail: `baseline was captured against ${baseline.model}, this run pins ${report.model} — recapture before trusting the deltas`,
    };
  }
  return { id: "model-pin", status: "pass", detail: `answered by the pinned ${report.model}` };
}

/** Has the fixture SET moved since the baseline was captured? A stale baseline fails loudly rather
 *  than warning: a warning would silently retire this gate the first time someone adds a fixture. */
function baselineCondition(baseline: DriftBaseline, fixtures: ReportFixture[]): DriftCondition {
  const now = new Set(fixtures.map((f) => f.id));
  const then = new Set(Object.keys(baseline.fixtures));
  const added = [...now].filter((id) => !then.has(id)).sort();
  const removed = [...then].filter((id) => !now.has(id)).sort();
  // A fixture PROMOTED to gating (or demoted from it) keeps the id set identical while changing
  // which fixtures the deltas below are computed over — so the two sides would silently stop
  // comparing the same thing. That is staleness too.
  const regated = fixtures
    .filter(
      (f) => baseline.fixtures[f.id] !== undefined && baseline.fixtures[f.id]!.gating !== f.gating,
    )
    .map((f) => f.id)
    .sort();
  if (added.length === 0 && removed.length === 0 && regated.length === 0) {
    return { id: "baseline", status: "pass", detail: `locked at ${baseline.capturedAt}` };
  }
  return {
    id: "baseline",
    status: "fail",
    detail:
      "STALE — the fixture set moved since capture" +
      (added.length > 0 ? `; added: ${added.join(", ")}` : "") +
      (removed.length > 0 ? `; missing from this run: ${removed.join(", ")}` : "") +
      (regated.length > 0 ? `; gating flag changed: ${regated.join(", ")}` : "") +
      ". Recapture with --capture and update the JEV_EVAL_BASELINE secret.",
  };
}

const SKIP_NO_BASELINE = "no baseline — set the JEV_EVAL_BASELINE secret from --capture";
const SKIP_STALE = "baseline is stale — recapture";

/** The baseline-relative conditions: 2 (accuracy), 3 (coverage) and the flip rate. Reported as
 *  deltas, which is safe precisely because the baseline is secret. */
function baselineRelative(baseline: DriftBaseline, gating: ReportFixture[]): DriftCondition[] {
  const before = Object.values(baseline.fixtures).filter((f) => f.gating);
  const accuracyDelta = accuracyOf(gating) - accuracyOf(before);
  const coverageDelta = coverageOf(gating) - coverageOf(before);
  const flip = flipRate(baseline, gating);
  return [
    {
      id: "accuracy",
      status: accuracyDelta < -ACCURACY_TOLERANCE ? "fail" : "pass",
      detail: `${signed(accuracyDelta)} vs baseline (tolerance ${ACCURACY_TOLERANCE})`,
    },
    {
      id: "coverage",
      status: coverageDelta < -COVERAGE_TOLERANCE ? "fail" : "pass",
      detail: `${signed(coverageDelta)} vs baseline (tolerance ${COVERAGE_TOLERANCE})`,
    },
    {
      id: "flip-rate",
      status: flip.rate > FLIP_RATE_CEILING ? "fail" : "pass",
      detail:
        `${flip.rate.toFixed(3)} of answers changed (ceiling ${FLIP_RATE_CEILING})` +
        (flip.moved.length > 0 ? ` — moved: ${flip.moved.join(", ")}` : ""),
    },
  ];
}

/**
 * The whole gate. Conditions are computed over GATING fixtures, matching `decide()`'s scope; the
 * baseline (non-gating) fixtures never gate anything, here or there. PURE.
 */
export function driftCheck(report: Report, baseline: DriftBaseline | null): DriftResult {
  const gating = report.results.filter((f) => f.gating);
  const conditions: DriftCondition[] = [floorCondition(report)];

  if (!baseline) {
    conditions.push(
      { id: "baseline", status: "skipped", detail: SKIP_NO_BASELINE },
      { id: "accuracy", status: "skipped", detail: SKIP_NO_BASELINE },
      { id: "coverage", status: "skipped", detail: SKIP_NO_BASELINE },
      { id: "flip-rate", status: "skipped", detail: SKIP_NO_BASELINE },
    );
  } else {
    const staleness = baselineCondition(baseline, report.results);
    conditions.push(staleness);
    if (staleness.status === "fail") {
      conditions.push(
        { id: "accuracy", status: "skipped", detail: SKIP_STALE },
        { id: "coverage", status: "skipped", detail: SKIP_STALE },
        { id: "flip-rate", status: "skipped", detail: SKIP_STALE },
      );
    } else {
      conditions.push(...baselineRelative(baseline, gating));
    }
  }

  conditions.push(modelPinCondition(report, baseline));
  return { pass: conditions.every((c) => c.status !== "fail"), conditions };
}

const MARK: Record<ConditionStatus, string> = { pass: "PASS", fail: "FAIL", skipped: "SKIP" };

/** The CI log's entire output. Relative by construction — see the redaction rule at the top. */
export function formatDrift(result: DriftResult, report: Report): string {
  const lines = [
    `drift check — backend=${report.backend} model=${report.model}`,
    "Figures are RELATIVE (MCA §2.3(f), public repo): deltas against the secret baseline, and",
    "pass/fail for anything measured against an in-tree constant. Re-run locally for absolutes.",
    "",
  ];
  for (const c of result.conditions) {
    lines.push(`  [${MARK[c.status]}] ${c.id.padEnd(10)} ${c.detail}`);
  }
  lines.push("");
  const skipped = result.conditions.filter((c) => c.status === "skipped");
  if (skipped.length > 0) {
    lines.push(`${skipped.length} condition(s) NOT checked — this gate is weaker than it looks.`);
  }
  lines.push(`DRIFT: ${result.pass ? "none" : "DETECTED"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "usage: bun run scripts/eval-drift.ts <report.json> [--baseline <file>] [--capture]\n" +
  "       with no --baseline, the blob is read from $JEV_EVAL_BASELINE";

/** Where the baseline comes from: an explicit file, else the environment, else nowhere — which is
 *  the bootstrapping state, not an error. */
async function loadBaseline(path: string | undefined): Promise<DriftBaseline | null> {
  if (path !== undefined) return parseBaseline(await Bun.file(path).json());
  const env = process.env.JEV_EVAL_BASELINE?.trim();
  if (!env) return null;
  return parseBaseline(JSON.parse(env));
}

async function cli(argv: string[]): Promise<number> {
  const flagged = new Set(["--baseline"]);
  const positional = argv.filter(
    (arg, i) => !arg.startsWith("--") && !flagged.has(argv[i - 1] ?? ""),
  );
  const reportPath = positional[0];
  if (reportPath === undefined) {
    console.error(USAGE);
    return EXIT.HARNESS_FAIL;
  }
  const baselineIndex = argv.indexOf("--baseline");
  const baselinePath = baselineIndex === -1 ? undefined : argv[baselineIndex + 1];
  if (baselineIndex !== -1 && (baselinePath === undefined || baselinePath.startsWith("--"))) {
    // Falling through to $JEV_EVAL_BASELINE here would answer a typo'd flag with a DIFFERENT
    // baseline than the one asked for, which is worse than refusing.
    console.error(`--baseline needs a file path\n${USAGE}`);
    return EXIT.HARNESS_FAIL;
  }
  const report = parseReport(await Bun.file(reportPath).json());

  if (argv.includes("--capture")) {
    // stdout, so it pipes straight into `gh secret set JEV_EVAL_BASELINE`.
    console.log(JSON.stringify(captureBaseline(report)));
    return EXIT.PASS;
  }

  const result = driftCheck(report, await loadBaseline(baselinePath));
  console.log(formatDrift(result, report));
  return result.pass ? EXIT.PASS : EXIT.GATE_FAIL;
}

if (import.meta.main) {
  try {
    process.exit(await cli(process.argv.slice(2)));
  } catch (err) {
    console.error(`[eval-drift] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.HARNESS_FAIL);
  }
}
