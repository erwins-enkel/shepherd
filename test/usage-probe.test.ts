import { test, expect } from "bun:test";
import { HerdrUsageProbe, PROBE_NAME } from "../src/usage-probe";
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
// orphaned forever and piled up daily. scrape() now reaps every probe agent (by the reserved
// PROBE_NAME) up front (and on every exit), self-healing past leaks regardless of how the prior
// run died — while leaving every real session strictly alone, INCLUDING one a user happened to
// name "usage-probe" (a producible prompt slug that the old bare-string match would have killed).
test("scrape reaps leftover probe tabs and never touches real sessions", async () => {
  const stopped: string[] = [];
  const agents = [
    agent({ name: PROBE_NAME, terminalId: "old1", paneId: "po1" }),
    agent({ name: PROBE_NAME, terminalId: "old2", paneId: "po2" }),
    agent({ name: "flatten", terminalId: "keep", paneId: "pk" }), // real session
    // a user session whose prompt slugged to the OLD probe string — must survive the reserved-name
    // match (the collision this guards against).
    agent({ name: "usage-probe", terminalId: "user", paneId: "pu" }),
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
  // …real sessions are left alone — the plain one and the "usage-probe"-slugged user session.
  expect(stopped).not.toContain("keep");
  expect(stopped).not.toContain("user");
});
