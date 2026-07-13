import { test, expect, beforeEach, afterEach } from "bun:test";
import { HerdrDriver, mapState, matchAgent, matchAgents, type HerdrAgent } from "../src/herdr";

// Pin compileCacheDir() to a deterministic sentinel so the `env NODE_COMPILE_CACHE=…`
// shim that start() prepends to every agent argv is assertable.
const NCC_SENTINEL = "/disk/ncc";
let prevNcc: string | undefined;
beforeEach(() => {
  prevNcc = process.env.SHEPHERD_NODE_COMPILE_CACHE;
  process.env.SHEPHERD_NODE_COMPILE_CACHE = NCC_SENTINEL;
});
afterEach(() => {
  if (prevNcc === undefined) delete process.env.SHEPHERD_NODE_COMPILE_CACHE;
  else process.env.SHEPHERD_NODE_COMPILE_CACHE = prevNcc;
});

/** Build a HerdrDriver whose sync AND async runners share ONE fake. The write surface
 *  (start/stop/relabel/closeTab, issue #1553) now runs on the async runner while reads
 *  (list/tabs/panes) stay on the sync one, so a write test must wire both from its fake. */
function mkDriver(fake: (args: string[]) => string): HerdrDriver {
  return new HerdrDriver(fake, async (args) => fake(args));
}

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
        tab_id: "t_new",
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

test("list parses herdr json into typed agents", async () => {
  const d = mkDriver(() => FIXTURE);
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

test("list surfaces the agent name (empty when herdr omits it)", async () => {
  const d = mkDriver(() => FIXTURE);
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

test("start gives each agent its own full-width tab, not a shared split pane", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  const agent = await d.start("flatten", "/wt/a", [
    "claude",
    "--dangerously-skip-permissions",
    "go",
  ]);
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
    "env",
    "NODE_COMPILE_CACHE=/disk/ncc",
    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
    "claude",
    "--dangerously-skip-permissions",
    "go",
  ]);
  // 3) the leftover shell root pane is closed so the agent is the tab's sole,
  //    full-width pane — a split pane would only get ~window/N width (the bug)
  expect(calls[3]).toEqual(["pane", "close", "p_root"]);
});

test("start wraps the agent argv in an `env NODE_COMPILE_CACHE=…` shim (off tmpfs, #560)", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  await d.start("flatten", "/wt/a", ["claude", "--dangerously-skip-permissions", "go"]);
  const startCall = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  const post = startCall.slice(startCall.indexOf("--") + 1);
  // env shim is the first four post-`--` tokens (env + two pinned vars), and claude is
  // still argv[0] after it
  expect(post.slice(0, 4)).toEqual([
    "env",
    "NODE_COMPILE_CACHE=/disk/ncc",
    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
    "claude",
  ]);
});

test("start pins the classic renderer (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1) for every spawn", async () => {
  // Claude Code's fullscreen renderer draws on the alternate screen buffer and captures the
  // mouse; Shepherd's poller/blocked scraping + xterm web terminal assume the classic
  // renderer. The pin forces classic regardless of the operator's persisted `tui` setting or
  // ambient CLAUDE_CODE_NO_FLICKER, so it must be present on EVERY spawned claude.
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  await d.start("flatten", "/wt/a", ["claude", "go"], { CLAUDE_CONFIG_DIR: "/x" });
  const post = extractPost(calls);
  expect(post).toContain("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1");
});

test("start bootstraps a 'shepherd' workspace when herdr has none (fresh/restarted daemon)", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST_EMPTY);
  });
  await d.start("flatten", "/wt/a", ["claude", "go"]);
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

test("stop closes the WHOLE tab backing a terminal id (not just its pane)", async () => {
  // Closing only the pane left an empty husk tab behind — every agent gets its own
  // dedicated tab, so a pane-close leaks the tab. Close the tab to take both down.
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return FIXTURE;
  });
  await d.stop("term_a");
  expect(calls.at(-1)).toEqual(["tab", "close", "t_new"]);
});

test("stop is a no-op for an unknown terminal id", async () => {
  const d = mkDriver(() => FIXTURE);
  await expect(d.stop("term_missing")).resolves.toBeUndefined();
});

