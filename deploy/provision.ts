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
import { HERDR_LAST_SUPPORTED_VERSION } from "../src/herdr-capabilities";
import { herdrPinnedInstallCommand } from "../src/herdr-install";
import { autoFixCommandFor, HERDR_SERVE } from "../src/remediations";
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
  /** Overrides the hintKey's shipped remediation for THIS loop only — set when the
   *  remediation does more than provision wants here. See herdr below. */
  installCommand?: string;
}

export const PREREQS: readonly Prereq[] = [
  { bin: "bun", hintKey: "diagnostics_hint_bun_missing", floor: BUN_MIN_VERSION },
  { bin: "node", hintKey: "diagnostics_hint_node_missing", floor: NODE_MIN_VERSION },
  {
    bin: "herdr",
    hintKey: "diagnostics_hint_herdr_missing",
    floor: HERDR_MIN_VERSION,
    // INSTALL ONLY — deliberately NOT the hint's shipped remediation, which is
    // `HERDR_INSTALL && (HERDR_SERVE)` and leaves a DETACHED, unsupervised daemon holding the
    // socket. `installService` then runs `enable --now herdr`, whose ExecStart hits that bound
    // socket, exits 1 ("herdr server is already running" — verified), and Restart=always
    // thrashes the unit while the orphan keeps serving. The check still reads `ok` (the orphan
    // answers), so the breakage would be invisible. On the service path the UNIT owns the
    // daemon; `buildOnly` (no systemd) starts it explicitly instead. #1574
    //
    // It is also built with the UPSTREAM-COMPARABLE download budget rather than reusing
    // `HERDR_INSTALL` verbatim (#1896): that constant is sized for the in-app Fix, whose child is
    // SIGKILLed at REMEDIATION_TIMEOUT_MS, while nothing kills provision. This is the path where a
    // failed herdr install genuinely strands an operator (`install.sh` aborts and the host is left
    // with no herdr), so it gets the same bandwidth tolerance upstream's own installer allows.
    installCommand: herdrPinnedInstallCommand(HERDR_LAST_SUPPORTED_VERSION, {
      downloadBudget: "upstream",
    }),
  },
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
  // `installCommand` wins when set (herdr: install-only, no daemon start). Otherwise the
  // shipped remediation via autoFixCommandFor, which still excludes guidance-only hints.
  return prereq.installCommand ?? autoFixCommandFor(prereq.hintKey);
}

/** Rewrite the herdr unit's `ExecStart` to an absolute, resolved herdr path. systemd needs an
 *  absolute executable, and herdr is NOT always at `~/.local/bin` — a package install can land
 *  it in `/usr/local/bin`. Presence (`probeVersion`) and liveness (`config.herdrBin`) both
 *  resolve `herdr` on `$PATH`, so a hardcoded unit path could point at nothing while the checks
 *  are perfectly happy, and `enable --now herdr` would fail the whole provision. #1574 */
export function templateHerdrUnit(unit: string, herdrPath: string): string {
  return unit.replace(/^ExecStart=.*$/m, `ExecStart=${herdrPath} server`);
}

/** Adopt the socket before enabling the unit: if the unit is NOT already the active herdr, stop
 *  whatever daemon is (an in-app Fix's detached `HERDR_SERVE` child, or a hand-rolled one). A
 *  second `herdr server` against a bound socket exits 1, so without this `enable --now herdr`
 *  would thrash. Sources `~/.shepherd/env` and honors `HERDR_BIN` so it stops the SAME binary
 *  the unit and the diagnostics probe use — a bare `herdr` would miss a `HERDR_BIN` daemon
 *  entirely. Best-effort by construction: every branch swallows failure and exits 0, so a host
 *  with no herdr running (the fresh-install case) sails straight through. #1574
 *
 *  `set -a` around the source is load-bearing, not decoration: a bare `.` leaves HERDR_SESSION /
 *  HERDR_SOCKET_PATH as UNEXPORTED shell variables, so the `server stop` CHILD never sees them
 *  and addresses the default socket. On a non-default-session host that stops nothing, the real
 *  orphan stays bound, and `enable --now herdr` then thrashes the unit forever behind a green
 *  check. (HERDR_BIN only appeared to work because it is expanded in-shell, below.) */
