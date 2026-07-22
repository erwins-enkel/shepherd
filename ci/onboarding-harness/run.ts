import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IncusDriver } from "./incus";
import { SCENARIOS } from "./scenarios";
import { seedInstance } from "./seed";
import {
  assertUnitActive,
  bootExpectingPreflightExit,
  bootShepherd,
  HARNESS_TOKEN,
  probeDiagnostics,
  waitForApi,
} from "./probe";
import { applyAgent, applyVerbatim } from "./apply";
import { assertDetection } from "./assert";
import { buildGapReport, gateGapScenarios, statusDescription } from "./report";
import { reportToGitHub, publishStatus } from "./issue";
import { remediationsFor } from "../../src/remediations";
import { HERDR_LAST_SUPPORTED_VERSION } from "../../src/herdr-capabilities";
import { HERDR_MISSING_EXIT_CODE, HERDR_MISSING_MARKER } from "../../src/preflight";
import type { DetectionResult, Scenario, ScenarioResult } from "./types";
import type { DiagnosticsSnapshot } from "../../src/types";

/** `git archive` the current HEAD into a tarball the seed engine pushes. */
function buildTarball(): string {
  const dir = mkdtempSync(join(tmpdir(), "shep-onb-"));
  const tar = join(dir, "shepherd.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"]);
  return tar;
}

/** Local repo path to the installer the install-e2e scenario stages + runs. */
const INSTALL_SCRIPT = join(import.meta.dir, "..", "..", "deploy", "install.sh");

/** Base fields every ScenarioResult carries, computed once per run. */
type ScenarioBase = {
  scenarioId: string;
  image: string;
  gateEligible: boolean;
};

/** Assert the herdr the install path actually landed is the PINNED one (#1896).
 *
 *  `herdr: ok` is NOT enough: today HERDR_LAST_SUPPORTED_VERSION happens to equal herdr's latest
 *  release, so an UNPINNED install (the very regression this guards) would satisfy the check and
 *  the scenario would pass green. Reading the installed version is the only end-to-end evidence
 *  that the pin is doing anything — and it becomes genuinely discriminating the day herdr ships
 *  past the ceiling, which is exactly when a silent regression would otherwise reach users.
 *
 *  PATH is prepended because herdr installs to ~/.local/bin, which an `incus exec` non-login shell
 *  does not have. Throws fail-closed: runScenario classifies it as a gating failure.
 *
 *  CALL IT ONLY WHEN THE herdr CHECK IS ALREADY `ok`. On a host where the install genuinely
 *  failed, herdr is missing for an ordinary reason, and this would replace that scenario's own
 *  diagnosis (`herdr want=ok got=error`, plus the install output) with a less useful message about
 *  the pin. The pin is a question you can only ask once something IS installed. */
async function assertPinnedHerdrInstalled(driver: IncusDriver, name: string): Promise<void> {
  const r = await driver.exec(name, [
    "sh",
    "-c",
    'export PATH="$HOME/.local/bin:$PATH"; "${HERDR_BIN:-herdr}" --version',
  ]);
  const version = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}${r.stderr}`)?.[1];
  if (version !== HERDR_LAST_SUPPORTED_VERSION) {
    throw new Error(
      `${name}: installed herdr is ${version ?? "unreadable"}, expected the pinned ` +
        `${HERDR_LAST_SUPPORTED_VERSION} — the install path is not honouring the pin`,
    );
  }
}

/** Shared tail of BOTH install-e2e runners: probe the freshly-installed host, assert the
 *  target-ok set, and shape the result. `expect` is the target state (not a seeded defect),
 *  so `reachedGreen` is just whether detection saw every check reach `ok`. */
async function finishInstallE2E(
  driver: IncusDriver,
  scenario: Scenario,
  base: ScenarioBase,
): Promise<ScenarioResult> {
  const after = await probeDiagnostics(driver, scenario.id);
  const detection = assertDetection(after, scenario.id, scenario.expect);
  // Only once the target set (herdr included) is green: an install that failed outright keeps its
  // own INSTALL GAP diagnosis rather than being re-labelled a pin failure.
  if (detection.detected) await assertPinnedHerdrInstalled(driver, scenario.id);
  return {
    ...base,
    detection,
    appliedVia: "verbatim",
    reachedGreen: detection.detected,
    installE2E: true,
  };
}

/** Inverse flow: bare host → real deploy/install.sh → assert it reaches green.
 *  No seeded defect, no baseline; `expect` is the target-ok set. The install is a
 *  deterministic, LLM-free apply, so it reuses the "verbatim" appliedVia. Throws
 *  fail-closed on a non-zero install. */
async function runInstallE2E(
  driver: IncusDriver,
  scenario: Scenario,
  base: ScenarioBase,
  tarball: string,
): Promise<ScenarioResult> {
  await seedInstance(driver, scenario, tarball, INSTALL_SCRIPT);
  const install = await driver.exec(scenario.id, [
    "sh",
    "-c",
    // SHEPHERD_DIR=/opt/shepherd so probe.ts's hardcoded `cd /opt/shepherd`
    // finds it; NO_SERVICE skips systemd (no PID 1 in a fresh exec session).
    // install.sh is `#!/usr/bin/env bash` + `set -o pipefail`; run it with bash,
    // not sh — on Ubuntu /bin/sh is dash, which aborts at `set -o pipefail`.
    "SHEPHERD_SRC=/root/shepherd.tar SHEPHERD_NO_SERVICE=1 SHEPHERD_DIR=/opt/shepherd bash /root/install.sh",
  ]);
  if (install.code !== 0) {
    throw new Error(`install.sh failed in ${scenario.id}:\n${install.stderr || install.stdout}`);
  }
  await bootShepherd(driver, scenario.id);
  return await finishInstallE2E(driver, scenario, base);
}

