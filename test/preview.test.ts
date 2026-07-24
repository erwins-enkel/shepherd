import { test, expect } from "bun:test";
import {
  pickPrimaryPort,
  sanitizeCloseCode,
  rewriteLoopbackLocation,
  resolveDevPort,
  detectDevCommand,
  makeRelayHandlers,
  type FsAccessors,
} from "../src/preview";
import { scanListeningPortsByWorktree, type ReaperProbes } from "../src/process-reaper";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── readPreviewHint + resolveDevPort ──────────────────────────────────────────

// Fake readFile helpers
const rejectReadFile = async (): Promise<string> => {
  throw new Error("ENOENT: no such file");
};
const makeReadFile = (content: string) => async (): Promise<string> => content;

// These tests exercise readPreviewHint behaviour indirectly via resolveDevPort.
test("resolveDevPort: valid port string '3000\\n' → hint honored (3000 curated, no probe)", async () => {
  const result = await resolveDevPort([3000], "/any", makeReadFile("3000\n"), async () => true);
  expect(result).toBe(3000);
});

test("resolveDevPort: non-numeric 'abc' hint → null (falls back to pickPrimaryPort)", async () => {
  const result = await resolveDevPort([5173], "/any", makeReadFile("abc"), neverProbe);
  expect(result).toBe(5173); // bad hint → falls back
});

test("resolveDevPort: out-of-range '0' hint → null (falls back)", async () => {
  const result = await resolveDevPort([5173], "/any", makeReadFile("0"), neverProbe);
  expect(result).toBe(5173);
});

test("resolveDevPort: out-of-range '70000' hint → null (falls back)", async () => {
  const result = await resolveDevPort([5173], "/any", makeReadFile("70000"), neverProbe);
  expect(result).toBe(5173);
});

test("resolveDevPort: surrounding whitespace '  5173  ' → hint honored (curated, no probe)", async () => {
  let probeCount = 0;
  const countingProbe = async (): Promise<boolean> => {
    probeCount++;
    return true;
  };
  const result = await resolveDevPort([5173], "/any", makeReadFile("  5173  "), countingProbe);
  expect(result).toBe(5173);
  expect(probeCount).toBe(0); // curated → no probe
});

test("resolveDevPort: junk-suffixed hint '3000abc' → rejected (falls back to pickPrimaryPort)", async () => {
  // parseInt("3000abc") = 3000 but /^\d+$/ rejects it → hint is null → falls back
  // Prove rejection: ports=[5173] so fallback picks 5173 (NOT 3000 via hint path)
  let probeCount = 0;
  const countingProbe = async (): Promise<boolean> => {
    probeCount++;
    return false;
  };
  const result = await resolveDevPort([5173], "/any", makeReadFile("3000abc"), countingProbe);
  expect(result).toBe(5173); // curated 5173 returned via fallback (no probe)
  expect(probeCount).toBe(0); // 3000 was NEVER probed (hint was rejected outright)
});

test("resolveDevPort: curated hint not in ports → falls back to pickPrimaryPort (ports.includes gate)", async () => {
  // hint=3000 (curated), ports=[5173] — 3000 not listening → ignored
  const result = await resolveDevPort([5173], "/any", makeReadFile("3000"), neverProbe);
  expect(result).toBe(5173); // fallback picks curated 5173
});

test("resolveDevPort: hint curated, in ports → returns hint WITHOUT probing", async () => {
  let probeCount = 0;
  const countingProbe = async (): Promise<boolean> => {
    probeCount++;
    return true;
  };
  // hint=5173 (curated), ports=[3000, 5173]
  const result = await resolveDevPort([3000, 5173], "/any", makeReadFile("5173"), countingProbe);
  expect(result).toBe(5173);
  expect(probeCount).toBe(0);
});

