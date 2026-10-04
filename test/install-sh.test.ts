/**
 * Executable coverage for deploy/install.sh beyond `bash -n`: source it in
 * lib-mode (SHEPHERD_INSTALL_LIB=1) and exercise the PURE decisions — OS→mode
 * mapping and source-resolve — with NO real installs, NO network, NO Incus.
 *
 * detect_os honors SHEPHERD_UNAME_S/_M seams; resolve_source is driven with a
 * temp dir + a local tarball (never the real `git clone` path).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALL_SH = resolve(import.meta.dir, "..", "deploy", "install.sh");

/** Source install.sh in lib-mode then run `script` (bash), returning the result. */
function runLib(
  script: string,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `source "${INSTALL_SH}"\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, SHEPHERD_INSTALL_LIB: "1", ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "install-sh-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("detect_os + decide (OS → mode)", () => {
  it("Linux ⇒ mode full", () => {
    const r = runLib("detect_os; decide", { SHEPHERD_UNAME_S: "Linux" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mode: full");
  });

  it("Darwin ⇒ core-only + degraded notice + SHEPHERD_NO_SERVICE set", () => {
    const r = runLib('detect_os; decide; echo "NO_SERVICE=${SHEPHERD_NO_SERVICE:-unset}"', {
      SHEPHERD_UNAME_S: "Darwin",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mode: core-only");
    expect(r.stdout).toContain("NO_SERVICE=1");
    // Concise degraded notice (printed via warn → stderr); the full capability
    // list now lives in provision.ts (macosDegradedBanner), not exercised here.
    const all = r.stdout + r.stderr;
    expect(all).toContain("DEGRADED");
    expect(all).toContain("core-only");
  });

  it("MINGW64_NT ⇒ refuse with WSL2 message + non-zero exit", () => {
    const r = runLib("detect_os; decide", { SHEPHERD_UNAME_S: "MINGW64_NT" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("WSL2");
  });

  it("MSYS ⇒ refuse with WSL2 message + non-zero exit", () => {
    const r = runLib("detect_os; decide", { SHEPHERD_UNAME_S: "MSYS_NT-10.0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("WSL2");
  });
});

describe("resolve_source", () => {
  it("SHEPHERD_SRC tarball extracts into $SHEPHERD_DIR", () => {
    const work = tmp();
    // build a tiny tree that looks like a Shepherd checkout, tar it
    const srcRoot = join(work, "srcroot");
    mkdirSync(join(srcRoot, "deploy"), { recursive: true });
    writeFileSync(join(srcRoot, "deploy", "provision.ts"), 'console.log("x");\n');
    const tarball = join(work, "src.tar");
    const tarRes = spawnSync("tar", ["-cf", tarball, "-C", srcRoot, "."], { encoding: "utf8" });
    expect(tarRes.status).toBe(0);

    const dest = join(work, "dest");
    const r = runLib("resolve_source", { SHEPHERD_SRC: tarball, SHEPHERD_DIR: dest });
    expect(r.status).toBe(0);

    // verify the extracted hand-off target landed in $SHEPHERD_DIR
    const check = spawnSync("test", ["-f", join(dest, "deploy", "provision.ts")]);
    expect(check.status).toBe(0);
  });

  it("existing non-checkout $SHEPHERD_DIR ⇒ non-zero exit, no clobber", () => {
    const work = tmp();
    const dest = join(work, "occupied");
    mkdirSync(dest, { recursive: true });
    const marker = join(dest, "random.txt");
    writeFileSync(marker, "do not touch me\n");

    const r = runLib("resolve_source", { SHEPHERD_DIR: dest });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("not a shepherd checkout");

    // the pre-existing file must still be intact (never clobbered)
    expect(readFileSync(marker, "utf8")).toBe("do not touch me\n");
  });
});

describe("install_deps", () => {
  /** Stub `bun` on PATH: logs `pwd|args` per call, fails the first `failFirst` calls and every
   *  call whose args equal `alwaysFail`. */
  function stubBun(failFirst: number, alwaysFail = ""): { binDir: string; log: string } {
    const work = tmp();
    const binDir = join(work, "bin");
    mkdirSync(binDir);
    const log = join(work, "calls.log");
    writeFileSync(
      join(binDir, "bun"),
      `#!/usr/bin/env bash\necho "$(pwd -P)|$*" >> "${log}"\n` +
        `[ "$*" = "${alwaysFail}" ] && exit 1\n` +
        `n=$(wc -l < "${log}")\n[ "$n" -le ${failFirst} ] && exit 1\nexit 0\n`,
      { mode: 0o755 },
    );
    return { binDir, log };
  }

  function calls(log: string): string[] {
    return readFileSync(log, "utf8").trim().split("\n");
  }

  function run(
    failFirst: number,
    alwaysFail = "",
  ): { dir: string; r: ReturnType<typeof runLib>; log: string } {
    const dir = realpathSync(tmp());
    const { binDir, log } = stubBun(failFirst, alwaysFail);
    const r = runLib("install_deps", {
      PATH: `${binDir}:${process.env.PATH}`,
      SHEPHERD_DIR: dir,
      SHEPHERD_RETRY_DELAY: "0",
    });
    return { dir, r, log };
  }

  it("node-gyp first, then bun install in $SHEPHERD_DIR", () => {
    const { dir, r, log } = run(0);
    expect(r.status).toBe(0);
    expect(calls(log)).toEqual([`${dir}|add -g node-gyp`, `${dir}|install`]);
  });

  it("transient failure ⇒ retried, then continues to bun install", () => {
    const { dir, r, log } = run(1);
    expect(r.status).toBe(0);
    expect(calls(log)).toEqual([
      `${dir}|add -g node-gyp`,
      `${dir}|add -g node-gyp`,
      `${dir}|install`,
    ]);
  });

  it("persistent node-gyp failure ⇒ non-zero exit, bun install never runs", () => {
    const { r, log } = run(99);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("node-gyp install failed");
    expect(calls(log)).toHaveLength(2);
  });

  it("persistent bun install failure ⇒ non-zero exit with a clear message", () => {
    const { r, log } = run(0, "install");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bun install failed");
    expect(calls(log)).toHaveLength(3);
  });
});

