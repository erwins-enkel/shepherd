import { test, expect } from "bun:test";
import { HerdrDriver, mapState } from "../src/herdr";

const FIXTURE = JSON.stringify({
  result: {
    type: "agent_list",
    agents: [
      {
        agent: "claude",
        agent_status: "working",
        cwd: "/wt/a",
        pane_id: "p1",
        tab_id: "t1",
        terminal_id: "term_a",
        workspace_id: "w1",
      },
      {
        agent: "claude",
        agent_status: "idle",
        cwd: "/wt/b",
        pane_id: "p2",
        tab_id: "t2",
        terminal_id: "term_b",
        workspace_id: "w2",
      },
    ],
  },
});

test("list parses herdr json into typed agents", () => {
  const d = new HerdrDriver(() => FIXTURE);
  const a = d.list();
  expect(a.length).toBe(2);
  expect(a[0]).toMatchObject({ terminalId: "term_a", agentStatus: "working", cwd: "/wt/a" });
});

test("start runs herdr then resolves the new agent by unique cwd", () => {
  const calls: string[][] = [];
  const d = new HerdrDriver((args) => {
    calls.push(args);
    return FIXTURE;
  });
  const agent = d.start("flatten", "/wt/a", ["claude", "--dangerously-skip-permissions", "go"]);
  expect(agent.terminalId).toBe("term_a");
  expect(calls[0]).toEqual([
    "agent",
    "start",
    "flatten",
    "--cwd",
    "/wt/a",
    "--no-focus",
    "--",
    "claude",
    "--dangerously-skip-permissions",
    "go",
  ]);
});

test("mapState maps herdr states to shepherd status", () => {
  expect(mapState("working")).toBe("running");
  expect(mapState("blocked")).toBe("blocked");
  expect(mapState("done")).toBe("done");
  expect(mapState("idle")).toBe("idle");
  expect(mapState("unknown")).toBe("idle");
});