test("start rolls back its orphan tab when agent start fails", async () => {
  // tab create succeeds, then `agent start` throws — without rollback the freshly
  // created tab lingers forever with no claude in it ("didn't even launch claude").
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    if (args[0] === "agent" && args[1] === "start") throw new Error("herdr: agent start failed");
    return reply(args, WORKSPACE_LIST);
  });
  await expect(d.start("flatten", "/wt/a", ["claude", "go"])).rejects.toThrow();
  expect(calls).toContainEqual(["tab", "close", "t_new"]);
});

// ── read-back resolve: registration staleness, tab-keying, exhaustion (reviewer-spawn race) ──

const EMPTY_LIST = JSON.stringify({ result: { type: "agent_list", agents: [] } });

test("start: resolve retries until the agent registers (registration staleness)", async () => {
  // `agent start` can return before the agent shows up in `agent list` — the read-back must
  // poll, not fail on the first empty read. Delay 0 keeps the test instant.
  let listCalls = 0;
  const runner = (args: string[]): string => {
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
    if (args[0] === "agent" && args[1] === "start") return "{}";
    if (args[0] === "agent" && args[1] === "list") {
      listCalls++;
      return listCalls < 3 ? EMPTY_LIST : FIXTURE; // empty twice, then the agent (tab t_new)
    }
    return "{}";
  };
  const d = new HerdrDriver(runner, async (a) => runner(a), 5, 0);
  const agent = await d.start("flatten", "/wt/a", ["claude", "go"]);
  expect(agent.terminalId).toBe("term_a");
  expect(listCalls).toBeGreaterThanOrEqual(3); // it polled past the empty reads
});

test("start: resolve is keyed by the created tab, not cwd (no cwd-collision aliasing)", async () => {
  // Two agents share cwd /wt/a; only the one in the tab we created (t_new) is ours. The old
  // cwd `.at(-1)` match could return the wrong (stale) sibling; the tab match cannot.
  const TWO_AT_SAME_CWD = JSON.stringify({
    result: {
      type: "agent_list",
      agents: [
        // ours — in the tab we just created
        {
          agent: "claude",
          agent_status: "working",
          cwd: "/wt/a",
          name: "flatten",
          pane_id: "p1",
          tab_id: "t_new",
          terminal_id: "term_ours",
          workspace_id: "w1",
        },
        // a stale sibling at the same cwd, listed LAST (so `.at(-1)` would have picked it)
        {
          agent: "claude",
          agent_status: "done",
          cwd: "/wt/a",
          name: "stale",
          pane_id: "p9",
          tab_id: "t_old",
          terminal_id: "term_stale",
          workspace_id: "w1",
        },
      ],
    },
  });
  const runner = (args: string[]): string => {
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
    if (args[0] === "agent" && args[1] === "start") return "{}";
    if (args[0] === "agent" && args[1] === "list") return TWO_AT_SAME_CWD;
    return "{}";
  };
  const d = new HerdrDriver(runner, async (a) => runner(a), 5, 0);
  const agent = await d.start("flatten", "/wt/a", ["claude", "go"]);
  expect(agent.terminalId).toBe("term_ours"); // the created tab, not the stale sibling
});

test("start: resolve exhaustion warns distinctly and rolls back the orphan tab", async () => {
  const calls: string[][] = [];
  const runner = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
    if (args[0] === "agent" && args[1] === "start") return "{}";
    if (args[0] === "agent" && args[1] === "list") return EMPTY_LIST; // never registers
    return "{}";
  };
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
  try {
    const d = new HerdrDriver(runner, async (a) => runner(a), 3, 0);
    await expect(d.start("flatten", "/wt/a", ["claude", "go"])).rejects.toThrow(
      /started agent not found for tab t_new/,
    );
  } finally {
    console.warn = origWarn;
  }
  // distinct exhaustion signal (herdr-health), not a silent first-try success
  expect(
    warnings.some((w) => w.includes("agent resolve exhausted after 3 attempts for tab t_new")),
  ).toBe(true);
  expect(calls).toContainEqual(["tab", "close", "t_new"]); // orphan tab rolled back
});

