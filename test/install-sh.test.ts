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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    // list now lives in provision.ts (MACOS_DEGRADED_BANNER), not exercised here.
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
    const check = spawnSync("cat", [marker], { encoding: "utf8" });
    expect(check.stdout).toBe("do not touch me\n");
  });
});
