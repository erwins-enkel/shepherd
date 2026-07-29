import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { posixShellJoin } from "../src/argv-limit";
import { buildWrappedArgv } from "../src/herdr";
import { buildSpawnScript, spawnCommandLine, writeSpawnScript } from "../src/spawn-script";
import { DARWIN_MAX_INPUT } from "./helpers/spawn-script";

const execFileAsync = promisify(execFile);

let scratch: string;
let prevAgentTmp: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "shepherd-spawn-script-"));
  prevAgentTmp = process.env.SHEPHERD_AGENT_TMPDIR;
  process.env.SHEPHERD_AGENT_TMPDIR = scratch;
});

afterEach(async () => {
  if (prevAgentTmp === undefined) delete process.env.SHEPHERD_AGENT_TMPDIR;
  else process.env.SHEPHERD_AGENT_TMPDIR = prevAgentTmp;
  await rm(scratch, { recursive: true, force: true });
});

const ARGV = [
  "env",
  "NODE_COMPILE_CACHE=/disk/ncc",
  "claude",
  "--append-system-prompt",
  "be brief",
];

describe("buildSpawnScript", () => {
  test("self-deletes BEFORE exec, and execs (never plain-runs) the joined argv", () => {
    const script = buildSpawnScript(ARGV);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);

    const lines = script.split("\n").filter((l) => l && !l.startsWith("#"));
    // Order matters: after `exec` nothing in this script runs, so the unlink must precede it.
    expect(lines).toEqual([`rm -f -- "$0"`, `exec ${posixShellJoin(ARGV)}`]);
  });

  test("reconstructs the exact argv — multi-word, newline and quote-bearing tokens survive", () => {
    // The directive Shepherd passes via --append-system-prompt is multi-line and apostrophe-dense;
    // a token that shattered here would spawn a mangled agent rather than fail loudly.
    const gnarly = [
      "claude",
      "--append-system-prompt",
      "line one\nline two 'quoted' & $(nope)",
      "",
    ];
    expect(buildSpawnScript(gnarly)).toContain(`exec ${posixShellJoin(gnarly)}`);
  });
});

describe("writeSpawnScript", () => {
  test("writes under the agent tmp dir with 0600 (dir 0700)", async () => {
    const path = await writeSpawnScript(ARGV);
    expect(path.startsWith(join(scratch, "spawn") + "/")).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  test("falls back to the system tmp dir when the #1875 redirect is disabled", async () => {
    process.env.SHEPHERD_AGENT_TMPDIR = ""; // operator rollback: agentTmpDir() === null
    const path = await writeSpawnScript(ARGV);
    try {
      expect(path.startsWith(join(tmpdir(), "spawn") + "/")).toBe(true);
    } finally {
      await rm(path, { force: true });
    }
  });

  test("every call gets its own file, so concurrent spawns cannot collide", async () => {
    const paths = await Promise.all([1, 2, 3].map(() => writeSpawnScript(ARGV)));
    expect(new Set(paths).size).toBe(3);
  });
});

describe("spawnCommandLine", () => {
  test("the TYPED line stays far under Darwin's MAX_INPUT for a full-size spawn", async () => {
    // The shape that broke #1967: a real ~8 KB system-prompt directive plus a --settings overlay.
    const wrapped = buildWrappedArgv([
      "claude",
      "--settings",
      JSON.stringify({ hooks: { Notification: ["x".repeat(2000)] } }),
      "--append-system-prompt",
      "You are an autonomous agent.\n".repeat(300),
    ]);
    expect(posixShellJoin(wrapped).length).toBeGreaterThan(8_000); // what used to be typed

    const line = await spawnCommandLine(wrapped);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(DARWIN_MAX_INPUT);
    expect(line).toMatch(/^'sh' '.*\.sh'$/);
  });

  test("a REAL sh run of the typed line execs the argv byte-identically and removes the script", async () => {
    // The one assertion here that cannot be satisfied by agreeing with our own arithmetic: it hands
    // the script to a real /bin/sh and reads back what the process actually received.
    const args = ["multi word", "with 'quote'", "two\nlines", "$HOME", ""];
    const line = await spawnCommandLine([
      "env",
      "SPAWN_SCRIPT_PROBE=1",
      "printf",
      "[%s]\n",
      ...args,
    ]);
    const path = /^'sh' '(.*)'$/.exec(line)?.[1] ?? "";
    expect(existsSync(path)).toBe(true);

    const { stdout } = await execFileAsync("sh", ["-c", line]);
    expect(stdout).toBe(args.map((a) => `[${a}]\n`).join(""));
    // Self-deleted by the script itself, mid-run, while sh still held it open.
    expect(existsSync(path)).toBe(false);
  });

  test("the exec'd process REPLACES the shell — no lingering `sh` in the foreground", async () => {
    // herdr resolves a trusted spawn by detecting the pane's FOREGROUND process, so a script that
    // forgot `exec` would leave `sh` there and break auto-detection (30s timeout, #1967's symptom).
    // Proven by pid identity, not by inspection: the outer shell prints its pid, then execs the
    // typed line; the command the script launches prints ITS pid. A missing `exec` anywhere in the
    // chain forks, and the two differ.
    const line = await spawnCommandLine(["sh", "-c", "echo $$"]);
    const { stdout } = await execFileAsync("sh", ["-c", `echo $$; exec ${line}`]);
    const [outer, inner] = stdout.trim().split("\n");
    expect(inner).toBe(outer);
  });
});
