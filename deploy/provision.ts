#!/usr/bin/env bun
/**
 * Cold-start provisioner — the hand-off target for `deploy/install.sh`.
 *
 * install.sh installs OS prereqs + Bun, lands the repo in $SHEPHERD_DIR, then runs
 * `bun run deploy/provision.ts` FROM that checkout (cwd = the checkout). This script
 * finishes provisioning using the SHARED remediation table (src/remediations.ts —
 * single source of truth), installs/enables the systemd user unit, and builds by
 * reusing deploy/update.sh (no duplicated deps/build/health logic).
 *
 * Operator-facing ops tooling like update.sh: output is plain English, NOT i18n'd.
 *
 * Structure: PURE decision logic (selecting commands, branch decisions) is separated
 * from side effects (an injected command runner) so it's unit-testable without
 * running anything (see test/provision.test.ts).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { BUN_MIN_VERSION, NODE_MIN_VERSION, HERDR_MIN_VERSION } from "../src/config";
import { compareSemver } from "../src/herdr-update";
import { autoFixCommandFor } from "../src/remediations";
import { resolveBackupDir, backupConfiguredMarker } from "../src/backup-paths";

// ── pure types + data ─────────────────────────────────────────────────────────

/** A table-driven prerequisite. `floor` undefined ⇒ presence-only (no version
 *  gate), like claude. `hintKey` selects the verbatim install via autoFixCommandFor
 *  — so tailscale (guidance-only) is intentionally NOT in this table and can never
 *  be auto-installed. */
export interface Prereq {
  /** Binary probed with `command -v` / `<bin> --version`. */
  bin: string;
  /** hintKey into the shared remediation table. */
  hintKey: string;
  /** Advisory version floor; undefined ⇒ presence-only. */
  floor?: string;
}

export const PREREQS: readonly Prereq[] = [
  { bin: "bun", hintKey: "diagnostics_hint_bun_missing", floor: BUN_MIN_VERSION },
  { bin: "node", hintKey: "diagnostics_hint_node_missing", floor: NODE_MIN_VERSION },
  { bin: "herdr", hintKey: "diagnostics_hint_herdr_missing", floor: HERDR_MIN_VERSION },
  // claude is presence-only (no version floor), like diagnostics.
  { bin: "claude", hintKey: "diagnostics_hint_claude_missing" },
];

/** Install-time RAM floor. Claude Code's native installer transiently peaks at ~2 GB during
 *  `claude install`; below this, the install can be OOM-killed on a small host (#749). Advisory
 *  only — we warn, never abort (a swap-backed host may still succeed). */
export const INSTALL_RAM_FLOOR_BYTES = 3 * 1024 * 1024 * 1024; // 3 GiB

/** Pure: an advisory string when total RAM is under the floor, else null. */
export function lowMemoryWarning(
  totalBytes: number,
  floorBytes = INSTALL_RAM_FLOOR_BYTES,
): string | null {
  if (totalBytes >= floorBytes) return null;
  const gib = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
  return (
    `low memory: ${gib(totalBytes)} GiB total RAM detected; Claude Code's installer needs ` +
    `~2 GB free during setup, so the install may be OOM-killed. Add RAM or swap if it fails.`
  );
}

/** The decision a host yields: whether to take the systemd-service path, and
 *  whether to print the macOS DEGRADED banner. */
export interface ServiceDecision {
  service: boolean;
  degradedBanner: boolean;
}

// ── pure decision logic ───────────────────────────────────────────────────────

/** Install predicate: missing (null version) ⇒ install; with a floor, below-floor
 *  ⇒ install; presence-only (no floor) ⇒ install only when absent. Adequate ⇒ skip
 *  (never re-download). */
export function needsInstall(version: string | null, floor: string | undefined): boolean {
  if (version === null) return true;
  if (floor === undefined) return false; // presence-only & present
  return compareSemver(version, floor) < 0;
}

/** The verbatim command to run for a prereq given its probed state, or undefined to
 *  skip. Selects via autoFixCommandFor (NOT raw REMEDIATIONS) so guidance-only hints
 *  are excluded. */
