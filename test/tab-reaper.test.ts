import { test, expect, describe } from "bun:test";
import {
  reapOrphanTabs,
  reapOrphanTabsLegacy,
  isShepherdHelperLabel,
  type ReapableHerdr,
} from "../src/tab-reaper";
import { PROBE_NAME } from "../src/usage-probe";
import { DISTILL_LABEL } from "../src/distiller";
import type { HerdrAgent, HerdrPane } from "../src/herdr";
import type { HerdrTab } from "../src/herdr";

function agent(terminalId: string, tabId: string): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt",
    name: "x",
    paneId: "p",
    tabId,
    terminalId,
    workspaceId: "w",
  };
}
function tab(tabId: string, label: string): HerdrTab {
  return { tabId, label, agentStatus: "unknown", workspaceId: "w" };
}
function pane(paneId: string, tabId: string, label: string): HerdrPane {
  return { paneId, tabId, label, cwd: "/wt", agentStatus: "unknown" };
}

/** Drives the LEGACY (list-absence) path via `list`/`tabs`. */
function legacyFake(
  agents: HerdrAgent[],
  tabs: HerdrTab[],
): { h: ReapableHerdr; closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    h: {
      list: () => agents,
      tabs: () => tabs,
      closeTab: (id) => void closed.push(id),
      panes: () => [],
      paneForegroundProcs: async () => [],
    },
  };
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
      list: () => {
        throw new Error("list unused on process-info path");
      },
      tabs: () => {
        throw new Error("tabs unused on process-info path");
      },
      closeTab: (id) => void closed.push(id),
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

// ── Legacy path (list-absence) — the herdr ≤0.6 fallback ──────────────────────

test("legacy: reaps probe + review + namer + distill tabs that have no live agent", () => {
  const { h, closed } = legacyFake(
    [agent("term_live", "w:5")], // the one live agent
    [
      tab("w:1", PROBE_NAME),
      tab("w:2", "review TASK-09"),
      tab("w:3", "name TASK-09"), // orphaned background-namer tab
      tab("w:4", DISTILL_LABEL), // orphaned distiller tab
      tab("w:5", "addition-leaky"), // live session tab — backed by an agent
    ],
  );
  const got = reapOrphanTabsLegacy(h);
  expect(new Set(got)).toEqual(new Set(["w:1", "w:2", "w:3", "w:4"]));
  expect(new Set(closed)).toEqual(new Set(["w:1", "w:2", "w:3", "w:4"]));
});

test("legacy: never reaps a labeled tab that still has a live agent (in-progress probe/review)", () => {
  const { h, closed } = legacyFake(
    [agent("term_probe", "w:1")], // probe currently running in w:1
    [tab("w:1", PROBE_NAME)],
  );
  reapOrphanTabsLegacy(h);
  expect(closed).toEqual([]);
});

test("legacy: never touches non-shepherd tabs — incl. user sessions slugged 'usage-probe' / 'distill'", () => {
  // "usage-probe" and "distill" are producible prompt slugs (normalize("usage probe") ===
  // "usage-probe"; slugifyManual("distill") === "distill"); an agentless tab with such a bare
  // slug is a real user session, NOT a helper — must never be reaped. The helpers use the
  // collision-proof __usage_probe__ / __distill__ markers instead.
  const { h, closed } = legacyFake(
    [],
    [tab("w:1", "my editor"), tab("w:2", "usage-probe"), tab("w:3", "distill")],
  );
  reapOrphanTabsLegacy(h);
  expect(closed).toEqual([]);
});

test("legacy: closes highest tab-number first so herdr's renumber-on-close can't drift targets", () => {
  // Documents the herdr ≤0.6 drift-safety guarantee: positional ids (workspace:N)
  // re-densify on close, so closing highest-first keeps each remaining target id valid.
  // Under herdr 0.7 stable ids (w1:tN) tabNumber() returns 0 for all ids, so the
  // descending sort is a no-op — the asserted ordering only holds under ≤0.6.
  const { h, closed } = legacyFake(
    [],
    [tab("w:2", PROBE_NAME), tab("w:10", PROBE_NAME), tab("w:5", "review TASK-1")],
  );
  reapOrphanTabsLegacy(h);
  expect(closed).toEqual(["w:10", "w:5", "w:2"]);
});

test("legacy: reaps 0.7 stable-id husks (w1:tN) and never touches a live tab", () => {
  // herdr 0.7 (#569) introduced stable short handles (w1, w1:t1, w1:p1) that don't
  // renumber on close. Two helper husks with no backing agent must be reaped; the live
  // user tab backed by an agent must never be closed.
  const { h, closed } = legacyFake(
    [agent("term_live", "w1:t3")],
    [
      tab("w1:t1", PROBE_NAME), // orphaned probe husk — no backing agent
      tab("w1:t2", "review TASK-1"), // orphaned review husk — no backing agent
      tab("w1:t3", "my-feature"), // live user tab — backed by an agent
    ],
  );
  const got = reapOrphanTabsLegacy(h);
  expect(new Set(got)).toEqual(new Set(["w1:t1", "w1:t2"]));
  expect(new Set(closed)).toEqual(new Set(["w1:t1", "w1:t2"]));
  expect(closed).not.toContain("w1:t3");
});

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

test("capability fallback: panes() throwing falls back to legacy list-absence reaping", async () => {
  const closed: string[] = [];
  const h: ReapableHerdr = {
    list: () => [agent("term_live", "w:5")],
    tabs: () => [tab("w:1", PROBE_NAME), tab("w:5", "addition-leaky")],
    closeTab: (id) => void closed.push(id),
    panes: () => {
      throw new Error("pane list: unknown subcommand"); // herdr 0.6
    },
    paneForegroundProcs: async () => [],
  };
  const r = await reapOrphanTabs(h);
  expect(r.closed).toEqual(["w:1"]); // husk absent from list
  expect(closed).toEqual(["w:1"]);
  expect(r.sparedLive).toBe(0);
  expect(r.sparedError).toBe(0);
});

describe("isShepherdHelperLabel", () => {
  const trueLabels: [string, string][] = [
    // pre-existing helpers
    [PROBE_NAME, "usage probe (underscore marker)"],
    [DISTILL_LABEL, "distiller (underscore marker)"],
    ["review TASK-09", "critic/code-review"],
    ["name TASK-09", "background namer"],
    // new helpers (#721)
    ["plan-review TASK-09", "plan-gate reviewer"],
    ["pr-critic /home/x/repo#42", "standalone PR critic"],
    ["recap TASK-09", "recap generator"],
    ["rundown", "herd-digest rundown (exact, liveness-gated)"],
    ["autopilot 643cfec7-1234-5678-abcd-ef0123456789", "autopilot LLM"],
    ["verify api key", "API-key verifier (multi-word exact)"],
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
    ["reviewing-pr", "starts with 'review' but no trailing space"],
    ["autopilot-mode", "hyphen instead of space — not an autopilot helper"],
    ["name-my-thing", "hyphen instead of space — not a namer helper"],
  ];

  for (const [label, desc] of falseLabels) {
    test(`false: ${desc} — ${JSON.stringify(label)}`, () => {
      expect(isShepherdHelperLabel(label)).toBe(false);
    });
  }
});