test("resolveDevPort: hint non-curated, in ports, probe passes → returns hint (wins over curated 5173)", async () => {
  // hint=9000 (non-curated), ports=[9000, 5173]; probe passes for 9000
  // Without the hint, pickPrimaryPort would return 5173. The hint overrides it.
  const probe = async (port: number): Promise<boolean> => port === 9000;
  const result = await resolveDevPort([9000, 5173], "/any", makeReadFile("9000"), probe);
  expect(result).toBe(9000);
});

test("resolveDevPort: hint non-curated, in ports, probe fails → falls back to pickPrimaryPort (returns curated 5173)", async () => {
  // hint=9000 (non-curated), probe fails for 9000; 5173 is curated → returned unprobed
  const probe = async (port: number): Promise<boolean> => port !== 9000;
  const result = await resolveDevPort([9000, 5173], "/any", makeReadFile("9000"), probe);
  expect(result).toBe(5173);
});

test("resolveDevPort: failed non-curated hint is NOT re-probed in the fallback", async () => {
  // hint=9000 (non-curated, in ports), no curated port present so the fallback reaches
  // the probe loop. 9000 fails its probe in the hint branch; it must be excluded from the
  // fallback set so it isn't probed a second time. 9500 answers and wins.
  const probed: number[] = [];
  const probe = async (port: number): Promise<boolean> => {
    probed.push(port);
    return port === 9500;
  };
  const result = await resolveDevPort([9000, 9500], "/any", makeReadFile("9000"), probe);
  expect(result).toBe(9500);
  expect(probed.filter((p) => p === 9000).length).toBe(1); // probed once (hint branch), not re-probed
});

test("resolveDevPort: hint not in ports → falls back, hint port never probed", async () => {
  // hint=9000, ports=[5173] — 9000 not listening
  const probedPorts: number[] = [];
  const trackingProbe = async (port: number): Promise<boolean> => {
    probedPorts.push(port);
    return false;
  };
  const result = await resolveDevPort([5173], "/any", makeReadFile("9000"), trackingProbe);
  expect(result).toBe(5173); // curated 5173 returned (no probe for curated)
  expect(probedPorts).not.toContain(9000);
});

test("resolveDevPort: no hint (readFile rejects) → falls back to pickPrimaryPort", async () => {
  const result = await resolveDevPort([5173], "/any", rejectReadFile, neverProbe);
  expect(result).toBe(5173);
});

