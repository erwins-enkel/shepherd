import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxScratchpadBind, sessionScratchpadDir } from "../src/tmp-sweep";

const WT = "/home/u/Work/.wt/proj";
const SID = "sess-uuid-1";
const uid = process.getuid?.() ?? 1000;

let tmpRoot: string;
const prev = {
  sweep: process.env.SHEPHERD_TMP_SWEEP_DIR,
  agent: process.env.SHEPHERD_AGENT_TMPDIR,
};

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-scratch-bind-")));
  process.env.SHEPHERD_TMP_SWEEP_DIR = tmpRoot;
  delete process.env.SHEPHERD_AGENT_TMPDIR;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const [k, v] of [
    ["SHEPHERD_TMP_SWEEP_DIR", prev.sweep],
    ["SHEPHERD_AGENT_TMPDIR", prev.agent],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("creates the host scratchpad dir 0700 and maps it to claude's in-membrane path", async () => {
  const bind = await sandboxScratchpadBind(WT, SID);
  const host = sessionScratchpadDir(WT, SID);
  expect(bind).toEqual({
    host,
    dest: `/tmp/claude-${uid}/-home-u-Work--wt-proj/${SID}/scratchpad`,
  });
  expect(statSync(host).mode & 0o777).toBe(0o700);
});

test("null on a blank claude session id (codex / pre-session-id)", async () => {
  expect(await sandboxScratchpadBind(WT, "")).toBeNull();
});

test("null when the disk redirect is disabled (SHEPHERD_AGENT_TMPDIR='')", async () => {
  process.env.SHEPHERD_AGENT_TMPDIR = "";
  expect(await sandboxScratchpadBind(WT, SID)).toBeNull();
});

test("null when the host scratchpad path is a symlink", async () => {
  const host = sessionScratchpadDir(WT, SID);
  const elsewhere = join(tmpRoot, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(dirname(host), { recursive: true });
  symlinkSync(elsewhere, host);
  expect(await sandboxScratchpadBind(WT, SID)).toBeNull();
});