describe("install_bun minimum version", () => {
  it("compares numeric components and ignores suffixes", () => {
    for (const [version, status] of [
      ["1.3.1", 1],
      ["1.3.2", 0],
      ["1.3.2-canary", 0],
      ["1.4.2", 0],
      ["1.10.0", 0],
      ["2.0.0", 0],
      ["0.99.99", 1],
    ] as const) {
      expect(runLib(`bun_version_at_least '${version}'`).status).toBe(status);
    }
  });

  it("upgrades old Bun and rechecks, leaving current Bun alone", () => {
    for (const [initial, upgraded, status, calls] of [
      ["1.3.1", "1.3.2", 0, "upgrade"],
      ["1.3.1", "1.3.1", 1, "upgrade"],
      ["1.4.2", "1.4.2", 0, ""],
    ] as const) {
      const home = tmp();
      const bin = join(home, ".bun/bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(home, "version"), initial);
      writeFileSync(
        join(bin, "bun"),
        `#!/bin/sh
if [ "$1" = --version ]; then cat "$HOME/version"; else
  echo "$*" >> "$HOME/calls"
  echo '${upgraded}' > "$HOME/version"
fi
`,
        { mode: 0o755 },
      );
      const result = runLib("install_bun", { HOME: home });
      expect(result.status).toBe(status);
      if (calls) expect(readFileSync(join(home, "calls"), "utf8").trim()).toBe(calls);
      else expect(result.stdout).toContain("skipping upgrade");
      if (status) expect(result.stderr).toContain("still too old after upgrade");
    }
  });
});