test("start: the read-back runs OUTSIDE the serializer — a slow resolve doesn't block the next start", async () => {
  // If the resolve were inside serializeStart, start #2's orchestration could not begin until
  // start #1's retry finished. Here #1's agent registers only AFTER #2 completes, yet #2 still
  // finishes first — proving the read-back holds no start mutex. (Old in-mutex code deadlocks.)
  let tabSeq = 0;
  let p2done = false;
  const makeTabCreate = (): string => {
    const id = `t_new${++tabSeq}`;
    return JSON.stringify({
      result: {
        type: "tab_created",
        tab: { tab_id: id, workspace_id: "w1" },
        root_pane: { pane_id: `pr${tabSeq}`, tab_id: id },
      },
    });
  };
  const listReply = (): string => {
    const agents: Record<string, string>[] = [
      {
        agent: "claude",
        agent_status: "working",
        cwd: "/wt/b",
        name: "two",
        pane_id: "p2",
        tab_id: "t_new2",
        terminal_id: "term_2",
        workspace_id: "w1",
      },
    ];
    if (p2done)
      agents.unshift({
        agent: "claude",
        agent_status: "working",
        cwd: "/wt/a",
        name: "one",
        pane_id: "p1",
        tab_id: "t_new1",
        terminal_id: "term_1",
        workspace_id: "w1",
      });
    return JSON.stringify({ result: { type: "agent_list", agents } });
  };
  const runner = (args: string[]): string => {
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return makeTabCreate();
    if (args[0] === "agent" && args[1] === "start") return "{}";
    if (args[0] === "agent" && args[1] === "list") return listReply();
    return "{}";
  };
  const d = new HerdrDriver(runner, async (a) => runner(a), 20, 20); // #1 keeps polling ~for a while
  const order: string[] = [];
  const p1 = d.start("one", "/wt/a", ["claude", "go"]).then((a) => {
    order.push("p1");
    return a;
  });
  const p2 = d.start("two", "/wt/b", ["claude", "go"]).then((a) => {
    p2done = true; // #1's agent becomes resolvable only now
    order.push("p2");
    return a;
  });
  const [a1, a2] = await Promise.all([p1, p2]);
  expect(a2.terminalId).toBe("term_2");
  expect(a1.terminalId).toBe("term_1");
  expect(order[0]).toBe("p2"); // #2 finished before #1's retry — resolve is not serialized
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

test("tabs parses herdr tab-list json into typed tabs", async () => {
  const d = new HerdrDriver((args) =>
    args[0] === "tab" && args[1] === "list" ? TAB_LIST : FIXTURE,
  );
  const t = d.tabs();
  expect(t.length).toBe(3);
  expect(t[0]).toMatchObject({ tabId: "w:1", label: "usage-probe", agentStatus: "unknown" });
});

test("closeTab is best-effort: swallows a runner error", async () => {
  const d = mkDriver(() => {
    throw new Error("boom");
  });
  await expect(d.closeTab("w:9")).resolves.toBeUndefined();
});

test("relabel: renames the agent and its tab via the looked-up tabId", async () => {
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
  const h = mkDriver(runner);
  await h.relabel("term_1", "fresh-name");
  expect(calls).toContainEqual(["agent", "rename", "term_1", "fresh-name"]);
  expect(calls).toContainEqual(["tab", "rename", "tab_9", "fresh-name"]);
});

test("relabel: no-op (no throw) when the agent is gone", async () => {
  const runner = (args: string[]) =>
    args[0] === "agent" && args[1] === "list" ? JSON.stringify({ result: { agents: [] } }) : "{}";
  const h = mkDriver(runner);
  await expect(h.relabel("term_gone", "fresh-name")).resolves.toBeUndefined();
});

test("mapState maps herdr states to shepherd status", async () => {
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

test("matchAgent: terminalId fast path wins even if cwd differs", async () => {
  const a = mkAgent({ terminalId: "term_old", cwd: "/elsewhere" });
  expect(matchAgent(sess, [a, mkAgent({ terminalId: "term_x" })])).toBe(a);
});

test("matchAgent: falls back to a single cwd match and ignores the stale id", async () => {
  const a = mkAgent({ terminalId: "term_new", cwd: "/wt/a" });
  expect(matchAgent(sess, [a])).toBe(a);
});

test("matchAgent: cwd shared by 2+ agents → disambiguate by name", async () => {
  const a = mkAgent({ terminalId: "t1", cwd: "/wt/a", name: "alpha" });
  const b = mkAgent({ terminalId: "t2", cwd: "/wt/a", name: "beta" });
  expect(matchAgent(sess, [a, b])).toBe(a);
});

test("matchAgent: cwd ambiguous AND name ambiguous → null", async () => {
  const a = mkAgent({ terminalId: "t1", cwd: "/wt/a", name: "alpha" });
  const b = mkAgent({ terminalId: "t2", cwd: "/wt/a", name: "alpha" });
  expect(matchAgent(sess, [a, b])).toBeNull();
});

test("matchAgent: no terminalId and no cwd match → null", async () => {
  expect(matchAgent(sess, [mkAgent({ terminalId: "t9", cwd: "/other" })])).toBeNull();
});

test("matchAgents: a dead session cannot steal a live sibling's exact-id agent at the same cwd", async () => {
  const live = { id: "L", herdrAgentId: "term_live", worktreePath: "/wt", name: "x" };
  const dead = { id: "D", herdrAgentId: "term_dead", worktreePath: "/wt", name: "x" };
  const agents = [mkAgent({ terminalId: "term_live", cwd: "/wt", name: "x" })];
  const m = matchAgents([live, dead], agents);
  expect(m.get("L")?.terminalId).toBe("term_live");
  expect(m.get("D")).toBeNull();
});

test("matchAgents: each live agent is adopted by at most one session", async () => {
  const a = { id: "A", herdrAgentId: "stale_a", worktreePath: "/wt", name: "alpha" };
  const b = { id: "B", herdrAgentId: "stale_b", worktreePath: "/wt", name: "beta" };
  const agents = [
    mkAgent({ terminalId: "fresh_a", cwd: "/wt", name: "alpha" }),
    mkAgent({ terminalId: "fresh_b", cwd: "/wt", name: "beta" }),
  ];
  const m = matchAgents([a, b], agents);
  expect(m.get("A")?.terminalId).toBe("fresh_a");
  expect(m.get("B")?.terminalId).toBe("fresh_b");
});

test("matchAgents: stale terminalId adopts the fresh agent at the same cwd", async () => {
  const s = { id: "S", herdrAgentId: "stale", worktreePath: "/wt/z", name: "x" };
  const m = matchAgents([s], [mkAgent({ terminalId: "fresh", cwd: "/wt/z", name: "x" })]);
  expect(m.get("S")?.terminalId).toBe("fresh");
});

test("matchAgents: across a herdr restart (all ids stale), a dead session can't steal the live one's agent by shared cwd", async () => {
  // Two non-isolated sessions at the same repo cwd; herdr reassigned every terminalId.
  const dead = { id: "D", herdrAgentId: "old_d", worktreePath: "/repo", name: "dead-task" };
  const live = { id: "L", herdrAgentId: "old_l", worktreePath: "/repo", name: "live-task" };
  const agents = [mkAgent({ terminalId: "fresh_l", cwd: "/repo", name: "live-task" })];
  const m = matchAgents([dead, live], agents); // dead listed first — must NOT win
  expect(m.get("L")?.terminalId).toBe("fresh_l");
  expect(m.get("D")).toBeNull();
});

test("matchAgents: a sole session at its cwd re-pairs even when its name drifted from the agent", async () => {
  // isolated session, unique cwd, herdr agent name no longer matches (relabel had failed).
  const s = { id: "S", herdrAgentId: "stale", worktreePath: "/wt/uniq", name: "new-name" };
  const m = matchAgents([s], [mkAgent({ terminalId: "fresh", cwd: "/wt/uniq", name: "old-name" })]);
  expect(m.get("S")?.terminalId).toBe("fresh");
});

import { maintenance } from "../src/maintenance";
import { HerdrUnavailableError, makeHerdrRunner, isNameTakenError } from "../src/herdr";

test("runner throws fast (no spawn) while maintenance is active", async () => {
  let spawned = 0;
  const runner = makeHerdrRunner(() => {
    spawned++;
    return "{}";
  });
  maintenance.begin();
  try {
    expect(() => runner(["agent", "list"])).toThrow(HerdrUnavailableError);
    expect(spawned).toBe(0); // never reached the exec
  } finally {
    maintenance.end();
  }
});

test("runner delegates to exec when maintenance is inactive", async () => {
  const runner = makeHerdrRunner(() => "ok");
  expect(runner(["agent", "list"])).toBe("ok");
});

import { makeHerdrAsyncRunner } from "../src/herdr";

const READ_REPLY = JSON.stringify({ result: { type: "read", read: { text: "Computing… (3s)" } } });

test("readAsync mirrors read's argv and parses the buffer text", async () => {
  let captured: string[] = [];
  const d = new HerdrDriver(
    () => FIXTURE,
    async (args) => {
      captured = args;
      return READ_REPLY;
    },
  );
  const text = await d.readAsync("term_a", "visible", 200);
  expect(text).toBe("Computing… (3s)");
  expect(captured).toEqual([
    "agent",
    "read",
    "term_a",
    "--format",
    "text",
    "--source",
    "visible",
    "--lines",
    "200",
  ]);
});

test("readAsync returns raw output when the reply is unparseable", async () => {
  const d = new HerdrDriver(
    () => FIXTURE,
    async () => "not json",
  );
  expect(await d.readAsync("term_a")).toBe("not json");
});

test("async runner throws fast (no spawn) while maintenance is active", async () => {
  let spawned = 0;
  const runner = makeHerdrAsyncRunner(async () => {
    spawned++;
    return "{}";
  });
  maintenance.begin();
  try {
    await expect(runner(["agent", "read"])).rejects.toBeInstanceOf(HerdrUnavailableError);
    expect(spawned).toBe(0);
  } finally {
    maintenance.end();
  }
});

// -- env param tests --

function extractPost(calls: string[][]): string[] {
  const startCall = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  return startCall.slice(startCall.indexOf("--") + 1);
}

test("start with no env arg: wrapped portion is exactly [env, NODE_COMPILE_CACHE=…, claude, …]", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  await d.start("flatten", "/wt/a", ["claude", "go"]);
  const post = extractPost(calls);
  expect(post).toEqual([
    "env",
    "NODE_COMPILE_CACHE=/disk/ncc",
    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
    "claude",
    "go",
  ]);
});

test("start with env arg: extra vars appear after NODE_COMPILE_CACHE, sorted by key, before argv", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  await d.start("flatten", "/wt/a", ["claude", "go"], { CLAUDE_CONFIG_DIR: "/x", FOO: "bar" });
  const post = extractPost(calls);
  // Keys sorted: CLAUDE_CONFIG_DIR < FOO; both pinned vars precede caller-supplied env
  expect(post).toEqual([
    "env",
    "NODE_COMPILE_CACHE=/disk/ncc",
    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
    "CLAUDE_CONFIG_DIR=/x",
    "FOO=bar",
    "claude",
    "go",
  ]);
});

test("start with empty env {}: wrapped is identical to no-env case", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  await d.start("flatten", "/wt/a", ["claude", "go"], {});
  const post = extractPost(calls);
  expect(post).toEqual([
    "env",
    "NODE_COMPILE_CACHE=/disk/ncc",
    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
    "claude",
    "go",
  ]);
});

test("start with CLAUDE_CODE_NO_FLICKER env: pin omitted, NO_FLICKER present in wrapped", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  await d.start("flatten", "/wt/a", ["claude", "go"], { CLAUDE_CODE_NO_FLICKER: "1" });
  const post = extractPost(calls);
  expect(post).not.toContain("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1");
  expect(post).toContain("CLAUDE_CODE_NO_FLICKER=1");
});

