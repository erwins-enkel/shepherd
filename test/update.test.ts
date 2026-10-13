import { test, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateService,
  type DiscardLaunch,
  type GitHashStreamer,
  type GitRawRunner,
  type GitRunner,
} from "../src/update";

/** A logPath guaranteed not to exist, so applyState() reads "idle". */
function freshLog(): string {
  return join(mkdtempSync(join(tmpdir(), "shepherd-update-test-")), "deploy.log");
}

/** Build a git runner from a map of "joined args" → stdout. */
function fakeGit(responses: Record<string, string>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    if (!(key in responses)) throw new Error(`unexpected git: ${key}`);
    return responses[key]!;
  };
}

const UP_TO_DATE = {
  "fetch --quiet origin main": "",
  "rev-parse --short HEAD": "abc1234\n",
  "rev-parse --short origin/main": "abc1234\n",
  "rev-list --count HEAD..origin/main": "0\n",
};

const BEHIND_TWO = {
  "fetch --quiet origin main": "",
  "rev-parse --short HEAD": "abc1234\n",
  "rev-parse --short origin/main": "def5678\n",
  "rev-list --count HEAD..origin/main": "2\n",
  "log --max-count=20 --format=%h%x09%s HEAD..origin/main":
    "def5678\tfeat(ui): add update badge\nbbb2222\tfix(server): guard route\n",
};

test("up to date → behind 0, no commits", async () => {
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), launch: () => {} });
  const s = await svc.check(1000);
  expect(s.behind).toBe(0);
  expect(s.commits).toEqual([]);
  expect(s.current).toBe("abc1234");
  expect(s.latest).toBe("abc1234");
  expect(s.error).toBeUndefined();
});

test("behind main → behind count + parsed commit list (newest first)", async () => {
  const svc = new UpdateService({ git: fakeGit(BEHIND_TWO), launch: () => {} });
  const s = await svc.check(2000);
  expect(s.behind).toBe(2);
  expect(s.current).toBe("abc1234");
  expect(s.latest).toBe("def5678");
  expect(s.commits).toEqual([
    { sha: "def5678", subject: "feat(ui): add update badge" },
    { sha: "bbb2222", subject: "fix(server): guard route" },
  ]);
});

test("subjects containing tabs survive parsing", async () => {
  const svc = new UpdateService({
    git: fakeGit({
      ...BEHIND_TWO,
      "rev-list --count HEAD..origin/main": "1\n",
      "log --max-count=20 --format=%h%x09%s HEAD..origin/main": "def5678\tfix: a\tb\tc\n",
    }),
    launch: () => {},
  });
  const s = await svc.check(3000);
  expect(s.commits).toEqual([{ sha: "def5678", subject: "fix: a\tb\tc" }]);
});

test("git failure fails safe to behind 0 with an error", async () => {
  const svc = new UpdateService({
    git: async () => {
      throw new Error("network down");
    },
    launch: () => {},
  });
  const s = await svc.check(4000);
  expect(s.behind).toBe(0);
  expect(s.error).toContain("network down");
});

test("current() caches the last check", async () => {
  const svc = new UpdateService({ git: fakeGit(BEHIND_TWO), launch: () => {} });
  expect(svc.current()).toBeNull();
  await svc.check(5000);
  expect(svc.current()?.behind).toBe(2);
});

test("rejecting async git runner fails safe: behind 0, error set, current preserved", async () => {
  // First check succeeds so `current` is populated; second rejects so we can verify
  // the fail-safe preserves the prior `current` value instead of wiping it.
  let callCount = 0;
  const svc = new UpdateService({
    git: async (args) => {
      if (callCount++ < 4) return fakeGit(UP_TO_DATE)(args); // first check succeeds
      throw new Error("network timeout");
    },
    launch: () => {},
  });
  const first = await svc.check(1000);
  expect(first.behind).toBe(0);
  expect(first.current).toBe("abc1234");
  const second = await svc.check(2000);
  expect(second.behind).toBe(0);
  expect(second.error).toContain("network timeout");
  expect(second.current).toBe("abc1234"); // preserved from prior check
});

test("apply() launches once and guards double-launch with a reason", () => {
  let launches = 0;
  const svc = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: freshLog(),
    launch: () => launches++,
  });
  expect(svc.apply()).toEqual({ started: true });
  const second = svc.apply();
  expect(second.started).toBe(false);
  expect(second.error).toBeTruthy(); // never a bare status — the UI shows this
  expect(launches).toBe(1);
});