export function selectPrereqCommand(
  prereq: Prereq,
  probed: { version: string | null },
): string | undefined {
  if (!needsInstall(probed.version, prereq.floor)) return undefined;
  return autoFixCommandFor(prereq.hintKey);
}

/** Service path iff linux AND SHEPHERD_NO_SERVICE unset/empty. macOS always takes
 *  the no-service path AND warrants the degraded banner. */
export function decideServicePath(
  platform: NodeJS.Platform | string,
  noService: string | undefined,
): ServiceDecision {
  if (platform === "darwin") return { service: false, degradedBanner: true };
  const service = platform === "linux" && !noService;
  return { service, degradedBanner: false };
}

/** Template the systemd unit so its WorkingDirectory points at the ACTUAL checkout
 *  (`repo`) instead of the hardcoded `%h/Work/shepherd`. This makes the default
 *  (`~/Work/shepherd`) install byte-identical to today while making a custom
 *  SHEPHERD_DIR correct — ExecStart stays `bun run src/index.ts` (relative to
 *  WorkingDirectory) and bun's path is independent of the checkout, so retargeting
 *  WorkingDirectory alone suffices. Replaces the single `WorkingDirectory=` line. */
export function templateUnit(unit: string, repo: string): string {
  return unit.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${repo}`);
}

/** Final guidance follow-ups that need a human secret and are NEVER auto-run. */
export function guidanceNextSteps(): string[] {
  return [
    "Shepherd will be available at http://localhost:7330",
    "",
    "A few steps need a human secret and were NOT run for you:",
    "  • Log into Claude:   claude   (then sign in with your Max/Pro subscription)",
    "  • GitHub auth:       gh auth login",
    "  • Remote access:     tailscale serve --bg 7330",
    "                       then add the tailnet hostname to SHEPHERD_ALLOWED_HOSTS",
    "                       (in ~/.shepherd/env or deploy/shepherd.service)",
  ];
}

const MACOS_DEGRADED_BANNER = [
  "",
  "════════════════════════════════════════════════════════════════════",
  "  ⚠  macOS: running in DEGRADED mode",
  "════════════════════════════════════════════════════════════════════",
  "  The following Linux-only capabilities are UNAVAILABLE on macOS:",
  "    • sandbox membrane (per-spawn credential isolation)",
  "    • egress allowlist (autonomous netns firewall)",
  "    • auto-drain",
  "    • tailscale-serve previews",
  "    • no automated install proof (the onboarding harness is Linux-only)",
  "",
  "  No launchd unit is installed. Start Shepherd manually with:",
  "    bun run start",
  "════════════════════════════════════════════════════════════════════",
  "",
];

// ── side-effect seam ──────────────────────────────────────────────────────────

/** Injectable command runner. Production runs the real binary; tests inject a
 *  recorder. Returns nothing — provision is fail-fast (throws on a hard failure). */
export type Runner = (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => void;

const defaultRunner: Runner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: opts?.env ?? process.env,
  });
  if (r.status !== 0) {
    throw new Error(`command failed (exit ${r.status ?? "signal"}): ${cmd} ${args.join(" ")}`);
  }
};

/** Injectable file IO. Production reads/writes the real filesystem; tests inject a
 *  recorder so the templated unit can be asserted without touching disk. */
export interface FileIO {
  read: (path: string) => string;
  write: (path: string, content: string) => void;
}

const defaultFileIO: FileIO = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, content) => writeFileSync(path, content),
};

/** Probe a binary's version via `<bin> --version`; null if absent or unparseable. */
function probeVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

function log(msg: string): void {
  process.stdout.write(`\x1b[36m▸ ${msg}\x1b[0m\n`);
}

// ── orchestration ─────────────────────────────────────────────────────────────

interface ProvisionOpts {
  run?: Runner;
  probe?: (bin: string) => string | null;
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  /** Repo checkout root (cwd by default). */
  repo?: string;
  /** Injectable file IO (templated-unit read/write); real fs by default. */
  fileIO?: FileIO;
  /** Injectable total-memory probe; defaults to os.totalmem. */
  totalMem?: () => number;
}

/** Step 1 — table-driven prereq install loop (idempotent; skips adequate tools). */
export function installPrereqs(
  probe: (bin: string) => string | null,
  run: Runner,
  env: NodeJS.ProcessEnv,
): void {
  log("checking prerequisites");
  for (const prereq of PREREQS) {
    const version = probe(prereq.bin);
    const cmd = selectPrereqCommand(prereq, { version });
    if (!cmd) {
      log(`  ${prereq.bin}: ok (${version ?? "present"})`);
      continue;
    }
    log(`  ${prereq.bin}: installing`);
    run("bash", ["-c", cmd], { env });
  }
}

/** Step 2 — node-gyp safety net (replicates ci/onboarding-harness/seed.ts).
 * node-pty's install rebuilds via node-gyp on prebuilt-less distros; ensure it's
 * present and that ~/.bun/bin + ~/.local/bin are on the PATH the later bun install
 * sees. User-writable locations only — NO /usr/local/bin / sudo. Returns the build
 * env (env + augmented PATH) used by every later build step. */
export function ensureNodeGyp(
  run: Runner,
  env: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  log("ensuring node-gyp (node-pty build dep)");
  const bunBin = join(home, ".bun", "bin");
  const localBin = join(home, ".local", "bin");
  run("bash", ["-c", "bun add -g node-gyp"], { env });
  return { ...env, PATH: `${bunBin}:${localBin}:${env.PATH ?? ""}` };
}

/** Linux service path: template+write the systemd user unit, daemon-reload,
 * enable-linger, enable, then build+start via deploy/update.sh. Fail-closed: throws
 * if $USER is unset (enable-linger needs it). */
export function installService(
  repo: string,
  run: Runner,
  fileIO: FileIO,
  env: NodeJS.ProcessEnv,
  home: string,
  buildEnv: NodeJS.ProcessEnv,
): void {
  log("installing systemd user unit");
  const unitDir = join(home, ".config", "systemd", "user");
  run("mkdir", ["-p", unitDir]);
  // Create ~/.shepherd BEFORE the unit is enabled/started: systemd opens the unit's
  // StandardOutput=append:%h/.shepherd/shepherd.log (and StandardError) BEFORE ExecStart
  // and does NOT create parent dirs. The server only makes ~/.shepherd at runtime — too
  // late for the first `systemctl --user start`, which would otherwise fail to activate
  // (EXIT_STDOUT, status 209) on a genuinely fresh host.
  run("mkdir", ["-p", join(home, ".shepherd")]);
  // Template (not a verbatim copy): point WorkingDirectory at the ACTUAL checkout
  // so a custom SHEPHERD_DIR install runs against the right dir, not the unit's
  // hardcoded %h/Work/shepherd. Default repo (~/Work/shepherd) ⇒ identical output.
  const unitSrc = fileIO.read(join(repo, "deploy", "shepherd.service"));
  fileIO.write(join(unitDir, "shepherd.service"), templateUnit(unitSrc, repo));
  // Hourly backup units (#1080), installed alongside the main service. The .service carries a
  // WorkingDirectory to template; the .timer has none, so it copies verbatim.
  const backupSvc = fileIO.read(join(repo, "deploy", "shepherd-backup.service"));
  fileIO.write(join(unitDir, "shepherd-backup.service"), templateUnit(backupSvc, repo));
  const backupTimer = fileIO.read(join(repo, "deploy", "shepherd-backup.timer"));
  fileIO.write(join(unitDir, "shepherd-backup.timer"), backupTimer);
  // Log-rotation units (#1212). Self-contained: the timer runs deploy/rotate-shepherd-log.sh (a
  // copytruncate size-cap), so there's NO external `logrotate` binary to be missing — it's
  // unconditional now (was gated on logrotate being present, which left the log unbounded on hosts
  // that lacked it). Copy the rotator to ~/.shepherd (the unit execs %h/.shepherd/...); the units'
  // own %h paths are expanded by systemd, so they copy verbatim.
  fileIO.write(
    join(home, ".shepherd", "rotate-shepherd-log.sh"),
    fileIO.read(join(repo, "deploy", "rotate-shepherd-log.sh")),
  );
  fileIO.write(
    join(unitDir, "shepherd-logrotate.service"),
    fileIO.read(join(repo, "deploy", "shepherd-logrotate.service")),
  );
  fileIO.write(
    join(unitDir, "shepherd-logrotate.timer"),
    fileIO.read(join(repo, "deploy", "shepherd-logrotate.timer")),
  );
  run("systemctl", ["--user", "daemon-reload"]);
  const user = env.USER;
  if (!user) throw new Error("cannot enable-linger: $USER is not set");
  run("loginctl", ["enable-linger", user]);
  run("systemctl", ["--user", "enable", "shepherd"]);
  // Mark this host as backup-EXPECTED before enabling the timer: the server's staleness check
  // treats marker-present + no recent success as a failure, so a box whose backup is broken from
  // the very first run is flagged (a no-marker host, e.g. macOS/core-only, stays silent).
  run("mkdir", ["-p", resolveBackupDir(env)]);
  fileIO.write(backupConfiguredMarker(env), "shepherd-backup.timer enabled\n");
  run("systemctl", ["--user", "enable", "--now", "shepherd-backup.timer"]);
  // Enable the (already-written) hourly log-rotation timer. #1212
  run("systemctl", ["--user", "enable", "--now", "shepherd-logrotate.timer"]);
  // No immediate `start shepherd-backup.service` here: on a fresh install the DB does not exist yet
  // (the server is started below by update.sh), so a read-only snapshot would fail the oneshot and
  // abort provision. update.sh runs its own GUARDED kick once deps are built, and the staleness
  // probe's marker-age grace already covers the spurious-first-alert race. #1080
  // update.sh does deps → UI build → restart (starts the now-enabled unit) → health.
  log("building + starting via deploy/update.sh");
  run("bash", [join(repo, "deploy", "update.sh")], { env: buildEnv });
}

/** No-service path (harness e2e + macOS): deps + UI install + UI build only.
 * Do NOT touch systemd. (The harness boots Shepherd directly afterward.) */
export function buildOnly(repo: string, run: Runner, buildEnv: NodeJS.ProcessEnv): void {
  log("installing deps (root + ui)");
  run("bash", ["-c", `cd "${repo}" && bun install`], { env: buildEnv });
  run("bash", ["-c", `cd "${repo}/ui" && bun install`], { env: buildEnv });
  log("building UI");
  run("bash", ["-c", `cd "${repo}/ui" && bun run build`], { env: buildEnv });
}

export function provision(opts: ProvisionOpts = {}): void {
  const run = opts.run ?? defaultRunner;
  const probe = opts.probe ?? probeVersion;
  const fileIO = opts.fileIO ?? defaultFileIO;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const repo = opts.repo ?? process.cwd();
  const home = homedir();
  const memFn = opts.totalMem ?? totalmem;

  const memWarning = lowMemoryWarning(memFn());
  if (memWarning !== null) {
    process.stdout.write(`\x1b[33m${memWarning}\x1b[0m\n`);
  }

  installPrereqs(probe, run, env);
  const buildEnv = ensureNodeGyp(run, env, home);

  const decision = decideServicePath(platform, env.SHEPHERD_NO_SERVICE);
  if (decision.service) {
    installService(repo, run, fileIO, env, home, buildEnv);
  } else {
    buildOnly(repo, run, buildEnv);
  }

  if (decision.degradedBanner) {
    for (const line of MACOS_DEGRADED_BANNER) process.stdout.write(`\x1b[33m${line}\x1b[0m\n`);
  }

  // final summary + guidance
  process.stdout.write("\n");
  for (const line of guidanceNextSteps()) process.stdout.write(`${line}\n`);
}

// Run when invoked directly (not when imported by tests).
if (import.meta.main) {
  try {
    provision();
  } catch (err) {
    process.stderr.write(`\x1b[31m✗ provision failed: ${(err as Error).message}\x1b[0m\n`);
    process.exit(1);
  }
}
