import { test, expect, describe } from "bun:test";
import {
  createOrphanTabSweeper,
  reapOrphanTabs,
  isShepherdHelperLabel,
  reapStaleReviewWorktrees,
  type ReapResult,
  type ReapableHerdr,
  type ReapWorktreesDeps,
} from "../src/tab-reaper";
import { PROBE_NAME } from "../src/usage-probe";
import { DISTILL_LABEL } from "../src/distiller";
import { OPTIMIZE_LABEL } from "../src/optimizer";
import type { HerdrPane } from "../src/herdr";

function pane(paneId: string, tabId: string, label: string): HerdrPane {
  return { paneId, tabId, label, cwd: "/wt", agentStatus: "unknown" };
}

/** Drives the process-info path: `panes()` returns the given panes, and
 *  `paneForegroundProcs(paneId)` resolves from `procMap` (a thrown value re-throws). */
function procFake(
  panes: HerdrPane[],
  procMap: Record<string, string[] | Error>,
  opts: { panesThrows?: boolean } = {},
): { h: ReapableHerdr; closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    h: {
      closeTab: async (id) => void closed.push(id),
      panes: () => {
        if (opts.panesThrows) throw new Error("pane list: unknown subcommand");
        return panes;
      },
      paneForegroundProcs: async (paneId) => {
        const v = procMap[paneId];
        if (v instanceof Error) throw v;
        return v ?? [];
      },
    },
  };
}

// ── Process-info path (herdr 0.7 husk detection) ──────────────────────────────

test("debounce: shell-only husk is NOT closed on first sweep, closed on second consecutive sweep", async () => {
  const panes = [pane("w1:p1", "w1:t1", PROBE_NAME)];
  const procMap: Record<string, string[]> = { "w1:p1": ["zsh"] };

  // Sweep 1: shell-only sighting — recorded, NOT closed.
  const f1 = procFake(panes, procMap);
  const r1 = await reapOrphanTabs(f1.h);
  expect(r1.closed).toEqual([]);
  expect(f1.closed).toEqual([]);
  expect(r1.shellOnly).toEqual(new Set(["w1:t1"]));

  // Sweep 2: still shell-only AND seen last sweep → close.
  const f2 = procFake(panes, procMap);
  const r2 = await reapOrphanTabs(f2.h, r1.shellOnly);
  expect(r2.closed).toEqual(["w1:t1"]);
  expect(f2.closed).toEqual(["w1:t1"]);
});

test("live spare: a helper pane running claude is never closed, counts as sparedLive", async () => {
  const panes = [pane("w1:p1", "w1:t1", "review TASK-09")];
  const procMap: Record<string, string[]> = {
    "w1:p1": ["claude", "npm exec something", "node-MainThread"],
  };

  const f1 = procFake(panes, procMap);
  const r1 = await reapOrphanTabs(f1.h);
  expect(r1.closed).toEqual([]);
  expect(r1.sparedLive).toBe(1);
  expect(r1.sparedError).toBe(0);
  expect(r1.shellOnly.has("w1:t1")).toBe(false);

  // Even feeding the (empty) set back, still spared.
  const f2 = procFake(panes, procMap);
  const r2 = await reapOrphanTabs(f2.h, r1.shellOnly);
  expect(r2.closed).toEqual([]);
  expect(f2.closed).toEqual([]);
  expect(r2.sparedLive).toBe(1);
});

test("process-info error spare: paneForegroundProcs throwing spares the pane (sparedError)", async () => {
  const panes = [pane("w1:p1", "w1:t1", PROBE_NAME)];
  const procMap: Record<string, Error> = {
    "w1:p1": new Error("transient process-info read failure"),
  };

  // Throwing on two consecutive sweeps never closes.
  const f1 = procFake(panes, procMap);
  const r1 = await reapOrphanTabs(f1.h);
  expect(r1.closed).toEqual([]);
  expect(r1.sparedError).toBe(1);
  expect(r1.shellOnly.has("w1:t1")).toBe(false);

  const f2 = procFake(panes, procMap);
  const r2 = await reapOrphanTabs(f2.h, r1.shellOnly);
  expect(r2.closed).toEqual([]);
  expect(f2.closed).toEqual([]);
  expect(r2.sparedError).toBe(1);
});