test("apply() surfaces a launch failure instead of throwing", () => {
  const svc = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: freshLog(),
    launch: () => {
      throw new Error("systemd-run not found");
    },
  });
  const r = svc.apply();
  expect(r.started).toBe(false);
  expect(r.error).toContain("systemd-run not found");
});

test("applyState() reads the deploy log: idle → running → failed", () => {
  const logPath = freshLog();
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), logPath, launch: () => {} });

  expect(svc.applyState().phase).toBe("idle"); // no log yet

  writeFileSync(logPath, "\x1b[36m▸ installing deps\x1b[0m\nbuilding UI\n");
  const running = svc.applyState();
  expect(running.phase).toBe("running");
  expect(running.log).toContain("installing deps");
  expect(running.log).not.toContain("\x1b["); // ANSI stripped

  writeFileSync(logPath, "build failed: tsc error\n__SHEPHERD_UPDATE_EXIT__:1\n");
  const failed = svc.applyState();
  expect(failed.phase).toBe("failed");
  expect(failed.exitCode).toBe(1);
  expect(failed.log).toContain("build failed: tsc error");
  expect(failed.log).not.toContain("__SHEPHERD_UPDATE_EXIT__"); // marker hidden from the UI
});

test("applyState() reports done on a clean exit", () => {
  const logPath = freshLog();
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), logPath, launch: () => {} });
  writeFileSync(logPath, "✓ shepherd healthy\n__SHEPHERD_UPDATE_EXIT__:0\n");
  const s = svc.applyState();
  expect(s.phase).toBe("done");
  expect(s.exitCode).toBe(0);
});

test("apply() retries after a previous deploy failed (latch self-heals)", () => {
  const logPath = freshLog();
  let launches = 0;
  const svc = new UpdateService({ git: fakeGit(UP_TO_DATE), logPath, launch: () => launches++ });
  expect(svc.apply().started).toBe(true);
  // a failed deploy left a non-zero exit marker behind
  writeFileSync(logPath, "boom\n__SHEPHERD_UPDATE_EXIT__:1\n");
  expect(svc.apply().started).toBe(true); // not stuck — retry is allowed
  expect(launches).toBe(2);
});

// ── dirtyStatus() + discard ──────────────────────────────────────────────────

const NUL = "\0";
/** Expected framed signature: three per-command subhashes, then hash their hex. */
function frameSig(status: Buffer, cached: Buffer, wt: Buffer): string {
  const h = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  return createHash("sha256")
    .update(h(status) + h(cached) + h(wt))
    .digest("hex");
}

/** Build a service whose signature inputs are fixed fixtures (status via gitRaw,
 *  the two diffs via gitHashStream). `streamThrows` simulates the cap/timeout. */
function dirtySvc(opts: { status: Buffer; cached?: Buffer; wt?: Buffer; streamThrows?: boolean }) {
  const cached = opts.cached ?? Buffer.alloc(0);
  const wt = opts.wt ?? Buffer.alloc(0);
  const gitRaw: GitRawRunner = async () => opts.status;
  const gitHashStream: GitHashStreamer = async (args, hash: Hash) => {
    if (opts.streamThrows) throw new Error("signature too large");
    const buf = args.includes("--cached") ? cached : wt;
    hash.update(buf);
    return buf.length;
  };
  return new UpdateService({ git: fakeGit(UP_TO_DATE), launch: () => {}, gitRaw, gitHashStream });
}

test("dirtyStatus(): clean tree → not dirty, sig of empty streams", async () => {
  const svc = dirtySvc({ status: Buffer.alloc(0) });
  const s = await svc.dirtyStatus();
  expect(s.dirty).toBe(false);
  expect(s.dirtyCount).toBe(0);
  expect(s.dirtyFiles).toEqual([]);
  expect(s.sig).toBe(frameSig(Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)));
  expect(s.pathspecAll.length).toBe(0);
  expect(s.pathspecWorktree.length).toBe(0);
});

