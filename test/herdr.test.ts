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

// herdr reply for `workspace list` — one workspace exists, so start() skips bootstrap
const WORKSPACE_LIST = JSON.stringify({
  result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "shepherd" }] },
});
// herdr reply for `workspace list` on a fresh/restarted daemon — none yet
const WORKSPACE_LIST_EMPTY = JSON.stringify({
  result: { type: "workspace_list", workspaces: [] },
});

// route a runner's reply by the herdr subcommand it's invoked with
function reply(args: string[], workspaceList: string): string {
  if (args[0] === "workspace" && args[1] === "list") return workspaceList;
  if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
  return FIXTURE;
}

test("start gives each agent its own full-width tab, not a shared split pane", () => {
  const calls: string[][] = [];
  const d = new HerdrDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  const agent = d.start("flatten", "/wt/a", ["claude", "--dangerously-skip-permissions", "go"]);
  expect(agent.terminalId).toBe("term_a");
  // 0) a workspace already exists, so we only check for one — no create
  expect(calls[0]).toEqual(["workspace", "list"]);
  expect(calls.some((c) => c[0] === "workspace" && c[1] === "create")).toBe(false);
  // 1) a dedicated tab is created (so the agent isn't split into a shared one)
  expect(calls[1]).toEqual(["tab", "create", "--cwd", "/wt/a", "--label", "flatten", "--no-focus"]);
  // 2) the agent starts INTO that tab
  expect(calls[2]).toEqual([
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
  expect(calls[3]).toEqual(["pane", "close", "p_root"]);
});

test("start bootstraps a 'shepherd' workspace when herdr has none (fresh/restarted daemon)", () => {
  const calls: string[][] = [];
  const d = new HerdrDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST_EMPTY);
  });
  d.start("flatten", "/wt/a", ["claude", "go"]);
  // with no active workspace, `tab create` would 500 — so we create one first
  expect(calls[0]).toEqual(["workspace", "list"]);
  expect(calls[1]).toEqual([
    "workspace",
    "create",
    "--cwd",
    "/wt/a",
    "--label",
    "shepherd",
    "--no-focus",
  ]);
  // …then the normal tab-create flow proceeds
  expect(calls[2]).toEqual(["tab", "create", "--cwd", "/wt/a", "--label", "flatten", "--no-focus"]);
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