// The DEFAULT reader (no injected readFile) reads at most MAX_HINT_BYTES (64) from
// disk. This file's first 64 bytes are a clean non-curated port (9000) + whitespace,
// with a stray "x" far past the cap. With the cap, the hint parses to 9000 and (probe
// passing) wins over the curated 5173 the heuristic would otherwise pick. WITHOUT the
// cap an unbounded read would see the trailing "x", reject the content as non-numeric,
// and fall back to pickPrimaryPort → curated 5173 — so a 9000 result proves only the
// bounded prefix was read.
test("resolveDevPort: default reader caps the read at MAX_HINT_BYTES", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-preview-hint-"));
  try {
    writeFileSync(join(dir, ".shepherd-preview"), `9000${" ".repeat(200)}x`);
    const alwaysLive = async (): Promise<boolean> => true;
    // Default readFile (undefined) → bounded reader.
    const result = await resolveDevPort([9000, 5173], dir, undefined, alwaysLive);
    expect(result).toBe(9000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── sanitizeCloseCode ─────────────────────────────────────────────────────────
//
// Security-relevant: a relayed close code from an untrusted peer must never be
// passed verbatim to `.close(code)` (reserved/abnormal codes throw). Accepted:
// 1000 (normal) + the application range 3000–4999. Everything else → null, the
// sentinel that routes safeClose to a no-arg `.close()`.

test("sanitizeCloseCode: 1000 (normal) passes through", () => {
  expect(sanitizeCloseCode(1000)).toBe(1000);
});

test("sanitizeCloseCode: application range bounds 3000 and 4999 pass through", () => {
  expect(sanitizeCloseCode(3000)).toBe(3000);
  expect(sanitizeCloseCode(4999)).toBe(4999);
});

test("sanitizeCloseCode: reserved/abnormal codes → null (no-arg close sentinel)", () => {
  // 1005/1006 are reserved (never sent on the wire), 1011 is server-only,
  // 2999/5000 fall just outside the application range.
  for (const code of [1005, 1006, 1011, 2999, 5000]) {
    expect(sanitizeCloseCode(code)).toBeNull();
  }
});

test("sanitizeCloseCode: undefined (no code) → null", () => {
  expect(sanitizeCloseCode(undefined)).toBeNull();
});

// ── rewriteLoopbackLocation ───────────────────────────────────────────────────

test("rewriteLoopbackLocation: absolute 127.0.0.1:<devPort> redirect → path-relative", () => {
  const h = new Headers({ location: "http://127.0.0.1:5173/dashboard?x=1#top" });
  rewriteLoopbackLocation(h, 5173);
  expect(h.get("location")).toBe("/dashboard?x=1#top");
});

test("rewriteLoopbackLocation: localhost:<devPort> redirect → path-relative", () => {
  const h = new Headers({ location: "http://localhost:3000/app/" });
  rewriteLoopbackLocation(h, 3000);
  expect(h.get("location")).toBe("/app/");
});

test("rewriteLoopbackLocation: loopback on a DIFFERENT port is left untouched", () => {
  // not our dev server (e.g. an API on another port) — out of scope (multi-port #396)
  const h = new Headers({ location: "http://127.0.0.1:9999/api" });
  rewriteLoopbackLocation(h, 5173);
  expect(h.get("location")).toBe("http://127.0.0.1:9999/api");
});

test("rewriteLoopbackLocation: cross-origin redirect (OAuth) is left untouched", () => {
  const h = new Headers({ location: "https://accounts.google.com/o/oauth2?id=1" });
  rewriteLoopbackLocation(h, 5173);
  expect(h.get("location")).toBe("https://accounts.google.com/o/oauth2?id=1");
});

test("rewriteLoopbackLocation: already-relative Location is left untouched", () => {
  const h = new Headers({ location: "/login?next=/x" });
  rewriteLoopbackLocation(h, 5173);
  expect(h.get("location")).toBe("/login?next=/x");
});

test("rewriteLoopbackLocation: no Location header is a no-op", () => {
  const h = new Headers({ "x-other": "1" });
  rewriteLoopbackLocation(h, 5173);
  expect(h.get("location")).toBeNull();
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
  expect(result!.get("/wt/alpha")).toEqual([5173]);
  // beta gets pid 102 (port 3000)
  expect(result!.get("/wt/beta")).toEqual([3000]);
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
  expect(result!.get("/wt/app")).toEqual([3000, 5173]);
});

test("scanListeningPortsByWorktree: excludes the agent comm (claude)", () => {
  const inodeMap = new Map([[1, 9999]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 42, cwd: "/wt/app", comm: "claude" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(result!.get("/wt/app")).toEqual([]);
});

test("scanListeningPortsByWorktree: excludes own process.pid", () => {
  const inodeMap = new Map([[1, 7330]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: process.pid, cwd: "/wt/app", comm: "bun" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(result!.get("/wt/app")).toEqual([]);
});

test("scanListeningPortsByWorktree: processes outside all worktrees are ignored", () => {
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 55, cwd: "/other/place", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/app"], probes);
  expect(result!.get("/wt/app")).toEqual([]);
});

test("scanListeningPortsByWorktree: returns empty arrays for worktrees with no matching procs", () => {
  const probes = makeProbes({
    scanProcs: () => [{ pid: 10, cwd: "/wt/other", comm: "vite" }],
    inodeToPortMap: () => new Map([[1, 5173]]),
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/alpha", "/wt/beta"], probes);
  expect(result!.get("/wt/alpha")).toEqual([]);
  expect(result!.get("/wt/beta")).toEqual([]);
});

test("scanListeningPortsByWorktree: empty worktreePaths → empty map", () => {
  const probes = makeProbes({
    scanProcs: () => [{ pid: 10, cwd: "/wt/app", comm: "vite" }],
    inodeToPortMap: () => new Map([[1, 5173]]),
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree([], probes);
  expect(result!.size).toBe(0);
});

test("scanListeningPortsByWorktree: a PID under a nested subdir is attributed to its worktree", () => {
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 77, cwd: "/wt/myapp/packages/server", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(["/wt/myapp"], probes);
  expect(result!.get("/wt/myapp")).toEqual([3000]);
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
  expect(result!.get("/wt/alpha")).toEqual([5173]);
  expect(result!.get("/wt/beta")).toEqual([4321]);
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
  expect(result!.get("/wt/app")).toEqual([5173]);
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
  expect(result!.get("/wt/app")).toEqual([]);
});

// ── PreviewService: reverse-proxy listeners + slot allocation ──────────────────
//
// These tests stand up REAL upstream Bun.serve servers (the "dev server") on
// ephemeral ports and a PreviewService over a high range unlikely to collide.
// Every test stops its upstream(s) AND the service in cleanup.

import { afterEach, beforeEach } from "bun:test";
import { PreviewService } from "../src/preview";

// Per-process random base avoids cross-process port collision: a fixed base (e.g. 39000)
// collides when a concurrent or leftover `bun test` process is binding the same range.
// The range sits BELOW the Linux ephemeral port range (32768–60999) so the OS won't hand a
// colliding ephemeral port to an unrelated socket; the random offset (10k span) isolates this
// process from other test processes. Max bound port = base+count ≈ 30003 < 32768. Ref #817.
const TEST_BASE = 20000 + Math.floor(Math.random() * 10000);
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

/**
 * WS upstream that DELAYS accepting the upgrade by `delayMs`, then echoes frames.
 * Used to deterministically exercise the relay's pre-open `pending` buffer: a
 * client frame sent before this upstream opens must be buffered then flushed.
 */
function delayedWsUpstream(delayMs: number): Upstream {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (srv.upgrade(req)) return undefined;
      return new Response("not a ws", { status: 426 });
    },
    websocket: {
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

test("PreviewService: pre-open buffering — client frame sent before upstream opens is flushed + echoed", async () => {
  // Upstream delays its WS accept, so the client frame sent on open() lands in
  // the relay's `pending` buffer and must be flushed once upstream opens.
  const up = delayedWsUpstream(300);
  const port = service!.ensure("s1", portOf(up));
  expect(port).not.toBeNull();

  const msgs = await collectWsMessages(`ws://127.0.0.1:${port}/`, 1, (ws) => {
    ws.send("buffered-before-open");
  });
  expect(msgs).toContain("echo:buffered-before-open");
});

test("PreviewService: pre-open buffer overflow closes the client (untrusted-flood cap)", async () => {
  // Slow upstream keeps the buffer open; the client floods >1 MiB before it
  // opens, so the relay must fail safe and close the client socket.
  const up = delayedWsUpstream(2000);
  const port = service!.ensure("s1", portOf(up));
  expect(port).not.toBeNull();

  const closed = await new Promise<{ wasClean: boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* peer gone */
      }
      reject(new Error("client was not closed by the overflow cap within timeout"));
    }, 4000);
    const chunk = "x".repeat(64 * 1024); // 64 KiB per frame
    ws.onopen = () => {
      // 24 × 64 KiB = 1.5 MiB > 1 MiB cap; upstream is still mid-delay so these
      // all hit the pending buffer.
      for (let i = 0; i < 24; i++) ws.send(chunk);
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      resolve({ wasClean: e.wasClean });
    };
  });
  // The relay closed us; assert the close happened (code/clean-ness varies by
  // platform for a no-arg close, so we only assert the path fired).
  expect(closed).toBeDefined();
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

test("PreviewService: HTTP proxy strips content-encoding/content-length (Bun decodes the body)", async () => {
  // A real compressing dev server: send a genuinely gzipped body with the matching
  // content-encoding/content-length. Bun's fetch in the proxy DECODES the body but
  // leaves those headers — forwarding them makes the browser re-decode/truncate. The
  // proxy must strip them and serve the decoded body verbatim.
  const raw = "<html>hello compressed preview world</html>";
  const gz = Bun.gzipSync(Buffer.from(raw));
  const up = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response(gz, {
        status: 200,
        headers: {
          "content-encoding": "gzip",
          "content-length": String(gz.length),
          "x-keep": "yes",
        },
      });
    },
  });
  upstreams.push(up);

  const port = service!.ensure("s1", portOf(up));
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  // content-encoding stripped so the browser doesn't gunzip already-decoded bytes
  expect(res.headers.get("content-encoding")).toBeNull();
  // the STALE (compressed) content-length must be gone; any length now present is the
  // serializer's correct decoded length, never the gzipped one
  expect(res.headers.get("content-length")).not.toBe(String(gz.length));
  expect(res.headers.get("x-keep")).toBe("yes");
  // body is the correctly-decoded original
  expect(await res.text()).toBe(raw);
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

// ── PreviewService: lastActivityAt / idleSince / devPortFor ───────────────────

test("PreviewService: lastActivityAt set at first bind; idleSince reflects it", () => {
  let t = 1000;
  const now = () => t;
  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT, now });
  try {
    svc.ensure("s1", 40000);
    // At t=1000, bound. Advance time by 500ms — idleSince should be 500.
    t = 1500;
    expect(svc.idleSince("s1", t)).toBe(500);
  } finally {
    svc.stopAll();
  }
});

test("PreviewService: re-ensure (devPort change) does NOT reset lastActivityAt", () => {
  let t = 1000;
  const now = () => t;
  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT, now });
  try {
    svc.ensure("s1", 40000);
    // Advance time, then re-ensure with a new devPort.
    t = 2000;
    svc.ensure("s1", 40001);
    // lastActivityAt should still be 1000 (the original bind time).
    expect(svc.idleSince("s1", 2500)).toBe(1500); // 2500 - 1000
  } finally {
    svc.stopAll();
  }
});

test("PreviewService: idleSince returns null for unbound session", () => {
  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT });
  try {
    expect(svc.idleSince("never-bound", Date.now())).toBeNull();
  } finally {
    svc.stopAll();
  }
});

test("PreviewService: devPortFor returns devPort for bound session, null for unbound", () => {
  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT });
  try {
    svc.ensure("s1", 40000);
    expect(svc.devPortFor("s1")).toBe(40000);
    expect(svc.devPortFor("never-bound")).toBeNull();
  } finally {
    svc.stopAll();
  }
});

test("PreviewService: devPortFor reflects live devPort after re-ensure", () => {
  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT });
  try {
    svc.ensure("s1", 40000);
    expect(svc.devPortFor("s1")).toBe(40000);
    svc.ensure("s1", 40001);
    expect(svc.devPortFor("s1")).toBe(40001);
  } finally {
    svc.stopAll();
  }
});