/** Turn the freshly-extracted /opt/shepherd into a real git checkout BEFORE
 *  install.sh runs. The service path invokes deploy/update.sh, which does
 *  `git rev-parse`/`git diff` under `set -euo pipefail`; a real install gets a
 *  `.git` from `git clone`, but the harness stages source from a `git archive`
 *  TARBALL (no `.git`), so update.sh would abort in a non-git dir. We install git,
 *  extract the tarball, and seed a one-commit repo. Running install.sh then with
 *  SHEPHERD_SRC==SHEPHERD_DIR==/opt/shepherd makes resolve_from_src use it IN PLACE
 *  (no clone, no copy, no clobber), preserving this `.git`. */
const GIT_CHECKOUT_SCRIPT =
  "apt-get update && apt-get install -y git && " +
  "mkdir -p /opt/shepherd && tar -xf /root/shepherd.tar -C /opt/shepherd && " +
  "cd /opt/shepherd && git init -q -b main && git add -A && " +
  'git -c user.email=harness@local -c user.name=harness commit -qm "harness seed"';

/** Establish the per-user systemd manager so `systemctl --user` works inside the
 *  `incus exec` session. `loginctl enable-linger` starts it ASYNCHRONOUSLY, so we
 *  poll until the user bus socket exists before any `systemctl --user` runs —
 *  without the wait, the immediately-following call races and fails to connect. */
const BUS_ESTABLISH_SCRIPT =
  "loginctl enable-linger root && " +
  "for i in $(seq 1 30); do [ -S /run/user/0/bus ] && break; sleep 0.5; done; " +
  "[ -S /run/user/0/bus ]";

/** Run install.sh THROUGH the service path: no SHEPHERD_NO_SERVICE (the unit must
 *  be installed + started), USER=root set explicitly (provision's installService
 *  throws if $USER is unset), XDG_RUNTIME_DIR so provision's own `systemctl --user`
 *  calls reach the bus, and SHEPHERD_SRC==SHEPHERD_DIR so install.sh uses the git
 *  checkout in place. */
const INSTALL_SERVICE_CMD =
  "XDG_RUNTIME_DIR=/run/user/0 USER=root " +
  "SHEPHERD_SRC=/opt/shepherd SHEPHERD_DIR=/opt/shepherd bash /root/install.sh";

/** Seed the operator bearer into the systemd unit's EnvironmentFile BEFORE install
 *  (#1112). The unit owns the process and reads its env from `EnvironmentFile=-%h/.shepherd/env`
 *  (%h=/root), NOT from INSTALL_SERVICE_CMD's exec env — so to let the GATED diagnostics
 *  probe authorize (probeDiagnostics sends `Authorization: Bearer ${HARNESS_TOKEN}`), the
 *  token must land in that file so the started unit's `config.token` matches. provision's
 *  `mkdir -p ~/.shepherd` is idempotent and never clobbers this file. */
const SEED_UNIT_TOKEN_SCRIPT = `mkdir -p /root/.shepherd && printf 'SHEPHERD_TOKEN=%s\\n' '${HARNESS_TOKEN}' > /root/.shepherd/env`;

/** Inverse flow PLUS the real systemd USER-UNIT lifecycle: bare host → git-checkout
 *  /opt/shepherd → enable-linger + user bus → real deploy/install.sh THROUGH the
 *  service path → assert the `shepherd` unit is active → health-check through the
 *  running unit. Unlike runInstallE2E it does NOT pass SHEPHERD_NO_SERVICE and never
 *  hand-boots `bun src/index.ts` (the unit owns the process). Throws fail-closed at
 *  every step; carries installE2E:true so a failure classifies as an INSTALL GAP. */
