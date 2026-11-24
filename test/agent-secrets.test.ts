import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSecretError,
  AgentSecretStore,
  MAX_SECRETS_PER_REPO,
  SECRET_LAUNCHER_ARGV0,
  normalizeSecretValue,
  removeSessionSecretDir,
  secretEnvLauncher,
  secretLauncherSkip,
  sessionSecretDir,
  sweepOrphanSecretDirs,
  SECRET_DIR_SWEEP_GRACE_MS,
  validateSecretName,
  writeSessionSecretDir,
} from "../src/agent-secrets";
import { redactKnownSecretValues, setKnownSecretValues } from "../src/redact";

/** Mode of a file read from an open handle (not path stat-then-read — CodeQL js/file-system-race). */
async function fileMode(p: string): Promise<number> {
  const fh = await open(p, "r");
  try {
    return (await fh.stat()).mode & 0o777;
  } finally {
    await fh.close();
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-secrets-"));
});
afterEach(async () => {
  setKnownSecretValues([]);
  await rm(dir, { recursive: true, force: true });
});

const REPO = "/home/op/repo-a";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentSecretError) return e.code;
    throw e;
  }
  throw new Error("expected rejection");
}

describe("validation", () => {
  test("names", () => {
    expect(validateSecretName("GITHUB_PACKAGES_TOKEN")).toBeNull();
    expect(validateSecretName("_x1")).toBeNull();
    expect(validateSecretName("a".repeat(64))).toBeNull();
    expect(validateSecretName("a".repeat(65))).toBe("invalid-name");
    expect(validateSecretName("1ABC")).toBe("invalid-name");
    expect(validateSecretName("A-B")).toBe("invalid-name");
    expect(validateSecretName("")).toBe("invalid-name");
    expect(validateSecretName(42)).toBe("invalid-name");
    for (const n of ["PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "path"])
      expect(validateSecretName(n)).toBe("reserved-name");
    for (const n of ["LD_PRELOAD", "claude_x", "SHEPHERD_A", "GIT_DIR", "Mise_x", "BWRAP_Y"])
      expect(validateSecretName(n)).toBe("reserved-name");
    expect(validateSecretName("GITHUB_PACKAGES")).toBeNull();
  });

  test("values", () => {
    expect(normalizeSecretValue("tok\r\n\n")).toBe("tok");
    expect(normalizeSecretValue("a\nb")).toBe("a\nb");
    expect(normalizeSecretValue("\n")).toBeNull();
    expect(normalizeSecretValue("")).toBeNull();
    expect(normalizeSecretValue("a\0b")).toBeNull();
    expect(normalizeSecretValue("x".repeat(16384))).toBe("x".repeat(16384));
    expect(normalizeSecretValue("x".repeat(16385))).toBeNull();
    expect(normalizeSecretValue("é".repeat(8193))).toBeNull(); // 16386 bytes
  });
});

describe("AgentSecretStore", () => {
  test("CRUD round-trips through a fresh instance; file 0600; list hides values", async () => {
    const path = join(dir, "agent-secrets.json");
    const s = new AgentSecretStore(path, () => 1000);
    await s.load();
    expect(await s.set(REPO, "B_TOKEN", "value-b\n")).toEqual({ name: "B_TOKEN", updatedAt: 1000 });
    await s.set(REPO, "A_TOKEN", "value-a");
    await s.set("/other", "C", "value-c");
    expect(await fileMode(path)).toBe(0o600);

    const fresh = new AgentSecretStore(path);
    await fresh.load();
    expect(fresh.list(REPO)).toEqual([
      { name: "A_TOKEN", updatedAt: 1000 },
      { name: "B_TOKEN", updatedAt: 1000 },
    ]);
    expect(JSON.stringify(fresh.list(REPO))).not.toContain("value-");
    expect(fresh.entries(REPO)).toEqual({ A_TOKEN: "value-a", B_TOKEN: "value-b" });
    expect(fresh.allValues().sort()).toEqual(["value-a", "value-b", "value-c"]);

    expect(await fresh.delete(REPO, "A_TOKEN")).toBe(true);
    expect(await fresh.delete(REPO, "A_TOKEN")).toBe(false);
    await fresh.delete(REPO, "B_TOKEN");
    const again = new AgentSecretStore(path);
    await again.load();
    expect(again.list(REPO)).toEqual([]);
    expect(again.entries("/other")).toEqual({ C: "value-c" });
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty(REPO);
  });

  test("invalid JSON file → writes refuse and the file is untouched", async () => {
    const path = join(dir, "agent-secrets.json");
    await writeFile(path, "{ not json");
    const s = new AgentSecretStore(path);
    await s.load();
    expect(await codeOf(s.set(REPO, "A", "value"))).toBe("store-error");
    expect(await codeOf(s.delete(REPO, "A"))).toBe("store-error");
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  test("no path → unavailable", async () => {
    const s = new AgentSecretStore(undefined);
    await s.load();
    expect(s.list(REPO)).toEqual([]);
    expect(await codeOf(s.set(REPO, "A", "value"))).toBe("unavailable");
  });

  test("name/value/count validation", async () => {
    const s = new AgentSecretStore(join(dir, "s.json"));
    expect(await codeOf(s.set(REPO, "9X", "value"))).toBe("invalid-name");
    expect(await codeOf(s.set(REPO, "PATH", "value"))).toBe("reserved-name");
    expect(await codeOf(s.set(REPO, "CLAUDE_CODE_X", "value"))).toBe("reserved-name");
    expect(await codeOf(s.set(REPO, "OK", "\r\n"))).toBe("invalid-value");
    expect(await codeOf(s.set(REPO, "OK", "a\0b"))).toBe("invalid-value");
    for (let i = 0; i < MAX_SECRETS_PER_REPO; i++) await s.set(REPO, `S${i}`, `value-${i}`);
    expect(await codeOf(s.set(REPO, "ONE_MORE", "value"))).toBe("too-many");
    await s.set(REPO, "S0", "replaced"); // replacing doesn't count
    expect(s.entries(REPO).S0).toBe("replaced");
    await s.set("/other", "ONE_MORE", "value"); // per repo
  });

  test("redaction registry tracks load, set and delete", async () => {
    const path = join(dir, "s.json");
    await writeFile(
      path,
      JSON.stringify({ [REPO]: { PRE: { value: "preloaded-secret", updatedAt: 1 } } }),
    );
    const s = new AgentSecretStore(path);
    await s.load();
    expect(redactKnownSecretValues("x preloaded-secret")).toBe("x <redacted>");
    await s.set(REPO, "NEW", "fresh-secret");
    expect(redactKnownSecretValues("fresh-secret")).toBe("<redacted>");
    await s.delete(REPO, "NEW");
    expect(redactKnownSecretValues("fresh-secret")).toBe("fresh-secret");
  });
});

describe("session secret dir", () => {
  test("modes, stale removal, empty → removed", async () => {
    const out = await writeSessionSecretDir(dir, "sess-1", { A: "one", B: "two" });
    expect(out).toBe(sessionSecretDir(dir, "sess-1"));
    const d = out!;
    expect((await stat(d)).mode & 0o777).toBe(0o700);
    expect(await fileMode(join(d, "A"))).toBe(0o600);
    expect(await readFile(join(d, "B"), "utf8")).toBe("two");

    await writeSessionSecretDir(dir, "sess-1", { A: "uno" });
    expect((await readdir(d)).sort()).toEqual(["A"]);
    expect(await readFile(join(d, "A"), "utf8")).toBe("uno");

    expect(await writeSessionSecretDir(dir, "sess-1", {})).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  test("rejects bad session ids and a symlinked dir", async () => {
    expect(() => sessionSecretDir(dir, "../x")).toThrow();
    const target = join(dir, "elsewhere");
    await mkdir(target);
    await symlink(target, join(dir, "evil.secrets"));
    await expect(writeSessionSecretDir(dir, "evil", { A: "x" })).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
  });

  test("remove + sweep", async () => {
    await writeSessionSecretDir(dir, "keep", { A: "1" });
    await writeSessionSecretDir(dir, "gone", { A: "1" });
    await writeSessionSecretDir(dir, "gone2", { A: "1" });
    await writeFile(join(dir, "unrelated.json"), "{}");
    await removeSessionSecretDir(dir, "gone2");
    await writeSessionSecretDir(dir, "gone3", { A: "1" });
    // Fresh dirs are in-flight spawns (no session row yet): the default grace keeps them.
    expect(await sweepOrphanSecretDirs(dir, (id) => id === "keep")).toBe(0);
    expect((await readdir(dir)).length).toBe(4);
    const later = () => Date.now() + SECRET_DIR_SWEEP_GRACE_MS + 1000;
    expect(await sweepOrphanSecretDirs(dir, (id) => id === "keep", { now: later })).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(["keep.secrets", "unrelated.json"]);
    expect(await sweepOrphanSecretDirs(join(dir, "missing"), () => false)).toBe(0);
  });
});

describe("launcher", () => {
  test("real /bin/sh exports exact values; argv carries only the dir", async () => {
    const values = {
      FOO: "a b  'q' \"dq\" $HOME `id` $(id) \\ end",
      MULTI: "line1\nline2",
      _X: "-n",
    };
    const d = (await writeSessionSecretDir(dir, "run", values))!;
    // A file whose name isn't an env name must be skipped, not exported.
    await writeFile(join(d, "bad-name"), "nope", { mode: 0o600 });
    const argv = secretEnvLauncher(d, [
      "/bin/sh",
      "-c",
      'printf "%s\\0%s\\0%s\\0%s" "$FOO" "$MULTI" "$_X" "$1"',
      "inner",
      "passed arg",
    ]);
    // Substring check only for long values: a short one like "-n" can occur inside the random tmp
    // dir path the argv legitimately carries; exact-element check covers every value.
    for (const v of Object.values(values)) {
      expect(argv.includes(v)).toBe(false);
      if (v.length >= 8) expect(argv.some((a) => a.includes(v))).toBe(false);
    }
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out.split("\0")).toEqual([values.FOO, values.MULTI, values._X, "passed arg"]);

    const envP = Bun.spawn(secretEnvLauncher(d, ["/usr/bin/env"]), {
      stdout: "pipe",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(await new Response(envP.stdout).text()).not.toContain("nope");
  });

  test("secretLauncherSkip", () => {
    const wrapped = ["bwrap", "--", ...secretEnvLauncher("/d", ["claude", "--x"])];
    expect(secretLauncherSkip(wrapped, 2)).toBe(5);
    expect(wrapped[2 + 5]).toBe("claude");
    expect(secretLauncherSkip(wrapped, 0)).toBe(0);
    expect(secretLauncherSkip(["/bin/sh", "-c", "echo hi", SECRET_LAUNCHER_ARGV0, "/d"], 0)).toBe(
      0,
    );
    expect(secretLauncherSkip(["claude"], 0)).toBe(0);
  });
});
