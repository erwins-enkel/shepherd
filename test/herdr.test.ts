import { test, expect } from "bun:test";
import { HerdrDriver, mapState, matchAgent, type HerdrAgent } from "../src/herdr";

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

test("stop closes the WHOLE tab backing a terminal id (not just its pane)", () => {
  // Closing only the pane left an empty husk tab behind — every agent gets its own
  // dedicated tab, so a pane-close leaks the tab. Close the tab to take both down.
  const calls: string[][] = [];
  const d = new HerdrDriver((args) => {
    calls.push(args);
    return FIXTURE;
  });
  d.stop("term_a");
  expect(calls.at(-1)).toEqual(["tab", "close", "t1"]);
});

test("stop is a no-op for an unknown terminal id", () => {
  const d = new HerdrDriver(() => FIXTURE);
  expect(() => d.stop("term_missing")).not.toThrow();
});

test("start rolls back its orphan tab when agent start fails", () => {
  // tab create succeeds, then `agent start` throws — without rollback the freshly
  // created tab lingers forever with no claude in it ("didn't even launch claude").
  const calls: string[][] = [];
  const d = new HerdrDriver((args) => {
    calls.push(args);
    if (args[0] === "agent" && args[1] === "start") throw new Error("herdr: agent start failed");
    return reply(args, WORKSPACE_LIST);
  });
  expect(() => d.start("flatten", "/wt/a", ["claude", "go"])).toThrow();
  expect(calls).toContainEqual(["tab", "close", "t_new"]);
});

const TAB_LIST = JSON.stringify({
  result: {
    type: "tab_list",
    tabs: [
      { tab_id: "w:1", label: "usage-probe", agent_status: "unknown", workspace_id: "w" },
      { tab_id: "w:2", label: "review TASK-09", agent_status: "unknown", workspace_id: "w" },
      { tab_id: "w:3", label: "addition-leaky", agent_status: "working", workspace_id: "w" },
    ],
  },
});

test("tabs parses herdr tab-list json into typed tabs", () => {
  const d = new HerdrDriver((args) =>
    args[0] === "tab" && args[1] === "list" ? TAB_LIST : FIXTURE,
  );
  const t = d.tabs();
  expect(t.length).toBe(3);
  expect(t[0]).toMatchObject({ tabId: "w:1", label: "usage-probe", agentStatus: "unknown" });
});

test("closeTab is best-effort: swallows a runner error", () => {
  const d = new HerdrDriver(() => {
    throw new Error("boom");
  });
  expect(() => d.closeTab("w:9")).not.toThrow();
});

test("relabel: renames the agent and its tab via the looked-up tabId", () => {
  const calls: string[][] = [];
  const runner = (args: string[]) => {
    calls.push(args);
    if (args[0] === "agent" && args[1] === "list") {
      return JSON.stringify({
        result: { agents: [{ terminal_id: "term_1", tab_id: "tab_9", name: "old-name" }] },
      });
    }
    return "{}";
  };
  const h = new HerdrDriver(runner);
  h.relabel("term_1", "fresh-name");
  expect(calls).toContainEqual(["agent", "rename", "term_1", "fresh-name"]);
  expect(calls).toContainEqual(["tab", "rename", "tab_9", "fresh-name"]);
});

test("relabel: no-op (no throw) when the agent is gone", () => {
  const runner = (args: string[]) =>
    args[0] === "agent" && args[1] === "list" ? JSON.stringify({ result: { agents: [] } }) : "{}";
  const h = new HerdrDriver(runner);
  expect(() => h.relabel("term_gone", "fresh-name")).not.toThrow();
});

test("mapState maps herdr states to shepherd status", () => {
  expect(mapState("working")).toBe("running");
  expect(mapState("blocked")).toBe("blocked");
  expect(mapState("done")).toBe("done");
  expect(mapState("idle")).toBe("idle");
  expect(mapState("unknown")).toBe("idle");
});

const mkAgent = (over: Partial<HerdrAgent>) =>
  ({
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt/a",
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId: "term_x",
    workspaceId: "w",
    ...over,
  }) as HerdrAgent;

const sess = { herdrAgentId: "term_old", worktreePath: "/wt/a", name: "alpha" };

test("matchAgent: terminalId fast path wins even if cwd differs", () => {
  const a = mkAgent({ terminalId: "term_old", cwd: "/elsewhere" });
  expect(matchAgent(sess, [a, mkAgent({ terminalId: "term_x" })])).toBe(a);
});

test("matchAgent: falls back to a single cwd match and ignores the stale id", () => {
  const a = mkAgent({ terminalId: "term_new", cwd: "/wt/a" });
  expect(matchAgent(sess, [a])).toBe(a);
});

test("matchAgent: cwd shared by 2+ agents → disambiguate by name", () => {
  const a = mkAgent({ terminalId: "t1", cwd: "/wt/a", name: "alpha" });
  const b = mkAgent({ terminalId: "t2", cwd: "/wt/a", name: "beta" });
  expect(matchAgent(sess, [a, b])).toBe(a);
});

test("matchAgent: cwd ambiguous AND name ambiguous → null", () => {
  const a = mkAgent({ terminalId: "t1", cwd: "/wt/a", name: "alpha" });
  const b = mkAgent({ terminalId: "t2", cwd: "/wt/a", name: "alpha" });
  expect(matchAgent(sess, [a, b])).toBeNull();
});

test("matchAgent: no terminalId and no cwd match → null", () => {
  expect(matchAgent(sess, [mkAgent({ terminalId: "t9", cwd: "/other" })])).toBeNull();
});