test("empty-procs spare: undeterminable pane (procs []) is spared fail-closed (sparedError)", async () => {
  const panes = [pane("w1:p1", "w1:t1", PROBE_NAME)];
  const procMap: Record<string, string[]> = { "w1:p1": [] };

  const f1 = procFake(panes, procMap);
  const r1 = await reapOrphanTabs(f1.h);
  expect(r1.closed).toEqual([]);
  expect(r1.sparedError).toBe(1);
  expect(r1.shellOnly.has("w1:t1")).toBe(false);

  const f2 = procFake(panes, procMap);
  const r2 = await reapOrphanTabs(f2.h, r1.shellOnly);
  expect(r2.closed).toEqual([]);
  expect(f2.closed).toEqual([]);
});

test("non-helper untouched: a non-helper shell-only pane is ignored across two sweeps", async () => {
  const panes = [pane("w1:p1", "w1:t1", "my-feature")];
  const procMap: Record<string, string[]> = { "w1:p1": ["zsh"] };

  const f1 = procFake(panes, procMap);
  const r1 = await reapOrphanTabs(f1.h);
  expect(r1.closed).toEqual([]);
  expect(r1.sparedLive).toBe(0);
  expect(r1.sparedError).toBe(0);
  expect(r1.shellOnly.has("w1:t1")).toBe(false);

  const f2 = procFake(panes, procMap);
  const r2 = await reapOrphanTabs(f2.h, r1.shellOnly);
  expect(r2.closed).toEqual([]);
  expect(f2.closed).toEqual([]);
});

test("distiller unique label: husk tab __distill__<8hex> is reaped after two shell-only sweeps", async () => {
  const uniqueLabel = `${DISTILL_LABEL}a1b2c3d4`;
  const panes = [pane("w1:p1", "w1:t1", uniqueLabel)];
  const procMap: Record<string, string[]> = { "w1:p1": ["zsh"] };

  // Sweep 1: shell-only sighting — recorded, NOT closed.
  const f1 = procFake(panes, procMap);
  const r1 = await reapOrphanTabs(f1.h);
  expect(r1.closed).toEqual([]);
  expect(f1.closed).toEqual([]);
  expect(r1.shellOnly).toEqual(new Set(["w1:t1"]));

  // Sweep 2: still shell-only AND seen last sweep → close.
  const f2 = procFake(panes, procMap);
  const r2 = await reapOrphanTabs(f2.h, r1.shellOnly);
  expect(r2.closed).toEqual(["w1:t1"]);
  expect(f2.closed).toEqual(["w1:t1"]);
});

test("distiller unique label: tab __distill__<8hex> with live agent is spared (liveness gate)", async () => {
  const uniqueLabel = `${DISTILL_LABEL}a1b2c3d4`;
  const panes = [pane("w1:p1", "w1:t1", uniqueLabel)];
  const procMap: Record<string, string[]> = { "w1:p1": ["claude"] };

  const f1 = procFake(panes, procMap);
  const r1 = await reapOrphanTabs(f1.h);
  expect(r1.closed).toEqual([]);
  expect(r1.sparedLive).toBe(1);
  expect(r1.shellOnly.has("w1:t1")).toBe(false);

  const f2 = procFake(panes, procMap);
  const r2 = await reapOrphanTabs(f2.h, r1.shellOnly);
  expect(r2.closed).toEqual([]);
  expect(f2.closed).toEqual([]);
  expect(r2.sparedLive).toBe(1);
});

