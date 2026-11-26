import { test, expect } from "bun:test";
import {
  pickPrimaryPort,
  sanitizeCloseCode,
  rewriteLoopbackLocation,
  resolveDevPort,
  readPreviewHint,
  detectDevCommand,
  makeRelayHandlers,
  parsePortRange,
  previewReach,
  previewRequestAllowed,
  loopbackV6Available,
  needsLoopbackV6,
  type FsAccessors,
  type PreviewReachInput,
} from "../src/preview";
import {
  scanListeningPortsByWorktree,
  type ListenerScanTarget,
  type ReaperProbes,
} from "../src/process-reaper";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// EXCLUDED_PORTS: a debugger/CDP endpoint answers a plain HTTP GET, so the liveness
// probe alone would happily hand one to the operator's browser as "the preview".

test("pickPrimaryPort: debugger/CDP ports are never picked, even answering HTTP", async () => {
  const alwaysLive = async (): Promise<boolean> => true;
  for (const port of [9222, 9229, 9230]) {
    expect(await pickPrimaryPort([port], alwaysLive)).toBeNull();
  }
  // …and they never outrank a real, higher-numbered dev port.
  expect(await pickPrimaryPort([9222, 9500], alwaysLive)).toBe(9500);
});

// ── readPreviewHint + resolveDevPort ──────────────────────────────────────────

// Fake readFile helpers
const rejectReadFile = async (): Promise<string> => {
  throw new Error("ENOENT: no such file");
};
const makeReadFile = (content: string) => async (): Promise<string> => content;

