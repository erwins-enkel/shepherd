import { test, expect } from "bun:test";
import { pickPrimaryPort } from "../src/preview";
import { scanListeningPortsByWorktree, type ReaperProbes } from "../src/process-reaper";

// ── pickPrimaryPort ───────────────────────────────────────────────────────────

const neverProbe = async (): Promise<boolean> => {
  throw new Error("httpProbe must not be called when a curated port is present");
};

const noProbe = async (): Promise<boolean> => false;

test("pickPrimaryPort: curated port wins over lower numeric port (5173 beats 3000)", async () => {
  const result = await pickPrimaryPort([3000, 5173], neverProbe);
  expect(result).toBe(5173);
});

test("pickPrimaryPort: curated list-order priority — 4321 beats 8080", async () => {
  // curated order: [5173, 5174, 4321, 4173, 3000, 8000, 8080]
  // 4321 appears before 8080 in the list → wins
  const result = await pickPrimaryPort([8080, 4321], neverProbe);
  expect(result).toBe(4321);
});

test("pickPrimaryPort: first curated port in list wins when multiple curated are present", async () => {
  // 5173 is first in the curated list, 3000 is fifth
  const result = await pickPrimaryPort([3000, 8000, 5173], neverProbe);
  expect(result).toBe(5173);
});

test("pickPrimaryPort: curated port is chosen WITHOUT calling httpProbe", async () => {
  let probeCallCount = 0;
  const countingProbe = async (): Promise<boolean> => {
    probeCallCount++;
    return true;
  };
  const result = await pickPrimaryPort([5173], countingProbe);
  expect(result).toBe(5173);
  expect(probeCallCount).toBe(0);
});

test("pickPrimaryPort: empty port list → null", async () => {
  const result = await pickPrimaryPort([], noProbe);
  expect(result).toBeNull();
});

test("pickPrimaryPort: non-curated port that fails httpProbe → null", async () => {
  // 9229 is a --inspect debugger port (not curated)
  const result = await pickPrimaryPort([9229], noProbe);
  expect(result).toBeNull();
});

test("pickPrimaryPort: non-curated fallback picks the LOWEST HTTP-answering port", async () => {
  // ports 9229 (no), 9500 (yes), 9600 (yes) — picks 9500 (lowest that answers)
  const respondingPorts = new Set([9500, 9600]);
  const probe = async (port: number): Promise<boolean> => respondingPorts.has(port);
  const result = await pickPrimaryPort([9229, 9500, 9600], probe);
  expect(result).toBe(9500);
});

test("pickPrimaryPort: non-curated fallback — only highest answers → picks it", async () => {
  const probe = async (port: number): Promise<boolean> => port === 9999;
  const result = await pickPrimaryPort([9229, 9500, 9999], probe);
  expect(result).toBe(9999);
});

test("pickPrimaryPort: non-curated fallback — none answer → null", async () => {
  const result = await pickPrimaryPort([9229, 12345], noProbe);
  expect(result).toBeNull();
});

test("pickPrimaryPort: mixed curated + non-curated → curated wins, no httpProbe", async () => {
  let called = false;
  const probe = async (): Promise<boolean> => {
    called = true;
    return true;
  };
  // 8080 is curated; 9229 is not
  const result = await pickPrimaryPort([9229, 8080], probe);
  expect(result).toBe(8080);
  expect(called).toBe(false);
});

test("pickPrimaryPort: only non-curated, none answer HTTP → null", async () => {
  const result = await pickPrimaryPort([9229, 5678], noProbe);
  expect(result).toBeNull();
});

// ── scanListeningPortsByWorktree ──────────────────────────────────────────────

function makeProbes(over: Partial<ReaperProbes> = {}): ReaperProbes {
  return {
    scanProcs: () => [],
    portsForPid: () => [],
    listeningPorts: () => new Set(),
    readTranscript: () => "",
    killPid: () => {},
    run: () => {},
    ...over,
  };
}