test("panes() throwing fails closed — reaps nothing, preserves debounce state, flags panesFailed", async () => {
  const { h, closed } = procFake([], {}, { panesThrows: true });
  const r = await reapOrphanTabs(h, new Set(["w1:t1"]));
  expect(r.closed).toEqual([]);
  expect(closed).toEqual([]);
  expect(r.sparedLive).toBe(0);
  expect(r.sparedError).toBe(0);
  expect(r.shellOnly).toEqual(new Set(["w1:t1"])); // debounce state preserved
  // The zero-work sweep is FLAGGED — indistinguishable-from-"no husks" was the #1852
  // operationally-silent failure mode.
  expect(r.panesFailed).toBe(true);
});

test("a normal sweep reports panesFailed=false", async () => {
  const f = procFake([pane("w1:p1", "w1:t1", PROBE_NAME)], { "w1:p1": ["zsh"] });
  const r = await reapOrphanTabs(f.h);
  expect(r.panesFailed).toBe(false);
});

// ── Per-tab liveness classification (#1852) ───────────────────────────────────
//
// Reaping closes whole TABS, but classification used to be per PANE. A helper tab can
// hold more than one pane — a headless codex-exec role deliberately retains its root
// shell pane, and a failed best-effort root-pane close leaves a shell pane beside the
// agent pane. The sibling shell pane then marked the tab reap-eligible while the live
// pane merely counted as spared: two sweeps later the tab was closed WITH the live
// helper inside. These tests pin the per-tab contract: any live/undeterminable pane
// spares AND de-primes the whole tab.

const MIXED_LABEL = "plan-review TASK-07";

test("mixed shell+live tab: repeated sweeps never close it and never prime the debounce", async () => {
  const panes = [
    pane("w1:p1", "w1:t1", MIXED_LABEL), // retained root shell pane
    pane("w1:p2", "w1:t1", MIXED_LABEL), // live agent pane
  ];
  const procMap: Record<string, string[]> = { "w1:p1": ["zsh"], "w1:p2": ["claude"] };
  const f = procFake(panes, procMap);

  let prev = new Set<string>();
  for (let sweep = 1; sweep <= 3; sweep++) {
    const r = await reapOrphanTabs(f.h, prev);
    expect(r.closed).toEqual([]);
    expect(f.closed).toEqual([]);
    expect(r.sparedLive).toBe(1); // one TAB spared, not one pane
    expect(r.shellOnly.has("w1:t1")).toBe(false); // never primed while a pane is live
    prev = r.shellOnly;
  }
});

test("mixed shell+error and shell+empty tabs are spared fail-closed as whole tabs", async () => {
  const panes = [
    pane("w1:p1", "w1:t1", MIXED_LABEL), // shell
    pane("w1:p2", "w1:t1", MIXED_LABEL), // process-info throws
    pane("w2:p1", "w2:t2", "recap TASK-08"), // shell
    pane("w2:p2", "w2:t2", "recap TASK-08"), // empty procs (undeterminable)
  ];
  const procMap: Record<string, string[] | Error> = {
    "w1:p1": ["zsh"],
    "w1:p2": new Error("transient process-info read failure"),
    "w2:p1": ["zsh"],
    "w2:p2": [],
  };
  const f = procFake(panes, procMap);

  let prev = new Set<string>();
  for (let sweep = 1; sweep <= 2; sweep++) {
    const r = await reapOrphanTabs(f.h, prev);
    expect(r.closed).toEqual([]);
    expect(f.closed).toEqual([]);
    expect(r.sparedError).toBe(2); // two TABS, fail-closed
    expect(r.shellOnly.size).toBe(0);
    prev = r.shellOnly;
  }
});