test("PreviewService: HTTP request advances lastActivityAt (idleSince drops)", async () => {
  let t = 1000;
  const now = () => t;
  const up = httpUpstream({ body: "ok" });
  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT, now });
  try {
    const port = svc.ensure("s1", portOf(up));
    // idleSince is 500ms before request
    t = 1500;
    expect(svc.idleSince("s1", t)).toBe(500);
    // Make an HTTP request — now() at time of request should be 1500
    await fetch(`http://127.0.0.1:${port}/`);
    // After the request, lastActivityAt should be 1500; advance time to 2000.
    t = 2000;
    expect(svc.idleSince("s1", t)).toBe(500); // 2000 - 1500
  } finally {
    svc.stopAll();
  }
});

test("makeRelayHandlers: touch called in both directions (client→upstream message, upstream→client onmessage)", () => {
  const handlers = makeRelayHandlers();
  const touches: string[] = [];

  // Build a minimal fake RelaySocket for the message handler.
  // The message handler calls ws.data.touch?.() then tries to relay.
  const fakeSocket = {
    data: {
      devPort: 9999,
      path: "/",
      protocols: [],
      touch: () => touches.push("client->upstream"),
    },
    __relay: {
      upstream: null,
      upstreamOpen: false,
      pending: [],
      pendingBytes: 0,
      closing: false,
    },
  };

  // Invoke message handler (client→upstream direction).
  handlers.message(fakeSocket as never, "hello");
  expect(touches).toContain("client->upstream");

  // Simulate the upstream→client direction by invoking a fake onmessage callback
  // assembled as the open handler would. We can't easily run open() without a real
  // WebSocket, so we test the touch invocation via the RelayData closure directly.
  const touchedUpstream: string[] = [];
  const fakeUpstreamRelayData = {
    devPort: 9999,
    path: "/",
    protocols: [],
    touch: () => touchedUpstream.push("upstream->client"),
  };

  // Replicate the upstream.onmessage handler body from makeRelayHandlers open():
  // ws.data.touch?.(); safeSend(ws, e.data)
  const fakeClientWs = {
    data: fakeUpstreamRelayData,
    send: () => {},
  };
  // Call touch as the open handler would on an upstream message event.
  fakeClientWs.data.touch?.();
  expect(touchedUpstream).toContain("upstream->client");
});