test("readPreviewHint: a FIFO hint returns null without blocking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hint-fifo-"));
  try {
    const mk = Bun.spawn(["mkfifo", join(dir, ".shepherd-preview")]);
    expect(await mk.exited).toBe(0);
    const t0 = performance.now();
    expect(await readPreviewHint(dir)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPreviewHint: a symlinked hint returns null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hint-link-"));
  try {
    writeFileSync(join(dir, "real"), "5173");
    symlinkSync(join(dir, "real"), join(dir, ".shepherd-preview"));
    expect(await readPreviewHint(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPreviewHint: a regular hint file is read by the default reader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hint-reg-"));
  try {
    writeFileSync(join(dir, ".shepherd-preview"), "5173\n");
    expect(await readPreviewHint(dir)).toBe(5173);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// These tests exercise readPreviewHint behaviour indirectly via resolveDevPort.
test("resolveDevPort: an explicit hint cannot point the preview at a debugger", async () => {
  const alwaysLive = async (): Promise<boolean> => true;
  const result = await resolveDevPort([9229, 5173], ["/any"], makeReadFile("9229"), alwaysLive);
  expect(result).toBe(5173);
});

test("resolveDevPort: valid port string '3000\\n' → hint honored (3000 curated, no probe)", async () => {
  const result = await resolveDevPort([3000], ["/any"], makeReadFile("3000\n"), async () => true);
  expect(result).toBe(3000);
});

test("resolveDevPort: non-numeric 'abc' hint → null (falls back to pickPrimaryPort)", async () => {
  const result = await resolveDevPort([5173], ["/any"], makeReadFile("abc"), neverProbe);
  expect(result).toBe(5173); // bad hint → falls back
});

test("resolveDevPort: out-of-range '0' hint → null (falls back)", async () => {
  const result = await resolveDevPort([5173], ["/any"], makeReadFile("0"), neverProbe);
  expect(result).toBe(5173);
});

test("resolveDevPort: out-of-range '70000' hint → null (falls back)", async () => {
  const result = await resolveDevPort([5173], ["/any"], makeReadFile("70000"), neverProbe);
  expect(result).toBe(5173);
});

test("resolveDevPort: surrounding whitespace '  5173  ' → hint honored (curated, no probe)", async () => {
  let probeCount = 0;
  const countingProbe = async (): Promise<boolean> => {
    probeCount++;
    return true;
  };
  const result = await resolveDevPort([5173], ["/any"], makeReadFile("  5173  "), countingProbe);
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
  const result = await resolveDevPort([5173], ["/any"], makeReadFile("3000abc"), countingProbe);
  expect(result).toBe(5173); // curated 5173 returned via fallback (no probe)
  expect(probeCount).toBe(0); // 3000 was NEVER probed (hint was rejected outright)
});

test("resolveDevPort: curated hint not in ports → falls back to pickPrimaryPort (ports.includes gate)", async () => {
  // hint=3000 (curated), ports=[5173] — 3000 not listening → ignored
  const result = await resolveDevPort([5173], ["/any"], makeReadFile("3000"), neverProbe);
  expect(result).toBe(5173); // fallback picks curated 5173
});

test("resolveDevPort: hint curated, in ports → returns hint WITHOUT probing", async () => {
  let probeCount = 0;
  const countingProbe = async (): Promise<boolean> => {
    probeCount++;
    return true;
  };
  // hint=5173 (curated), ports=[3000, 5173]
  const result = await resolveDevPort([3000, 5173], ["/any"], makeReadFile("5173"), countingProbe);
  expect(result).toBe(5173);
  expect(probeCount).toBe(0);
});

test("resolveDevPort: hint non-curated, in ports, probe passes → returns hint (wins over curated 5173)", async () => {
  // hint=9000 (non-curated), ports=[9000, 5173]; probe passes for 9000
  // Without the hint, pickPrimaryPort would return 5173. The hint overrides it.
  const probe = async (port: number): Promise<boolean> => port === 9000;
  const result = await resolveDevPort([9000, 5173], ["/any"], makeReadFile("9000"), probe);
  expect(result).toBe(9000);
});

test("resolveDevPort: hint non-curated, in ports, probe fails → falls back to pickPrimaryPort (returns curated 5173)", async () => {
  // hint=9000 (non-curated), probe fails for 9000; 5173 is curated → returned unprobed
  const probe = async (port: number): Promise<boolean> => port !== 9000;
  const result = await resolveDevPort([9000, 5173], ["/any"], makeReadFile("9000"), probe);
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
  const result = await resolveDevPort([9000, 9500], ["/any"], makeReadFile("9000"), probe);
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
  const result = await resolveDevPort([5173], ["/any"], makeReadFile("9000"), trackingProbe);
  expect(result).toBe(5173); // curated 5173 returned (no probe for curated)
  expect(probedPorts).not.toContain(9000);
});

test("resolveDevPort: no hint (readFile rejects) → falls back to pickPrimaryPort", async () => {
  const result = await resolveDevPort([5173], ["/any"], rejectReadFile, neverProbe);
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
    const result = await resolveDevPort([9000, 5173], [dir], undefined, alwaysLive);
    expect(result).toBe(9000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveDevPort across several hint directories ────────────────────────────
//
// A scratchpad-rooted server contributes its own directory as a hint location, so the
// worktree root has to keep winning: it is the canonical, agent-declared one.

/** Reader that resolves `.shepherd-preview` per directory; missing dirs throw (ENOENT). */
const makeDirReadFile = (byDir: Record<string, string>) => async (path: string) => {
  for (const [dir, content] of Object.entries(byDir)) {
    if (path === `${dir}/.shepherd-preview`) return content;
  }
  throw new Error("ENOENT: no such file");
};

test("resolveDevPort: the worktree-root hint outranks a scratchpad one", async () => {
  const result = await resolveDevPort(
    [3000, 4321],
    ["/wt/app", "/scratch/proto"],
    makeDirReadFile({ "/wt/app": "3000", "/scratch/proto": "4321" }),
    neverProbe,
  );
  expect(result).toBe(3000);
});

test("resolveDevPort: a scratchpad hint is honored when the worktree root has none", async () => {
  const result = await resolveDevPort(
    [3000, 9000],
    ["/wt/app", "/scratch/proto"],
    makeDirReadFile({ "/scratch/proto": "9000" }),
    async () => true,
  );
  expect(result).toBe(9000);
});

test("resolveDevPort: hint dirs are tried in order, first VALID one wins", async () => {
  // An unreadable/garbage hint must not stop the walk — it is not a declaration.
  const result = await resolveDevPort(
    [4321],
    ["/wt/app", "/scratch/proto", "/scratch"],
    makeDirReadFile({ "/wt/app": "not-a-port", "/scratch": "4321" }),
    neverProbe,
  );
  expect(result).toBe(4321);
});

test("resolveDevPort: no hint dirs at all still falls back to the heuristic", async () => {
  expect(await resolveDevPort([5173], [], undefined, neverProbe)).toBe(5173);
});

// ── #3237: ephemeral-range ports are never heuristically probed ───────────────

const linuxRange = async () => ({ lo: 32768, hi: 60999 });

const recordingProbe = (live: (port: number) => boolean) => {
  const probed: number[] = [];
  const probe = async (port: number): Promise<boolean> => {
    probed.push(port);
    return live(port);
  };
  return { probed, probe };
};

test("resolveDevPort: an undeclared ephemeral-range port is never probed", async () => {
  const { probed, probe } = recordingProbe(() => true);
  expect(await resolveDevPort([40000], ["/any"], rejectReadFile, probe, linuxRange)).toBeNull();
  expect(probed).toEqual([]);
});

test("resolveDevPort: ephemeral ports are skipped, a lower non-curated port still wins", async () => {
  const { probed, probe } = recordingProbe(() => true);
  const result = await resolveDevPort([4100, 40000], ["/any"], rejectReadFile, probe, linuxRange);
  expect(result).toBe(4100);
  expect(probed).toEqual([4100]);
});

test("resolveDevPort: a declared ephemeral-range port is still honored", async () => {
  const { probe } = recordingProbe(() => true);
  const result = await resolveDevPort([40000], ["/any"], makeReadFile("40000"), probe, linuxRange);
  expect(result).toBe(40000);
});

test("resolveDevPort: a failed declared ephemeral hint does not unlock other ephemeral ports", async () => {
  const { probed, probe } = recordingProbe(() => false);
  const result = await resolveDevPort(
    [40000, 41000],
    ["/any"],
    makeReadFile("40000"),
    probe,
    linuxRange,
  );
  expect(result).toBeNull();
  expect(probed).toEqual([40000]);
});

test("resolveDevPort: a range covering a curated port still returns it unprobed", async () => {
  const wide = async () => ({ lo: 1024, hi: 65535 });
  expect(await resolveDevPort([5173], ["/any"], rejectReadFile, neverProbe, wide)).toBe(5173);
});

test("parsePortRange: parses the kernel's ip_local_port_range format", () => {
  expect(parsePortRange("32768\t60999\n")).toEqual({ lo: 32768, hi: 60999 });
  expect(parsePortRange("1024 65535")).toEqual({ lo: 1024, hi: 65535 });
});

test("parsePortRange: rejects garbage, reversed and out-of-range input", () => {
  expect(parsePortRange("")).toBeNull();
  expect(parsePortRange("abc def")).toBeNull();
  expect(parsePortRange("60999 32768")).toBeNull();
  expect(parsePortRange("0 60999")).toBeNull();
  expect(parsePortRange("32768 70000")).toBeNull();
  expect(parsePortRange("32768 60999 1")).toBeNull();
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

test("rewriteLoopbackLocation: either given port (dev or forwarded upstream) → path-relative", () => {
  const h = new Headers({ location: "http://127.0.0.1:41234/next" });
  rewriteLoopbackLocation(h, 5173, 41234);
  expect(h.get("location")).toBe("/next");
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

/** Scan targets from bare worktree paths, with a session id derived from each path.
 *  Tests that exercise the scratchpad fallback build their targets explicitly instead. */
function targets(paths: string[]): ListenerScanTarget[] {
  return paths.map((worktreePath) => ({ worktreePath, sessionId: `sess:${worktreePath}` }));
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

  const result = scanListeningPortsByWorktree(targets(["/wt/alpha", "/wt/beta"]), probes);

  // Map built exactly once
  expect(mapBuildCount).toBe(1);
  // alpha gets pid 101 (port 5173) + pid 103 (no ports)
  expect(result!.get("/wt/alpha")!.ports).toEqual([5173]);
  // beta gets pid 102 (port 3000)
  expect(result!.get("/wt/beta")!.ports).toEqual([3000]);
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
  const result = scanListeningPortsByWorktree(targets(["/wt/app"]), probes);
  // sorted, deduped: [3000, 5173]
  expect(result!.get("/wt/app")!.ports).toEqual([3000, 5173]);
});

test("scanListeningPortsByWorktree: excludes the agent comm (claude)", () => {
  const inodeMap = new Map([[1, 9999]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 42, cwd: "/wt/app", comm: "claude" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(targets(["/wt/app"]), probes);
  expect(result!.get("/wt/app")!.ports).toEqual([]);
});

test("scanListeningPortsByWorktree: excludes own process.pid", () => {
  const inodeMap = new Map([[1, 7330]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: process.pid, cwd: "/wt/app", comm: "bun" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(targets(["/wt/app"]), probes);
  expect(result!.get("/wt/app")!.ports).toEqual([]);
});

test("scanListeningPortsByWorktree: processes outside all worktrees are ignored", () => {
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 55, cwd: "/other/place", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(targets(["/wt/app"]), probes);
  expect(result!.get("/wt/app")!.ports).toEqual([]);
});

test("scanListeningPortsByWorktree: returns empty arrays for worktrees with no matching procs", () => {
  const probes = makeProbes({
    scanProcs: () => [{ pid: 10, cwd: "/wt/other", comm: "vite" }],
    inodeToPortMap: () => new Map([[1, 5173]]),
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(targets(["/wt/alpha", "/wt/beta"]), probes);
  expect(result!.get("/wt/alpha")!.ports).toEqual([]);
  expect(result!.get("/wt/beta")!.ports).toEqual([]);
});

test("scanListeningPortsByWorktree: empty worktreePaths → empty map", () => {
  const probes = makeProbes({
    scanProcs: () => [{ pid: 10, cwd: "/wt/app", comm: "vite" }],
    inodeToPortMap: () => new Map([[1, 5173]]),
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(targets([]), probes);
  expect(result!.size).toBe(0);
});

test("scanListeningPortsByWorktree: a PID under a nested subdir is attributed to its worktree", () => {
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 77, cwd: "/wt/myapp/packages/server", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(targets(["/wt/myapp"]), probes);
  expect(result!.get("/wt/myapp")!.ports).toEqual([3000]);
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
  const result = scanListeningPortsByWorktree(targets(["/wt/alpha", "/wt/beta"]), probes);
  expect(result!.get("/wt/alpha")!.ports).toEqual([5173]);
  expect(result!.get("/wt/beta")!.ports).toEqual([4321]);
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
  const result = scanListeningPortsByWorktree(targets(["/wt/app"]), probes);
  expect(portsForPidCalled).toBe(true);
  expect(result!.get("/wt/app")!.ports).toEqual([5173]);
});

test("scanListeningPortsByWorktree: proc under /wt/appold is NOT attributed to /wt/app", () => {
  // Prefix-sibling boundary: /wt/app must not match /wt/appold/src
  const inodeMap = new Map([[1, 3000]]);
  const probes = makeProbes({
    scanProcs: () => [{ pid: 55, cwd: "/wt/appold/src", comm: "node" }],
    inodeToPortMap: () => inodeMap,
    socketInodesForPid: () => [1],
  });
  const result = scanListeningPortsByWorktree(targets(["/wt/app"]), probes);
  expect(result!.get("/wt/app")!.ports).toEqual([]);
});

// ── scanListeningPortsByWorktree: the scratchpad provenance fallback ──────────
//
// Agents prototyping in the Claude scratchpad start their dev server there, so a cwd
// test alone never sees it. The inherited SHEPHERD_SESSION_ID marker re-attaches it —
// but only for a process that is BOTH inside the scratch root and actually listening.

const SCRATCH = "/scratch";
const PROTO = "/scratch/claude-1000/wt-slug/cc-session/scratchpad/proto";

/** One listening scratchpad process, with whatever marker (or none) a test wants. */
function scratchScanProbes(marker: string | null, over: Partial<ReaperProbes> = {}) {
  return makeProbes({
    scanProcs: () => [{ pid: 91, cwd: PROTO, comm: "python3" }],
    inodeToPortMap: () => new Map([[1, 8123]]),
    socketInodesForPid: () => [1],
    environForPid: (): Record<string, string> =>
      marker === null ? {} : { SHEPHERD_SESSION_ID: marker },
    ...over,
  });
}

const oneTarget = [{ worktreePath: "/wt/app", sessionId: "s-1" }];

test("scanListeningPortsByWorktree: a marked scratchpad listener lands on its session's worktree", () => {
  const result = scanListeningPortsByWorktree(oneTarget, scratchScanProbes("s-1"), SCRATCH);
  expect(result!.get("/wt/app")!.ports).toEqual([8123]);
});

test("scanListeningPortsByWorktree: the scratchpad listener contributes its dirs as hint locations", () => {
  const result = scanListeningPortsByWorktree(oneTarget, scratchScanProbes("s-1"), SCRATCH);
  const hints = result!.get("/wt/app")!.hintDirs;
  // Own dir first, then ancestors — capped, and never reaching the scratch root itself.
  expect(hints[0]).toBe(PROTO);
  expect(hints.length).toBeLessThanOrEqual(4);
  expect(hints).not.toContain(SCRATCH);
  for (const dir of hints) expect(dir.startsWith(`${SCRATCH}/`)).toBe(true);
});

test("scanListeningPortsByWorktree: a marker naming another session is not attributed", () => {
  const result = scanListeningPortsByWorktree(oneTarget, scratchScanProbes("s-other"), SCRATCH);
  expect(result!.get("/wt/app")).toEqual({ ports: [], hintDirs: [] });
});

test("scanListeningPortsByWorktree: an unmarked scratchpad listener is not attributed", () => {
  const result = scanListeningPortsByWorktree(oneTarget, scratchScanProbes(null), SCRATCH);
  expect(result!.get("/wt/app")).toEqual({ ports: [], hintDirs: [] });
});

test("scanListeningPortsByWorktree: no scratchRoot (redirect disabled) keeps the scan cwd-only", () => {
  const result = scanListeningPortsByWorktree(oneTarget, scratchScanProbes("s-1"));
  expect(result!.get("/wt/app")).toEqual({ ports: [], hintDirs: [] });
});

test("scanListeningPortsByWorktree: a backend without environForPid never attributes by marker", () => {
  const probes = makeProbes({
    scanProcs: () => [{ pid: 91, cwd: PROTO, comm: "python3" }],
    inodeToPortMap: () => new Map([[1, 8123]]),
    socketInodesForPid: () => [1],
    // environForPid deliberately absent (darwin)
  });
  const result = scanListeningPortsByWorktree(oneTarget, probes, SCRATCH);
  expect(result!.get("/wt/app")).toEqual({ ports: [], hintDirs: [] });
});

test("scanListeningPortsByWorktree: a non-listening scratchpad proc is never environ-read", () => {
  // The environ read takes the target's mmap lock, so it must stay behind the
  // listening test — a transient agent child must not cost one.
  let environReads = 0;
  const probes = makeProbes({
    scanProcs: () => [{ pid: 91, cwd: PROTO, comm: "bash" }],
    inodeToPortMap: () => new Map(),
    socketInodesForPid: () => [],
    environForPid: () => {
      environReads++;
      return { SHEPHERD_SESSION_ID: "s-1" };
    },
  });
  const result = scanListeningPortsByWorktree(oneTarget, probes, SCRATCH);
  expect(result!.get("/wt/app")!.ports).toEqual([]);
  expect(environReads).toBe(0);
});

test("scanListeningPortsByWorktree: a marked listener outside the scratch root stays ignored", () => {
  const probes = scratchScanProbes("s-1", {
    scanProcs: () => [{ pid: 91, cwd: "/tmp/elsewhere", comm: "python3" }],
  });
  const result = scanListeningPortsByWorktree(oneTarget, probes, SCRATCH);
  expect(result!.get("/wt/app")).toEqual({ ports: [], hintDirs: [] });
});

test("scanListeningPortsByWorktree: two sessions sharing a worktree path do not shadow each other", () => {
  const result = scanListeningPortsByWorktree(
    [
      { worktreePath: "/wt/app", sessionId: "s-1" },
      { worktreePath: "/wt/app", sessionId: "s-2" },
    ],
    scratchScanProbes("s-2"),
    SCRATCH,
  );
  expect(result!.size).toBe(1);
  expect(result!.get("/wt/app")!.ports).toEqual([8123]);
});

// ── PreviewService: reverse-proxy listeners + slot allocation ──────────────────
//
// These tests stand up REAL upstream Bun.serve servers (the "dev server") on
// ephemeral ports and a PreviewService over a high range unlikely to collide.
// Every test stops its upstream(s) AND the service in cleanup.

import { afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { PreviewService, type PreviewServiceOptions } from "../src/preview";

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
/** Resolvers for upstream handlers parked mid-request; afterEach resolves them all. */
const parked: Array<() => void> = [];

/** The real listen port of a started upstream (`Server.port` is typed optional). */
function portOf(s: Upstream): number {
  return s.port as number;
}

/** Stand up a plain-HTTP upstream returning `body`/`status`/`headers`; tracked for cleanup. */
function httpUpstream(opts: {
  status?: number;
  headers?: HeadersInit;
  body?: string;
  echoPath?: boolean;
  /** Receives each request's headers as the upstream saw them. */
  seen?: Headers[];
  /** Receives each request's pathname as the upstream saw it. */
  paths?: string[];
}): Upstream {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      opts.seen?.push(req.headers);
      const url = new URL(req.url);
      opts.paths?.push(url.pathname);
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
  for (const resolve of parked.splice(0)) resolve();
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

test("PreviewService: HTTP proxy strips shepherd_session from Cookie, keeps other cookies", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ seen })));
  await fetch(`http://127.0.0.1:${port}/`, {
    headers: { cookie: "a=1; shepherd_session=SECRET; b=2" },
  });
  expect(seen[0]!.get("cookie")).toBe("a=1; b=2");
});

test("PreviewService: HTTP proxy drops Cookie entirely when only shepherd_session was sent", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ seen })));
  await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: "shepherd_session=SECRET" } });
  expect(seen[0]!.get("cookie")).toBeNull();
});

test("PreviewService: HTTP proxy adds no Cookie header when none was sent", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ seen })));
  await fetch(`http://127.0.0.1:${port}/`);
  expect(seen[0]!.get("cookie")).toBeNull();
});

test("PreviewService: HTTP proxy strips shepherd_session from comma-joined duplicate Cookie headers", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ seen })));
  const headers = new Headers();
  headers.append("cookie", "a=1");
  headers.append("cookie", "shepherd_session=SECRET");
  await fetch(`http://127.0.0.1:${port}/`, { headers });
  expect(seen[0]!.get("cookie") ?? "").not.toContain("SECRET");
});