test("scanListeningPortsByWorktree: builds the inode→port map EXACTLY ONCE for N worktrees/PIDs", () => {
  let mapBuildCount = 0;

  const procs = [
    { pid: 101, cwd: "/wt/alpha/src", comm: "vite" },
    { pid: 102, cwd: "/wt/beta", comm: "node" },
    { pid: 103, cwd: "/wt/alpha", comm: "bun" },
  ];

  // inode assignments: pid 101 → inode 1001 (port 5173), pid 102 → inode 1002 (port 3000)
  // pid 103 has no socket inodes
  const inodeMap = new Map([
    [1001, 5173],
    [1002, 3000],
  ]);

  const pidInodes: Record<number, number[]> = {
    101: [1001],
    102: [1002],
    103: [],
  };

  const probes = makeProbes({
    scanProcs: () => procs,
    inodeToPortMap: () => {
      mapBuildCount++;
      return inodeMap;
    },
    socketInodesForPid: (pid) => pidInodes[pid] ?? [],
  });

  const result = scanListeningPortsByWorktree(["/wt/alpha", "/wt/beta"], probes);

  // Map built exactly once
  expect(mapBuildCount).toBe(1);
  // alpha gets pid 101 (port 5173) + pid 103 (no ports)
  expect(result.get("/wt/alpha")).toEqual([5173]);
  // beta gets pid 102 (port 3000)
  expect(result.get("/wt/beta")).toEqual([3000]);
});

