import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMEDIATION_TIMEOUT_MS } from "../src/config";
import { HERDR_LAST_SUPPORTED_VERSION } from "../src/herdr-capabilities";
import {
  HERDR_IN_APP_DOWNLOAD_WORST_CASE_MS,
  HERDR_SERVE_WORST_CASE_MS,
  HERDR_VERIFY_WORST_CASE_MS,
  herdrAssetKey,
  herdrPinnedInstallCommand,
  herdrReleaseTagUrl,
  herdrReleaseUrl,
  sanitizeVersion,
} from "../src/herdr-install";

const PIN = HERDR_LAST_SUPPORTED_VERSION;

// ── shape / property assertions ───────────────────────────────────────────────

describe("herdrPinnedInstallCommand: shape", () => {
  const cmd = herdrPinnedInstallCommand();

  it("pins the supported ceiling and never reaches the latest-only upstream installer", () => {
    expect(cmd).toContain(`/releases/download/v${PIN}/herdr-`);
    // The whole point of #1896: `herdr.dev/install.sh` resolves latest.json and installs
    // whatever is newest, which is what put an above-ceiling herdr on every fresh host.
    expect(cmd).not.toContain("herdr.dev/install.sh");
  });

  it("is a subshell so `${HERDR_INSTALL} && (${HERDR_SERVE})` gates on the WHOLE program", () => {
    expect(cmd.startsWith("(")).toBe(true);
    expect(cmd.trimEnd().endsWith(")")).toBe(true);
  });

  it("emits a single line — DiagnoseRows renders it `white-space: pre` in a card with no desktop max-height", () => {
    expect(cmd).not.toContain("\n");
  });

  it("downloads into the install dir, never /tmp, so the swap is an atomic same-fs rename", () => {
    expect(cmd).toContain('D="${HERDR_INSTALL_DIR:-$HOME/.local/bin}"');
    expect(cmd).toContain('T="$D/.herdr.$$"');
    expect(cmd).not.toContain("/tmp/");
  });

  it("claims success only behind a post-swap executable check", () => {
    const guard = cmd.indexOf('[ -x "$D/herdr" ]');
    const claim = cmd.indexOf(`echo "herdr ${PIN} installed`);
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it("sizes the download per consumer: upstream-comparable vs the in-app deadline", () => {
    expect(herdrPinnedInstallCommand(PIN, { downloadBudget: "upstream" })).toContain(
      "--max-time 120",
    );
    expect(herdrPinnedInstallCommand(PIN, { downloadBudget: "in-app" })).toContain("--max-time 90");
    // Default is the tight one: REMEDIATIONS is the default consumer, and an accidentally-loose
    // in-app command would be SIGKILLed mid-download by defaultRunRemediation.
    expect(cmd).toContain("--max-time 90");
  });

  it("keeps the in-app budget inside the remediation group-kill, with every term declared", () => {
    // Not `REMEDIATION_TIMEOUT_MS - download - serve`: a residual makes this tautological and it
    // would keep passing when the download budget is raised — the exact regression it guards.
    const worstCase =
      HERDR_IN_APP_DOWNLOAD_WORST_CASE_MS + HERDR_VERIFY_WORST_CASE_MS + HERDR_SERVE_WORST_CASE_MS;
    expect(worstCase).toBeLessThanOrEqual(REMEDIATION_TIMEOUT_MS);
  });

  it("strips shell metacharacters out of the version", () => {
    const evil = herdrPinnedInstallCommand('0.7.5"; rm -rf ~ #');
    expect(evil).toContain("/releases/download/v0.7.5/herdr-");
    expect(evil).not.toContain("rm -rf ~");
  });
});

describe("herdrReleaseTagUrl", () => {
  it("points at the pinned release tag and sanitizes", () => {
    expect(herdrReleaseTagUrl("0.7.5")).toBe(
      "https://github.com/ogulcancelik/herdr/releases/tag/v0.7.5",
    );
    expect(herdrReleaseTagUrl("0.7.5; rm -rf ~")).toBe(
      "https://github.com/ogulcancelik/herdr/releases/tag/v0.7.5",
    );
  });
});

describe("sanitizeVersion", () => {
  it("keeps version chars, drops the rest, and never returns empty", () => {
    expect(sanitizeVersion("0.7.5")).toBe("0.7.5");
    expect(sanitizeVersion("herdr 0.7.5\n")).toBe("0.7.5");
    expect(sanitizeVersion("")).toBe("unknown");
    expect(sanitizeVersion(null)).toBe("unknown");
  });
});

// ── PATH-shim harness: run the REAL program with fake `uname` / `curl` ────────
//
// Every branch below executes the production string. Fakes are on PATH (and `$HOME` contains a
// SPACE, so a missing quote fails here rather than on a user's machine); nothing touches the
// network and nothing touches the real ~/.local/bin.

interface Shim {
  dir: string;
  home: string;
  installDir: string;
  curlLog: string;
}

function makeShim(opts: {
  unameS?: string;
  unameM?: string;
  /** what the fake `curl` does: succeed writing a stub, or fail */
  curl:
    | { mode: "fail" }
    | { mode: "stub"; version?: string; executable?: boolean; versionExit?: number };
}): Shim {
  const dir = mkdtempSync(join(tmpdir(), "herdr-install-"));
  const home = join(dir, "home dir"); // deliberate space
  const bin = join(dir, "bin");
  const installDir = join(home, ".local", "bin");
  const curlLog = join(dir, "curl.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });

  const write = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };

  write(
    "uname",
    `#!/bin/sh\ncase "$1" in -s) echo '${opts.unameS ?? "Linux"}' ;; -m) echo '${opts.unameM ?? "x86_64"}' ;; *) echo '${opts.unameS ?? "Linux"}' ;; esac\n`,
  );

  if (opts.curl.mode === "fail") {
    write("curl", `#!/bin/sh\nprintf '%s\\n' "$*" >> '${curlLog}'\nexit 22\n`);
  } else {
    const version = opts.curl.version ?? PIN;
    const versionExit = opts.curl.versionExit ?? 0;
    // The artifact the fake curl "downloads". Written from Node (never interpolated into shell
    // quoting) so the payload's own quotes can't corrupt the shim. `executable: false` writes a
    // blob the shell cannot exec — the glibc-asset-on-musl shape.
    const payload = join(dir, "payload");
    writeFileSync(
      payload,
      opts.curl.executable === false
        ? "\u007fELF not runnable here\n"
        : `#!/bin/sh\necho "herdr ${version}"\nexit ${versionExit}\n`,
    );
    write(
      "curl",
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${curlLog}'\n` +
        // mimic `curl -o <path> <url>`: find the -o argument
        `out=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\n` +
        `cp '${payload}' "$out"\n`,
    );
  }

  return { dir, home, installDir, curlLog };
}

function runProgram(
  shim: Shim,
  cmd: string = herdrPinnedInstallCommand(),
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("sh", ["-c", cmd], {
    env: {
      PATH: `${join(shim.dir, "bin")}:/usr/bin:/bin`,
      HOME: shim.home,
    },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function curlCalls(shim: Shim): string {
  return existsSync(shim.curlLog) ? execFileSync("cat", [shim.curlLog], { encoding: "utf8" }) : "";
}

/** Leftover temp files in the install dir — the program must clean up on every path. */
function strays(shim: Shim): string[] {
  if (!existsSync(shim.installDir)) return [];
  return readdirSync(shim.installDir).filter((f) => f.startsWith(".herdr"));
}

describe("herdrPinnedInstallCommand: execution branches", () => {
  const cleanup = (shim: Shim) => rmSync(shim.dir, { recursive: true, force: true });

  it("success: installs an executable herdr reporting the pin, leaves no temp behind", () => {
    const shim = makeShim({ curl: { mode: "stub" } });
    try {
      const r = runProgram(shim);
      expect(r.code).toBe(0);
      const installed = join(shim.installDir, "herdr");
      expect(existsSync(installed)).toBe(true);
      expect(execFileSync(installed, ["--version"], { encoding: "utf8" })).toContain(PIN);
      expect(strays(shim)).toEqual([]);
      // The temp was written INSIDE the install dir (same filesystem ⇒ atomic rename), not /tmp.
      expect(curlCalls(shim)).toContain(join(shim.installDir, ".herdr."));
      expect(r.stdout).toContain(`herdr ${PIN} installed`);
    } finally {
      cleanup(shim);
    }
  });

  it("unmapped OS: fails loudly naming the release tag, without downloading anything", () => {
    const shim = makeShim({ unameS: "SunOS", curl: { mode: "stub" } });
    try {
      const r = runProgram(shim);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(herdrReleaseTagUrl(PIN));
      expect(curlCalls(shim)).toBe("");
    } finally {
      cleanup(shim);
    }
  });

  it("unmapped architecture: fails loudly naming the release tag, without downloading anything", () => {
    const shim = makeShim({ unameM: "armv7l", curl: { mode: "stub" } });
    try {
      const r = runProgram(shim);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(herdrReleaseTagUrl(PIN));
      expect(curlCalls(shim)).toBe("");
    } finally {
      cleanup(shim);
    }
  });

  it("download failure: fails loudly, installs nothing, leaves no temp", () => {
    const shim = makeShim({ curl: { mode: "fail" } });
    try {
      const r = runProgram(shim);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("download failed");
      expect(existsSync(join(shim.installDir, "herdr"))).toBe(false);
      expect(strays(shim)).toEqual([]);
    } finally {
      cleanup(shim);
    }
  });

  it("cannot exec (musl/glibc): warns but installs anyway — a hard abort would kill install.sh on Alpine", () => {
    const shim = makeShim({ curl: { mode: "stub", executable: false } });
    try {
      const r = runProgram(shim);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("does not run here");
      expect(existsSync(join(shim.installDir, "herdr"))).toBe(true);
      expect(strays(shim)).toEqual([]);
    } finally {
      cleanup(shim);
    }
  });

  it("exit 0 with an unparseable version: warns but installs anyway — that is our parser, not a bad artifact", () => {
    const shim = makeShim({ curl: { mode: "stub", version: "unreleased-build" } });
    try {
      const r = runProgram(shim);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("could not read a version");
      expect(existsSync(join(shim.installDir, "herdr"))).toBe(true);
    } finally {
      cleanup(shim);
    }
  });

  it("version mismatch: refuses to install — the one case with positive evidence the artifact is wrong", () => {
    const shim = makeShim({ curl: { mode: "stub", version: "9.9.9" } });
    try {
      const r = runProgram(shim);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("reports 9.9.9");
      expect(existsSync(join(shim.installDir, "herdr"))).toBe(false);
      expect(strays(shim)).toEqual([]);
    } finally {
      cleanup(shim);
    }
  });

  it("refuses to claim success when $D/herdr is a directory (mv would move INTO it)", () => {
    const shim = makeShim({ curl: { mode: "stub" } });
    try {
      mkdirSync(join(shim.installDir, "herdr"), { recursive: true });
      const r = runProgram(shim);
      expect(r.code).not.toBe(0);
      // A bare `-x` test passes on a traversable directory, so this is the case that would
      // otherwise report a healthy install with no herdr binary anywhere.
      expect(r.stdout).not.toContain("installed to");
    } finally {
      cleanup(shim);
    }
  });

  it("unwritable install dir: fails non-zero and never claims success", () => {
    const shim = makeShim({ curl: { mode: "stub" } });
    try {
      mkdirSync(shim.installDir, { recursive: true });
      chmodSync(shim.installDir, 0o500); // read+execute, not writable
      const r = runProgram(shim);
      expect(r.code).not.toBe(0);
      // `echo` exits 0, so an unguarded success line would report a healthy install on a host
      // with no herdr — and provision's runner (which throws only on non-zero) would sail on.
      expect(r.stdout).not.toContain("installed to");
      expect(existsSync(join(shim.installDir, "herdr"))).toBe(false);
    } finally {
      chmodSync(shim.installDir, 0o700);
      cleanup(shim);
    }
  });
});

// ── the two platform mappings must agree ─────────────────────────────────────
//
// herdrAssetKey (TypeScript: the preflight banner + #1902's downgrade) and the shell `case` arms
// (every real install) are independent tables that can silently diverge. No harness scenario runs
// macOS, so this is the only seam that can catch the Darwin arms at all.

describe("TS herdrAssetKey and the shell uname mapping agree", () => {
  const pairs: Array<{ platform: NodeJS.Platform; arch: string; s: string; m: string }> = [
    { platform: "linux", arch: "x64", s: "Linux", m: "x86_64" },
    { platform: "linux", arch: "arm64", s: "Linux", m: "aarch64" },
    { platform: "darwin", arch: "x64", s: "Darwin", m: "x86_64" },
    { platform: "darwin", arch: "arm64", s: "Darwin", m: "aarch64" },
    // Shell-only aliases the TS table never sees, asserted against the same canonical URL.
    { platform: "linux", arch: "x64", s: "Linux", m: "amd64" },
    { platform: "darwin", arch: "arm64", s: "Darwin", m: "arm64" },
  ];

  for (const { platform, arch, s, m } of pairs) {
    it(`${s}/${m} downloads ${herdrAssetKey(platform, arch)}`, () => {
      const shim = makeShim({ unameS: s, unameM: m, curl: { mode: "stub" } });
      try {
        runProgram(shim);
        expect(curlCalls(shim)).toContain(herdrReleaseUrl(PIN, herdrAssetKey(platform, arch)!));
      } finally {
        rmSync(shim.dir, { recursive: true, force: true });
      }
    });
  }
});
