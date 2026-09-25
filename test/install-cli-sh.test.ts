/**
 * deploy/install-cli.sh (#2484): installs the prebuilt `shepherd` CLI from a `cli-v<ver>` release.
 * Runs the real script against a file:// release tree (SHEPHERD_CLI_BASE_URL) of fake binaries —
 * no network, nothing outside temp dirs.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "deploy", "install-cli.sh");
const TARGET = "x86_64-unknown-linux-gnu";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "install-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A fake CLI binary that reports `version`. */
const fakeBin = (version: string) => `#!/bin/sh\necho "shepherd ${version}"\n`;

/** Publish a fake `cli-v<version>` release under `base`; `sum` overrides the checksum. */
function publish(base: string, version: string, sum?: string): void {
  const dir = join(base, `cli-v${version}`);
  mkdirSync(dir, { recursive: true });
  const body = fakeBin(version);
  writeFileSync(join(dir, `shepherd-${TARGET}`), body);
  const hex = sum ?? createHash("sha256").update(body).digest("hex");
  writeFileSync(join(dir, `shepherd-${TARGET}.sha256`), `${hex}  shepherd-${TARGET}\n`);
}

function run(
  args: string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, SHEPHERD_UNAME_S: "Linux", SHEPHERD_UNAME_M: "x86_64", ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function setup() {
  const base = tmp();
  const dir = join(tmp(), "bin");
  return { base, dir, env: { SHEPHERD_CLI_BASE_URL: `file://${base}`, SHEPHERD_CLI_DIR: dir } };
}

describe("cli_target", () => {
  const target = (s: string, m: string) =>
    spawnSync("bash", ["-c", `source "${SCRIPT}"; cli_target`], {
      encoding: "utf8",
      env: { ...process.env, SHEPHERD_INSTALL_LIB: "1", SHEPHERD_UNAME_S: s, SHEPHERD_UNAME_M: m },
    }).stdout.trim();

  it("maps supported hosts to release targets", () => {
    expect(target("Linux", "x86_64")).toBe("x86_64-unknown-linux-gnu");
    expect(target("Linux", "aarch64")).toBe("aarch64-unknown-linux-gnu");
    expect(target("Linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(target("Darwin", "arm64")).toBe("aarch64-apple-darwin");
  });

  it("has no target for Intel macOS or other arches", () => {
    expect(target("Darwin", "x86_64")).toBe("");
    expect(target("Linux", "riscv64")).toBe("");
  });
});

describe("install-cli.sh", () => {
  it("installs a verified, executable binary", () => {
    const { base, dir, env } = setup();
    publish(base, "1.2.3");
    const r = run(["1.2.3"], env);
    expect(r.status).toBe(0);
    const dest = join(dir, "shepherd");
    expect(statSync(dest).mode & 0o111).not.toBe(0);
    expect(spawnSync(dest, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(
      "shepherd 1.2.3",
    );
    // no temp files left beside it
    expect(readdirSync(dir)).toEqual(["shepherd"]);
  });

  it("is idempotent: already-current skips the download entirely", () => {
    const { base, dir, env } = setup();
    publish(base, "1.2.3");
    expect(run(["1.2.3"], env).status).toBe(0);
    rmSync(base, { recursive: true, force: true }); // any fetch would now fail
    const again = run(["1.2.3"], env);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already at 1.2.3");
    expect(existsSync(join(dir, "shepherd"))).toBe(true);
  });

  it("replaces a binary at another version", () => {
    const { base, dir, env } = setup();
    publish(base, "1.2.3");
    publish(base, "1.3.0");
    expect(run(["1.2.3"], env).status).toBe(0);
    expect(run(["1.3.0"], env).status).toBe(0);
    const out = spawnSync(join(dir, "shepherd"), ["--version"], { encoding: "utf8" }).stdout;
    expect(out.trim()).toBe("shepherd 1.3.0");
  });

  it("refuses a checksum mismatch and leaves the old binary in place", () => {
    const { base, dir, env } = setup();
    publish(base, "1.2.3");
    publish(base, "1.3.0", "0".repeat(64));
    expect(run(["1.2.3"], env).status).toBe(0);
    const r = run(["1.3.0"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("checksum mismatch");
    const out = spawnSync(join(dir, "shepherd"), ["--version"], { encoding: "utf8" }).stdout;
    expect(out.trim()).toBe("shepherd 1.2.3");
    expect(readdirSync(dir)).toEqual(["shepherd"]);
  });

  it("fails (for the caller to soft-fail) when the version isn't published", () => {
    const { dir, env } = setup();
    const r = run(["9.9.9"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("download failed");
    expect(existsSync(join(dir, "shepherd"))).toBe(false);
  });

  it("rejects a malformed version before building a URL", () => {
    const { env } = setup();
    const r = run(["1.2.3/../../x"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("invalid CLI version");
  });

  it("exits 0 with a cargo hint on an unsupported platform", () => {
    const { env } = setup();
    const r = run(["1.2.3"], { ...env, SHEPHERD_UNAME_S: "Darwin", SHEPHERD_UNAME_M: "x86_64" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("cargo install --path cli");
  });

  it("defaults to the checkout's package.json version", () => {
    const { base, dir, env } = setup();
    const version = (
      JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    publish(base, version);
    expect(run([], env).status).toBe(0);
    const out = spawnSync(join(dir, "shepherd"), ["--version"], { encoding: "utf8" }).stdout;
    expect(out.trim()).toBe(`shepherd ${version}`);
  });
});

describe("callers", () => {
  const read = (f: string) => readFileSync(resolve(import.meta.dir, "..", "deploy", f), "utf8");

  it("install.sh and update.sh run install-cli.sh soft-failing (never abort on a missing asset)", () => {
    expect(read("install.sh")).toMatch(/^\s*bash deploy\/install-cli\.sh \|\| warn /m);
    expect(read("update.sh")).toMatch(/^bash "\$REPO\/deploy\/install-cli\.sh" \|\| warn /m);
  });

  it("SHEPHERD_NO_CLI skips without touching the network", () => {
    const { env } = setup();
    const r = run(["1.2.3"], { ...env, SHEPHERD_NO_CLI: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skipping");
  });
});
