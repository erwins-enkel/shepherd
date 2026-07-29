import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { posixShellJoin } from "../src/argv-limit";
import { buildWrappedArgv } from "../src/herdr";
import { buildSpawnScript, spawnCommandLine, writeSpawnScript } from "../src/spawn-script";
import { DARWIN_MAX_INPUT } from "./helpers/spawn-script";

/**
 * Feed `input` to a real POSIX shell the way herdr does — TYPED on the shell's stdin — and return
 * its stdout. Deliberately not `sh -c "<line>"`: the transport is a shell reading typed input, so
 * stdin is the faithful reproduction, and it keeps a path derived from `SHEPHERD_AGENT_TMPDIR` off
 * a child process's command line (the indirect-command-injection shape, flagged by CodeQL).
 */
function typeIntoShell(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sh = spawn("sh", { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    sh.stdout.setEncoding("utf8");
    sh.stdout.on("data", (chunk) => (out += chunk));
    sh.on("error", reject);
    sh.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`sh exited with ${code}`)),
    );
    sh.stdin.end(input);
  });
}

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

  test("reaps scripts a failed spawn abandoned, and never a live one", async () => {
    // The self-delete only fires when the script RUNS, so a spawn whose `pane run` failed every
    // attempt leaves one behind. Observed for real: a full test-suite run left four in the agent
    // tmp root. Unreaped they accrete in the directory whose inodes Shepherd has exhausted before.
    const abandoned = await writeSpawnScript(ARGV);
    const fresh = await writeSpawnScript(ARGV);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(abandoned, twoHoursAgo, twoHoursAgo);

    await writeSpawnScript(ARGV); // the next spawn is what sweeps

    expect(existsSync(abandoned)).toBe(false);
    // A script written moments ago may still be waiting for its pane — never reap that.
    expect(existsSync(fresh)).toBe(true);
  });

  test("refuses a squatted script dir — writes to a private one instead", async () => {
    // With the #1875 redirect rolled back the dir is a fixed `<tmpdir>/spawn` in a world-writable
    // parent, and `mkdir(recursive)` accepts a pre-existing dir WITHOUT applying the mode. A local
    // user who owns that dir could swap our script between the write and the pane's `sh` opening it
    // — code execution as the Shepherd user. Group/other-writable stands in for foreign ownership,
    // which a test cannot create without root; both are rejected by the same lstat check.
    mkdirSync(join(scratch, "spawn"), { recursive: true });
    chmodSync(join(scratch, "spawn"), 0o777);

    const path = await writeSpawnScript(ARGV);

    expect(dirname(path)).not.toBe(join(scratch, "spawn"));
    expect(statSync(dirname(path)).mode & 0o077).toBe(0); // no group/other access
    expect(statSync(dirname(path)).uid).toBe(process.getuid!());
    await rm(dirname(path), { recursive: true, force: true });
  });

  test("refuses a symlink planted on the script dir rather than following it", async () => {
    // lstat, not stat: a symlink pointing at an attacker-owned directory must not be followed.
    const target = join(scratch, "elsewhere");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(scratch, "spawn"));

    const path = await writeSpawnScript(ARGV);

    expect(path.startsWith(target)).toBe(false);
    expect(path.startsWith(join(scratch, "spawn"))).toBe(false);
    await rm(dirname(path), { recursive: true, force: true });
  });

  test.each([
    ["a plain file", (p: string) => writeFileSync(p, "squat")],
    ["a dangling symlink", (p: string) => symlinkSync(join(p, "..", "nonexistent"), p)],
  ])("keeps spawning when %s occupies the script dir path", async (_label, squat) => {
    // Recursive mkdir swallows EEXIST only for a real DIRECTORY; a plain file or a dangling symlink
    // throws. Unhandled, that is a spawn-wide denial of service any local user could trigger with a
    // single `touch /tmp/spawn` — cheaper than the ownership squat above and just as total.
    squat(join(scratch, "spawn"));

    const path = await writeSpawnScript(ARGV);

    expect(existsSync(path)).toBe(true);
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
    await rm(dirname(path), { recursive: true, force: true });
  });

  test("recovers when the private fallback dir is removed under it", async () => {
    // The fallback is remembered across spawns, so a tmp cleaner that removes it must not strand
    // every later spawn on a stale path (ENOENT on write).
    mkdirSync(join(scratch, "spawn"), { recursive: true });
    chmodSync(join(scratch, "spawn"), 0o777); // force the fallback
    const first = await writeSpawnScript(ARGV);
    await rm(dirname(first), { recursive: true, force: true });

    const second = await writeSpawnScript(ARGV);

    expect(existsSync(second)).toBe(true);
    await rm(dirname(second), { recursive: true, force: true });
  });

  test("a failing reap never fails the spawn", async () => {
    // Cleanup is best-effort by design: an unreadable dir must not be why an agent cannot start.
    const path = await writeSpawnScript(ARGV);
    chmodSync(dirname(path), 0o300); // no read permission → readdir throws
    try {
      await expect(writeSpawnScript(ARGV)).resolves.toContain("/spawn-");
    } finally {
      chmodSync(dirname(path), 0o700); // restore so afterEach can clean up
    }
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

  test("typing the line at a REAL shell execs the argv byte-identically and removes the script", async () => {
    // The one assertion here that cannot be satisfied by agreeing with our own arithmetic: it types
    // the line at a real /bin/sh and reads back what the launched process actually received.
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

    const stdout = await typeIntoShell(`${line}\n`);
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
    const stdout = await typeIntoShell(`echo $$\nexec ${line}\n`);
    const [outer, inner] = stdout.trim().split("\n");
    expect(inner).toBe(outer);
  });
});