test("live pane DE-PRIMES a prior first-sighting; the shell sibling can never confirm a live tab", async () => {
  // Sweep 1: both panes read shell-only (the agent's pre-`exec` window) → first sighting.
  const panes = [pane("w1:p1", "w1:t1", MIXED_LABEL), pane("w1:p2", "w1:t1", MIXED_LABEL)];
  const procMap: Record<string, string[]> = { "w1:p1": ["zsh"], "w1:p2": ["zsh"] };
  const f = procFake(panes, procMap);

  const r1 = await reapOrphanTabs(f.h);
  expect(r1.shellOnly).toEqual(new Set(["w1:t1"])); // primed

  // Sweep 2: the agent exec'd — p2 is now live. The OLD per-pane code closed the tab
  // here (p1 shell-only + primed); the per-tab gate must spare AND clear the priming.
  procMap["w1:p2"] = ["claude"];
  const r2 = await reapOrphanTabs(f.h, r1.shellOnly);
  expect(r2.closed).toEqual([]);
  expect(f.closed).toEqual([]);
  expect(r2.sparedLive).toBe(1);
  expect(r2.shellOnly.has("w1:t1")).toBe(false); // de-primed

  // Sweep 3: the role finished; its pane idles as a shell again. This must be a FRESH
  // first sighting (not a stale confirm off sweep 1) …
  procMap["w1:p2"] = ["zsh"];
  const r3 = await reapOrphanTabs(f.h, r2.shellOnly);
  expect(r3.closed).toEqual([]);
  expect(r3.shellOnly).toEqual(new Set(["w1:t1"]));

  // … and sweep 4 confirms → reaped. The spare clears, it doesn't poison convergence.
  const r4 = await reapOrphanTabs(f.h, r3.shellOnly);
  expect(r4.closed).toEqual(["w1:t1"]);
  expect(f.closed).toEqual(["w1:t1"]);
});

// ── createOrphanTabSweeper (#1852) ────────────────────────────────────────────

function rr(over: Partial<ReapResult> = {}): ReapResult {
  return {
    closed: [],
    sparedLive: 0,
    sparedError: 0,
    shellOnly: new Set(),
    panesFailed: false,
    ...over,
  };
}

function mkSweeper(opts: {
  reapImpl: (prev: Set<string>) => ReapResult | Promise<ReapResult>;
  maintenance?: () => boolean;
}) {
  const scheduled: { fn: () => void; ms: number }[] = [];
  const results: ReapResult[] = [];
  const sweeper = createOrphanTabSweeper({
    reap: async (prev) => opts.reapImpl(prev),
    schedule: (fn, ms) => void scheduled.push({ fn, ms }),
    maintenanceActive: opts.maintenance ?? (() => false),
    onResult: (r) => void results.push(r),
    confirmDelayMs: 30_000,
  });
  return { sweeper, scheduled, results };
}

test("sweeper: overlapping triggers serialize — one pass in flight, extra triggers coalesce into ONE queued pass", async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const gates: Array<() => void> = [];
  const { sweeper } = mkSweeper({
    reapImpl: (prev) => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<ReapResult>((res) => {
        gates.push(() => {
          inFlight--;
          res(rr({ shellOnly: prev }));
        });
      });
    },
  });

  sweeper.trigger(); // starts pass 1 (e.g. the 5s boot pass, still crawling a big inventory)
  sweeper.trigger(); // e.g. the 45s pass — must QUEUE, not overlap
  sweeper.trigger(); // a third trigger coalesces into the same queued pass
  expect(calls).toBe(1);

  gates[0]!(); // pass 1 completes
  await Bun.sleep(0);
  expect(calls).toBe(2); // exactly one queued confirming pass started
  gates[1]!();
  await Bun.sleep(0);
  expect(calls).toBe(2);
  expect(maxInFlight).toBe(1); // never concurrent
});