test("start with CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN env: pin appears exactly once (no duplicate)", async () => {
  const calls: string[][] = [];
  const d = mkDriver((args) => {
    calls.push(args);
    return reply(args, WORKSPACE_LIST);
  });
  await d.start("flatten", "/wt/a", ["claude", "go"], {
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
  });
  const post = extractPost(calls);
  expect(post.filter((t) => t === "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1").length).toBe(1);
});

// -- panes() tests --

const PANE_LIST = JSON.stringify({
  result: {
    type: "pane_list",
    panes: [
      {
        agent_status: "unknown",
        cwd: "/home/patrick",
        focused: false,
        foreground_cwd: "/home/patrick",
        label: "plan-review TASK-368",
        pane_id: "w65:p2",
        revision: 0,
        tab_id: "w65:t2",
        terminal_id: "term_abc",
        workspace_id: "w65",
      },
      {
        agent_status: "working",
        cwd: "/wt/agent",
        focused: true,
        foreground_cwd: "/wt/agent",
        label: "some-task",
        pane_id: "w65:p3",
        revision: 1,
        tab_id: "w65:t3",
        terminal_id: "term_xyz",
        workspace_id: "w65",
      },
    ],
  },
});

const PANE_LIST_MISSING_FIELDS = JSON.stringify({
  result: {
    type: "pane_list",
    panes: [
      {
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        // label, cwd, agent_status intentionally absent
      },
    ],
  },
});