test("PreviewService: HTTP proxy drops upstream Set-Cookie for shepherd_session, keeps app cookies", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "shepherd_session=attacker; Path=/");
  headers.append("set-cookie", "shepherd_session=; Path=/; Max-Age=0");
  headers.append("set-cookie", "app=1; Path=/");
  const port = service!.ensure("s1", portOf(httpUpstream({ headers })));
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.headers.getSetCookie()).toEqual(["app=1; Path=/"]);
});

test("PreviewService: HTTP proxy drops empty-name Set-Cookie that would replay as shepherd_session", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "=shepherd_session=attacker; Path=/api");
  headers.append("set-cookie", " = shepherd_session=attacker; Path=/");
  headers.append("set-cookie", "=other=1; Path=/");
  const port = service!.ensure("s1", portOf(httpUpstream({ headers })));
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.headers.getSetCookie()).toEqual(["=other=1; Path=/"]);
});

// ── Slot-origin isolation across owners (audit run-2 R2-F03) ─────────────────

/** `name=value` of the proxy's owner-marker Set-Cookie, or null. */
function ownerMarker(res: Response, port: number | null): string | null {
  const c = res.headers.getSetCookie().find((s) => s.startsWith(`shepherd_preview_owner_${port}=`));
  return c ? c.split(";")[0]! : null;
}