test("sweeper: a queued pass receives its predecessor's sightings — it is a REAL confirming pass", async () => {
  const prevs: Set<string>[] = [];
  const gates: Array<() => void> = [];
  const { sweeper } = mkSweeper({
    reapImpl: (prev) => {
      prevs.push(prev);
      return new Promise<ReapResult>((res) =>
        gates.push(() => res(rr({ shellOnly: new Set(["husk"]) }))),
      );
    },
  });

  sweeper.trigger();
  sweeper.trigger(); // queued while pass 1 runs
  gates[0]!();
  await Bun.sleep(0);
  gates[1]!();
  await Bun.sleep(0);

  expect(prevs.length).toBe(2);
  expect(prevs[0]).toEqual(new Set());
  expect(prevs[1]).toEqual(new Set(["husk"])); // NOT a same-set replay — the old race
});

test("sweeper: a NEW first-sighting self-schedules one confirming pass, which closes and goes quiet", async () => {
  const seq: ReapResult[] = [
    rr({ shellOnly: new Set(["t1"]) }), // sighting pass
    rr({ closed: ["t1"], shellOnly: new Set(["t1"]) }), // confirm pass: closes
  ];
  let i = 0;
  const prevs: Set<string>[] = [];
  const { sweeper, scheduled } = mkSweeper({
    reapImpl: (prev) => {
      prevs.push(prev);
      return seq[i++]!;
    },
  });

  sweeper.trigger();
  await Bun.sleep(0);
  expect(scheduled.length).toBe(1); // exactly one confirm scheduled
  expect(scheduled[0]!.ms).toBe(30_000);

  scheduled[0]!.fn(); // fire the confirming pass
  await Bun.sleep(0);
  expect(prevs[1]).toEqual(new Set(["t1"])); // confirms off the sighting set
  expect(scheduled.length).toBe(1); // repeat sightings schedule nothing further (no tight loop)
  expect(i).toBe(2);
});

test("sweeper: restart mid-debounce — a fresh instance converges from ONE trigger via its self-confirm", async () => {
  // Instance 1 sights the husk; the process restarts before its confirm fires (the old
  // in-memory debounce reset). The husk persists in herdr.
  const first = mkSweeper({ reapImpl: () => rr({ shellOnly: new Set(["husk"]) }) });
  first.sweeper.trigger();
  await Bun.sleep(0);
  expect(first.scheduled.length).toBe(1); // the confirm the restart will drop

  // Instance 2: fresh empty debounce, same herdr state. A SINGLE boot trigger re-sights
  // and its self-scheduled confirm closes — no dependence on a second external trigger.
  let pass = 0;
  const closedOnPass: number[] = [];
  const second = mkSweeper({
    reapImpl: (prev) => {
      pass++;
      if (prev.has("husk")) {
        closedOnPass.push(pass);
        return rr({ closed: ["husk"], shellOnly: new Set(["husk"]) });
      }
      return rr({ shellOnly: new Set(["husk"]) });
    },
  });
  second.sweeper.trigger();
  await Bun.sleep(0);
  expect(second.scheduled.length).toBe(1);
  second.scheduled[0]!.fn();
  await Bun.sleep(0);
  expect(closedOnPass).toEqual([2]);
});

test("sweeper: boot triggers skipped under maintenance — the first later trigger converges by itself", async () => {
  let maint = true;
  let pass = 0;
  const closed: string[] = [];
  const { sweeper, scheduled } = mkSweeper({
    maintenance: () => maint,
    reapImpl: (prev) => {
      pass++;
      if (prev.has("h")) {
        closed.push("h");
        return rr({ closed: ["h"], shellOnly: new Set(["h"]) });
      }
      return rr({ shellOnly: new Set(["h"]) });
    },
  });

  sweeper.trigger(); // 5s boot trigger — maintenance window
  sweeper.trigger(); // 45s boot trigger — still in maintenance
  await Bun.sleep(0);
  expect(pass).toBe(0); // both skipped

  maint = false;
  sweeper.trigger(); // first hourly trigger
  await Bun.sleep(0);
  expect(scheduled.length).toBe(1);
  scheduled[0]!.fn(); // its self-confirm — nothing waits another hour
  await Bun.sleep(0);
  expect(closed).toEqual(["h"]);
});

