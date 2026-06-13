import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IncusDriver } from "./incus";
import { SCENARIOS } from "./scenarios";
import { seedInstance } from "./seed";
import { bootShepherd, probeDiagnostics } from "./probe";
import { applyAgent, applyVerbatim } from "./apply";
import { assertDetection } from "./assert";
import { buildGapReport } from "./report";
import { remediationsFor } from "./remediations";
import type { DetectionResult, Scenario, ScenarioResult } from "./types";

/** `git archive` the current HEAD into a tarball the seed engine pushes. */
function buildTarball(): string {
  const dir = mkdtempSync(join(tmpdir(), "shep-onb-"));
  const tar = join(dir, "shepherd.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"]);
  return tar;
}

async function runScenario(
  driver: IncusDriver,
  scenario: Scenario,
  tarball: string,
): Promise<ScenarioResult> {
  const base = { scenarioId: scenario.id, image: scenario.image };
  let detection: DetectionResult | undefined;
  try {
    await seedInstance(driver, scenario, tarball);
    await bootShepherd(driver, scenario.id);
    const before = await probeDiagnostics(driver, scenario.id);
    detection = assertDetection(before, scenario.id, scenario.expect);

    const verbatim = remediationsFor(before);
    let appliedVia: ScenarioResult["appliedVia"];
    let detectionOnly = false;
    if (verbatim.length > 0) {
      await applyVerbatim(driver, scenario.id, before);
      appliedVia = "verbatim";
    } else if (scenario.agentIncompatible) {
      console.log(`[${scenario.id}] agent-incompatible — detection-only`);
      appliedVia = "skipped";
      detectionOnly = true;
    } else {
      await applyAgent(driver, scenario.id, before);
      appliedVia = "agent";
    }
    const after = detectionOnly ? before : await probeDiagnostics(driver, scenario.id);
    return {
      ...base,
      detection,
      appliedVia,
      reachedGreen: !detectionOnly && after.overall === "ok",
      detectionOnly: detectionOnly || undefined,
    };
  } catch (err) {
    return {
      ...base,
      detection: detection ?? { scenarioId: scenario.id, detected: false, misses: [] },
      appliedVia: "skipped",
      reachedGreen: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await driver.delete(scenario.id);
  }
}

// FIXED absolute path under the host-global Shepherd state dir (~/.shepherd) — NOT
// $TMPDIR. A systemd-user timer service and an interactive shell can see different
// $TMPDIR (PrivateTmp, per-session dirs), which would defeat the lock; $HOME is
// stable and identical for both (same user), so the lock is genuinely host-wide.
const LOCK_PATH = join(homedir(), ".shepherd", "onboarding-harness.lock");

/** Acquire a host-wide exclusive lock so concurrent runs never share the Incus
 *  host. `wx` fails if the lock already exists. Returns a release fn. */
function acquireHostLock(): () => void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  let fd: number;
  try {
    fd = openSync(LOCK_PATH, "wx");
  } catch {
    console.error(`another onboarding-harness run holds ${LOCK_PATH}; aborting`);
    process.exit(3);
  }
  return () => {
    closeSync(fd);
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  };
}

async function main() {
  // Maintenance: reap ALL harness instances across runs (manual recovery only).
  if (process.argv.includes("--reap-orphans")) {
    await new IncusDriver(undefined, "shep-onb-").sweep();
    console.log("reaped all shep-onb-* instances");
    return;
  }

  const only = process.argv.includes("--scenario")
    ? process.argv[process.argv.indexOf("--scenario") + 1]
    : null;
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`no scenario matched ${only}`);
    process.exit(2);
  }

  const release = acquireHostLock();
  // Per-run prefix isolates this run's instances; `sweep()` then only ever
  // touches our own, so overlapping runs can't destroy each other (point 5).
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const driver = new IncusDriver(undefined, `shep-onb-${runId}-`);
  const results: ScenarioResult[] = [];
  try {
    const tarball = buildTarball();
    for (const s of scenarios) {
      console.log(`\n=== ${s.id} (${s.image}) ===`);
      results.push(await runScenario(driver, s, tarball));
    }
  } finally {
    await driver.sweep(); // teardown — own-prefix instances only
    release();
  }

  const report = buildGapReport(results);
  const out = join(process.cwd(), "onboarding-gap-report.md");
  writeFileSync(out, report);
  console.log(`\n${report}\nReport written to ${out}`);

  // Non-zero exit if any APPLY-ABLE scenario failed to reach green (detection-only
  // scenarios are excluded). Consumed by the Phase 2 gate.
  const applicable = results.filter((r) => !r.detectionOnly);
  process.exit(applicable.every((r) => r.reachedGreen) ? 0 : 1);
}

void main();
