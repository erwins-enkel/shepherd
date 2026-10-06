import { test, expect, describe, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupHelperDir,
  ensureHelperTmpRootTrusted,
  helperTmpRoot,
  makeHelperTmpDir,
} from "../src/transient-helper-lifecycle";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, val: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = val;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

/** `dashify` — mirrors the encoding claude uses to name a cwd's scratch dir. */
const dashify = (p: string): string => p.replace(/[/.]/g, "-");

describe("cleanupHelperDir (#2304)", () => {
  test("removes BOTH the mktemp cwd and the claude-side scratch it derived", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "helper-lifecycle-test-"));
    dirs.push(scratchRoot);
    setEnv("SHEPHERD_TMP_SWEEP_DIR", scratchRoot);

    const cwd = makeHelperTmpDir("shepherd-namer-");
    dirs.push(cwd);
    // Stand in for what claude writes: `<claudeTmpRoot>/<dashify(cwd)>/<uuid>/scratchpad`.
    const scratch = join(scratchRoot, dashify(cwd));
    mkdirSync(join(scratch, "some-uuid", "scratchpad"), { recursive: true });
    writeFileSync(join(scratch, "some-uuid", "scratchpad", "note.txt"), "x");

    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(scratch)).toBe(true);

    cleanupHelperDir(cwd);

    // The cwd removal is synchronous; the scratch removal is deliberately fire-and-forget
    // async (never a sync rm -rf on the Bun event loop), so let the microtask/IO settle.
    expect(existsSync(cwd)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(scratch)).toBe(false);
  });

  test("does not throw when neither dir exists", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "helper-lifecycle-test-"));
    dirs.push(scratchRoot);
    setEnv("SHEPHERD_TMP_SWEEP_DIR", scratchRoot);
    expect(() =>
      cleanupHelperDir(join(tmpdir(), `shepherd-namer-absent-${Math.random()}`)),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });

  test("makeHelperTmpDir creates a dir with the given prefix under the agent tmp root", () => {
    const base = mkdtempSync(join(tmpdir(), "helper-root-test-"));
    dirs.push(base);
    const root = join(base, "not-yet-created");
    setEnv("SHEPHERD_AGENT_TMPDIR", root);
    expect(helperTmpRoot()).toBe(root);
    const cwd = makeHelperTmpDir("shepherd-namer-");
    expect(existsSync(cwd)).toBe(true);
    expect(cwd.startsWith(join(root, "shepherd-namer-"))).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  test("helperTmpRoot falls back to os.tmpdir() when the agent tmp dir is disabled", () => {
    setEnv("SHEPHERD_AGENT_TMPDIR", "");
    expect(helperTmpRoot()).toBe(tmpdir());
  });
});

describe("ensureHelperTmpRootTrusted", () => {
  function tmpConfig(content?: object): string {
    const dir = mkdtempSync(join(tmpdir(), "helper-trust-test-"));
    dirs.push(dir);
    const cfg = join(dir, ".claude.json");
    if (content) writeFileSync(cfg, JSON.stringify(content));
    return cfg;
  }
  const read = (cfg: string) => JSON.parse(readFileSync(cfg, "utf8"));

  /** A fresh owner-only (mkdtemp = 0700) dir to act as the helper root. */
  function privateRoot(): string {
    const d = mkdtempSync(join(tmpdir(), "helper-root-test-"));
    dirs.push(d);
    return d;
  }

  test("defaults to helperTmpRoot(), preserving other config", async () => {
    const root = privateRoot();
    setEnv("SHEPHERD_AGENT_TMPDIR", root);
    const cfg = tmpConfig({ numStartups: 3, projects: { "/repo": { allowedTools: [] } } });
    expect(await ensureHelperTmpRootTrusted(cfg)).toBe(true);
    const j = read(cfg);
    expect(j.projects[root].hasTrustDialogAccepted).toBe(true);
    expect(j.numStartups).toBe(3);
    expect(j.projects["/repo"]).toEqual({ allowedTools: [] });
  });

  test("re-seeds a root whose trust was reset to false", async () => {
    const root = privateRoot();
    const cfg = tmpConfig({ projects: { [root]: { hasTrustDialogAccepted: false, a: 1 } } });
    expect(await ensureHelperTmpRootTrusted(cfg, root)).toBe(true);
    expect(read(cfg).projects[root]).toEqual({ hasTrustDialogAccepted: true, a: 1 });
  });

  test("tightens a group/world-writable root we own (umask 002) to go-w, then trusts it", async () => {
    const root = privateRoot();
    chmodSync(root, 0o777);
    const cfg = tmpConfig({ projects: {} });
    expect(await ensureHelperTmpRootTrusted(cfg, root)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(read(cfg).projects[root].hasTrustDialogAccepted).toBe(true);
  });

  // Safe as root too: /tmp is sticky, so it is refused before any chmod.
  test("refuses /tmp without touching it or the config", async () => {
    const before = statSync("/tmp").mode;
    const cfg = tmpConfig({ projects: {} });
    expect(await ensureHelperTmpRootTrusted(cfg, "/tmp")).toBe(false);
    expect(statSync("/tmp").mode).toBe(before);
    expect(read(cfg).projects).toEqual({});
  });

  test("refuses a sticky-bit dir we own without chmodding it", async () => {
    const root = privateRoot();
    // chmod(1), not chmodSync: Bun 1.3.10's fs.chmod drops the sticky bit (Node keeps it), which
    // left a plain 0777 dir here and turned this into a test of the world-writable path.
    execFileSync("chmod", ["1777", root]);
    expect(statSync(root).mode & 0o7777).toBe(0o1777);
    const cfg = tmpConfig({ projects: {} });
    expect(await ensureHelperTmpRootTrusted(cfg, root)).toBe(false);
    expect(statSync(root).mode & 0o7777).toBe(0o1777);
    expect(read(cfg).projects).toEqual({});
  });

  test("trusts nothing when the agent tmp dir is disabled (os.tmpdir() fallback)", async () => {
    setEnv("SHEPHERD_AGENT_TMPDIR", "");
    const cfg = tmpConfig({ projects: {} });
    expect(await ensureHelperTmpRootTrusted(cfg)).toBe(false);
    expect(read(cfg).projects).toEqual({});
  });

  test("refuses a symlinked or missing root", async () => {
    const target = privateRoot();
    const link = join(privateRoot(), "link");
    symlinkSync(target, link);
    const cfg = tmpConfig({ projects: {} });
    expect(await ensureHelperTmpRootTrusted(cfg, link)).toBe(false);
    expect(await ensureHelperTmpRootTrusted(cfg, join(target, "absent"))).toBe(false);
    expect(read(cfg).projects).toEqual({});
  });
});