test("panes() parses multi-pane reply into HerdrPane[] with correct field mapping", async () => {
  const d = new HerdrDriver((args) =>
    args[0] === "pane" && args[1] === "list" ? PANE_LIST : FIXTURE,
  );
  const p = d.panes();
  expect(p.length).toBe(2);
  expect(p[0]).toMatchObject({
    paneId: "w65:p2",
    tabId: "w65:t2",
    label: "plan-review TASK-368",
    cwd: "/home/patrick",
    agentStatus: "unknown",
  });
  expect(p[1]).toMatchObject({
    paneId: "w65:p3",
    tabId: "w65:t3",
    label: "some-task",
    cwd: "/wt/agent",
    agentStatus: "working",
  });
});

test("panes() applies defensive defaults when optional fields are absent", async () => {
  const d = new HerdrDriver((args) =>
    args[0] === "pane" && args[1] === "list" ? PANE_LIST_MISSING_FIELDS : FIXTURE,
  );
  const p = d.panes();
  expect(p.length).toBe(1);
  expect(p[0]).toMatchObject({
    paneId: "w1:p1",
    tabId: "w1:t1",
    label: "",
    cwd: "",
    agentStatus: "unknown",
  });
});

test("panes() returns [] when result.panes is absent", async () => {
  const d = new HerdrDriver((args) =>
    args[0] === "pane" && args[1] === "list" ? JSON.stringify({ result: {} }) : FIXTURE,
  );
  expect(d.panes()).toEqual([]);
});