test("scanListeningPortsByWorktree: ports are sorted and deduplicated per worktree", () => {
  const inodeMap = new Map([
    [1, 3000],
    [2, 5173],
    [3, 3000], // duplicate port
  ]);
  const probes = makeProbes({
    scanProcs: () => [
      { pid: 10, cwd: "/wt/app", comm: "vite" },
      { pid: 11, cwd: "/wt/app/subdir", comm: "node" },
    ],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: (pid) => (pid === 10 ? [1, 2] : [3]),
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  // sorted, deduped: [3000, 5173]
  expect(result.get("/wt/app")).toEqual([3000, 5173]);
});

test("scanListeningPortsByWorktree: excludes the agent comm (claude)", () => {
  const inodeMap = new Map([[1, 9999]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 42, cwd: "/wt/app", comm: "claude" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(result.get("/wt/app")).toEqual([]);
});

test("scanListeningPortsByWorktree: excludes own process.pid", () => {
  const inodeMap = new Map([[1, 7330]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: process.pid, cwd: "/wt/app", comm: "bun" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(result.get("/wt/app")).toEqual([]);
});

test("scanListeningPortsByWorktree: processes outside all worktrees are ignored", () => {
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 55, cwd: "/other/place", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(result.get("/wt/app")).toEqual([]);
});

test("scanListeningPortsByWorktree: returns empty arrays for worktrees with no matching procs", () => {
  const probes = makeProbes({
    scanProcs: () => [{ pid: 10, cwd: "/wt/other", comm: "vite" }],
    inodeToPortMap: () => new Map([[1, 5173]]),
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/alpha", "/wt/beta"], probes);
  expect(result.get("/wt/alpha")).toEqual([]);
  expect(result.get("/wt/beta")).toEqual([]);
});

test("scanListeningPortsByWorktree: empty worktreePaths → empty map", () => {
  const probes = makeProbes({
    scanProcs: () => [{ pid: 10, cwd: "/wt/app", comm: "vite" }],
    inodeToPortMap: () => new Map([[1, 5173]]),
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree([], probes);
  expect(result.size).toBe(0);
});

test("scanListeningPortsByWorktree: a PID under a nested subdir is attributed to its worktree", () => {
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 77, cwd: "/wt/myapp/packages/server", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/myapp"], probes);
  expect(result.get("/wt/myapp")).toEqual([3000]);
});

test("scanListeningPortsByWorktree: multiple worktrees get independent port sets", () => {
  const inodeMap = new Map([
    [1, 5173],
    [2, 4321],
  ]);
  const probes = makeProbes({
    scanProcs: () => [
      { pid: 10, cwd: "/wt/alpha", comm: "vite" },
      { pid: 20, cwd: "/wt/beta", comm: "astro" },
    ],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: (pid) => (pid === 10 ? [1] : [2]),
  });
  const result = scanListeningPortsByWorktree(["/wt/alpha", "/wt/beta"], probes);
  expect(result.get("/wt/alpha")).toEqual([5173]);
  expect(result.get("/wt/beta")).toEqual([4321]);
});

test("scanListeningPortsByWorktree: mismatched probe config (socketInodesForPid only) falls back to portsForPid", () => {
  // Only socketInodesForPid supplied — inodeToPortMap absent.
  // Supply both or neither; partial pair must not silently return [].
  let portsForPidCalled = false;
  const probes = makeProbes({
    scanProcs: () => [{ pid: 88, cwd: "/wt/app", comm: "vite" }],
    // inodeToPortMap intentionally omitted
    socketInodesForPid: () => [999],
    portsForPid: (pid) => {
      portsForPidCalled = true;
      return pid === 88 ? [5173] : [];
    },
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(portsForPidCalled).toBe(true);
  expect(result.get("/wt/app")).toEqual([5173]);
});

test("scanListeningPortsByWorktree: proc under /wt/appold is NOT attributed to /wt/app", () => {
  // Prefix-sibling boundary: /wt/app must not match /wt/appold/src
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 55, cwd: "/wt/appold/src", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(result.get("/wt/app")).toEqual([]);
});

// ── PreviewService: reverse-proxy listeners + slot allocation ──────────────────
//
// These tests stand up REAL upstream Bun.serve servers (the "dev server") on
// ephemeral ports and a PreviewService over a high range unlikely to collide.
// Every test stops its upstream(s) AND the service in cleanup.

import { afterEach, beforeEach } from "bun:test";
import { PreviewService } from "../src/preview";

// A high, unusual base unlikely to collide with anything on the test host.
const TEST_BASE = 39000;
const TEST_COUNT = 4;

type Upstream = ReturnType<typeof Bun.serve>;

const upstreams: Upstream[] = [];
let service: PreviewService | null = null;

/** The real listen port of a started upstream (`Server.port` is typed optional). */
function portOf(s: Upstream): number {
  return s.port as number;
}

/** Stand up a plain-HTTP upstream returning `body`/`status`/`headers`; tracked for cleanup. */
function httpUpstream(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  echoPath?: boolean;
}): Upstream {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const body = opts.echoPath ? url.pathname + url.search : (opts.body ?? "ok");
      return new Response(body, {
        status: opts.status ?? 200,
        headers: opts.headers ?? {},
      });
    },
  });
  upstreams.push(s);
  return s;
}

/** Stand up an upstream that on WS-open pushes `pushMsg` and echoes incoming frames. */
function wsUpstream(pushMsg: string): Upstream {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("not a ws", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(pushMsg);
      },
      message(ws, msg) {
        ws.send("echo:" + msg);
      },
    },
  });
  upstreams.push(s);
  return s;
}

/** Connect a client WS to the preview listener and resolve once `count` messages arrive. */
function collectWsMessages(
  url: string,
  count: number,
  onOpen?: (ws: WebSocket) => void,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got: string[] = [];
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* peer gone */
      }
      reject(new Error(`timed out waiting for ${count} ws messages (got ${got.length})`));
    }, 4000);
    ws.onopen = () => onOpen?.(ws);
    ws.onmessage = (e) => {
      got.push(String(e.data));
      if (got.length >= count) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* peer gone */
        }
        resolve(got);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
}

beforeEach(() => {
  service = new PreviewService({ base: TEST_BASE, count: TEST_COUNT });
});

afterEach(() => {
  try {
    service?.stopAll();
  } catch {
    /* teardown best-effort */
  }
  service = null;
  for (const u of upstreams.splice(0)) {
    try {
      u.stop(true);
    } catch {
      /* teardown best-effort */
    }
  }
});

test("PreviewService: HMR round-trip — upstream push + client echo both relay", async () => {
  const up = wsUpstream("hmr-update");
  const port = service!.ensure("s1", portOf(up));
  expect(port).not.toBeNull();

  // Expect 2 messages: the upstream push (upstream→client) AND the echo of our
  // client-sent frame (client→upstream→client). This proves bidirectional relay.
  const msgs = await collectWsMessages(`ws://127.0.0.1:${port}/`, 2, (ws) => {
    ws.send("ping-from-client");
  });
  expect(msgs).toContain("hmr-update");
  expect(msgs).toContain("echo:ping-from-client");
});

test("PreviewService: HTTP proxy strips X-Frame-Options + CSP frame-ancestors, keeps rest", async () => {
  const up = httpUpstream({
    status: 200,
    headers: {
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; img-src *",
      "X-Keep": "yes",
    },
    body: "<html>hi</html>",
  });
  const port = service!.ensure("s1", portOf(up));
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("x-frame-options")).toBeNull();
  expect(res.headers.get("x-keep")).toBe("yes");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).not.toContain("frame-ancestors");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("img-src *");
  expect(await res.text()).toBe("<html>hi</html>");
});

test("PreviewService: fail-closed — upstream dead → 502/503, not a hang or empty 200", async () => {
  // Bind to a devPort nothing listens on (free a port by stopping an upstream).
  const dead = httpUpstream({});
  const deadPort = portOf(dead);
  dead.stop(true);
  upstreams.splice(upstreams.indexOf(dead), 1);

  const port = service!.ensure("s1", deadPort);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect([502, 503]).toContain(res.status);
});