test("sweeper: a panesFailed pass surfaces via onResult and the preserved debounce still confirms later", async () => {
  const seq: ReapResult[] = [
    rr({ shellOnly: new Set(["t9"]) }), // sighting
    rr({ shellOnly: new Set(["t9"]), panesFailed: true }), // confirm hits a panes() failure — zero work
    rr({ closed: ["t9"], shellOnly: new Set(["t9"]) }), // next trigger confirms off the preserved set
  ];
  let i = 0;
  const prevs: Set<string>[] = [];
  const { sweeper, scheduled, results } = mkSweeper({
    reapImpl: (prev) => {
      prevs.push(prev);
      return seq[i++]!;
    },
  });

  sweeper.trigger();
  await Bun.sleep(0);
  scheduled[0]!.fn();
  await Bun.sleep(0);
  expect(results[1]!.panesFailed).toBe(true); // observable, not a silent zero

  sweeper.trigger(); // e.g. the hourly pass
  await Bun.sleep(0);
  expect(prevs[2]).toEqual(new Set(["t9"])); // debounce survived the failed pass
  expect(results[2]!.closed).toEqual(["t9"]);
});

describe("isShepherdHelperLabel", () => {
  const trueLabels: [string, string][] = [
    // pre-existing helpers
    [PROBE_NAME, "usage probe (underscore marker)"],
    [DISTILL_LABEL, "distiller bare prefix (underscore marker)"],
    [`${DISTILL_LABEL}a1b2c3d4`, "distiller unique label (prefix + 8hex suffix)"],
    [OPTIMIZE_LABEL, "optimizer bare prefix (underscore marker)"],
    [`${OPTIMIZE_LABEL}a1b2c3d4`, "optimizer unique label (prefix + 8hex suffix)"],
    ["review TASK-09", "critic/code-review"],
    ["name TASK-09", "background namer"],
    // new helpers (#721)
    ["plan-review TASK-09", "plan-gate reviewer"],
    ["pr-critic /home/x/repo#42", "standalone PR critic"],
    ["recap TASK-09", "recap generator"],
    ["rundown", "herd-digest rundown (exact, liveness-gated)"],
    ["autopilot 643cfec7-1234-5678-abcd-ef0123456789", "autopilot LLM"],
    ["verify api key", "API-key verifier (multi-word exact)"],
    // #1852: prompt recommender — previously uncovered, leaked forever across restarts
    ["recommend TASK-09", "prompt recommender"],
  ];

  for (const [label, desc] of trueLabels) {
    test(`true: ${desc} — ${JSON.stringify(label)}`, () => {
      expect(isShepherdHelperLabel(label)).toBe(true);
    });
  }

  const falseLabels: [string, string][] = [
    // bare slugs that look similar but are producible user slugs
    ["plan-review-thing", "hyphen, no space — not a plan-review helper"],
    ["my-feature", "ordinary user session slug"],
    ["usage-probe", "slug form of PROBE_NAME — must NOT be reaped"],
    ["distill", "slug form of DISTILL_LABEL — must NOT be reaped"],
    ["optimize", "slug form of OPTIMIZE_LABEL — must NOT be reaped"],
    ["my-feature-branch", "ordinary user slug (no underscores)"],
    ["reviewing-pr", "starts with 'review' but no trailing space"],
    ["autopilot-mode", "hyphen instead of space — not an autopilot helper"],
    ["name-my-thing", "hyphen instead of space — not a namer helper"],
    ["recommend-tweaks", "hyphen instead of space — not a recommender helper"],
  ];

  for (const [label, desc] of falseLabels) {
    test(`false: ${desc} — ${JSON.stringify(label)}`, () => {
      expect(isShepherdHelperLabel(label)).toBe(false);
    });
  }
});

// ── Stranded review-worktree disk sweep (#721) ────────────────────────────────

const PARENT = "/home/x/.shepherd-worktrees";
const HEX8 = "deadbeef";
const UUID_TAG = "643cfec7-1234-5678-9abc-def012345678-deadbeef";