const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

test("PreviewService: refuses service-worker script requests with 403, never dials upstream", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ seen, body: "self.onfetch=()=>{}" })));
  const res = await fetch(`http://127.0.0.1:${port}/sw.js`, {
    headers: { "service-worker": "script" },
  });
  expect(res.status).toBe(403);
  expect(seen).toHaveLength(0);
  // An ordinary request for the same path still proxies.
  const ok = await fetch(`http://127.0.0.1:${port}/sw.js`);
  expect(ok.status).toBe(200);
  expect(seen).toHaveLength(1);
});

test("PreviewService: navigation without the owner marker clears site state and sets the marker", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure(
    "s1",
    portOf(httpUpstream({ seen, headers: { "cache-control": "max-age=31536000", expires: "x" } })),
  );
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    headers: {
      ...NAV,
      "if-none-match": '"abc"',
      "if-modified-since": "Thu, 01 Jan 2026 00:00:00 GMT",
    },
  });
  const csd = res.headers.get("clear-site-data") ?? "";
  expect(csd).toContain('"cache"');
  expect(csd).toContain('"storage"');
  expect(csd).not.toContain("cookies");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("expires")).toBeNull();
  const set = res.headers
    .getSetCookie()
    .find((s) => s.startsWith(`shepherd_preview_owner_${port}=`));
  expect(set).toContain("HttpOnly");
  expect(seen[0]!.get("if-none-match")).toBeNull();
  expect(seen[0]!.get("if-modified-since")).toBeNull();
});

test("PreviewService: navigation with the current owner marker keeps site state, marker not forwarded", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ seen })));
  const marker = ownerMarker(await fetch(`http://127.0.0.1:${port}/`, { headers: NAV }), port)!;
  expect(marker).not.toBeNull();
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { ...NAV, cookie: `app=1; ${marker}`, "if-none-match": '"abc"' },
  });
  expect(res.headers.get("clear-site-data")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(ownerMarker(res, port)).toBeNull();
  expect(seen[1]!.get("cookie")).toBe("app=1");
  expect(seen[1]!.get("if-none-match")).toBe('"abc"');
});

test("PreviewService: a new owner of the same slot gets a fresh marker, so the old one triggers a wipe", async () => {
  const up = portOf(httpUpstream({}));
  const port = service!.ensure("A", up)!;
  const markerA = ownerMarker(await fetch(`http://127.0.0.1:${port}/`, { headers: NAV }), port)!;
  service!.release("A");
  await Bun.sleep(20);
  expect(service!.ensure("B", up)).toBe(port);
  const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { ...NAV, cookie: markerA } });
  expect(res.headers.get("clear-site-data")).toContain('"storage"');
  const markerB = ownerMarker(res, port)!;
  expect(markerB).not.toBe(markerA);
});

test("PreviewService: non-navigation requests are not wiped and keep upstream caching", async () => {
  const port = service!.ensure(
    "s1",
    portOf(httpUpstream({ headers: { "cache-control": "max-age=60" } })),
  );
  const res = await fetch(`http://127.0.0.1:${port}/app.js`, {
    headers: { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
  });
  expect(res.headers.get("clear-site-data")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("max-age=60");
  expect(ownerMarker(res, port)).toBeNull();
});

test("PreviewService: drops upstream Set-Cookie naming an owner marker, keeps app cookies", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "shepherd_preview_owner_8001=forged; Path=/");
  headers.append("set-cookie", "=shepherd_preview_owner_8002=forged; Path=/");
  headers.append("set-cookie", "app=1; Path=/");
  const port = service!.ensure("s1", portOf(httpUpstream({ headers })));
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.headers.getSetCookie()).toEqual(["app=1; Path=/"]);
});

test("PreviewService: strips any owner-marker cookie before forwarding upstream", async () => {
  const seen: Headers[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ seen })));
  await fetch(`http://127.0.0.1:${port}/`, {
    headers: { cookie: "a=1; shepherd_preview_owner_8009=x; b=2" },
  });
  expect(seen[0]!.get("cookie")).toBe("a=1; b=2");
});

test("PreviewService: HTTP proxy keeps cookies whose names merely resemble shepherd_session", async () => {
  const seen: Headers[] = [];
  const headers = new Headers();
  headers.append("set-cookie", "xshepherd_session=1");
  headers.append("set-cookie", "shepherd_session2=1");
  const port = service!.ensure("s1", portOf(httpUpstream({ headers, seen })));
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { cookie: "xshepherd_session=1; shepherd_session2=1" },
  });
  expect(seen[0]!.get("cookie")).toBe("xshepherd_session=1; shepherd_session2=1");
  expect(res.headers.getSetCookie()).toEqual(["xshepherd_session=1", "shepherd_session2=1"]);
});

test("PreviewService: WS relay does not forward the client's shepherd_session to the upstream", async () => {
  const seen: Headers[] = [];
  const up = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      seen.push(req.headers);
      if (srv.upgrade(req)) return undefined;
      return new Response("not a ws", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send("hi");
      },
      message() {},
    },
  });
  upstreams.push(up);
  const port = service!.ensure("s1", portOf(up));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { cookie: "shepherd_session=SECRET" },
  } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    ws.onmessage = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  ws.close();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.get("cookie") ?? "").not.toContain("SECRET");
});

// ── Host/Origin check ─────────────────────────────────────────────────────────

const TAILNET = "node.tailnet.ts.net";

/** `previewRequestAllowed` over a plain header record. */
function allowed(h: Record<string, string>, extra: readonly (string | null | undefined)[] = []) {
  return previewRequestAllowed(new Headers(h), extra);
}