// -- paneForegroundProcs() tests --

const HUSK_PROC_REPLY = JSON.stringify({
  result: {
    process_info: {
      foreground_process_group_id: 4005163,
      foreground_processes: [
        {
          argv: ["/usr/bin/zsh"],
          cmdline: "/usr/bin/zsh",
          cwd: "/home/patrick",
          name: "zsh",
          pid: 4005163,
        },
      ],
      pane_id: "w65:p3",
      shell_pid: 4005163,
    },
    type: "pane_process_info",
  },
});

const LIVE_PROC_REPLY = JSON.stringify({
  result: {
    process_info: {
      foreground_process_group_id: 5001000,
      foreground_processes: [
        { name: "claude", pid: 5001000 },
        { name: "npm", pid: 5001001 },
        { name: "node-MainThread", pid: 5001002 },
      ],
      pane_id: "w65:p4",
      shell_pid: 5000900,
    },
    type: "pane_process_info",
  },
});

test("paneForegroundProcs() returns ['zsh'] for a husk pane", async () => {
  const d = new HerdrDriver(
    () => FIXTURE,
    async (args) => {
      expect(args).toEqual(["pane", "process-info", "--pane", "w65:p3"]);
      return HUSK_PROC_REPLY;
    },
  );
  const procs = await d.paneForegroundProcs("w65:p3");
  expect(procs).toEqual(["zsh"]);
});

test("paneForegroundProcs() returns multi-name list for a live pane", async () => {
  const d = new HerdrDriver(
    () => FIXTURE,
    async () => LIVE_PROC_REPLY,
  );
  const procs = await d.paneForegroundProcs("w65:p4");
  expect(procs).toEqual(["claude", "npm", "node-MainThread"]);
});

test("paneForegroundProcs() returns [] on unparseable reply (JSON parse failure)", async () => {
  const d = new HerdrDriver(
    () => FIXTURE,
    async () => "not valid json at all",
  );
  const procs = await d.paneForegroundProcs("w65:p2");
  expect(procs).toEqual([]);
});

