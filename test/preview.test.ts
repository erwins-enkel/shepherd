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