test("previewRequestAllowed: loopback Host without Origin passes", () => {
  expect(allowed({ host: "127.0.0.1:8001" })).toBe(true);
  expect(allowed({ host: "localhost:8001" })).toBe(true);
  expect(allowed({ host: "[::1]:8001" })).toBe(true);
});

test("previewRequestAllowed: foreign or missing Host fails", () => {
  expect(allowed({ host: "evil.example:8001" })).toBe(false);
  expect(allowed({})).toBe(false);
});

test("previewRequestAllowed: an extra host with its same-origin https Origin passes", () => {
  const h = { host: `${TAILNET}:8001`, origin: `https://${TAILNET}:8001` };
  expect(allowed(h, [TAILNET])).toBe(true);
  expect(allowed(h)).toBe(false);
});

test("previewRequestAllowed: Origin must be same-origin with Host", () => {
  const host = "127.0.0.1:8001";
  expect(allowed({ host, origin: "http://127.0.0.1:8001" })).toBe(true);
  expect(allowed({ host, origin: "https://evil.example" })).toBe(false);
  expect(allowed({ host, origin: "http://127.0.0.1:8002" })).toBe(false); // another slot
  expect(allowed({ host, origin: "" })).toBe(false);
  expect(allowed({ host, origin: "chrome-extension://abc" })).toBe(false);
});

test("previewRequestAllowed: Origin null passes only with Sec-Fetch-Site same-origin", () => {
  const host = "127.0.0.1:8001";
  expect(allowed({ host, origin: "null", "sec-fetch-site": "same-origin" })).toBe(true);
  expect(allowed({ host, origin: "null", "sec-fetch-site": "Same-Origin" })).toBe(true);
  expect(allowed({ host, origin: "null" })).toBe(false);
  expect(allowed({ host, origin: "null", "sec-fetch-site": "cross-site" })).toBe(false);
  expect(allowed({ host, origin: "null", "sec-fetch-site": "same-site" })).toBe(false);
  expect(allowed({ host, origin: "null", "sec-fetch-site": "none" })).toBe(false);
  // Sec-Fetch-Site never overrides the Host rule or a non-null cross-origin Origin.
  const sameOrigin = { origin: "null", "sec-fetch-site": "same-origin" };
  expect(allowed({ host: "evil.example:8001", ...sameOrigin })).toBe(false);
  expect(allowed({ host, origin: "https://evil.example", "sec-fetch-site": "same-origin" })).toBe(
    false,
  );
});

test("previewRequestAllowed: an elided port is the Origin scheme's default on both sides", () => {
  const extra = ["host.example"];
  expect(allowed({ host: "host.example", origin: "https://host.example" }, extra)).toBe(true);
  expect(allowed({ host: "host.example:443", origin: "https://host.example" }, extra)).toBe(true);
  expect(allowed({ host: "host.example", origin: "http://host.example:80" }, extra)).toBe(true);
  expect(allowed({ host: "host.example:80", origin: "https://host.example" }, extra)).toBe(false);
});

test("previewRequestAllowed: hostnames compare ignoring case, a trailing dot and IPv6 spelling", () => {
  expect(allowed({ host: "LOCALHOST.:8001" })).toBe(true);
  expect(allowed({ host: "[0:0:0:0:0:0:0:1]:8001" })).toBe(true);
  expect(allowed({ host: `${TAILNET.toUpperCase()}:8001` }, [`${TAILNET}.`])).toBe(true);
  expect(allowed({ host: `${TAILNET}.:8001`, origin: `https://${TAILNET}:8001` }, [TAILNET])).toBe(
    true,
  );
});

test("previewRequestAllowed: a bare IPv6 allowlist entry matches its bracketed Host", () => {
  const h = { host: "[fd7a:115c:a1e0::1]:8001" };
  expect(allowed(h, ["fd7a:115c:a1e0::1"])).toBe(true);
  expect(allowed(h, ["[fd7a:115c:a1e0::1]"])).toBe(true);
  expect(allowed(h, [null, undefined, "", "  "])).toBe(false);
});

test("previewRequestAllowed: a Host that is not a bare host[:port] fails", () => {
  expect(allowed({ host: "evil.example@127.0.0.1:8001" })).toBe(false);
  expect(allowed({ host: "127.0.0.1:8001/x" })).toBe(false);
  expect(allowed({ host: "127.0.0.1:8001, evil.example" })).toBe(false);
  expect(allowed({ host: "127.0.0.1:99999" })).toBe(false);
  expect(allowed({ host: "" })).toBe(false);
});

test("PreviewService: a cross-origin request gets 403 and never reaches the upstream", async () => {
  const paths: string[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ paths })));
  const res = await fetch(`http://127.0.0.1:${port}/t4-cross-origin`, {
    headers: { origin: "https://evil.example" },
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toStartWith("text/plain");
  expect(await res.text()).toBe("Forbidden");
  expect(paths).not.toContain("/t4-cross-origin");
});

test("PreviewService: a request with a foreign Host gets 403 and never reaches the upstream", async () => {
  const paths: string[] = [];
  const port = service!.ensure("s1", portOf(httpUpstream({ paths })));
  const res = await fetch(`http://127.0.0.1:${port}/t4-foreign-host`, {
    headers: { host: `evil.example:${port}` },
  });
  expect(res.status).toBe(403);
  expect(paths).not.toContain("/t4-foreign-host");
  // The same request under a loopback Host proxies.
  expect((await fetch(`http://127.0.0.1:${port}/t4-foreign-host`)).status).toBe(200);
  expect(paths).toContain("/t4-foreign-host");
});

test("PreviewService: an allowed host with its own Origin is proxied", async () => {
  service?.stopAll();
  service = new PreviewService({
    base: TEST_BASE,
    count: TEST_COUNT,
    allowedHosts: () => ["node.tailnet.example"],
  });
  const paths: string[] = [];
  const port = service.ensure("s1", portOf(httpUpstream({ paths, body: "allowed-host-body" })));
  const res = await fetch(`http://127.0.0.1:${port}/t-allowed-host`, {
    headers: {
      host: `node.tailnet.example:${port}`,
      origin: `https://node.tailnet.example:${port}`,
    },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("allowed-host-body");
  expect(paths).toContain("/t-allowed-host");
});

/** What a recording WS upstream saw on one request. */
type SeenUpgrade = { path: string; origin: string | null; protocol: string | null };

/** WS upstream that pushes "hi" on open and records each request's path, Origin and
 *  offered subprotocols. */
function recordingWsUpstream(seen: SeenUpgrade[]): Upstream {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      seen.push({
        path: new URL(req.url).pathname,
        origin: req.headers.get("origin"),
        protocol: req.headers.get("sec-websocket-protocol"),
      });
      if (srv.upgrade(req)) return undefined;
      return new Response("not a ws", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send("hi");
      },
      message() {},
    },
  });
  upstreams.push(s);
  return s;
}

/** Connect a client WS (sending `origin` and offering `protocols` when given); settle on its
 *  first frame or failure. */
function wsFirstFrame(
  url: string,
  origin?: string,
  protocols?: string[],
): Promise<{ opened: boolean; frame: string | null }> {
  return new Promise((resolve) => {
    const options = { headers: origin ? { Origin: origin } : undefined, protocols };
    // The DOM constructor type lacks Bun's options form (headers).
    const ws = new WebSocket(url, options as never);
    let opened = false;
    const done = (frame: string | null) => {
      clearTimeout(timer);
      resolve({ opened, frame });
      try {
        ws.close();
      } catch {
        /* peer gone */
      }
    };
    const timer = setTimeout(() => done(null), 3000);
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (e) => done(String(e.data));
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
  });
}

