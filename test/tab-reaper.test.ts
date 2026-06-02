import { test, expect } from "bun:test";
import { reapOrphanTabs, type ReapableHerdr } from "../src/tab-reaper";
import { PROBE_NAME } from "../src/usage-probe";
import type { HerdrAgent } from "../src/herdr";
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

function fake(agents: HerdrAgent[], tabs: HerdrTab[]): { h: ReapableHerdr; closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    h: {
      list: () => agents,
      tabs: () => tabs,
      closeTab: (id) => void closed.push(id),
    },
  };
}

test("reaps probe + review + namer tabs that have no live agent", () => {
  const { h, closed } = fake(
    [agent("term_live", "w:4")], // the one live agent
    [
      tab("w:1", PROBE_NAME),
      tab("w:2", "review TASK-09"),
      tab("w:3", "name TASK-09"), // orphaned background-namer tab
      tab("w:4", "addition-leaky"), // live session tab — backed by an agent
    ],
  );
  const got = reapOrphanTabs(h);
  expect(new Set(got)).toEqual(new Set(["w:1", "w:2", "w:3"]));
  expect(new Set(closed)).toEqual(new Set(["w:1", "w:2", "w:3"]));
});

test("never reaps a labeled tab that still has a live agent (in-progress probe/review)", () => {
  const { h, closed } = fake(
    [agent("term_probe", "w:1")], // probe currently running in w:1
    [tab("w:1", PROBE_NAME)],
  );
  reapOrphanTabs(h);
  expect(closed).toEqual([]);
});

test("never touches non-shepherd tabs — incl. a user session slugged 'usage-probe'", () => {
  // "usage-probe" is a producible prompt slug (normalize("usage probe") === "usage-probe"); an
  // agentless tab with that label is a real user session, NOT a probe — must never be reaped.
  const { h, closed } = fake([], [tab("w:1", "my editor"), tab("w:2", "usage-probe")]);
  reapOrphanTabs(h);
  expect(closed).toEqual([]);
});

test("closes highest tab-number first so herdr's renumber-on-close can't drift targets", () => {
  // herdr tab_ids are positional (workspace:N) and re-densify when a tab closes;
  // closing the highest number first means each close only shifts already-closed tabs.
  const { h, closed } = fake(
    [],
    [tab("w:2", PROBE_NAME), tab("w:10", PROBE_NAME), tab("w:5", "review TASK-1")],
  );
  reapOrphanTabs(h);
  expect(closed).toEqual(["w:10", "w:5", "w:2"]);
});