test("dirtyStatus(): parses modify/add/rename into the two pathspecs", async () => {
  // ' M mod.ts'  (in HEAD → worktree),  'A  add.ts' (pure add → NOT worktree),
  // 'R  to.ts\0from.ts' (both sides in All; only the old side in Worktree)
  const status = Buffer.from(` M mod.ts${NUL}A  add.ts${NUL}R  to.ts${NUL}from.ts${NUL}`, "utf8");
  const s = await dirtySvc({ status }).dirtyStatus();
  expect(s.dirty).toBe(true);
  expect(s.dirtyCount).toBe(3); // three entries (rename is one)
  expect(s.dirtyFiles).toEqual([" M mod.ts", "A  add.ts", "R  to.ts"]);
  // pathspecAll: mod.ts, add.ts, to.ts (new), from.ts (old)
  expect(s.pathspecAll.toString("utf8")).toBe(`mod.ts${NUL}add.ts${NUL}to.ts${NUL}from.ts${NUL}`);
  // pathspecWorktree: mod.ts, from.ts — excludes the pure add and the rename's new side
  expect(s.pathspecWorktree.toString("utf8")).toBe(`mod.ts${NUL}from.ts${NUL}`);
});

test("dirtyStatus(): sig is content-sensitive — same status, different diff → different sig", async () => {
  const status = Buffer.from(` M a.ts${NUL}`, "utf8");
  // A pure status signature would MATCH here (status bytes identical); the framed
  // content signature must differ because the unstaged diff content differs.
  const s1 = await dirtySvc({ status, wt: Buffer.from("diff v1") }).dirtyStatus();
  const s2 = await dirtySvc({ status, wt: Buffer.from("diff v2") }).dirtyStatus();
  expect(s1.sig).not.toBe(s2.sig);
  expect(s1.sig).toBe(frameSig(status, Buffer.alloc(0), Buffer.from("diff v1")));
});

test("dirtyStatus(): dirtyFiles cap + total count", async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ` M f${i}.ts`).join(NUL) + NUL;
  const s = await new UpdateService({
    git: fakeGit(UP_TO_DATE),
    launch: () => {},
    limit: 20,
    gitRaw: async () => Buffer.from(entries, "utf8"),
    gitHashStream: async () => 0,
  }).dirtyStatus();
  expect(s.dirtyCount).toBe(25);
  expect(s.dirtyFiles.length).toBe(20); // capped for display
});

test("dirtyStatus(): cap/timeout → sig null but still dirty + counted", async () => {
  const status = Buffer.from(` M big.bin${NUL}`, "utf8");
  const s = await dirtySvc({ status, streamThrows: true }).dirtyStatus();
  expect(s.dirty).toBe(true);
  expect(s.dirtyCount).toBe(1);
  expect(s.sig).toBeNull(); // friendly fallback: no one-click discard
});

test("applyState() classifies dirty / stale reasons from the deploy log", () => {
  const dirtyLog = freshLog();
  const svcDirty = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: dirtyLog,
    launch: () => {},
  });
  writeFileSync(dirtyLog, "✗ --pull needs a clean tree\n__SHEPHERD_UPDATE_EXIT__:1\n");
  expect(svcDirty.applyState().reason).toBe("dirty");

  const staleLog = freshLog();
  const svcStale = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: staleLog,
    launch: () => {},
  });
  writeFileSync(
    staleLog,
    "✗ SHEPHERD_DISCARD_STALE: working tree changed\n__SHEPHERD_UPDATE_EXIT__:1\n",
  );
  expect(svcStale.applyState().reason).toBe("stale");

  const otherLog = freshLog();
  const svcOther = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: otherLog,
    launch: () => {},
  });
  writeFileSync(otherLog, "✗ tsc error\n__SHEPHERD_UPDATE_EXIT__:1\n");
  expect(svcOther.applyState().reason).toBeNull();
});

test("apply({discard}) forwards the confirmation tokens to launch", () => {
  const discardLaunches: DiscardLaunch[] = [];
  let plainLaunches = 0;
  const svc = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: freshLog(),
    launch: (d) => {
      if (d) discardLaunches.push(d);
      else plainLaunches++;
    },
  });
  const r = svc.apply({
    discard: true,
    sig: "SIG",
    dir: "/tmp/d",
    pathspecAllFile: "/tmp/d/all",
    pathspecWtFile: "/tmp/d/worktree",
  });
  expect(r.started).toBe(true);
  expect(discardLaunches).toEqual([
    {
      sig: "SIG",
      dir: "/tmp/d",
      pathspecAllFile: "/tmp/d/all",
      pathspecWtFile: "/tmp/d/worktree",
    },
  ]);
  expect(plainLaunches).toBe(0);
});