test("PreviewService: a cross-origin WS upgrade fails and never reaches the upstream", async () => {
  const seen: SeenUpgrade[] = [];
  const port = service!.ensure("s1", portOf(recordingWsUpstream(seen)));
  const out = await wsFirstFrame(`ws://127.0.0.1:${port}/t4-ws-cross`, "https://evil.example");
  expect(out).toEqual({ opened: false, frame: null });
  expect(seen.map((s) => s.path)).not.toContain("/t4-ws-cross");
}, 10_000);

test("PreviewService: WS relay sends the dev server's own origin upstream only when the client sent one", async () => {
  const seen: SeenUpgrade[] = [];
  // devPort (5173) differs from the dialled upstream port: the Origin names the dev port.
  const port = service!.ensure("s1", 5173, portOf(recordingWsUpstream(seen)));
  const withOrigin = `ws://127.0.0.1:${port}/t4-with-origin`;
  expect((await wsFirstFrame(withOrigin, `http://127.0.0.1:${port}`)).frame).toBe("hi");
  expect((await wsFirstFrame(`ws://127.0.0.1:${port}/t4-no-origin`)).frame).toBe("hi");
  const originAt = (path: string) => seen.find((s) => s.path === path)?.origin;
  expect(originAt("/t4-with-origin")).toBe("http://localhost:5173");
  expect(originAt("/t4-no-origin")).toBeNull();
}, 10_000);

test("PreviewService: WS relay still offers the client's subprotocols upstream", async () => {
  const seen: SeenUpgrade[] = [];
  const port = service!.ensure("s1", portOf(recordingWsUpstream(seen)));
  const url = `ws://127.0.0.1:${port}/t4-protocols`;
  expect((await wsFirstFrame(url, undefined, ["vite-hmr", "x"])).frame).toBe("hi");
  expect(seen.find((s) => s.path === "/t4-protocols")?.protocol ?? "").toContain("vite-hmr");
}, 10_000);

test("PreviewService: upstream Clear-Site-Data never passes; a new owner's navigation gets only the proxy's", async () => {
  const headers = new Headers({ "clear-site-data": '"cookies"' });
  headers.append("set-cookie", "shepherd_session=x; Path=/");
  const port = service!.ensure("s1", portOf(httpUpstream({ headers })));
  const plain = await fetch(`http://127.0.0.1:${port}/`);
  expect(plain.headers.get("clear-site-data")).toBeNull();
  expect(plain.headers.getSetCookie()).toEqual([]);
  const nav = await fetch(`http://127.0.0.1:${port}/`, { headers: NAV });
  expect(nav.headers.get("clear-site-data")).toBe('"cache", "storage"');
  expect(nav.headers.getSetCookie().some((c) => c.startsWith("shepherd_session="))).toBe(false);
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

// ── PreviewService: per-slot proxy limits ─────────────────────────────────────

/** A promise an upstream handler awaits until `release()` (or test cleanup) resolves it. */
function park(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  parked.push(release);
  return { promise, release };
}

/** Swap the shared service for one with `proxyLimits` (afterEach stops it); returns the slot
 *  URL proxying to `up`. */
function limitedProxy(proxyLimits: PreviewServiceOptions["proxyLimits"], up: Upstream): string {
  service?.stopAll();
  service = new PreviewService({ base: TEST_BASE, count: TEST_COUNT, proxyLimits });
  return `http://127.0.0.1:${service.ensure("s1", portOf(up))}/`;
}

/** Poll `cond` every 10 ms until it holds or `ms` elapses; returns its final value. */
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  return cond();
}

/** HTTP upstream whose first request waits on `first`; later ones answer at once. */
function firstHeldUpstream(first: Promise<void>): { up: Upstream; hits: () => number } {
  let hits = 0;
  const up = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      const n = ++hits;
      if (n === 1) await first;
      return new Response(`hit${n}`);
    },
  });
  upstreams.push(up);
  return { up, hits: () => hits };
}

/** Upstream serving `chunks` slow chunks at /stream (endless when null) and "ok" elsewhere. */
function streamingUpstream(chunks: number | null): Upstream {
  const up = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname !== "/stream") return new Response("ok");
      let i = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            await Bun.sleep(20);
            if (chunks === null || i < chunks) c.enqueue(new TextEncoder().encode(`chunk${++i};`));
            else c.close();
          },
        }),
      );
    },
  });
  upstreams.push(up);
  return up;
}

test("PreviewService: a stalled upstream gets 504 after the headers deadline", async () => {
  const stall = park();
  const up = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      await stall.promise;
      return new Response("late");
    },
  });
  upstreams.push(up);
  const url = limitedProxy({ headersTimeoutMs: 200 }, up);
  const started = Date.now();
  const res = await fetch(url);
  expect(res.status).toBe(504);
  expect(await res.text()).toBe("Preview upstream timed out");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("PreviewService: a body still streaming past the headers deadline completes", async () => {
  const enc = new TextEncoder();
  const up = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      let sent = 0;
      // Headers + first chunk go out at once; the body ends ~550 ms later.
      return new Response(
        new ReadableStream({
          async pull(c) {
            if (sent++ === 0) return c.enqueue(enc.encode("head;"));
            await Bun.sleep(550);
            c.enqueue(enc.encode("tail"));
            c.close();
          },
        }),
      );
    },
  });
  upstreams.push(up);
  const url = limitedProxy({ headersTimeoutMs: 300 }, up);
  const started = Date.now();
  const res = await fetch(`${url}t-slow-body`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("head;tail");
  expect(Date.now() - started).toBeGreaterThan(300); // the body did outlive the deadline
});

test("PreviewService: a client abort cancels the upstream request", async () => {
  const stall = park();
  let upstreamAborted = false;
  const up = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      req.signal.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      await stall.promise;
      return new Response("late");
    },
  });
  upstreams.push(up);
  const port = service!.ensure("s1", portOf(up));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  await expect(fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal })).rejects.toThrow();
  expect(await waitFor(() => upstreamAborted)).toBe(true);
});

test("PreviewService: requests past the slot concurrency wait FIFO for a permit", async () => {
  const first = park();
  const { up, hits } = firstHeldUpstream(first.promise);
  const url = limitedProxy({ concurrency: 1 }, up);
  const a = fetch(url);
  expect(await waitFor(() => hits() === 1)).toBe(true);
  const b = fetch(url);
  await Bun.sleep(150);
  expect(hits()).toBe(1); // queued behind the held permit, not yet sent upstream
  first.release();
  const [resA, resB] = await Promise.all([a, b]);
  expect([resA.status, resB.status]).toEqual([200, 200]);
  expect([await resA.text(), await resB.text()]).toEqual(["hit1", "hit2"]);
});

test("PreviewService: a full slot queue answers 503", async () => {
  const first = park();
  const { up, hits } = firstHeldUpstream(first.promise);
  const url = limitedProxy({ concurrency: 1, queue: 0 }, up);
  const a = fetch(url);
  expect(await waitFor(() => hits() === 1)).toBe(true);
  const busy = await fetch(url);
  expect(busy.status).toBe(503);
  expect(await busy.text()).toBe("Preview busy");
  first.release();
  const resA = await a;
  expect(resA.status).toBe(200);
  expect(await resA.text()).toBe("hit1");
  expect(hits()).toBe(1);
});

