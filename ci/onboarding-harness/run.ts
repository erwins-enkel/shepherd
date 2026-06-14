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
import { buildGapReport, statusDescription } from "./report";
import { reportToGitHub, publishStatus } from "./issue";
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
  const base = {
    scenarioId: scenario.id,
    image: scenario.image,
    // Part of the deterministic release gate iff structured AND not detection-only
    // (mirrors onboarding-gate.sh). Prose/agent + detection-only never gate.
    gateEligible: scenario.coaching === "structured" && !scenario.detectionOnly,
  };
  let detection: DetectionResult | undefined;
  try {
    await seedInstance(driver, scenario, tarball);
    await bootShepherd(driver, scenario.id);
    const before = await probeDiagnostics(driver, scenario.id);
    detection = assertDetection(before, scenario.id, scenario.expect);

    const verbatim = remediationsFor(before);
    let appliedVia: ScenarioResult["appliedVia"];
    let detectionOnly = false;
    if (scenario.detectionOnly) {
      // Defect detectable but unfixable unattended (needs human/secret) — verify
      // detection only, never apply.
      console.log(`[${scenario.id}] detection-only by design — no apply`);
      appliedVia = "skipped";
      detectionOnly = true;
    } else if (verbatim.length > 0) {
      await applyVerbatim(driver, scenario.id, before);
      appliedVia = "verbatim";
    } else if (scenario.agentIncompatible) {
      console.log(`[${scenario.id}] agent-incompatible, no verbatim fix — detection-only`);
      appliedVia = "skipped";
      detectionOnly = true;
    } else {
      await applyAgent(driver, scenario.id, before);
      appliedVia = "agent";
    }
    const after = detectionOnly ? before : await probeDiagnostics(driver, scenario.id);
    // Success is SCOPED to the checks this scenario broke: a throw-away instance
    // never has a fully-healthy host (no tailnet, no gh login, etc.), so the global
    // `overall` can't be "ok" — green means the seeded defect's checks recovered.
    const expectedNowOk = scenario.expect.every(
      (e) => after.checks.find((c) => c.id === e.id)?.state === "ok",
    );
    return {
      ...base,
      detection,
      appliedVia,
      reachedGreen: !detectionOnly && expectedNowOk,
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
 *  host. `wx` fails if the lock already exists. Returns an idempotent release fn.
 *  The release is ALSO wired to SIGINT/SIGTERM: Node skips `finally` on a
 *  signal-kill, so without this a Ctrl-C'd or `systemctl stop`-ed run would leave
 *  a stale lock that blocks every future run at exit 3. (A hard SIGKILL still
 *  can't be caught — `--reap-orphans` clears such a leak.) */
function acquireHostLock(): () => void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  let fd: number;
  try {
    fd = openSync(LOCK_PATH, "wx");
  } catch {
    console.error(`another onboarding-harness run holds ${LOCK_PATH}; aborting`);
    process.exit(3);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(fd);
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}

/** Accountability + traceability: on a FULL run (never a single `--scenario`,
 *  which checks one defect and must not open/close the rolling issue or stamp a
 *  verdict), report the outcome to GitHub — a rolling regression issue AND a
 *  commit status on the tested SHA, so every run leaves a visible green/red record
 *  and even a clean run is observable. Opt-in via env so manual full runs stay
 *  side-effect-free; the nightly service sets it. Best-effort: a gh failure is
 *  logged loudly but never masks the run result. */
async function maybeReportRun(
  results: ScenarioResult[],
  report: string,
  only: string | null | undefined,
  ok: boolean,
): Promise<void> {
  if (only || process.env.SHEPHERD_ONBOARDING_REPORT_ISSUE !== "1") return;
  try {
    const outcome = await reportToGitHub(results, report, new Date().toISOString());
    console.log(`[github] issue: ${outcome.summary}`);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await publishStatus(sha, ok, statusDescription(results), outcome.issueUrl);
    console.log(`[github] status: ${ok ? "success" : "failure"} on ${sha.slice(0, 7)}`);
  } catch (err) {
    console.error(`[github] reporting failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  // Maintenance: reap ALL harness instances across runs AND clear a stale lock
  // left by a hard-killed (SIGKILL) run (manual recovery only).
  if (process.argv.includes("--reap-orphans")) {
    await new IncusDriver(undefined, "shep-onb-").sweep();
    try {
      unlinkSync(LOCK_PATH);
      console.log("cleared stale host lock");
    } catch {
      /* no lock held */
    }
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

  // Verdict = the deterministic GATE subset only (structured, non-detection-only —
  // same as onboarding-gate.sh). A prose/agent gap (git-missing) or a detection-only
  // scenario shows in the report but never fails the run or blocks a release.
  const gateOk = results.filter((r) => r.gateEligible).every((r) => r.reachedGreen);
  await maybeReportRun(results, report, only, gateOk);
  process.exit(gateOk ? 0 : 1);
}

void main();
