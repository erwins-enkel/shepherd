import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMEDIATIONS, autoFixCommandFor, HERDR_SERVE, HERDR_INSTALL } from "../src/remediations";

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
} {
  const dir = mkdtempSync(join(tmpdir(), "herdr-remediation-"));
  const binDir = join(dir, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  return {
    dir,
    logPath: join(dir, "herdr.log"),
    markerPath: join(dir, "marker"),
    writeStub: (script: string) => writeFileSync(join(binDir, "herdr"), script, { mode: 0o755 }),
  };
}

function runInSandbox(cmd: string, home: string) {
  return spawnSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home }, encoding: "utf8" });
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
    expect(HERDR_SERVE.indexOf("herdr agent list")).toBeLessThan(
      HERDR_SERVE.indexOf("herdr server"),
    );
  });

  it("puts ~/.local/bin on PATH before invoking herdr", () => {
    expect(HERDR_SERVE.indexOf(".local/bin")).toBeLessThan(HERDR_SERVE.indexOf("herdr agent list"));
  });

  it("herdr_missing installs AND starts, so the single-apply preflight scenario reaches green", () => {
    const cmd = REMEDIATIONS.diagnostics_hint_herdr_missing!;
    expect(cmd).toContain("herdr.dev/install.sh");
    expect(cmd).toContain("herdr server");
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