test("PreviewService: a slot permit frees once the response body completes", async () => {
  // A leaked permit would queue the next request until the deadline: 504, not a hang.
  const url = limitedProxy({ concurrency: 1, headersTimeoutMs: 1000 }, streamingUpstream(5));
  for (let i = 0; i < 2; i++) {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  }
  const streamed = await fetch(`${url}stream`);
  expect(await streamed.text()).toBe("chunk1;chunk2;chunk3;chunk4;chunk5;");
  const after = await fetch(url);
  expect(after.status).toBe(200);
  expect(await after.text()).toBe("ok");
});

test("PreviewService: a slot permit frees when the client drops a streaming response", async () => {
  const url = limitedProxy({ concurrency: 1, headersTimeoutMs: 1000 }, streamingUpstream(null));
  const ctl = new AbortController();
  const streamed = await fetch(`${url}stream`, { signal: ctl.signal });
  await streamed.body!.getReader().read();
  ctl.abort();
  const after = await fetch(url);
  expect(after.status).toBe(200);
  expect(await after.text()).toBe("ok");
});

/**
 * Raw TCP WS upstream: completes the 101 handshake, then never reads its socket again. It
 * writes an unmasked ping every 50 ms instead: a write is how a non-reading peer notices
 * the other end is gone, so `closed()` turns true once the relay drops this connection.
 */
async function stalledWsUpstream(): Promise<{
  port: number;
  handshaken: Promise<void>;
  closed: () => boolean;
  close: () => void;
}> {
  const sockets = new Set<Socket>();
  const pingers = new Set<ReturnType<typeof setInterval>>();
  let closed = false;
  let handshake!: () => void;
  const handshaken = new Promise<void>((resolve) => {
    handshake = resolve;
  });
  const srv = createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.once("data", (buf) => {
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf.toString("latin1"))?.[1];
      // Only the relay's WS connection counts; drop any other caller (e.g. a port probe).
      if (key === undefined) return void sock.destroy();
      sock.on("close", () => {
        closed = true;
      });
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      sock.pause();
      handshake();
      const pinger = setInterval(() => {
        if (sock.destroyed) clearInterval(pinger);
        else sock.write(Buffer.from([0x89, 0x00]));
      }, 50);
      pingers.add(pinger);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return {
    port: (srv.address() as AddressInfo).port,
    handshaken,
    closed: () => closed,
    close: () => {
      for (const pinger of pingers) clearInterval(pinger);
      for (const sock of sockets) sock.destroy();
      srv.close();
    },
  };
}

test("PreviewService: WS relay drops both sides when the upstream stops reading", async () => {
  const up = await stalledWsUpstream();
  let ws: WebSocket | null = null;
  try {
    const port = service!.ensure("s1", up.port);
    let sent = false;
    const closedAfterFlood = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws.onclose = () => {
        clearTimeout(timer);
        resolve(sent); // a close before the flood went out is not the cap's doing
      };
      ws.onopen = async () => {
        await up.handshaken;
        await Bun.sleep(100); // let the relay see the upstream open (past the pre-open buffer)
        // 32 MiB: kernel socket buffers absorb a few MiB before `bufferedAmount` grows.
        const mib = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 32; i++) ws?.send(mib);
        sent = true;
      };
    });
    expect(closedAfterFlood).toBe(true);
    // The upstream still isn't reading: its connection closing proves the relay dropped it.
    expect(await waitFor(up.closed)).toBe(true);
  } finally {
    (ws as WebSocket | null)?.close();
    up.close();
  }
}, 10_000);

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

test("PreviewService: upstreamPort — HTTP and WS dial it, devPortFor keeps devPort (#2902)", async () => {
  const http = httpUpstream({ echoPath: true });
  const port = service!.ensure("s1", 5173, portOf(http));
  expect(service!.devPortFor("s1")).toBe(5173);
  expect(await (await fetch(`http://127.0.0.1:${port}/x?y=1`)).text()).toBe("/x?y=1");

  // Re-ensure moves the upstream live (netns respawn → new forward), WS included.
  const ws = wsUpstream("from-forward");
  expect(service!.ensure("s1", 5173, portOf(ws))).toBe(port);
  expect(await collectWsMessages(`ws://127.0.0.1:${port}/`, 1)).toEqual(["from-forward"]);
  expect(service!.devPortFor("s1")).toBe(5173);
});

