import { test, expect, describe } from "bun:test";
import {
  reapOrphanTabs,
  isShepherdHelperLabel,
  reapStaleReviewWorktrees,
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

test("panes() throwing fails closed — reaps nothing, preserves debounce state", async () => {
  const { h, closed } = procFake([], {}, { panesThrows: true });
  const r = await reapOrphanTabs(h, new Set(["w1:t1"]));
  expect(r.closed).toEqual([]);
  expect(closed).toEqual([]);
  expect(r.sparedLive).toBe(0);
  expect(r.sparedError).toBe(0);
  expect(r.shellOnly).toEqual(new Set(["w1:t1"])); // debounce state preserved
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
