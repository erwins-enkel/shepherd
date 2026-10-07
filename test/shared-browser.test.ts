import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpClient } from "../src/cdp-pipe";
import {
  SharedBrowserError,
  SharedBrowserManager,
  browserProfileDir,
  reapOrphanBrowsers,
  type SharedBrowserDeps,
} from "../src/shared-browser";

// Fake Chromium: NUL-framed CDP on fd3 (in) / fd4 (out), answering the methods the manager and
// these tests use. Runs under the test runtime itself (process.execPath).
const FAKE_CHROMIUM = `
const fs = require("node:fs");
const out = fs.createWriteStream(null, { fd: 4 });
let buf = "";
let n = 0;
fs.createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\0")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    let result = {};
    if (m.method === "Target.attachToBrowserTarget") result = { sessionId: "B" + ++n };
    else if (m.method === "Target.createTarget") result = { targetId: "T:" + m.params.url };
    else if (m.method === "Target.getTargets") result = { targetInfos: [] };
    out.write(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }) + "\\0");
  }
});
process.stderr.write("fake chromium up\\n");
`;

interface Spawned {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: ChildProcess;
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

let root: string;
let spawned: Spawned[];
let timers: FakeTimer[];
let logs: string[];
let managers: SharedBrowserManager[];
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shared-browser-test-"));
  spawned = [];
  timers = [];
  logs = [];
  managers = [];
  clock = 1000;
});

afterEach(async () => {
  for (const m of managers) m.stopAll();
  for (const s of spawned) s.child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

function manager(overrides: Partial<SharedBrowserDeps> = {}): SharedBrowserManager {
  const m = new SharedBrowserManager({
    profileRoot: join(root, "profiles"),
    env: {},
    which: async (bin) => `/usr/bin/${bin}`,
    spawn: (command, args, options) => {
      const child = spawn(process.execPath, ["-e", FAKE_CHROMIUM], {
        stdio: options.stdio,
        env: process.env,
      });
      spawned.push({ command, args, options, child });
      return child;
    },
    now: () => clock,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as FakeTimer).cleared = true;
    },
    log: (msg) => logs.push(msg),
    ...overrides,
  });
  managers.push(m);
  return m;
}

interface Sink extends CdpClient {
  messages: Record<string, unknown>[];
  closed: { code?: number; reason?: string } | null;
  next(): Promise<Record<string, unknown>>;
}

function sink(): Sink {
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  const s: Sink = {
    messages: [],
    closed: null,
    send(text) {
      const msg = JSON.parse(text) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(msg);
      else s.messages.push(msg);
    },
    close(code, reason) {
      s.closed = { code, reason };
    },
    next() {
      const queued = s.messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
  return s;
}

const exited = (child: ChildProcess) =>
  new Promise<string | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
    else child.once("exit", (_code, signal) => resolve(signal));
  });

const liveTimers = (ms: number) => timers.filter((t) => !t.cleared && t.ms === ms);

test("launch + attach: commands round-trip through the pipe", async () => {
  const m = manager();
  const s = sink();
  const client = await m.attach("/repos/app", s);
  await client.ready;
  client.receive(JSON.stringify({ id: 7, method: "Target.getTargets" }));
  expect(await s.next()).toEqual({ id: 7, result: { targetInfos: [] } });
  expect(m.isRunning("/repos/app")).toBe(true);
  expect(m.runningCount).toBe(1);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.command).toBe("/usr/bin/chromium");
  expect(spawned[0]!.options.stdio).toEqual(["ignore", "ignore", "pipe", "pipe", "pipe"]);
  expect(spawned[0]!.options.detached).toBe(false);
});

test("concurrent attaches for one repo share a single launch", async () => {
  const m = manager();
  const [a, b] = await Promise.all([
    m.attach("/repos/app", sink()),
    m.attach("/repos/app", sink()),
  ]);
  await Promise.all([a.ready, b.ready]);
  expect(spawned).toHaveLength(1);
});