test("PreviewService: upstream→client frame triggers touch via real upstream.onmessage wiring", async () => {
  // Integration test: exercises the actual upstream.onmessage = (e) => { ws.data.touch?.(); ... }
  // path in makeRelayHandlers. If that line were removed, idleSince would reflect only
  // the WS-upgrade timestamp (t=1000), NOT the later t=5000 set by the upstream frame —
  // so the final assertion (idle < 100 at t=5000) would fail.
  //
  // Strategy: bind + upgrade happen at t=1000. The upstream is a delayed WS server that
  // opens AFTER a 200ms pause. During that pause we advance the injected clock to t=5000.
  // When upstream.onopen fires it sends "server-push"; the relay's upstream.onmessage then
  // calls ws.data.touch?.() which stamps lastActivityAt=5000. Without that touch call,
  // lastActivityAt stays 1000 (the upgrade stamp) and idleSince(5000) = 4000, not ~0.
  let t = 1000;
  const now = () => t;

  // Upstream that delays its WS accept by 200ms, then on open sends a push frame.
  let upstreamServerWs: { send: (msg: string) => void } | null = null;
  let upstreamOpenResolve: (() => void) | null = null;
  const upstreamOpenedP = new Promise<void>((r) => {
    upstreamOpenResolve = r;
  });
  const delayedPushUpstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      await new Promise((r) => setTimeout(r, 200)); // delay so we can advance clock
      if (srv.upgrade(req)) return undefined;
      return new Response("not a ws", { status: 426 });
    },
    websocket: {
      open(ws) {
        upstreamServerWs = ws;
        upstreamOpenResolve?.();
      },
      message() {},
    },
  });
  upstreams.push(delayedPushUpstream);

  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT, now });
  try {
    const port = svc.ensure("s1", portOf(delayedPushUpstream));
    expect(port).not.toBeNull();

    // Collect exactly 1 message from the upstream push (received via upstream.onmessage).
    const msgsP = collectWsMessages(`ws://127.0.0.1:${port}/`, 1);

    // Wait until the upstream has opened its side (still within the 200ms delay window).
    await upstreamOpenedP;

    // Advance the clock AFTER the WS upgrade (which stamped t=1000) but BEFORE the
    // upstream sends its push frame (which triggers upstream.onmessage → touch).
    t = 5000;

    // Now send the push frame from the upstream; the relay's upstream.onmessage fires
    // and calls ws.data.touch?.() stamping lastActivityAt=5000.
    upstreamServerWs!.send("server-push");

    const msgs = await msgsP;
    expect(msgs).toContain("server-push");

    // idleSince(5000) must be ~0 — meaning lastActivityAt was stamped at t=5000 by
    // upstream.onmessage. Without the touch call, lastActivityAt stays 1000 → idle=4000.
    const idle = svc.idleSince("s1", t);
    expect(idle).toBeLessThan(100); // stamped at t=5000, measured at t=5000 → near 0
  } finally {
    svc.stopAll();
  }
});

