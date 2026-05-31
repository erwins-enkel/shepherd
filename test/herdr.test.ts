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
        name: "flatten",
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

const TAB_CREATE = JSON.stringify({
  result: {
    type: "tab_created",
    tab: { tab_id: "t_new", workspace_id: "w1" },
    root_pane: { pane_id: "p_root", tab_id: "t_new", terminal_id: "term_root" },
  },
});

test("list surfaces the agent name (empty when herdr omits it)", () => {
  const d = new HerdrDriver(() => FIXTURE);
  const a = d.list();
  expect(a[0]!.name).toBe("flatten");
  expect(a[1]!.name).toBe(""); // second fixture agent has no name field
});

test("start gives each agent its own full-width tab, not a shared split pane", () => {
  const calls: string[][] = [];
  const d = new HerdrDriver((args) => {
    calls.push(args);
    return args[0] === "tab" && args[1] === "create" ? TAB_CREATE : FIXTURE;
  });
  const agent = d.start("flatten", "/wt/a", ["claude", "--dangerously-skip-permissions", "go"]);
  expect(agent.terminalId).toBe("term_a");
  // 1) a dedicated tab is created first (so the agent isn't split into a shared one)
  expect(calls[0]).toEqual(["tab", "create", "--cwd", "/wt/a", "--label", "flatten", "--no-focus"]);
  // 2) the agent starts INTO that tab
  expect(calls[1]).toEqual([
    "agent",
    "start",
    "flatten",
    "--tab",
    "t_new",
    "--cwd",
    "/wt/a",
    "--no-focus",
    "--",
    "claude",
    "--dangerously-skip-permissions",
    "go",
  ]);
  // 3) the leftover shell root pane is closed so the agent is the tab's sole,
  //    full-width pane — a split pane would only get ~window/N width (the bug)
  expect(calls[2]).toEqual(["pane", "close", "p_root"]);
});

test("stop closes the pane backing a terminal id", () => {
  const calls: string[][] = [];
  const d = new HerdrDriver((args) => {
    calls.push(args);
    return FIXTURE;
  });
  d.stop("term_a");
  expect(calls.at(-1)).toEqual(["pane", "close", "p1"]);
});

test("stop is a no-op for an unknown terminal id", () => {
  const d = new HerdrDriver(() => FIXTURE);
  expect(() => d.stop("term_missing")).not.toThrow();
});

test("mapState maps herdr states to shepherd status", () => {
  expect(mapState("working")).toBe("running");
  expect(mapState("blocked")).toBe("blocked");
  expect(mapState("done")).toBe("done");
  expect(mapState("idle")).toBe("idle");
  expect(mapState("unknown")).toBe("idle");
});
