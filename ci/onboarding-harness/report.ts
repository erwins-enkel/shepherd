import { LAUNCH_FAILURE_PREFIX } from "./incus";
import type { ScenarioResult } from "./types";

/** A scenario that threw BEFORE its diagnostics could be evaluated (the catch-block
 *  sentinel: an error paired with no detection and no recorded misses). install-e2e is
 *  never one of these — it exists to test the installer, so its throws must gate. */
function isPreDetectionThrow(r: ScenarioResult): boolean {
  if (r.installE2E) return false;
  return !!r.error && !r.detection.detected && r.detection.misses.length === 0;
}

/** A pre-detection throw whose error is a LAUNCH failure — the instance never even
 *  started (image rot, disk-full, name-collision). This is infrastructure, NOT a
 *  product gap: excluded from the green tally AND de-gated (does not block a release),
 *  but still surfaced loudly (opens/keeps the rolling issue, shown in the status line)
 *  so harness rot is never silent. A pre-detection throw with any OTHER message
 *  (file-push failure, baseline crash, "Shepherd did not come up", a probe crash) is a
 *  BOOT CRASH (see classify) that DOES gate — past launch, it could be a real regression. */
export function isHarnessError(r: ScenarioResult): boolean {
  return isPreDetectionThrow(r) && !!r.error && r.error.startsWith(LAUNCH_FAILURE_PREFIX);
}

/** All launch-failure (infra) scenarios — used to keep them visible (issue/status)
 *  even though they don't gate. */
export function harnessErrorScenarios(results: ScenarioResult[]): ScenarioResult[] {
  return results.filter(isHarnessError);
}

type Classification =
  | "PASS"
  | "DETECTION GAP"
  | "ADVICE GAP"
  | "INSTALL GAP"
  | "DETECTION-ONLY"
  | "HARNESS ERROR"
  | "BOOT CRASH";

/** Pure: render the per-scenario outcomes as a markdown gap report. Classifies
 *  each scenario as PASS, DETECTION GAP (defect missed/misclassified), ADVICE GAP
 *  (detected but coaching didn't reach green), INSTALL GAP (the install-e2e scenario
 *  didn't reach green — an installer regression, NOT a detection failure, since it
 *  has no seeded defect), DETECTION-ONLY (detected with no apply attempted by
 *  design — e.g. claude-missing in Phase 1; NOT a gap), HARNESS ERROR (launch
 *  failure — infra/image-rot, de-gated but visible), or BOOT CRASH (threw after
 *  launch but before detection — gates, could be a real regression). The green tally
 *  counts only apply-able scenarios so detection-only AND harness-errored ones don't
 *  drag the denominator. */
function classify(r: ScenarioResult): Classification {
  // install-e2e takes precedence over the infra check: it has no seeded defect, so a
  // miss — including a thrown install.sh/boot/probe failure — is an installer regression
  // (INSTALL GAP), never a HARNESS ERROR or a DETECTION GAP ("a defect was missed").
  if (r.installE2E) return r.reachedGreen ? "PASS" : "INSTALL GAP";
  if (isHarnessError(r)) return "HARNESS ERROR";
  // Pre-detection throw that is NOT a launch failure: the instance launched but
  // something past launch crashed (file-push, baseline, boot, probe). This could be a
  // real product/harness regression, so it GATES — do NOT let it collapse into
  // "DETECTION GAP" ("a defect was missed"), which would misinform the operator.
  if (isPreDetectionThrow(r)) return "BOOT CRASH";
  if (r.detectionOnly) return r.detection.detected ? "DETECTION-ONLY" : "DETECTION GAP";
  if (r.reachedGreen) return "PASS";
  return r.detection.detected ? "ADVICE GAP" : "DETECTION GAP";
}

/** Gate regressions: a gate-eligible (deterministic) scenario that didn't reach
 *  green and is not a launch-failure harness error. These — and only these — drive
 *  the release verdict (status + issue). Prose/agent + detection-only scenarios are
 *  reported but never gate. Launch failures (infra) are excluded here but kept
 *  visible via the rolling issue and status line. */
export function gateGapScenarios(results: ScenarioResult[]): ScenarioResult[] {
  return results.filter((r) => r.gateEligible && !r.reachedGreen && !isHarnessError(r));
}

/** One-line GATE outcome for a commit-status description (≤140 chars on the
 *  wire) — scoped to the deterministic subset, so an informational prose/agent
 *  gap (e.g. git-missing) doesn't flip the release verdict. Harness errors are
 *  excluded from the denominator (they didn't get a fair attempt) but noted. */
export function statusDescription(results: ScenarioResult[]): string {
  const gate = results.filter((r) => r.gateEligible && !isHarnessError(r));
  const green = gate.filter((r) => r.reachedGreen).length;
  const gaps = gateGapScenarios(results);
  const harness = harnessErrorScenarios(results);
  const harnessNote = harness.length
    ? ` (${harness.length} harness error${harness.length > 1 ? "s" : ""})`
    : "";
  return gaps.length === 0
    ? `${green}/${gate.length} gate scenarios green${harnessNote}`
    : `${gaps.length} gate gap(s): ${gaps.map((g) => g.scenarioId).join(", ")}${harnessNote}`;
}

function tableRow(r: ScenarioResult, klass: Classification): string {
  return `| ${r.scenarioId} | ${r.image} | ${r.detection.detected ? "yes" : "no"} | ${r.appliedVia} | ${r.reachedGreen ? "yes" : "no"} | ${klass} |`;
}

function gapEntry(
  r: ScenarioResult,
  klass: "DETECTION GAP" | "ADVICE GAP" | "INSTALL GAP" | "BOOT CRASH",
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
    if (
      klass === "DETECTION GAP" ||
      klass === "ADVICE GAP" ||
      klass === "INSTALL GAP" ||
      klass === "BOOT CRASH"
    ) {
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