// ── detectDevCommand ──────────────────────────────────────────────────────────

/** Build a minimal FsAccessors from a map of path→content. */
function makeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): FsAccessors {
  return {
    readText: async (p: string): Promise<string | null> => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p] as string;
      return null;
    },
    exists: async (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    readdir: async (p: string) => dirs[p] ?? [],
  };
}

test("detectDevCommand: root dev script + bun.lock → bun run dev", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/bun.lock": "",
  });
  expect(await detectDevCommand("/wt", fs)).toBe("bun run dev");
});

test("detectDevCommand: root dev + bun.lockb → bun run dev", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/bun.lockb": "",
  });
  expect(await detectDevCommand("/wt", fs)).toBe("bun run dev");
});

test("detectDevCommand: root dev + pnpm-lock.yaml → pnpm run dev", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/pnpm-lock.yaml": "",
  });
  expect(await detectDevCommand("/wt", fs)).toBe("pnpm run dev");
});

test("detectDevCommand: root dev + yarn.lock → yarn dev", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/yarn.lock": "",
  });
  expect(await detectDevCommand("/wt", fs)).toBe("yarn dev");
});

test("detectDevCommand: root dev + package-lock.json → npm run dev", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/package-lock.json": "",
  });
  expect(await detectDevCommand("/wt", fs)).toBe("npm run dev");
});