test("paneForegroundProcs() propagates a thrown runner error (does not swallow)", async () => {
  const cliErr = new Error("herdr: unknown subcommand pane process-info");
  const d = new HerdrDriver(
    () => FIXTURE,
    async () => {
      throw cliErr;
    },
  );
  await expect(d.paneForegroundProcs("w65:p2")).rejects.toThrow(
    "herdr: unknown subcommand pane process-info",
  );
});

// -- isNameTakenError unit tests --

const NAME_TAKEN_JSON =
  '{"error":{"code":"agent_name_taken","message":"agent name review TASK-504 is already used; candidates: terminal_id=t1 tab_id=tab_9 status=Unknown"},"id":"cli:agent:start"}';

test("isNameTakenError: true when agent_name_taken appears on .stderr", async () => {
  const err = Object.assign(new Error("herdr CLI error"), { stderr: NAME_TAKEN_JSON });
  expect(isNameTakenError(err)).toBe(true);
});

test("isNameTakenError: true when agent_name_taken appears on .message", async () => {
  const err = new Error(NAME_TAKEN_JSON);
  expect(isNameTakenError(err)).toBe(true);
});

test("isNameTakenError: true when agent_name_taken appears on .stdout", async () => {
  const err = Object.assign(new Error("herdr CLI error"), { stdout: NAME_TAKEN_JSON });
  expect(isNameTakenError(err)).toBe(true);
});

test("isNameTakenError: false for an unrelated error", async () => {
  const err = new Error("herdr: some other failure");
  expect(isNameTakenError(err)).toBe(false);
});

test("isNameTakenError: false for undefined", async () => {
  expect(isNameTakenError(undefined)).toBe(false);
});

test("isNameTakenError: false for null", async () => {
  expect(isNameTakenError(null)).toBe(false);
});

test("isNameTakenError: false for plain string without marker", async () => {
  expect(isNameTakenError("something went wrong")).toBe(false);
});

// -- start() collision-breaker tests --

// Fixture: the squatter agent that holds the name before the retry succeeds
const SQUATTER_LIST = JSON.stringify({
  result: {
    type: "agent_list",
    agents: [
      {
        agent: "claude",
        agent_status: "done",
        cwd: "/wt/a",
        name: "review TASK-504",
        pane_id: "p_sq",
        tab_id: "tab_squatter",
        terminal_id: "term_squatter",
        workspace_id: "w1",
      },
    ],
  },
});

// Agent list after the squatter is evicted: the freshly started agent appears at /wt/a
const POST_EVICT_LIST = JSON.stringify({
  result: {
    type: "agent_list",
    agents: [
      {
        agent: "claude",
        agent_status: "working",
        cwd: "/wt/a",
        name: "review TASK-504",
        pane_id: "p_new",
        tab_id: "t_new",
        terminal_id: "term_started",
        workspace_id: "w1",
      },
    ],
  },
});

function makeNameTakenError(): Error {
  return Object.assign(new Error("herdr CLI error"), { stderr: NAME_TAKEN_JSON });
}

test("start: single collision then success — squatter tab closed, agent returned", async () => {
  const calls: string[][] = [];
  let agentStartAttempts = 0;
  // list() returns squatter on first call (during eviction), then the fresh agent
  let listCallCount = 0;

  const runner = (args: string[]) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
    if (args[0] === "agent" && args[1] === "start") {
      agentStartAttempts++;
      if (agentStartAttempts === 1) throw makeNameTakenError();
      return "{}";
    }
    if (args[0] === "agent" && args[1] === "list") {
      listCallCount++;
      // first list() call is during eviction (resolves squatter), second is the final resolve
      return listCallCount === 1 ? SQUATTER_LIST : POST_EVICT_LIST;
    }
    if (args[0] === "tab" && args[1] === "close") return "{}";
    if (args[0] === "pane" && args[1] === "close") return "{}";
    return "{}";
  };

  const d = mkDriver(runner);
  const agent = await d.start("review TASK-504", "/wt/a", ["claude", "go"]);

  // squatter's tab was closed
  expect(calls).toContainEqual(["tab", "close", "tab_squatter"]);
  // exactly 2 agent start attempts
  expect(agentStartAttempts).toBe(2);
  // returned the newly started agent
  expect(agent.terminalId).toBe("term_started");
});