test("profile dir is stable per repo and distinct across repos", async () => {
  const p = join(root, "profiles");
  expect(browserProfileDir(p, "/repos/My App")).toBe(browserProfileDir(p, "/repos/My App"));
  expect(browserProfileDir(p, "/repos/My App")).toMatch(/\/my-app-[0-9a-f]{12}$/);
  expect(browserProfileDir(p, "/a/app")).not.toBe(browserProfileDir(p, "/b/app"));

  const m = manager();
  await (
    await m.attach("/repos/My App", sink())
  ).ready;
  const dir = browserProfileDir(p, "/repos/My App");
  expect(spawned[0]!.args).toContain(`--user-data-dir=${dir}`);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

test("headful with a display, headless without", async () => {
  await (
    await manager({ env: { WAYLAND_DISPLAY: "wayland-1" } }).attach("/r/a", sink())
  ).ready;
  await (
    await manager({ env: { DISPLAY: ":0" } }).attach("/r/b", sink())
  ).ready;
  await (
    await manager({ env: {} }).attach("/r/c", sink())
  ).ready;
  const [wayland, x11, none] = spawned.map((s) => s.args);
  for (const args of [wayland!, x11!]) {
    expect(args).toContain("--ozone-platform-hint=auto");
    expect(args).not.toContain("--headless=new");
  }
  expect(none).toContain("--headless=new");
  expect(none).not.toContain("--ozone-platform-hint=auto");
  for (const args of [wayland!, x11!, none!]) {
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.at(-1)).toBe("about:blank");
  }
});

test("binary: SHEPHERD_CHROMIUM_BIN wins, else first found candidate", async () => {
  await (
    await manager({
      env: { SHEPHERD_CHROMIUM_BIN: "/opt/chrome" },
      which: async (bin) => bin,
    }).attach("/r/a", sink())
  ).ready;
  await (
    await manager({
      which: async (bin) => (bin === "google-chrome" ? "/usr/bin/google-chrome" : null),
    }).attach("/r/b", sink())
  ).ready;
  expect(spawned.map((s) => s.command)).toEqual(["/opt/chrome", "/usr/bin/google-chrome"]);
});

test("missing binary rejects with SharedBrowserError missing-binary", async () => {
  const m = manager({ which: async () => null });
  const err = await m.attach("/r/a", sink()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SharedBrowserError);
  expect((err as SharedBrowserError).code).toBe("missing-binary");
  expect(spawned).toHaveLength(0);
});

test("cap: launching a 4th evicts the longest-idle unattached browser", async () => {
  const m = manager();
  const a = await m.attach("/r/a", sink());
  clock = 2000;
  const b = await m.attach("/r/b", sink());
  await m.attach("/r/c", sink());
  clock = 3000;
  b.detach(); // idle since 3000
  clock = 4000;
  a.detach(); // idle since 4000
  await m.attach("/r/d", sink());
  expect(m.runningCount).toBe(3);
  expect(m.isRunning("/r/b")).toBe(false);
  expect(m.isRunning("/r/a")).toBe(true);
  expect(await exited(spawned[1]!.child)).toBe("SIGTERM");
});

test("cap: refused when every running browser is attached", async () => {
  const m = manager();
  for (const r of ["/r/a", "/r/b", "/r/c"]) await m.attach(r, sink());
  const err = await m.attach("/r/d", sink()).catch((e: unknown) => e);
  expect((err as SharedBrowserError).code).toBe("cap");
  expect(m.runningCount).toBe(3);
  expect(spawned).toHaveLength(3);
});

test("idle: stops idleMs after the last detach; a re-attach cancels it", async () => {
  const m = manager({ idleMs: 60_000 });
  const a = await m.attach("/r/a", sink());
  expect(liveTimers(60_000)).toHaveLength(0);
  a.detach();
  a.detach(); // idempotent
  const [first] = liveTimers(60_000);
  expect(first).toBeDefined();

  const b = await m.attach("/r/a", sink());
  expect(first!.cleared).toBe(true);
  expect(spawned).toHaveLength(1);
  b.detach();
  const [second] = liveTimers(60_000);
  second!.fn();
  expect(m.isRunning("/r/a")).toBe(false);
  expect(await exited(spawned[0]!.child)).toBe("SIGTERM");
});

test("open: creates a target, counts as activity but not as an attach", async () => {
  const m = manager({ idleMs: 60_000 });
  await m.open("/r/a", "http://localhost:5173/");
  expect(m.isRunning("/r/a")).toBe(true);
  expect(liveTimers(60_000)).toHaveLength(1); // no attach → idle armed after the open

  const s = sink();
  const client = await m.attach("/r/a", s);
  expect(liveTimers(60_000)).toHaveLength(0);
  await m.open("/r/a", "about:blank");
  expect(liveTimers(60_000)).toHaveLength(0); // still attached
  await client.ready;
  expect(s.closed).toBeNull();
});

test("child crash: clients closed, entry removed, next attach relaunches", async () => {
  const m = manager();
  const s = sink();
  await (
    await m.attach("/r/a", s)
  ).ready;
  spawned[0]!.child.kill("SIGKILL");
  await exited(spawned[0]!.child);
  await new Promise((r) => setTimeout(r, 10));
  expect(s.closed?.code).toBe(1011);
  expect(m.isRunning("/r/a")).toBe(false);
  expect(logs.some((l) => l.includes("exited unexpectedly"))).toBe(true);

  await (
    await m.attach("/r/a", sink())
  ).ready;
  expect(spawned).toHaveLength(2);
  expect(m.isRunning("/r/a")).toBe(true);
});

test("stopAll: synchronous SIGTERM to every child, clients closed, later launches refused", async () => {
  const m = manager();
  const s = sink();
  await (
    await m.attach("/r/a", s)
  ).ready;
  await (
    await m.attach("/r/b", sink())
  ).ready;
  m.stopAll();
  expect(m.runningCount).toBe(0);
  expect(spawned.every((x) => x.child.killed)).toBe(true);
  expect(s.closed?.code).toBe(1011);
  expect(await Promise.all(spawned.map((x) => exited(x.child)))).toEqual(["SIGTERM", "SIGTERM"]);
  expect(liveTimers(5000).length).toBe(0); // SIGKILL fallback cleared on exit
  const err = await m.attach("/r/c", sink()).catch((e: unknown) => e);
  expect((err as SharedBrowserError).code).toBe("launch-failed");
});

test("reapOrphanBrowsers: SIGTERMs foreign browser roots on our profiles only", async () => {
  const proc = join(root, "proc");
  const profiles = "/home/u/.shepherd/browser-profiles";
  const fakeProc = async (pid: number, ppid: number, args: string[]) => {
    await mkdir(join(proc, String(pid)), { recursive: true });
    await writeFile(join(proc, String(pid), "cmdline"), args.join("\0") + "\0");
    await writeFile(join(proc, String(pid), "stat"), `${pid} (chro me) S ${ppid} 1 1`);
  };
  const flag = `--user-data-dir=${profiles}/app-abc`;
  await fakeProc(100, 1, ["chromium", flag]); // orphan root → reaped
  await fakeProc(101, 100, ["chromium", "--type=renderer", flag]); // its child → skipped
  await fakeProc(500, 1, ["bun", "server"]); // us
  await fakeProc(501, 500, ["chromium", flag]); // our own live browser → kept
  await fakeProc(502, 1, ["chromium", "--user-data-dir=/home/u/other"]); // not ours → kept
  await mkdir(join(proc, "self"));
  const killed: [number, string][] = [];
  const n = await reapOrphanBrowsers(profiles, {
    procRoot: proc,
    platform: "linux",
    selfPid: 500,
    kill: (pid, sig) => killed.push([pid, sig]),
  });
  expect(n).toBe(1);
  expect(killed).toEqual([[100, "SIGTERM"]]);
  expect(await reapOrphanBrowsers(profiles, { platform: "darwin" })).toBe(0);
});
