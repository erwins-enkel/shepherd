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
import { homedir } from "node:os";
import { join } from "node:path";
import { BUN_MIN_VERSION, NODE_MIN_VERSION, HERDR_MIN_VERSION } from "../src/config";
import { compareSemver } from "../src/herdr-update";
import { autoFixCommandFor } from "../src/remediations";

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
}

export function provision(opts: ProvisionOpts = {}): void {
  const run = opts.run ?? defaultRunner;
  const probe = opts.probe ?? probeVersion;
  const fileIO = opts.fileIO ?? defaultFileIO;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const repo = opts.repo ?? process.cwd();
  const home = homedir();

  // ── 1. prereqs (table-driven, idempotent) ──────────────────────────────────
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

  // ── 2. node-gyp safety net (replicates ci/onboarding-harness/seed.ts) ────────
  // node-pty's install rebuilds via node-gyp on prebuilt-less distros; ensure it's
  // present and that ~/.bun/bin + ~/.local/bin are on the PATH the later bun install
  // sees. User-writable locations only — NO /usr/local/bin / sudo.
  log("ensuring node-gyp (node-pty build dep)");
  const bunBin = join(home, ".bun", "bin");
  const localBin = join(home, ".local", "bin");
  run("bash", ["-c", "bun add -g node-gyp"], { env });
  const buildEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${bunBin}:${localBin}:${env.PATH ?? ""}`,
  };

  // ── 3. service vs no-service ────────────────────────────────────────────────
  const decision = decideServicePath(platform, env.SHEPHERD_NO_SERVICE);

  if (decision.service) {
    log("installing systemd user unit");
    const unitDir = join(home, ".config", "systemd", "user");
    run("mkdir", ["-p", unitDir]);
    // Template (not a verbatim copy): point WorkingDirectory at the ACTUAL checkout
    // so a custom SHEPHERD_DIR install runs against the right dir, not the unit's
    // hardcoded %h/Work/shepherd. Default repo (~/Work/shepherd) ⇒ identical output.
    const unitSrc = fileIO.read(join(repo, "deploy", "shepherd.service"));
    fileIO.write(join(unitDir, "shepherd.service"), templateUnit(unitSrc, repo));
    run("systemctl", ["--user", "daemon-reload"]);
    const user = env.USER;
    if (!user) throw new Error("cannot enable-linger: $USER is not set");
    run("loginctl", ["enable-linger", user]);
    run("systemctl", ["--user", "enable", "shepherd"]);
    // update.sh does deps → UI build → restart (starts the now-enabled unit) → health.
    log("building + starting via deploy/update.sh");
    run("bash", [join(repo, "deploy", "update.sh")], { env: buildEnv });
  } else {
    // No-service path (harness e2e + macOS): deps + UI build + node-gyp net only.
    // Do NOT touch systemd. (The harness boots Shepherd directly afterward.)
    log("installing deps (root + ui)");
    run("bash", ["-c", `cd "${repo}" && bun install`], { env: buildEnv });
    run("bash", ["-c", `cd "${repo}/ui" && bun install`], { env: buildEnv });
    log("building UI");
    run("bash", ["-c", `cd "${repo}/ui" && bun run build`], { env: buildEnv });
  }

  if (decision.degradedBanner) {
    for (const line of MACOS_DEGRADED_BANNER) process.stdout.write(`\x1b[33m${line}\x1b[0m\n`);
  }

  // ── 4. final summary + guidance ─────────────────────────────────────────────
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