test("start: two collisions then success — bounded retry recovers, squatter evicted each time", async () => {
  const calls: string[][] = [];
  let agentStartAttempts = 0;
  let listCallCount = 0;

  const runner = (args: string[]) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
    if (args[0] === "agent" && args[1] === "start") {
      agentStartAttempts++;
      if (agentStartAttempts < 3) throw makeNameTakenError();
      return "{}";
    }
    if (args[0] === "agent" && args[1] === "list") {
      listCallCount++;
      // first two list() calls are squatter evictions; third is final resolve
      return listCallCount < 3 ? SQUATTER_LIST : POST_EVICT_LIST;
    }
    if (args[0] === "tab" && args[1] === "close") return "{}";
    if (args[0] === "pane" && args[1] === "close") return "{}";
    return "{}";
  };

  const d = mkDriver(runner);
  const agent = await d.start("review TASK-504", "/wt/a", ["claude", "go"]);

  expect(agentStartAttempts).toBe(3);
  expect(agent.terminalId).toBe("term_started");
  // squatter tab closed at least once (may be twice if it re-appears)
  const closeCalls = calls.filter((c) => c[0] === "tab" && c[1] === "close");
  // the squatter close happened (tab_squatter), created tab NOT closed (no rollback)
  expect(closeCalls.some((c) => c[2] === "tab_squatter")).toBe(true);
  expect(closeCalls.every((c) => c[2] !== "t_new")).toBe(true);
});

test("start: persistent collision exhausts 3 attempts — created tab rolled back, throws", async () => {
  const calls: string[][] = [];
  let agentStartAttempts = 0;

  const runner = (args: string[]) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
    if (args[0] === "agent" && args[1] === "start") {
      agentStartAttempts++;
      throw makeNameTakenError();
    }
    if (args[0] === "agent" && args[1] === "list") return SQUATTER_LIST;
    if (args[0] === "tab" && args[1] === "close") return "{}";
    return "{}";
  };

  const d = mkDriver(runner);
  await expect(d.start("review TASK-504", "/wt/a", ["claude", "go"])).rejects.toThrow();

  // 3 total attempts exhausted
  expect(agentStartAttempts).toBe(3);
  // our freshly created tab (t_new) was rolled back
  expect(calls).toContainEqual(["tab", "close", "t_new"]);
});

test("start: non-name-taken error — no retry, immediate rollback", async () => {
  const calls: string[][] = [];
  let agentStartAttempts = 0;

  const runner = (args: string[]) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return WORKSPACE_LIST;
    if (args[0] === "tab" && args[1] === "create") return TAB_CREATE;
    if (args[0] === "agent" && args[1] === "start") {
      agentStartAttempts++;
      throw new Error("herdr: disk full");
    }
    if (args[0] === "tab" && args[1] === "close") return "{}";
    return "{}";
  };

  const d = mkDriver(runner);
  await expect(d.start("review TASK-504", "/wt/a", ["claude", "go"])).rejects.toThrow(
    "herdr: disk full",
  );

  // only one attempt — no retry for non-name-taken errors
  expect(agentStartAttempts).toBe(1);
  // created tab rolled back
  expect(calls).toContainEqual(["tab", "close", "t_new"]);
});

// ── send (issue #1567) ───────────────────────────────────────────────────────

test("send: issues `agent send <target> <text>` on the ASYNC runner", async () => {
  const calls: string[][] = [];
  const syncCalls: string[][] = [];
  const d = new HerdrDriver(
    (args) => {
      syncCalls.push(args);
      return "{}";
    },
    async (args) => {
      calls.push(args);
      return "{}";
    },
  );

  await d.send("term_a", "hello world");

  expect(calls).toEqual([["agent", "send", "term_a", "hello world"]]);
  // must never block the loop on the sync runner
  expect(syncCalls).toEqual([]);
});

test("send: propagates a runner failure (a dead pane is never a silent no-op)", async () => {
  const d = new HerdrDriver(
    () => "{}",
    async () => {
      throw new Error("herdr: no such agent");
    },
  );

  await expect(d.send("gone", "hi")).rejects.toThrow("herdr: no such agent");
});