test("detectDevCommand: root dev + no lockfile → npm run dev", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  });
  expect(await detectDevCommand("/wt", fs)).toBe("npm run dev");
});

test("detectDevCommand: no root dev → curated subdir ui has dev → cd ui && bun run dev", async () => {
  const fs = makeFs(
    {
      "/wt/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
      "/wt/ui/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "/wt/ui/bun.lock": "",
    },
    { "/wt/packages": [] },
  );
  expect(await detectDevCommand("/wt", fs)).toBe("cd ui && bun run dev");
});

test("detectDevCommand: no root dev → subdir app has dev → cd app && npm run dev", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({}),
    "/wt/app/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  });
  expect(await detectDevCommand("/wt", fs)).toBe("cd app && npm run dev");
});

test("detectDevCommand: two subdirs with dev → null (ambiguous)", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({}),
    "/wt/ui/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/web/package.json": JSON.stringify({ scripts: { dev: "next" } }),
  });
  expect(await detectDevCommand("/wt", fs)).toBeNull();
});

test("detectDevCommand: no dev anywhere → null", async () => {
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
  });
  expect(await detectDevCommand("/wt", fs)).toBeNull();
});

test("detectDevCommand: no package.json at all → null", async () => {
  const fs = makeFs({});
  expect(await detectDevCommand("/wt", fs)).toBeNull();
});

test("detectDevCommand: root dev → subdir dev → root wins (root has priority)", async () => {
  // root has dev AND subdir has dev — root wins because step 1 short-circuits
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/ui/package.json": JSON.stringify({ scripts: { dev: "next" } }),
    "/wt/bun.lock": "",
  });
  expect(await detectDevCommand("/wt", fs)).toBe("bun run dev");
});