/** Terse fake-deps builder. By default: one parent listing `names`, nothing owned,
 *  no live session, scanAlive→all-false, no spawns, now=1_000_000, grace=60_000. */
function mkDeps(overrides: Partial<ReapWorktreesDeps> & { names?: string[] } = {}): {
  deps: ReapWorktreesDeps;
  removed: string[];
} {
  const removed: string[] = [];
  const names = overrides.names ?? [];
  const deps: ReapWorktreesDeps = {
    parents: overrides.parents ?? [PARENT],
    listDir: overrides.listDir ?? (() => names),
    protectedPaths: overrides.protectedPaths ?? new Set(),
    sessionWorktreePaths: overrides.sessionWorktreePaths ?? new Set(),
    scanAlive: overrides.scanAlive ?? ((paths) => new Map(paths.map((p) => [p, false]))),
    listReviewerSpawns: overrides.listReviewerSpawns ?? (() => []),
    now: overrides.now ?? (() => 1_000_000),
    graceMs: overrides.graceMs ?? 60_000,
    // Default to epoch (very old) so age guard never fires → existing reap-tests still reap.
    dirMtime: overrides.dirMtime ?? (() => 0),
    remove: overrides.remove ?? ((p) => void removed.push(p)),
  };
  return { deps, removed };
}

test("stranded reap: dead, unowned, no-spawn review husk is removed", () => {
  const name = `shepherd-review-${HEX8}`;
  const { deps, removed } = mkDeps({ names: [name] });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([`${PARENT}/${name}`]);
  expect(removed).toEqual([`${PARENT}/${name}`]);
  expect(r.sparedOwned).toBe(0);
  expect(r.sparedLive).toBe(0);
});

test("foreign-basename reap: a defunct-repo basename is still selected (basename-agnostic)", () => {
  const name = `flowagent-review-${HEX8}`;
  const { deps, removed } = mkDeps({ names: [name] });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([`${PARENT}/${name}`]);
  expect(removed).toEqual([`${PARENT}/${name}`]);
});

test("uuid-tag reap: a randomUUID-sha8 tag shape is matched and removed", () => {
  const name = `shepherd-review-${UUID_TAG}`;
  const { deps, removed } = mkDeps({ names: [name] });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([`${PARENT}/${name}`]);
  expect(removed).toEqual([`${PARENT}/${name}`]);
});

test("live-claude spare: a candidate hosting a live claude is sparedLive, not removed", () => {
  const name = `shepherd-review-${HEX8}`;
  const path = `${PARENT}/${name}`;
  const { deps, removed } = mkDeps({
    names: [name],
    scanAlive: () => new Map([[path, true]]),
  });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([]);
  expect(removed).toEqual([]);
  expect(r.sparedLive).toBe(1);
  expect(r.sparedOwned).toBe(0);
});

test("protectedPaths spare regardless of age/proc (#631 orphan regression guard)", () => {
  // A re-adopted plan-gate orphan: DEAD reviewer (scanAlive→false) AND an OLD uncompleted
  // reviewer_spawns row — but the service still holds it in memory. MUST be spared.
  const name = `shepherd-review-${HEX8}`;
  const path = `${PARENT}/${name}`;
  const { deps, removed } = mkDeps({
    names: [name],
    protectedPaths: new Set([path]),
    scanAlive: () => new Map([[path, false]]),
    listReviewerSpawns: () => [
      { worktreePath: path, completedAt: null, spawnedAt: 0 }, // ancient, uncompleted
    ],
  });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([]);
  expect(removed).toEqual([]);
  expect(r.sparedOwned).toBe(1);
  expect(r.sparedLive).toBe(0);
});

