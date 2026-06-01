import { test, expect } from "bun:test";
import { HerdrUsageProbe } from "../src/usage-probe";
import type { HerdrAgent } from "../src/herdr";

function agent(over: Partial<HerdrAgent>): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "idle",
    cwd: "/repo",
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId: "term",
    workspaceId: "w",
    ...over,
  };
}

// Regression: probes used to leak a herdr tab whenever start() threw *after* `tab create`
// succeeded — the catch returned before the terminalId-based cleanup could run, so the tab was
// orphaned forever and piled up daily. scrape() now reaps every "usage-probe"-named agent up
// front (and on every exit), self-healing past leaks regardless of how the prior run died.
test("scrape reaps leftover usage-probe tabs and never touches real sessions", async () => {
  const stopped: string[] = [];
  const agents = [
    agent({ name: "usage-probe", terminalId: "old1", paneId: "po1" }),
    agent({ name: "usage-probe", terminalId: "old2", paneId: "po2" }),
    agent({ name: "flatten", terminalId: "keep", paneId: "pk" }), // real session
  ];
  const herdr = {
    list: () => agents,
    start: () => {
      throw new Error("agent start failed after tab create");
    },
    stop: (id: string) => {
      stopped.push(id);
    },
  };

  const res = await new HerdrUsageProbe(herdr, "/repo").scrape();

  expect(res).toBeNull();
  // both leftover probes reaped…
  expect(stopped).toContain("old1");
  expect(stopped).toContain("old2");
  // …the real session is left alone.
  expect(stopped).not.toContain("keep");
});
