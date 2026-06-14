import type { ScenarioResult } from "./types";

/** Pure: render the per-scenario outcomes as a markdown gap report. Classifies
 *  each scenario as PASS, DETECTION GAP (defect missed/misclassified), ADVICE GAP
 *  (detected but coaching didn't reach green), or DETECTION-ONLY (detected with no
 *  apply attempted by design — e.g. claude-missing in Phase 1; NOT a gap). The
 *  green tally counts only apply-able scenarios so detection-only ones don't drag
 *  the denominator. */
function classify(r: ScenarioResult): "PASS" | "DETECTION GAP" | "ADVICE GAP" | "DETECTION-ONLY" {
  if (r.detectionOnly) return r.detection.detected ? "DETECTION-ONLY" : "DETECTION GAP";
  if (r.reachedGreen) return "PASS";
  return r.detection.detected ? "ADVICE GAP" : "DETECTION GAP";
}

/** Scenarios that represent a real regression worth flagging — a missed/
 *  misclassified defect (DETECTION GAP) or coaching that didn't heal it (ADVICE
 *  GAP). PASS and by-design DETECTION-ONLY are NOT gaps. */
export function gapScenarios(results: ScenarioResult[]): ScenarioResult[] {
  return results.filter((r) => {
    const k = classify(r);
    return k === "DETECTION GAP" || k === "ADVICE GAP";
  });
}

/** One-line outcome for a commit-status description (≤140 chars on the wire). */
export function statusDescription(results: ScenarioResult[]): string {
  const applicable = results.filter((r) => !r.detectionOnly);
  const green = applicable.filter((r) => r.reachedGreen).length;
  const gaps = gapScenarios(results);
  return gaps.length === 0
    ? `${green}/${applicable.length} scenarios green`
    : `${gaps.length} gap(s): ${gaps.map((g) => g.scenarioId).join(", ")}`;
}

function tableRow(r: ScenarioResult, klass: ReturnType<typeof classify>): string {
  return `| ${r.scenarioId} | ${r.image} | ${r.detection.detected ? "yes" : "no"} | ${r.appliedVia} | ${r.reachedGreen ? "yes" : "no"} | ${klass} |`;
}

function gapEntry(r: ScenarioResult, klass: "DETECTION GAP" | "ADVICE GAP"): string {
  const misses = r.detection.misses.map((m) => `${m.id} want=${m.want} got=${m.got}`).join("; ");
  return `- **${r.scenarioId}** (${klass})${misses ? ` — ${misses}` : ""}${r.error ? ` — ${r.error}` : ""}`;
}

export function buildGapReport(results: ScenarioResult[]): string {
  const applicable = results.filter((r) => !r.detectionOnly);
  const green = applicable.filter((r) => r.reachedGreen).length;
  const detectionOnly = results.length - applicable.length;
  const lines: string[] = [
    "# Onboarding Gap Report",
    "",
    `**${green} / ${applicable.length} scenarios reached green.**` +
      (detectionOnly ? ` (${detectionOnly} detection-only, by design — excluded.)` : ""),
    "",
    "| Scenario | Image | Detected | Applied | Green | Classification |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const gaps: string[] = [];
  for (const r of results) {
    const klass = classify(r);
    lines.push(tableRow(r, klass));
    if (klass === "DETECTION GAP" || klass === "ADVICE GAP") {
      gaps.push(gapEntry(r, klass));
    }
  }
  if (gaps.length) {
    lines.push("", "## Gaps", "", ...gaps);
  }
  return lines.join("\n") + "\n";
}