async function runInstallLifecycleE2E(
  driver: IncusDriver,
  scenario: Scenario,
  base: ScenarioBase,
  tarball: string,
): Promise<ScenarioResult> {
  // Bare host: same seeding as runInstallE2E (pushes tarball + install.sh, no
  // baseline) — works because the scenario also sets installE2E:true.
  await seedInstance(driver, scenario, tarball, INSTALL_SCRIPT);

  const checkout = await driver.exec(scenario.id, ["sh", "-c", GIT_CHECKOUT_SCRIPT]);
  if (checkout.code !== 0) {
    throw new Error(
      `git checkout setup failed in ${scenario.id}:\n${checkout.stderr || checkout.stdout}`,
    );
  }

  const bus = await driver.exec(scenario.id, ["sh", "-c", BUS_ESTABLISH_SCRIPT]);
  if (bus.code !== 0) {
    throw new Error(`user bus did not come up in ${scenario.id}:\n${bus.stderr || bus.stdout}`);
  }

  // Seed the unit's EnvironmentFile token before install so the started service is
  // bearer-authorizable for the gated diagnostics probe (#1112).
  const envSeed = await driver.exec(scenario.id, ["sh", "-c", SEED_UNIT_TOKEN_SCRIPT]);
  if (envSeed.code !== 0) {
    throw new Error(
      `unit token seed failed in ${scenario.id}:\n${envSeed.stderr || envSeed.stdout}`,
    );
  }

  const install = await driver.exec(scenario.id, ["sh", "-c", INSTALL_SERVICE_CMD]);
  if (install.code !== 0) {
    throw new Error(
      `install.sh (service) failed in ${scenario.id}:\n${install.stderr || install.stdout}`,
    );
  }

  // The units own their processes — assert both are active, then wait for Shepherd to serve.
  // herdr is checked explicitly: a green `herdr` diagnostic only proves some daemon answers,
  // not that the SUPERVISED one does. An unsupervised daemon on the socket makes herdr.service
  // thrash into `failed` behind a passing check — invisible without this assertion. #1574
  await assertUnitActive(driver, scenario.id, "herdr");
  await assertUnitActive(driver, scenario.id);
  await waitForApi(driver, scenario.id);
  return await finishInstallE2E(driver, scenario, base);
}

/** Fail-fast PREFLIGHT flow (`herdr-missing`). Since #1313 a missing herdr prints
 *  the banner and exits 78 BEFORE the HTTP server binds, so the standard boot+probe
 *  detection path can't run. The baseline installs a herdr STUB; the seed removes
 *  it, restoring the real fail-fast. We:
 *   1. boot in the foreground and assert exit 78 + the banner marker (detection);
 *   2. apply the REAL verbatim herdr remediation (via the production REMEDIATIONS
 *      map — a full synthetic snapshot, so remediationsFor resolves the install);
 *   3. re-boot normally (herdr now present) and assert the herdr check is `ok`.
 *  Throws fail-closed at each step — a failure is caught by runScenario as a gating
 *  BOOT CRASH, which is correct: a preflight that didn't fire, or a remediation that
 *  didn't heal, is a real regression, not something to swallow. */
async function runHerdrPreflightE2E(
  driver: IncusDriver,
  scenario: Scenario,
  base: ScenarioBase,
  tarball: string,
): Promise<ScenarioResult> {
  await seedInstance(driver, scenario, tarball);

  // Detection: with herdr removed, boot must fail-fast with the banner + exit 78.
  // ONLY exit 78 passes — timeout's 124 (or any other code) means it did NOT
  // fail-fast, i.e. a real regression to surface.
  const boot = await bootExpectingPreflightExit(driver, scenario.id);
  if (boot.code !== HERDR_MISSING_EXIT_CODE || !boot.output.includes(HERDR_MISSING_MARKER)) {
    throw new Error(
      `${scenario.id}: expected herdr fail-fast (exit ${HERDR_MISSING_EXIT_CODE} + banner), ` +
        `got exit ${boot.code}:\n${boot.output.slice(-800)}`,
    );
  }

  // Apply the real verbatim remediation. remediationsFor iterates snapshot.checks,
  // so this MUST be a full DiagnosticsSnapshot (a bare check object → no checks →
  // [] → silent no-op). This resolves diagnostics_hint_herdr_missing → the real
  // herdr install from src/remediations.ts (no hardcoded copy).
  const synthetic: DiagnosticsSnapshot = {
    checks: [{ id: "herdr", state: "error", hintKey: "diagnostics_hint_herdr_missing" }],
    generatedAt: 0,
    overall: "error",
  };
  if (!(await applyVerbatim(driver, scenario.id, synthetic))) {
    throw new Error(`${scenario.id}: verbatim herdr remediation failed`);
  }

  // Re-boot normally (herdr now present) and confirm the check recovered to ok — AND, once it has,
  // that the remediation installed the PINNED version rather than merely some herdr.
  await bootShepherd(driver, scenario.id);
  const after = await probeDiagnostics(driver, scenario.id);
  const herdrOk = after.checks.find((c) => c.id === "herdr")?.state === "ok";
  if (herdrOk) await assertPinnedHerdrInstalled(driver, scenario.id);
  return {
    ...base,
    detection: { scenarioId: scenario.id, detected: true, misses: [] },
    appliedVia: "verbatim",
    reachedGreen: herdrOk,
  };
}

