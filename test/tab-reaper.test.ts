import { test, expect } from "bun:test";
import { reapOrphanTabs, type ReapableHerdr } from "../src/tab-reaper";
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

test("reaps usage-probe + review tabs that have no live agent", () => {
  const { h, closed } = fake(
    [agent("term_live", "w:3")], // the one live agent
    [
      tab("w:1", "usage-probe"),
      tab("w:2", "review TASK-09"),
      tab("w:3", "addition-leaky"), // live session tab — backed by an agent
    ],
  );
  const got = reapOrphanTabs(h);
  expect(new Set(got)).toEqual(new Set(["w:1", "w:2"]));
  expect(new Set(closed)).toEqual(new Set(["w:1", "w:2"]));
});

test("never reaps a labeled tab that still has a live agent (in-progress probe/review)", () => {
  const { h, closed } = fake(
    [agent("term_probe", "w:1")], // probe currently running in w:1
    [tab("w:1", "usage-probe")],
  );
  reapOrphanTabs(h);
  expect(closed).toEqual([]);
});

test("never touches non-shepherd tabs (other labels)", () => {
  const { h, closed } = fake([], [tab("w:1", "my editor"), tab("w:2", "1")]);
  reapOrphanTabs(h);
  expect(closed).toEqual([]);
});

test("closes highest tab-number first so herdr's renumber-on-close can't drift targets", () => {
  // herdr tab_ids are positional (workspace:N) and re-densify when a tab closes;
  // closing the highest number first means each close only shifts already-closed tabs.
  const { h, closed } = fake(
    [],
    [tab("w:2", "usage-probe"), tab("w:10", "usage-probe"), tab("w:5", "review TASK-1")],
  );
  reapOrphanTabs(h);
  expect(closed).toEqual(["w:10", "w:5", "w:2"]);
});