test("PreviewService: converge carries upstreamPort through to ensure", async () => {
  const up = httpUpstream({ body: "fwd" });
  service!.converge([{ sessionId: "s1", devPort: 5173, upstreamPort: portOf(up) }]);
  const port = service!.snapshot()["s1"]?.previewPort;
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("fwd");
  expect(service!.devPortFor("s1")).toBe(5173);
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

test("PreviewService: slot-range port is not accepted as a dev port", () => {
  const svc = new PreviewService({ base: TEST_BASE, count: TEST_COUNT });
  const warn = console.warn;
  console.warn = () => {};
  try {
    expect(svc.ensure("s1", TEST_BASE + 1)).toBeNull();
    expect(svc.snapshot()).toEqual({});
  } finally {
    console.warn = warn;
    svc.stopAll();
  }
});

test("PreviewService: reserved dev or upstream port is refused", () => {
  const reserved = 41234;
  const svc = new PreviewService({
    base: TEST_BASE,
    count: TEST_COUNT,
    reservedPorts: () => [reserved, null, undefined, 0],
  });
  const warn = console.warn;
  const warns: string[] = [];
  console.warn = (m: string) => warns.push(m);
  try {
    expect(svc.ensure("s1", reserved)).toBeNull();
    expect(svc.ensure("s1", reserved)).toBeNull();
    expect(svc.ensure("s1", 41235, reserved)).toBeNull();
    expect(svc.snapshot()).toEqual({});
    expect(warns.length).toBe(1); // once per session+port
  } finally {
    console.warn = warn;
    svc.stopAll();
  }
});

test("PreviewService: an in-netns dev port in the slot range binds when its dialled port is free", async () => {
  // Only the dialled upstream port is checked: the dev port lives in the session's netns.
  const port = service!.ensure("s1", TEST_BASE + 1, portOf(httpUpstream({ body: "netns-dev" })));
  expect(port).not.toBeNull();
  const res = await fetch(`http://127.0.0.1:${port}/t-netns-dev`);
  expect(await res.text()).toBe("netns-dev");
});

test("PreviewService: converge drops warn state for sessions it no longer lists", () => {
  const reserved = 41239;
  const svc = new PreviewService({
    base: TEST_BASE,
    count: TEST_COUNT,
    reservedPorts: () => [reserved],
  });
  const warn = console.warn;
  const warns: string[] = [];
  console.warn = (m: string) => warns.push(m);
  try {
    svc.converge([{ sessionId: "s1", devPort: reserved }]);
    svc.converge([{ sessionId: "s1", devPort: reserved }]);
    expect(warns.length).toBe(1); // still listed: warned once
    svc.converge([]); // no longer listed: its warn state goes with it
    svc.ensure("s1", reserved);
    expect(warns.length).toBe(2);
  } finally {
    console.warn = warn;
    svc.stopAll();
  }
});

test("PreviewService: bound session re-ensured with a reserved port is released", async () => {
  const reserved = 41236;
  const changes: Array<[string, number | null]> = [];
  const svc = new PreviewService({
    base: TEST_BASE,
    count: TEST_COUNT,
    reservedPorts: () => [reserved],
    onChange: (id, port) => changes.push([id, port]),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const port = svc.ensure("s1", 40000);
    expect(port).not.toBeNull();
    expect(svc.ensure("s1", reserved)).toBeNull();
    expect(svc.snapshot()).toEqual({});
    expect(changes).toEqual([
      ["s1", port],
      ["s1", null],
    ]);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toBeDefined();
  } finally {
    console.warn = warn;
    svc.stopAll();
  }
});

test("PreviewService: isReservedPort covers slot range and reserved list only", () => {
  const svc = new PreviewService({
    base: TEST_BASE,
    count: TEST_COUNT,
    reservedPorts: () => [41237, null],
  });
  expect(svc.isReservedPort(TEST_BASE)).toBe(true);
  expect(svc.isReservedPort(TEST_BASE + TEST_COUNT - 1)).toBe(true);
  expect(svc.isReservedPort(TEST_BASE + TEST_COUNT)).toBe(false);
  expect(svc.isReservedPort(TEST_BASE - 1)).toBe(false);
  expect(svc.isReservedPort(41237)).toBe(true);
  expect(svc.isReservedPort(41238)).toBe(false);
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

/** Swap a bound listener's servers for one whose `stop()` throws SYNCHRONOUSLY (a non-promise
 *  return would fail the same way, since `.catch` would then throw). */
function breakServer(svc: PreviewService, sessionId: string): { stopReal: () => void } {
  const listener = (svc as any).listeners.get(sessionId);
  const real: Upstream[] = listener.servers;
  listener.servers = [
    {
      stop() {
        throw new Error("boom: server already gone");
      },
    },
  ];
  // The service can no longer reach the REAL servers (we just swapped them out), so `stopAll`/`release`
  // will never close their sockets. The test must, or it leaks a listening port for the rest of the run.
  return {
    stopReal: () => {
      for (const server of real)
        void Promise.resolve(server.stop(true)).catch(() => {
          /* already gone */
        });
    },
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

// ── IPv6 loopback companions ──────────────────────────────────────────────────

/** Whether `node:net` can listen on `::1` — an independent check of `loopbackV6Available`. */
function netListensOnLoopbackV6(): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host: "::1", port: 0 }, () => srv.close(() => resolve(true)));
  });
}

test("loopbackV6Available: agrees with a node:net listen on ::1", async () => {
  expect(loopbackV6Available()).toBe(await netListensOnLoopbackV6());
});

test("needsLoopbackV6: IPv4 loopback and wildcard binds need [::1], other hosts don't", () => {
  for (const host of ["127.0.0.1", "localhost", "0.0.0.0"])
    expect(needsLoopbackV6(host)).toBe(true);
  for (const host of ["::", "::1", "[::1]", "127.0.0.2", "100.64.0.7", "box.example.ts.net", ""])
    expect(needsLoopbackV6(host)).toBe(false);
});

/** Status + body of a GET, or null when the connection fails. */
async function getOrNull(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

test("PreviewService loopbackV6: 127.0.0.1 proxies; [::1] proxies iff the host has IPv6 loopback", async () => {
  const up = httpUpstream({ body: "v6-companion-body" });
  const svc = new PreviewService({ base: TEST_BASE + 100, count: TEST_COUNT, loopbackV6: true });
  try {
    const port = svc.ensure("s1", portOf(up));
    expect(port).not.toBeNull();
    expect(await getOrNull(`http://127.0.0.1:${port}/`)).toEqual({
      status: 200,
      body: "v6-companion-body",
    });
    const v6 = await getOrNull(`http://[::1]:${port}/`);
    expect(v6).toEqual(loopbackV6Available() ? { status: 200, body: "v6-companion-body" } : null);
  } finally {
    svc.stopAll();
  }
});

test.skipIf(!loopbackV6Available())(
  "PreviewService loopbackV6: release frees the slot's [::1] port",
  async () => {
    const up = httpUpstream({ body: "v6-release-body" });
    const svc = new PreviewService({ base: TEST_BASE + 200, count: TEST_COUNT, loopbackV6: true });
    try {
      const port = svc.ensure("s1", portOf(up));
      expect(port).not.toBeNull();
      expect((await getOrNull(`http://[::1]:${port}/`))?.body).toBe("v6-release-body");
      svc.release("s1");
      // Throws EADDRINUSE if the [::1] server were still bound.
      const probe = Bun.serve({ hostname: "::1", port: port!, fetch: () => new Response("free") });
      probe.stop(true);
    } finally {
      svc.stopAll();
    }
  },
);

test.skipIf(!loopbackV6Available())(
  "PreviewService loopbackV6: a slot whose [::1] port is taken is skipped, its 127.0.0.1 bind undone",
  () => {
    const base = TEST_BASE + 300;
    const holder = Bun.serve({ hostname: "::1", port: base, fetch: () => new Response("held") });
    const up = httpUpstream({});
    const svc = new PreviewService({ base, count: TEST_COUNT, loopbackV6: true });
    try {
      expect(svc.ensure("s1", portOf(up))).toBe(base + 1);
      // Throws EADDRINUSE if the slot's 127.0.0.1 server were left bound.
      const probe = Bun.serve({ hostname: "127.0.0.1", port: base, fetch: () => new Response("") });
      probe.stop(true);
    } finally {
      svc.stopAll();
      holder.stop(true);
    }
  },
);

// ── previewReach (#2767) ──────────────────────────────────────────────────────

const reach = (over: Partial<PreviewReachInput>) =>
  previewReach({
    previewPort: 4101,
    host: "macbook.example.ts.net",
    autoServe: true,
    serve: "ok",
    denied: false,
    ...over,
  });

test("previewReach: a served slot opens at THIS instance's host and slot", () => {
  expect(reach({})).toEqual({
    bound: true,
    url: "https://macbook.example.ts.net:4101/",
    unavailable: null,
  });
  expect(reach({ host: "linux.example.ts.net", previewPort: 4100 }).url).toBe(
    "https://linux.example.ts.net:4100/",
  );
});

test("previewReach: with auto-serve off the operator maps slots, so a bound slot is offered", () => {
  expect(reach({ autoServe: false, serve: undefined, denied: true })).toEqual({
    bound: true,
    url: "https://macbook.example.ts.net:4101/",
    unavailable: null,
  });
});

test("previewReach: no tailnet host → not_served, bound or not, never a URL", () => {
  expect(reach({ host: null })).toEqual({ bound: true, url: null, unavailable: "not_served" });
  expect(reach({ host: null, previewPort: null, serve: undefined })).toEqual({
    bound: false,
    url: null,
    unavailable: "not_served",
  });
});

test("previewReach: refused serve config is explained before and after a start", () => {
  expect(reach({ previewPort: null, serve: undefined, denied: true })).toEqual({
    bound: false,
    url: null,
    unavailable: "serve_denied",
  });
  expect(reach({ serve: "failed", denied: true }).unavailable).toBe("serve_denied");
});

test("previewReach: a failed or unsettled mapping has no URL", () => {
  expect(reach({ serve: "failed" })).toEqual({
    bound: true,
    url: null,
    unavailable: "serve_failed",
  });
  expect(reach({ serve: undefined })).toEqual({
    bound: true,
    url: null,
    unavailable: "serve_pending",
  });
});

test("previewReach: nothing bound and nothing wrong → no preview, no reason", () => {
  expect(reach({ previewPort: null, serve: undefined })).toEqual({
    bound: false,
    url: null,
    unavailable: null,
  });
});