test("apply() without discard opts launches plainly (no discard forwarded)", () => {
  const discardLaunches: DiscardLaunch[] = [];
  let plain = 0;
  const svc = new UpdateService({
    git: fakeGit(UP_TO_DATE),
    logPath: freshLog(),
    launch: (d) => {
      if (d) discardLaunches.push(d);
      else plain++;
    },
  });
  expect(svc.apply().started).toBe(true);
  expect(discardLaunches).toEqual([]);
  expect(plain).toBe(1);
});

test("app-managed Mac hands off atomically without launching a deploy", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-app-update-"));
  try {
    const svc = new UpdateService({
      appUpdateDir: dir,
      platform: "darwin",
      scriptPath: "/does-not-exist",
    });
    writeFileSync(join(dir, "shepherd-update.log"), "old result\n__SHEPHERD_UPDATE_EXIT__:1\n");
    const before = Date.now();
    expect(svc.apply()).toEqual({ started: true });
    const request = JSON.parse(readFileSync(join(dir, "update-request"), "utf8"));
    expect(request.requestedAt).toBeGreaterThanOrEqual(before);
    expect(request.requestedAt).toBeLessThanOrEqual(Date.now());
    expect(readFileSync(join(dir, "shepherd-update.log"), "utf8")).toBe(
      "▸ handing the update to the Shepherd app on this Mac…\n",
    );
    expect(readdirSync(dir).sort()).toEqual(["shepherd-update.log", "update-request"]);
    expect(svc.applyState().phase).toBe("running");
    expect(svc.apply().started).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app handoff rejects discard even without complete discard tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-app-update-"));
  try {
    let launches = 0;
    const svc = new UpdateService({ appUpdateDir: dir, launch: () => launches++ });
    const result = svc.apply({ discard: true });
    expect(result.started).toBe(false);
    expect(result.error).toContain(
      "discarding local changes is not supported on an app-managed Mac",
    );
    expect(launches).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale app request fails durably, removes the request and permits retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-app-update-"));
  try {
    const svc = new UpdateService({ appUpdateDir: dir });
    expect(svc.apply().started).toBe(true);
    const request = join(dir, "update-request");
    expect(svc.applyState().phase).toBe("running");
    const stale = new Date(Date.now() - 61_000);
    utimesSync(request, stale, stale);
    const result = svc.applyState();
    expect(result.phase).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.log).toContain("open the app on this Mac and retry");
    expect(existsSync(request)).toBe(false);
    expect(new UpdateService({ appUpdateDir: dir }).applyState()).toEqual(result);
    expect(svc.apply().started).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale app request is retired even if its log disappeared", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-app-update-"));
  try {
    const svc = new UpdateService({ appUpdateDir: dir });
    expect(svc.apply().started).toBe(true);
    unlinkSync(join(dir, "shepherd-update.log"));
    const stale = new Date(Date.now() - 61_000);
    utimesSync(join(dir, "update-request"), stale, stale);
    expect(svc.applyState().phase).toBe("failed");
    expect(existsSync(join(dir, "update-request"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimed app request stays running and app markers survive server restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-app-update-"));
  try {
    const svc = new UpdateService({ appUpdateDir: dir });
    expect(svc.apply().started).toBe(true);
    unlinkSync(join(dir, "update-request"));
    expect(svc.applyState().phase).toBe("running");
    for (const code of [0, 7]) {
      writeFileSync(
        join(dir, "shepherd-update.log"),
        `app progress\n__SHEPHERD_UPDATE_EXIT__:${code}\n`,
      );
      const result = new UpdateService({ appUpdateDir: dir }).applyState();
      expect(result.phase).toBe(code === 0 ? "done" : "failed");
      expect(result.exitCode).toBe(code);
      expect(result.log).toBe("app progress");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unmanaged Mac explains the manual update path without launching systemd", () => {
  const logPath = freshLog();
  const svc = new UpdateService({ appUpdateDir: "", platform: "darwin", logPath });
  expect(svc.apply()).toEqual({
    started: false,
    error:
      "this Mac's Shepherd server is not managed by the Shepherd app — update it with deploy/update.sh",
  });
  expect(existsSync(logPath)).toBe(false);
});

test("failed app request publication does not leave a running log blocking retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-app-update-"));
  try {
    const svc = new UpdateService({ appUpdateDir: dir });
    const temporary = join(dir, `update-request.${process.pid}.tmp`);
    writeFileSync(temporary, "occupied");
    expect(svc.apply().started).toBe(false);
    expect(svc.applyState().phase).toBe("idle");
    expect(svc.apply().started).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
