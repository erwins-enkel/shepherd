import { HERDR_LAST_SUPPORTED_VERSION } from "../src/herdr-capabilities";
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMEDIATIONS, autoFixCommandFor, HERDR_SERVE, HERDR_INSTALL } from "../src/remediations";
import { buildUpdateScript } from "../src/herdr-update";
import { config } from "../src/config";

/** Build an isolated $HOME (with `logPath`/`markerPath` already decided) and a `.local/bin`
 *  dir so HERDR_SERVE's own `export PATH="$HOME/.local/bin:$PATH"` resolves to whatever stub
 *  a test writes there — never the real herdr binary this host may have installed. Callers
 *  write the stub (referencing the returned paths) via `writeStub`, then MUST clean up via
 *  `rmSync(dir, { recursive: true, force: true })`. */
function makeSandbox(): {
  dir: string;
  logPath: string;
  markerPath: string;
  writeStub: (script: string) => void;
  writeSystemctlStub: (script: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "herdr-remediation-"));
  const binDir = join(dir, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  // Stub `systemctl` too, denying by default (`cat herdr` non-zero ⇒ "no unit here").
  // MANDATORY, not tidiness: HERDR_SERVE's unit branch would otherwise resolve the REAL
  // systemctl from /usr/bin and could `restart herdr` on the developer's own machine.
  writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return {
    dir,
    logPath: join(dir, "herdr.log"),
    markerPath: join(dir, "marker"),
    writeStub: (script: string) => writeFileSync(join(binDir, "herdr"), script, { mode: 0o755 }),
    writeSystemctlStub: (script: string) =>
      writeFileSync(join(binDir, "systemctl"), script, { mode: 0o755 }),
  };
}

function runInSandbox(cmd: string, home: string, extraEnv: Record<string, string> = {}) {
  // Hermetic PATH: the stub bin dir FIRST, then only the base system dirs (`sh`, `sleep`,
  // `touch`, `command` must resolve). Deliberately does NOT inherit process.env.PATH, for two
  // reasons. (1) Safety: a dev host has a real herdr on PATH, and a test that falls through to
  // it would talk to the live daemon. (2) Teeth: the stub must be reachable even when the
  // command under test never runs HERDR_SERVE's own `export PATH=...` — otherwise a regression
  // that drops the subshell (leaving the export gated out) would find no herdr at all, log
  // nothing, exit non-zero, and pass this test on a herdr-less CI runner.
  const sandboxPath = `${home}/.local/bin:/usr/bin:/bin`;
  return spawnSync("sh", ["-c", cmd], {
    env: { ...process.env, HOME: home, PATH: sandboxPath, ...extraEnv },
    encoding: "utf8",
  });
}