const HERDR_ADOPT_SOCKET =
  'export PATH="$HOME/.local/bin:$PATH"; ' +
  'set -a; [ -f "$HOME/.shepherd/env" ] && . "$HOME/.shepherd/env"; set +a; ' +
  'H="${HERDR_BIN:-herdr}"; ' +
  "systemctl --user is-active --quiet herdr && exit 0; " +
  'command -v "$H" >/dev/null 2>&1 && "$H" server stop >/dev/null 2>&1; ' +
  "systemctl --user reset-failed herdr >/dev/null 2>&1; exit 0";

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
 *  (`repo`) instead of the hardcoded `%h/.shepherd/app`. This makes the default
 *  (`~/.shepherd/app`) install byte-identical while making a custom
 *  SHEPHERD_DIR correct — ExecStart stays `bun run src/index.ts` (relative to
 *  WorkingDirectory) and bun's path is independent of the checkout, so retargeting
 *  WorkingDirectory alone suffices. Replaces the single `WorkingDirectory=` line. */
export function templateUnit(unit: string, repo: string): string {
  return unit.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${repo}`);
}

/** Final guidance follow-ups that need a human secret and are NEVER auto-run.
 *  Leads with the checkout dir so every platform (incl. Linux/systemd) shows
 *  where install.sh landed Shepherd. */
export function guidanceNextSteps(repo: string): string[] {
  return [
    `Installed to: ${repo}`,
    "Shepherd will be available at http://localhost:7330",
    "",
    "A few steps need a human secret and were NOT run for you:",
    "  • Log into Claude:   claude   (then sign in with your Max/Pro subscription)",
    "  • GitHub auth:       gh auth login",
    "  • PATH (macOS):      herdr/claude live in ~/.local/bin — ensure it's on PATH:",
    '                       export PATH="$HOME/.local/bin:$PATH"',
    "  • Remote access:     tailscale serve --bg 7330",
    "                       then add the tailnet hostname to SHEPHERD_ALLOWED_HOSTS",
    "                       (in ~/.shepherd/env or deploy/shepherd.service)",
  ];
}

/** macOS degraded-mode banner. Takes the actual checkout dir (`repo`) so the
 *  manual-start line is copy-pasteable — the operator otherwise has no idea
 *  where install.sh landed Shepherd (default ~/.shepherd/app, but SHEPHERD_DIR
 *  can retarget it). */
export function macosDegradedBanner(repo: string): string[] {
  return [
    "",
    "════════════════════════════════════════════════════════════════════",
    "  ⚠  macOS: running in DEGRADED mode",
    "════════════════════════════════════════════════════════════════════",
    "  The following Linux-only capabilities are UNAVAILABLE on macOS:",
    "    • sandbox membrane (per-spawn credential isolation)",
    "    • egress allowlist (autonomous netns firewall)",
    "    • auto-drain",
    "    • stopping a preview from the UI",
    "    • exposing previews over the tailnet (needs the `tailscale` CLI)",
    "    • no automated install proof (the onboarding harness is Linux-only)",
    "",
    "  No launchd unit is installed. Start Shepherd manually with:",
    `    cd "${repo}" && bun run start`,
    "════════════════════════════════════════════════════════════════════",
    "",
  ];
}

/** Manual-start hint for the Linux no-service path (SHEPHERD_NO_SERVICE): no
 *  systemd unit was installed, so — like macOS — the operator must start
 *  Shepherd by hand and needs to know the checkout dir. */
export function noServiceStartHint(repo: string): string[] {
  return [
    "",
    "  No systemd unit was installed (SHEPHERD_NO_SERVICE). Start Shepherd manually with:",
    `    cd "${repo}" && bun run start`,
    "",
  ];
}

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

/** Synchronous sleep — provision runs a sequential, synchronous install flow, so the
 *  between-attempt backoff in {@link runWithRetry} can't be a Promise. `ms <= 0` is a
 *  no-op (tests pass 0 to stay instant). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Bounded, fail-closed retry around a single `run` step. Bun's dependency fetch/extract
 *  can hit a transient registry/mirror flake — observed as `error: Fail extracting tarball
 *  for "node-pty"` (#1602) — that succeeds on a re-run. Wrapping the `bun install` steps
 *  lets one such flake not fail a cold-start install (nor red the onboarding release gate,
 *  whose installE2E/serviceLifecycle scenarios drive this path). Any non-zero exit retries
 *  up to `attempts`; a deterministic failure just re-fails each attempt and the last error
 *  propagates — so a real regression still gates. Mirrors the apply-time retry in #1599. */
function runWithRetry(
  run: Runner,
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } | undefined,
  attempts: number,
  delayMs: number,
): void {
  for (let attempt = 1; ; attempt++) {
    try {
      run(cmd, args, opts);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      log(`  step failed (attempt ${attempt}/${attempts}) — retrying in ${delayMs}ms`);
      sleepSync(delayMs);
    }
  }
}

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

/** Resolve the herdr binary to an absolute path for the unit's ExecStart (systemd needs one);
 *  null if it cannot be found.
 *
 *  Resolution order mirrors `config.herdrBin` (`HERDR_BIN ?? "herdr"`): source `~/.shepherd/env`
 *  — the same file shepherd.service and herdr.service read — then `command -v "${HERDR_BIN:-herdr}"`.
 *  Anything else supervises a different binary than the one diagnostics probes.
 *
 *  MUST be given the AUGMENTED env (`buildEnv`), not provision's inherited one: install.sh drops
 *  herdr in ~/.local/bin, which is absent from the PATH provision itself was launched with, so
 *  an inherited-PATH lookup finds nothing on the very host that just installed it. */
function probeBinPath(_bin: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync(
      "sh",
      [
        "-c",
        '[ -f "$HOME/.shepherd/env" ] && . "$HOME/.shepherd/env"; command -v "${HERDR_BIN:-herdr}"',
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env },
    );
    const p = out.trim();
    return p === "" ? null : p;
  } catch {
    return null;
  }
}

/** Read a file that may not exist yet; null when absent/unreadable. Lets `installService` ask
 *  "did this unit actually change?" without a stat seam — a missing unit reads as changed. */
function readIfPresent(fileIO: FileIO, path: string): string | null {
  try {
    return fileIO.read(path);
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
  /** Injectable absolute-path resolver (herdr.service ExecStart templating). */
  probePath?: (bin: string, env: NodeJS.ProcessEnv) => string | null;
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
  /** Resolves a binary to an absolute path against a given env (injected in tests). */
  probePath: (bin: string, env: NodeJS.ProcessEnv) => string | null = probeBinPath,
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
  // hardcoded %h/.shepherd/app. Default repo (~/.shepherd/app) ⇒ identical output.
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
  // herdr's daemon: Shepherd cannot spawn a single agent without it, and herdr 0.7.3 does NOT
  // auto-spawn it (#1574). TEMPLATED, not verbatim: ExecStart must be the herdr this host
  // actually resolves on PATH (installers use ~/.local/bin, packages /usr/local/bin), else the
  // unit points at nothing while `probeVersion`/`config.herdrBin` are perfectly happy.
  // buildEnv, NOT env: it carries ~/.local/bin (where install.sh just put herdr) on PATH.
  const herdrPath = probePath("herdr", buildEnv);
  if (!herdrPath) throw new Error("cannot install herdr.service: herdr is not on PATH");
  const herdrUnitPath = join(unitDir, "herdr.service");
  const desiredHerdrUnit = templateHerdrUnit(
    fileIO.read(join(repo, "deploy", "herdr.service")),
    herdrPath,
  );
  const herdrUnitChanged = readIfPresent(fileIO, herdrUnitPath) !== desiredHerdrUnit;
  if (herdrUnitChanged) fileIO.write(herdrUnitPath, desiredHerdrUnit);
  run("systemctl", ["--user", "daemon-reload"]);
  // Pick up a CHANGED ExecStart on a host whose herdr unit is already running: `enable --now`
  // will not restart an active unit, so a re-provision after herdr moved (e.g. /usr/local/bin →
  // ~/.local/bin, or HERDR_BIN changed) would otherwise leave the old daemon running the stale
  // path forever. `try-restart` restarts it iff active, and is a no-op when it is not.
  //
  // GATED on the unit actually differing: try-restart kills the daemon backing every live agent
  // session, so bouncing it for a byte-identical unit would make each re-provision needlessly
  // disruptive. A missing installed unit reads as "changed" (the first-install case).
  if (herdrUnitChanged) run("systemctl", ["--user", "try-restart", "herdr"]);
  const user = env.USER;
  if (!user) throw new Error("cannot enable-linger: $USER is not set");
  run("loginctl", ["enable-linger", user]);
  run("systemctl", ["--user", "enable", "shepherd"]);
  // Take the socket before enabling: any daemon NOT owned by the unit (an in-app Fix's detached
  // HERDR_SERVE child, a hand-rolled server) would make ExecStart exit 1 and thrash the unit.
  // No-op on a fresh host, and on one the unit already owns.
  run("bash", ["-c", HERDR_ADOPT_SOCKET], { env });
  // --now: bring the daemon up immediately. MUST precede update.sh below, which starts
  // Shepherd — a Shepherd that boots against a dead herdr reports `offline` and spawns
  // nothing. `enable` alone would only arm it for the next login.
  run("systemctl", ["--user", "enable", "--now", "herdr"]);
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

/** No-service path (harness e2e + macOS): starts the herdr daemon directly (no systemd unit
 * on this path), then deps + UI install + UI build. Do NOT touch systemd. (The harness boots
 * Shepherd directly afterward.) */
export function buildOnly(
  repo: string,
  run: Runner,
  buildEnv: NodeJS.ProcessEnv,
  // Bounds the transient-flake retry on the `bun install` steps; tests pass `delayMs: 0`.
  retry: { attempts: number; delayMs: number } = { attempts: 2, delayMs: 3000 },
): void {
  // No systemd on this path (harness install-e2e + macOS), so start the daemon directly.
  // HERDR_SERVE is idempotent and polls until it answers, so this both starts and verifies.
  log("starting herdr server (no-service path)");
  run("bash", ["-c", HERDR_SERVE], { env: buildEnv });
  log("installing deps (root + ui)");
  // Retry only the network-bound install: a transient `node-pty` tarball-extract flake
  // must not fail the install (#1602). fix-perms / build are local + deterministic.
  runWithRetry(
    run,
    "bash",
    ["-c", `cd "${repo}" && bun install`],
    { env: buildEnv },
    retry.attempts,
    retry.delayMs,
  );
  // node-pty ships spawn-helper without the exec bit and Bun preserves tarball perms,
  // so on macOS posix_spawn fails ("posix_spawnp failed.") and every pane stays black.
  // Re-set it right after the root install; a silent no-op off macOS. See the script.
  run("bash", ["-c", `cd "${repo}" && bun scripts/fix-node-pty-perms.mjs`], { env: buildEnv });
  runWithRetry(
    run,
    "bash",
    ["-c", `cd "${repo}/ui" && bun install`],
    { env: buildEnv },
    retry.attempts,
    retry.delayMs,
  );
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
  const probePath = opts.probePath ?? probeBinPath;

  const memWarning = lowMemoryWarning(memFn());
  if (memWarning !== null) {
    process.stdout.write(`\x1b[33m${memWarning}\x1b[0m\n`);
  }

  installPrereqs(probe, run, env);
  const buildEnv = ensureNodeGyp(run, env, home);

  const decision = decideServicePath(platform, env.SHEPHERD_NO_SERVICE);
  if (decision.service) {
    installService(repo, run, fileIO, env, home, buildEnv, probePath);
  } else {
    buildOnly(repo, run, buildEnv);
  }

  printClosingGuidance(decision, repo);
}

/** Emit the closing banners + next-steps guidance. Extracted from provision() so
 *  the manual-start branching (macOS degraded vs Linux no-service) doesn't push
 *  provision over its complexity budget. */
function printClosingGuidance(decision: ServiceDecision, repo: string): void {
  if (decision.degradedBanner) {
    for (const line of macosDegradedBanner(repo)) process.stdout.write(`\x1b[33m${line}\x1b[0m\n`);
  } else if (!decision.service) {
    // Linux no-service path (SHEPHERD_NO_SERVICE): nothing auto-starts and no
    // degraded banner fires, so surface the manual-start command + dir here.
    for (const line of noServiceStartHint(repo)) process.stdout.write(`\x1b[33m${line}\x1b[0m\n`);
  }

  // final summary + guidance
  process.stdout.write("\n");
  for (const line of guidanceNextSteps(repo)) process.stdout.write(`${line}\n`);
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