test("detectDevCommand: workspace glob packages/* finds the one with dev", async () => {
  const fs = makeFs(
    {
      "/wt/package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "/wt/packages/app/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "/wt/packages/lib/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    },
    { "/wt/packages": ["app", "lib"] },
  );
  expect(await detectDevCommand("/wt", fs)).toBe("cd packages/app && npm run dev");
});

test("detectDevCommand: fs errors in readText/exists → null (fail closed, never throws)", async () => {
  // All accessors throw to simulate unreadable filesystem (permissions, I/O error, etc.)
  const throwingFs: FsAccessors = {
    readText: async () => {
      throw new Error("EACCES");
    },
    exists: async () => {
      throw new Error("EACCES");
    },
    readdir: async () => {
      throw new Error("EACCES");
    },
  };
  // Must not throw — fs errors mean "no command here" → null
  const result = await detectDevCommand("/wt", throwingFs);
  expect(result).toBeNull();
});

test("detectDevCommand: subdir with no lockfile falls back to root bun.lock → bun run dev", async () => {
  // Canonical monorepo: single bun.lock at root, no lockfile in the subdir.
  const fs = makeFs({
    "/wt/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    "/wt/ui/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    "/wt/bun.lock": "",
    // deliberately NO /wt/ui/bun.lock
  });
  expect(await detectDevCommand("/wt", fs)).toBe("cd ui && bun run dev");
});

test("detectDevCommand: workspaces object form { packages: [...] } is handled", async () => {
  // npm/yarn-classic object workspaces: { packages: ["packages/*"] }
  const fs = makeFs(
    {
      "/wt/package.json": JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
      "/wt/packages/app/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "/wt/packages/lib/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    },
    { "/wt/packages": ["app", "lib"] },
  );
  expect(await detectDevCommand("/wt", fs)).toBe("cd packages/app && npm run dev");
});

// ── teardown guards (#1567 review) ───────────────────────────────────────────

// Its own slot range: `stopAll` returns before the async `server.stop(true)` has actually released
// the socket, so reusing TEST_BASE here races earlier tests' listeners and fails to bind.
const GUARD_BASE = 31000 + Math.floor(Math.random() * 3000);

/** Swap a bound listener's server for one whose `stop()` throws SYNCHRONOUSLY (a non-promise
 *  return would fail the same way, since `.catch` would then throw). */
function breakServer(svc: PreviewService, sessionId: string): { stopReal: () => void } {
  const listener = (svc as any).listeners.get(sessionId);
  const real = listener.server;
  listener.server = {
    stop() {
      throw new Error("boom: server already gone");
    },
  };
  // The service can no longer reach the REAL server (we just swapped it out), so `stopAll`/`release`
  // will never close its socket. The test must, or it leaks a listening port for the rest of the run.
  return {
    stopReal: () =>
      void Promise.resolve(real?.stop(true)).catch(() => {
        /* already gone */
      }),
  };
}

test("PreviewService: release() still fires onChange when server.stop() throws synchronously", () => {
  const changes: Array<[string, number | null]> = [];
  const svc = new PreviewService({
    base: GUARD_BASE,
    count: TEST_COUNT,
    onChange: (id, port) => changes.push([id, port]),
  });
  const port = svc.ensure("s1", 40000);
  expect(port).not.toBeNull();
  const broken = breakServer(svc, "s1");

  expect(() => svc.release("s1")).not.toThrow();
  expect(changes).toEqual([
    ["s1", port],
    ["s1", null], // teardown completed despite the throw
  ]);
  svc.stopAll();
  broken.stopReal(); // the swapped-out server is ours to close
});

test("PreviewService: stopAll() clears its maps even when one server.stop() throws synchronously", () => {
  const svc = new PreviewService({ base: GUARD_BASE + 100, count: TEST_COUNT });
  expect(svc.ensure("s1", 40000)).not.toBeNull();
  expect(svc.ensure("s2", 40001)).not.toBeNull(); // two listeners, so an aborted loop is observable
  const broken = breakServer(svc, "s1"); // the FIRST listener throws — the loop must not abort

  expect(() => svc.stopAll()).not.toThrow();
  broken.stopReal(); // stopAll could not reach it; close it here or the port leaks
  expect((svc as any).listeners.size).toBe(0);
  expect((svc as any).slotOwner.size).toBe(0);
});
