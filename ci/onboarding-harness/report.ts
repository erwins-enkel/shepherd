import type { ScenarioResult } from "./types";

/** A scenario that THREW before its diagnostics could be evaluated — the
 *  catch-block fallback sentinel (an error paired with no detection and no
 *  recorded misses). This is an INFRASTRUCTURE failure (image-not-found, seed/boot
 *  crash), NOT a product detection gap: the instance never booted far enough to
 *  test Shepherd, so blaming detection would be a misclassification (and reads as a
 *  Shepherd onboarding defect when it's really image rot). A throw AFTER detection
 *  ran keeps its real detection result (non-empty misses or detected=true) and is
 *  classified as a normal gap instead. */
function isHarnessError(r: ScenarioResult): boolean {
  return !!r.error && !r.detection.detected && r.detection.misses.length === 0;
}

type Classification =
  | "PASS"
  | "DETECTION GAP"
  | "ADVICE GAP"
  | "INSTALL GAP"
  | "DETECTION-ONLY"
  | "HARNESS ERROR";

/** Pure: render the per-scenario outcomes as a markdown gap report. Classifies
 *  each scenario as PASS, DETECTION GAP (defect missed/misclassified), ADVICE GAP
 *  (detected but coaching didn't reach green), INSTALL GAP (the install-e2e scenario
 *  didn't reach green — an installer regression, NOT a detection failure, since it
 *  has no seeded defect), DETECTION-ONLY (detected with no apply attempted by
 *  design — e.g. claude-missing in Phase 1; NOT a gap), or HARNESS ERROR (threw
 *  before detection — infra/image-rot, not a product gap). The green tally counts
 *  only apply-able scenarios so detection-only AND harness-errored ones don't drag
 *  the denominator. */
function classify(r: ScenarioResult): Classification {
  if (isHarnessError(r)) return "HARNESS ERROR";
  // install-e2e has no seeded defect, so a miss is an installer regression — never
  // label it a DETECTION GAP (which reads as "a defect was missed").
  if (r.installE2E) return r.reachedGreen ? "PASS" : "INSTALL GAP";
  if (r.detectionOnly) return r.detection.detected ? "DETECTION-ONLY" : "DETECTION GAP";
  if (r.reachedGreen) return "PASS";
  return r.detection.detected ? "ADVICE GAP" : "DETECTION GAP";
}

/** Gate regressions: a gate-eligible (deterministic) scenario that didn't reach
 *  green. These — and only these — drive the release verdict (status + issue).
 *  Prose/agent + detection-only scenarios are reported but never gate. */
export function gateGapScenarios(results: ScenarioResult[]): ScenarioResult[] {
  return results.filter((r) => r.gateEligible && !r.reachedGreen);
}

/** One-line GATE outcome for a commit-status description (≤140 chars on the
 *  wire) — scoped to the deterministic subset, so an informational prose/agent
 *  gap (e.g. git-missing) doesn't flip the release verdict. */
export function statusDescription(results: ScenarioResult[]): string {
  const gate = results.filter((r) => r.gateEligible);
  const green = gate.filter((r) => r.reachedGreen).length;
  const gaps = gateGapScenarios(results);
  return gaps.length === 0
    ? `${green}/${gate.length} gate scenarios green`
    : `${gaps.length} gate gap(s): ${gaps.map((g) => g.scenarioId).join(", ")}`;
}

function tableRow(r: ScenarioResult, klass: Classification): string {
  return `| ${r.scenarioId} | ${r.image} | ${r.detection.detected ? "yes" : "no"} | ${r.appliedVia} | ${r.reachedGreen ? "yes" : "no"} | ${klass} |`;
}

function gapEntry(
  r: ScenarioResult,
  klass: "DETECTION GAP" | "ADVICE GAP" | "INSTALL GAP",
): string {
  const misses = r.detection.misses.map((m) => `${m.id} want=${m.want} got=${m.got}`).join("; ");
  return `- **${r.scenarioId}** (${klass})${misses ? ` — ${misses}` : ""}${r.error ? ` — ${r.error}` : ""}`;
}

function harnessErrorEntry(r: ScenarioResult): string {
  return `- **${r.scenarioId}** (HARNESS ERROR — infra, not a product gap)${r.error ? ` — ${r.error}` : ""}`;
}

export function buildGapReport(results: ScenarioResult[]): string {
  // Both detection-only (by design) and harness-errored (never booted) scenarios
  // are excluded from the green ratio — neither got a fair coaching attempt, so
  // counting them as non-green would read as a product regression.
  const harnessErrored = results.filter(isHarnessError);
  const applicable = results.filter((r) => !r.detectionOnly && !isHarnessError(r));
  const green = applicable.filter((r) => r.reachedGreen).length;
  const detectionOnly = results.filter((r) => r.detectionOnly && !isHarnessError(r)).length;
  const lines: string[] = [
    "# Onboarding Gap Report",
    "",
    `**${green} / ${applicable.length} scenarios reached green.**` +
      (detectionOnly ? ` (${detectionOnly} detection-only, by design — excluded.)` : "") +
      (harnessErrored.length
        ? ` (${harnessErrored.length} harness error${harnessErrored.length > 1 ? "s" : ""} — infra, excluded.)`
        : ""),
    "",
    "| Scenario | Image | Detected | Applied | Green | Classification |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const gaps: string[] = [];
  const errors: string[] = [];
  for (const r of results) {
    const klass = classify(r);
    lines.push(tableRow(r, klass));
    if (klass === "DETECTION GAP" || klass === "ADVICE GAP" || klass === "INSTALL GAP") {
      gaps.push(gapEntry(r, klass));
    } else if (klass === "HARNESS ERROR") {
      errors.push(harnessErrorEntry(r));
    }
  }
  if (gaps.length) {
    lines.push("", "## Gaps", "", ...gaps);
  }
  if (errors.length) {
    lines.push("", "## Harness errors", "", ...errors);
  }
  return lines.join("\n") + "\n";
}