test("recent-spawn grace: within-grace uncompleted spawn spared; older-than-grace reaped", () => {
  const name = `shepherd-review-${HEX8}`;
  const path = `${PARENT}/${name}`;
  // now=1_000_000, grace=60_000 → cutoff=940_000.
  const recent = mkDeps({
    names: [name],
    listReviewerSpawns: () => [
      { worktreePath: path, completedAt: null, spawnedAt: 950_000 }, // within grace
    ],
  });
  const r1 = reapStaleReviewWorktrees(recent.deps);
  expect(r1.reaped).toEqual([]);
  expect(recent.removed).toEqual([]);
  expect(r1.sparedOwned).toBe(1);

  const stale = mkDeps({
    names: [name],
    listReviewerSpawns: () => [
      { worktreePath: path, completedAt: null, spawnedAt: 900_000 }, // older than grace
    ],
  });
  const r2 = reapStaleReviewWorktrees(stale.deps);
  expect(r2.reaped).toEqual([path]);
  expect(stale.removed).toEqual([path]);
  expect(r2.sparedOwned).toBe(0);
});

test("session spare (guard e): a hex-tag dir backing a live session is spared", () => {
  const name = `shepherd-review-${HEX8}`; // would match the regex
  const path = `${PARENT}/${name}`;
  const { deps, removed } = mkDeps({
    names: [name],
    sessionWorktreePaths: new Set([path]),
  });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([]);
  expect(removed).toEqual([]);
  expect(r.sparedOwned).toBe(1);
});

test("dir-age guard: a too-young (mid-begin) candidate is spared, not reaped (TOCTOU)", () => {
  // now=1_000_000, grace=60_000 → a dir mtime'd at now-grace/2 (970_000) is < graceMs old.
  // It matches the tag regex, is not owned, not alive, has no recent spawn row (the
  // pre-inflight begin() window), yet must be spared by the directory-age guard.
  const name = `shepherd-review-${HEX8}`;
  const { deps, removed } = mkDeps({
    names: [name],
    dirMtime: () => 1_000_000 - 60_000 / 2, // 970_000 — younger than graceMs
  });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([]);
  expect(removed).toEqual([]);
  expect(r.sparedOwned).toBe(1);
  expect(r.sparedLive).toBe(0);
});

test("dir-age guard: an unstattable candidate (dirMtime null) is spared fail-closed", () => {
  const name = `shepherd-review-${HEX8}`;
  const { deps, removed } = mkDeps({
    names: [name],
    dirMtime: () => null, // can't stat → fail closed, spare
  });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([]);
  expect(removed).toEqual([]);
  expect(r.sparedOwned).toBe(1);
  expect(r.sparedLive).toBe(0);
});

test("non-tag-shape user session ignored: non-hex suffix is not a candidate", () => {
  const name = "shepherd-review-myfeature"; // user prompt slugging to review-myfeature
  const { deps, removed } = mkDeps({ names: [name] });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([]);
  expect(removed).toEqual([]);
  expect(r.sparedOwned).toBe(0);
  expect(r.sparedLive).toBe(0);
});

test("non-review dir ignored: a work-issue dir is not a candidate", () => {
  const name = "shepherd-work-issue-721";
  const { deps, removed } = mkDeps({ names: [name] });
  const r = reapStaleReviewWorktrees(deps);
  expect(r.reaped).toEqual([]);
  expect(removed).toEqual([]);
});

test("multi-parent: candidates gathered across two parents", () => {
  const p1 = "/a/.shepherd-worktrees";
  const p2 = "/b/.shepherd-worktrees";
  const n1 = `shepherd-review-${HEX8}`;
  const n2 = `tank-review-cafebabe`;
  const { deps, removed } = mkDeps({
    parents: [p1, p2],
    listDir: (parent) => (parent === p1 ? [n1] : [n2]),
  });
  const r = reapStaleReviewWorktrees(deps);
  expect(new Set(r.reaped)).toEqual(new Set([`${p1}/${n1}`, `${p2}/${n2}`]));
  expect(new Set(removed)).toEqual(new Set([`${p1}/${n1}`, `${p2}/${n2}`]));
});
