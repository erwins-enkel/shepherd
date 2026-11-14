import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { sandboxScratchpadDest, sessionScratchpadDir } from "../src/tmp-sweep";
import { locateSessionFile } from "../src/file-locate";

let tmpRoot: string;
let repoDir: string;
let scratchRoot: string;
let scratch: string;
const prevSweep = process.env.SHEPHERD_TMP_SWEEP_DIR;
const prevHome = process.env.HOME;
const SID = "claude-sess-1";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-locate-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(join(repoDir, "docs"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# hi\n");
  writeFileSync(join(repoDir, ".git"), "gitdir: /x\n");
  writeFileSync(join(tmpRoot, "secret.env"), "X=1");
  symlinkSync(join(tmpRoot, "secret.env"), join(repoDir, "leak.env"));
  scratchRoot = mkdtempSync(join(config.repoRoot, "shepherd-locate-tmp-"));
  process.env.SHEPHERD_TMP_SWEEP_DIR = scratchRoot;
  // Built from the test's own root (SHEPHERD_TMP_SWEEP_DIR) rather than written through
  // sessionScratchpadDir(), whose os.tmpdir() fallback CodeQL flags as an insecure temp file.
  scratch = join(scratchRoot, repoDir.replace(/[/.]/g, "-"), SID, "scratchpad");
  expect(sessionScratchpadDir(repoDir, SID)).toBe(scratch);
  mkdirSync(join(scratch, "reports"), { recursive: true });
  writeFileSync(join(scratch, "reports", "run.md"), "r");
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
  if (prevSweep === undefined) delete process.env.SHEPHERD_TMP_SWEEP_DIR;
  else process.env.SHEPHERD_TMP_SWEEP_DIR = prevSweep;
  process.env.HOME = prevHome;
});

const locate = (p: string, sid = SID) => locateSessionFile(repoDir, sid, p);

test("maps a worktree file, a worktree dir and the worktree root", async () => {
  expect(await locate(join(repoDir, "README.md"))).toEqual({
    source: "worktree",
    path: "README.md",
    type: "file",
  });
  expect(await locate(join(repoDir, "docs") + "/")).toEqual({
    source: "worktree",
    path: "docs",
    type: "dir",
  });
  expect(await locate(repoDir)).toEqual({ source: "worktree", path: "", type: "dir" });
});

test("maps a scratchpad file, also via the sandboxed agent's path", async () => {
  const want = { source: "scratchpad", path: "reports/run.md", type: "file" } as const;
  expect(await locate(join(scratch, "reports", "run.md"))).toEqual(want);
  expect(await locate(join(sandboxScratchpadDest(repoDir, SID), "reports", "run.md"))).toEqual(
    want,
  );
});

test("expands ~/ against HOME", async () => {
  process.env.HOME = tmpRoot;
  expect(await locate("~/repo/README.md")).toEqual({
    source: "worktree",
    path: "README.md",
    type: "file",
  });
});

test("refuses .git, escapes, out-pointing symlinks, outside and relative paths", async () => {
  for (const p of [
    join(repoDir, ".git"),
    join(repoDir, "docs", "..", "..", "secret.env"),
    join(repoDir, "leak.env"),
    join(tmpRoot, "secret.env"),
    "/etc/passwd",
    "README.md",
    join(repoDir, "missing.md"),
    "",
    `${repoDir}/README.md\0`,
  ])
    expect(await locate(p)).toBeNull();
});

test("a session without a claude id has no scratchpad", async () => {
  expect(await locate(join(scratch, "reports", "run.md"), "")).toBeNull();
});

function harness() {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
  };
  const s = store.create({
    name: "locate-session",
    prompt: "p",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/locate",
    worktreePath: repoDir,
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: SID,
    model: null,
  });
  return { app: makeApp(deps), store, s };
}

const get = (app: ReturnType<typeof makeApp>, id: string, p: string) =>
  app.fetch(new Request(`http://x/api/sessions/${id}/files/locate?path=${encodeURIComponent(p)}`));

test("GET files/locate returns the target, 404 outside the roots", async () => {
  const { app, s } = harness();
  const ok = await get(app, s.id, join(scratch, "reports", "run.md"));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ source: "scratchpad", path: "reports/run.md", type: "file" });
  expect((await get(app, s.id, "/etc/passwd")).status).toBe(404);
  expect((await get(app, "nope", join(repoDir, "README.md"))).status).toBe(404);
});

test("GET files/locate of an archived session is 404", async () => {
  const { app, store, s } = harness();
  store.archive(s.id);
  expect((await get(app, s.id, join(repoDir, "README.md"))).status).toBe(404);
});

// ── reported host files (#4017) ────────────────────────────────────────────────

const hostGet = (app: ReturnType<typeof makeApp>, id: string, p: string) =>
  app.fetch(new Request(`http://x/api/sessions/${id}/files/host?path=${encodeURIComponent(p)}`));

/** A session whose transcript (under a spawn account in tmpRoot) announces `announce`. */
function hostHarness(announce: string) {
  const h = harness();
  const account = join(tmpRoot, "account");
  h.store.setSpawnIdentity(h.s.id, null, account);
  const dir = join(account, "projects", repoDir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const line = { type: "assistant", message: { content: [{ type: "text", text: announce }] } };
  writeFileSync(join(dir, `${SID}.jsonl`), JSON.stringify(line) + "\n");
  return h;
}

const prevAgentTmp = process.env.SHEPHERD_AGENT_TMPDIR;
function hostEnvForTest() {
  process.env.HOME = tmpRoot;
  process.env.SHEPHERD_AGENT_TMPDIR = ""; // the run's temp root may sit under the real one
}
afterEach(() => {
  if (prevAgentTmp === undefined) delete process.env.SHEPHERD_AGENT_TMPDIR;
  else process.env.SHEPHERD_AGENT_TMPDIR = prevAgentTmp;
});

test("GET files/locate maps an announced host file to a host target", async () => {
  hostEnvForTest();
  const report = join(tmpRoot, "state", "report.md");
  mkdirSync(join(tmpRoot, "state"));
  writeFileSync(report, "# R\n");
  const quiet = join(tmpRoot, "state", "quiet.md");
  writeFileSync(quiet, "q");
  const { app, s } = hostHarness(`Report: [r](${report})`);
  const ok = await get(app, s.id, report);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ source: "host", path: report, type: "file" });
  expect((await get(app, s.id, quiet)).status).toBe(404);
  expect((await get(app, s.id, join(tmpRoot, "secret.env"))).status).toBe(404);
});

test("GET files/host returns the text; 404 for refused, unknown and archived", async () => {
  hostEnvForTest();
  const report = join(tmpRoot, "report.md");
  writeFileSync(report, "# R\n");
  const { app, store, s } = hostHarness(`see ${report} and ${join(tmpRoot, "secret.env")}`);
  const ok = await hostGet(app, s.id, report);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ path: report, size: 4, text: "# R\n" });
  expect((await hostGet(app, s.id, join(tmpRoot, "secret.env"))).status).toBe(404);
  expect((await hostGet(app, s.id, "/etc/passwd")).status).toBe(404);
  expect((await hostGet(app, "nope", report)).status).toBe(404);
  store.archive(s.id);
  expect((await hostGet(app, s.id, report)).status).toBe(404);
});