describe("herdr offline remediation (#1574)", () => {
  it("exposes a start command for the offline hint", () => {
    expect(REMEDIATIONS.diagnostics_hint_herdr_offline).toBe(HERDR_SERVE);
  });

  it("makes the offline fix auto-runnable in-app (not guidance-only)", () => {
    expect(autoFixCommandFor("diagnostics_hint_herdr_offline")).toBe(HERDR_SERVE);
  });

  it("starts the daemon detached, portably (macOS has no setsid)", () => {
    expect(HERDR_SERVE).toContain("setsid");
    expect(HERDR_SERVE).toContain("nohup");
  });

  it("is idempotent: a live daemon short-circuits before spawning a second", () => {
    expect(HERDR_SERVE.indexOf('"$H" agent list')).toBeLessThan(HERDR_SERVE.indexOf('"$H" server'));
  });

  it("puts ~/.local/bin on PATH before invoking herdr", () => {
    expect(HERDR_SERVE.indexOf(".local/bin")).toBeLessThan(HERDR_SERVE.indexOf('"$H" agent list'));
  });

  it("resolves the binary through HERDR_BIN, matching what the check actually spawns", () => {
    // diagnostics spawns config.herdrBin = HERDR_BIN ?? "herdr". Starting a bare `herdr`
    // here would start a DIFFERENT binary than the one probed whenever HERDR_BIN is set.
    expect(HERDR_SERVE).toContain('H="${HERDR_BIN:-herdr}"');
    expect(HERDR_SERVE).toContain("systemctl --user restart herdr");
    expect(HERDR_SERVE).not.toContain("herdr agent list");
    expect(HERDR_SERVE).not.toContain("setsid herdr server");
  });

  it("drives the systemd unit when one exists, instead of racing it with a detached daemon", () => {
    // On a provisioned host `herdr: offline` means herdr.service cannot bind. Spawning a
    // detached daemon there puts an unsupervised process on the socket: the unit's ExecStart
    // exits 1 forever (StartLimitIntervalSec=0 ⇒ never parks in `failed`) while the check reads
    // `ok` because the orphan answers. Drive the unit; never race it. (#1574)
    const { dir, writeStub, writeSystemctlStub } = makeSandbox();
    const herdrLog = join(dir, "herdr.log");
    const sysLog = join(dir, "systemctl.log");
    try {
      // Daemon is dead until the unit is restarted; then it answers.
      writeStub(
        `#!/bin/sh\necho "$@" >>${herdrLog}\n` +
          `if [ "$1" = "agent" ] && [ -f ${dir}/started ]; then exit 0; fi\n` +
          `if [ "$1" = "agent" ]; then exit 1; fi\nexit 0\n`,
      );
      // Unit exists (`cat` ⇒ 0); `restart` brings the daemon up.
      writeSystemctlStub(
        `#!/bin/sh\necho "$@" >>${sysLog}\n` +
          `for a in "$@"; do\n` +
          `  [ "$a" = "cat" ] && exit 0\n` +
          `  [ "$a" = "restart" ] && { touch ${dir}/started; exit 0; }\n` +
          `done\nexit 1\n`,
      );

      const r = runInSandbox(HERDR_SERVE, dir);

      expect(r.status).toBe(0);
      const sys = readFileSync(sysLog, "utf8");
      expect(sys).toContain("restart herdr");
      // `reset-failed` clears a legacy/hand-edited unit the start-limiter parked in `failed`
      // BEFORE the restart (mirrors provision's HERDR_ADOPT_SOCKET). The stub `exit 1`s on the
      // unmatched `reset-failed` arg, so this exercises the real failing-reset-failed→restart
      // path: ordering proves reset-failed runs first, and status 0 proves the non-zero
      // reset-failed did NOT abort the sequence — a `;`→`&&` regression would flip status to 1
      // and never reach restart.
      expect(sys.indexOf("reset-failed herdr")).toBeGreaterThanOrEqual(0);
      expect(sys.indexOf("reset-failed herdr")).toBeLessThan(sys.indexOf("restart herdr"));
      // The daemon was NEVER spawned directly — no orphan on the socket.
      expect(readFileSync(herdrLog, "utf8")).not.toContain("server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HERDR_BIN, when set, is the binary actually started (behavioral)", () => {
    // The check this must clear spawns config.herdrBin. If HERDR_SERVE hardcoded `herdr`,
    // a host with HERDR_BIN set would start the wrong binary and the poll would time out.
    const { dir, writeStub } = makeSandbox();
    const altLog = join(dir, "alt.log");
    const defaultLog = join(dir, "default.log");
    try {
      // The on-PATH stub must NEVER run when HERDR_BIN points elsewhere.
      writeStub(`#!/bin/sh\necho "$@" >>${defaultLog}\nexit 0\n`);
      const altBin = join(dir, "herdr-alt");
      writeFileSync(altBin, `#!/bin/sh\necho "$@" >>${altLog}\nexit 0\n`, { mode: 0o755 });

      const r = runInSandbox(HERDR_SERVE, dir, { HERDR_BIN: altBin });

      expect(r.status).toBe(0);
      expect(existsSync(altLog)).toBe(true);
      expect(readFileSync(altLog, "utf8")).toContain("agent list");
      // The PATH-resolved `herdr` was never touched.
      expect(existsSync(defaultLog)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("herdr_missing installs AND starts, so the single-apply preflight scenario reaches green", () => {
    const cmd = REMEDIATIONS.diagnostics_hint_herdr_missing!;
    // PINNED install (#1896), never the latest-only upstream installer.
    expect(cmd).toContain(`/releases/download/v${HERDR_LAST_SUPPORTED_VERSION}/herdr-`);
    expect(cmd).not.toContain("herdr.dev/install.sh");
    expect(cmd).toContain('"$H" server');
  });

  it("herdr_missing wraps the reused HERDR_SERVE block in a subshell so && gates it as one unit", () => {
    // Shape-only check: the reused block must be parenthesized, not spliced in bare —
    // otherwise `;` inside HERDR_SERVE would terminate the && chain early (Finding 1).
    // The behavioral describe() below actually executes both forms to prove the gating.
    expect(REMEDIATIONS.diagnostics_hint_herdr_missing).toContain(`&& (${HERDR_SERVE})`);
  });
});

describe("herdr_missing composition is behaviorally gated, not just shaped right (#1574)", () => {
  // These execute the composed command through a real shell with a stubbed `herdr` —
  // substring/ordering assertions above pin the *shape* of the string but would pass
  // just as happily if `&&` bound to only the leading `export` (the exact bug Finding 1
  // caught). Only running it proves the gating.
  //
  // Safety: NEVER exercises the real HERDR_INSTALL (network install script) or the real
  // `herdr` binary. `false`/`true` stand in for the install clause. Every run gets its own
  // $HOME with a stubbed `herdr` on `.local/bin`, so HERDR_SERVE's own PATH-prepend resolves
  // to the stub — never the real herdr this dev host has installed.
  //
  // Derive from the PRODUCTION string, substituting only the network-touching install
  // clause. A regression that drops the subshell parens changes this command's shell
  // semantics and fails the install-failure test below — which is the whole point.
  const composed = (installClause: string) =>
    REMEDIATIONS.diagnostics_hint_herdr_missing!.replace(HERDR_INSTALL, installClause);

  it("derives from the production string by substituting the install clause", () => {
    // Guards against a silently-vacuous substitution (e.g. HERDR_INSTALL renamed/edited
    // so .replace matches nothing and `composed` just returns the unmodified prod string).
    expect(composed("false")).not.toContain("curl");
  });

  it("install failure gates the WHOLE block: herdr is never invoked at all", () => {
    const { dir, logPath, writeStub } = makeSandbox();
    writeStub(`#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
    try {
      const result = runInSandbox(composed("false"), dir);
      expect(result.status).not.toBe(0);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gates on a MULTI-STATEMENT failing install too — the shape HERDR_INSTALL now has (#1896)", () => {
    // The `false` case above cannot catch the real regression risk any more: HERDR_INSTALL is now
    // a multi-statement program, so if it ever lost its own subshell wrapper, `&&` would bind to
    // only its LAST statement and the install's failure would stop gating. Substituting a
    // multi-statement clause reproduces exactly that shape and proves the composition still gates.
    const { dir, logPath, writeStub } = makeSandbox();
    writeStub(`#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
    try {
      const result = runInSandbox(composed("( echo installing >/dev/null; false )"), dir);
      expect(result.status).not.toBe(0);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a live daemon short-circuits: no second server is spawned", () => {
    const { dir, logPath, writeStub } = makeSandbox();
    writeStub(
      `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "agent" ]; then exit 0; fi\nexit 0\n`,
    );
    try {
      const result = runInSandbox(composed("true"), dir);
      expect(result.status).toBe(0);
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("agent list");
      expect(log).not.toContain("server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a dead daemon is spawned, then polled until it answers", () => {
    const { dir, markerPath, writeStub } = makeSandbox();
    writeStub(
      `#!/bin/sh\n` +
        `if [ "$1" = "server" ]; then touch "${markerPath}"; exit 0; fi\n` +
        `if [ "$1" = "agent" ]; then [ -f "${markerPath}" ] && exit 0 || exit 1; fi\n` +
        `exit 1\n`,
    );
    try {
      const result = runInSandbox(composed("true"), dir);
      expect(result.status).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("herdr_outdated: update + handoff, not a bare reinstall (#1578)", () => {
  it("routes through the herdr update+handoff machinery (buildUpdateScript)", () => {
    // The fix for #1578: reinstalling the binary alone cleared the WARNING (the probe reads
    // `herdr --version`) but left the RUNNING daemon old — a split state. The remediation now
    // IS the update+handoff+recovery script, so a successful fix updates the binary AND hands
    // the live targets to the new server atomically.
    expect(REMEDIATIONS.diagnostics_hint_herdr_outdated).toBe(
      buildUpdateScript(config.herdrUpdateLogPath),
    );
  });

  it("updates AND hands off with recovery — not the reverted install+live-handoff design", () => {
    const cmd = REMEDIATIONS.diagnostics_hint_herdr_outdated!;
    expect(cmd).toContain("update --handoff"); // atomic update + handoff
    expect(cmd).toContain("setsid"); // detached-relaunch recovery so a failed handoff can't strand the host
    // The first-cut design used `herdr server live-handoff` behind a reachability poll (the
    // OLD daemon answers before AND after → false success). Guard against its return.
    expect(cmd).not.toContain("live-handoff");
    // No longer a bare reinstall (the pre-#1578 behavior that left the daemon old).
    expect(cmd).not.toBe(HERDR_INSTALL);
  });

  it("stays auto-fixable in-app (not guidance-only)", () => {
    expect(autoFixCommandFor("diagnostics_hint_herdr_outdated")).toBe(
      REMEDIATIONS.diagnostics_hint_herdr_outdated,
    );
  });
});

describe("herdr_outdated is behaviorally recover-on-fail, not just shaped right (#1578)", () => {
  // Execute the SAME generator the production entry uses (buildUpdateScript), with the audit
  // log redirected into the sandbox so the test never writes the dev's ~/.shepherd. The
  // structural test above pins that the entry IS buildUpdateScript(config.herdrUpdateLogPath);
  // the log path doesn't affect the update/handoff/recovery control flow exercised here.
  // herdr-update.test.ts asserts the STRING shape — these are the first tests that RUN it.
  //
  // Safety: NEVER runs the real network `herdr update` or the real herdr binary. The herdrBin
  // is pinned to bare `herdr`, which runInSandbox's PATH resolves to the sandbox stub.
  const scriptFor = (logPath: string) => buildUpdateScript(logPath, null, null, "herdr");

  it("a reachable server after update settles WITHOUT relaunching (also the no-op case)", () => {
    // A no-op `herdr update` whose OLD server still answers `agent list` exits 0 at the SHELL
    // layer — the shell CANNOT distinguish it from a real update (false success). That is
    // caught one layer up by DiagnosticsService.fix()'s re-probe of `herdr --version` (see
    // test/diagnostics.test.ts). Here we only assert the shell reaches the reachable branch.
    const { dir, logPath, writeStub } = makeSandbox();
    writeStub(`#!/bin/sh\nexit 0\n`); // update: ok; agent list: ok (server answers)
    try {
      const r = runInSandbox(scriptFor(logPath), dir);
      expect(r.status).toBe(0);
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("reachable after update");
      expect(log).not.toContain("unreachable after retries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a handoff that leaves NO running server triggers the detached relaunch recovery", () => {
    const { dir, logPath, writeStub } = makeSandbox();
    // `herdr update` exits 0 even when it left no running server (#1558), but the server never
    // answers — the grace+retry loop exhausts and the setsid fallback relaunch fires so the
    // host is never stranded offline (review point 2). The relaunch marker is echoed to the
    // durable log BEFORE the backgrounded setsid, so asserting on the log is race-free.
    writeStub(
      `#!/bin/sh\n` +
        `case "$1" in\n` +
        `  update) exit 0 ;;\n` +
        `  agent) exit 1 ;;\n` + // never reachable → forces the fallback
        `  server) exit 0 ;;\n` +
        `esac\nexit 0\n`,
    );
    try {
      runInSandbox(scriptFor(logPath), dir);
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("unreachable after retries");
      expect(log).toContain("relaunching");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // buildUpdateScript's grace loop sleeps 3×2s before the fallback — allow for it.
  }, 15_000);
});