/** Pick + run the standard-path remediation: detection-only (by design or
 *  agent-incompatible), verbatim, or agent. Returns the chosen `appliedVia` and
 *  whether this was a detection-only (no-apply) run. */
async function applyDispatch(
  driver: IncusDriver,
  scenario: Scenario,
  before: DiagnosticsSnapshot,
): Promise<{ appliedVia: ScenarioResult["appliedVia"]; detectionOnly: boolean }> {
  if (scenario.detectionOnly) {
    // Defect detectable but unfixable unattended (needs human/secret) — verify
    // detection only, never apply.
    console.log(`[${scenario.id}] detection-only by design — no apply`);
    return { appliedVia: "skipped", detectionOnly: true };
  }
  if (remediationsFor(before).length > 0) {
    await applyVerbatim(driver, scenario.id, before);
    return { appliedVia: "verbatim", detectionOnly: false };
  }
  if (scenario.agentIncompatible) {
    console.log(`[${scenario.id}] agent-incompatible, no verbatim fix — detection-only`);
    return { appliedVia: "skipped", detectionOnly: true };
  }
  await applyAgent(driver, scenario.id, before);
  return { appliedVia: "agent", detectionOnly: false };
}

export async function runScenario(
  driver: IncusDriver,
  scenario: Scenario,
  tarball: string,
): Promise<ScenarioResult> {
  const base: ScenarioBase = {
    scenarioId: scenario.id,
    image: scenario.image,
    // Part of the deterministic release gate iff structured AND not detection-only
    // (mirrors onboarding-gate.sh). Prose/agent + detection-only never gate.
    gateEligible: scenario.coaching === "structured" && !scenario.detectionOnly,
  };
  let detection: DetectionResult | undefined;
  try {
    if (scenario.serviceLifecycle)
      return await runInstallLifecycleE2E(driver, scenario, base, tarball);
    if (scenario.installE2E) return await runInstallE2E(driver, scenario, base, tarball);
    if (scenario.preflightFailFast)
      return await runHerdrPreflightE2E(driver, scenario, base, tarball);

    await seedInstance(driver, scenario, tarball);
    await bootShepherd(driver, scenario.id);
    const before = await probeDiagnostics(driver, scenario.id);
    detection = assertDetection(before, scenario.id, scenario.expect);

    const { appliedVia, detectionOnly } = await applyDispatch(driver, scenario, before);
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
      // Carry the flag through the throw path: an install-e2e that fails (install.sh
      // non-zero, boot/probe crash) is an INSTALL regression that MUST gate — without
      // this it'd be mislabeled a HARNESS ERROR and silently dropped from the tally.
      installE2E: scenario.installE2E,
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
    // Ensure the shared `shep-onb` profile exists with the in-repo spec before any
    // instance is launched. Runs for both full and --scenario paths (only --reap-orphans
    // returns early above, so this is never reached on that path). Fail-closed: a wrong
    // or missing profile would silently OOM every instance, so we fix it up front.
    await driver.ensureProfile();
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

  // Release verdict = gate-eligible scenarios with a real gap; launch-failure harness
  // errors (infra) are excluded (they stay visible via the rolling issue), so image rot
  // never flips the gate red. Non-launch crashes (BOOT CRASH) are NOT harness errors and
  // still gate.
  const gateOk = gateGapScenarios(results).length === 0;
  await maybeReportRun(results, report, only, gateOk);
  process.exit(gateOk ? 0 : 1);
}

// Only run when executed directly (`bun run …/run.ts`), not when a test imports
// `runScenario` from this module — importing must not acquire the host lock + exit.
if (import.meta.main) void main();