test("PreviewService: slot allocation bounded by count — (count+1)th session → null", () => {
  for (let i = 0; i < TEST_COUNT; i++) {
    const p = service!.ensure(`s${i}`, 40000 + i);
    expect(p).not.toBeNull();
  }
  const overflow = service!.ensure("overflow", 40099);
  expect(overflow).toBeNull();
});

test("PreviewService: release frees a slot for a later ensure", () => {
  for (let i = 0; i < TEST_COUNT; i++) {
    expect(service!.ensure(`s${i}`, 40000 + i)).not.toBeNull();
  }
  expect(service!.ensure("overflow", 40099)).toBeNull();
  service!.release("s0");
  expect(service!.ensure("later", 40100)).not.toBeNull();
});

test("PreviewService: snapshot reflects bound sessions only", () => {
  const p0 = service!.ensure("s0", 40000);
  const p1 = service!.ensure("s1", 40001);
  const snap = service!.snapshot();
  expect(snap["s0"]).toEqual({ previewPort: p0 });
  expect(snap["s1"]).toEqual({ previewPort: p1 });
  service!.release("s0");
  const snap2 = service!.snapshot();
  expect(snap2["s0"]).toBeUndefined();
  expect(snap2["s1"]).toEqual({ previewPort: p1 });
});

test("PreviewService: release is idempotent", () => {
  service!.ensure("s0", 40000);
  service!.release("s0");
  expect(() => service!.release("s0")).not.toThrow();
  expect(() => service!.release("never-bound")).not.toThrow();
});

test("PreviewService: converge binds new + releases absent", () => {
  service!.ensure("keep", 40000);
  service!.ensure("drop", 40001);
  service!.converge([
    { sessionId: "keep", devPort: 40000 },
    { sessionId: "new", devPort: 40002 },
  ]);
  const snap = service!.snapshot();
  expect(snap["keep"]).toBeDefined();
  expect(snap["new"]).toBeDefined();
  expect(snap["drop"]).toBeUndefined();
});

test("PreviewService: target integrity — any path still hits the session's own devPort", async () => {
  const up = httpUpstream({ echoPath: true });
  const port = service!.ensure("s1", portOf(up));
  const res = await fetch(`http://127.0.0.1:${port}/anything?q=1`);
  expect(res.status).toBe(200);
  // Body echoes the path it actually reached on the upstream — proves no host/port redirect.
  expect(await res.text()).toBe("/anything?q=1");
});

test("PreviewService: re-ensure updates devPort live without rebind, no onChange", async () => {
  const upA = httpUpstream({ body: "A" });
  const upB = httpUpstream({ body: "B" });
  const changes: Array<[string, number | null]> = [];
  const svc = new PreviewService({
    base: TEST_BASE,
    count: TEST_COUNT,
    onChange: (id, port) => changes.push([id, port]),
  });
  try {
    const port = svc.ensure("s1", portOf(upA));
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("A");
    // re-ensure with a new devPort: same listener, now targets B, NO new onChange.
    const port2 = svc.ensure("s1", portOf(upB));
    expect(port2).toBe(port);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("B");
    // onChange fired exactly once (the first bind), not on the devPort-only update.
    expect(changes).toEqual([["s1", port]]);
  } finally {
    svc.stopAll();
  }
});

test("PreviewService: onChange fires on first bind and on release", () => {
  const changes: Array<[string, number | null]> = [];
  const svc = new PreviewService({
    base: TEST_BASE,
    count: TEST_COUNT,
    onChange: (id, port) => changes.push([id, port]),
  });
  try {
    const port = svc.ensure("s1", 40000);
    svc.release("s1");
    expect(changes).toEqual([
      ["s1", port],
      ["s1", null],
    ]);
  } finally {
    svc.stopAll();
  }
});

test("PreviewService: range exhaustion logs a warning and never crashes", () => {
  const warns: unknown[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a);
  try {
    for (let i = 0; i < TEST_COUNT; i++) service!.ensure(`s${i}`, 40000 + i);
    const overflow = service!.ensure("overflow", 40099);
    expect(overflow).toBeNull();
    expect(warns.length).toBeGreaterThan(0);
  } finally {
    console.warn = orig;
  }
});

test("PreviewService: stopAll clears all listeners and the snapshot", () => {
  service!.ensure("s0", 40000);
  service!.ensure("s1", 40001);
  service!.stopAll();
  expect(service!.snapshot()).toEqual({});
});
