import { describe, expect, it, mock } from "bun:test";
import { SocketHerdrDriver, selectHerdrDriver } from "../src/herdr-socket-driver";
import type { HerdrDriver, HerdrAgent, HerdrTab, HerdrPane } from "../src/herdr";
import { HerdrSocketError, type HerdrSocketClient } from "../src/herdr-socket-client";

/** Fake client exposing controllable `request` / `requestLegacy` spies routed through the same
 *  `impl`. Cast through `unknown` (no explicit `any`). `requestLegacy` carries the ≤0.7.4
 *  `agent.send` / `agent.start` calls whose shapes the vendored protocol-17 types no longer describe. */
function fakeClient(impl: (method: string, params: unknown) => unknown): HerdrSocketClient {
  return { request: mock(impl), requestLegacy: mock(impl) } as unknown as HerdrSocketClient;
}

/** Fake CLI driver where every `IHerdrDriver` method is a spy. Cast through `unknown`
 *  since the real `HerdrDriver` class has private fields this plain object lacks. */
function fakeCli() {
  return {
    list: mock(() => [] as HerdrAgent[]),
    tabs: mock(() => [] as HerdrTab[]),
    panes: mock(() => [] as HerdrPane[]),
    start: mock(() => ({}) as HerdrAgent),
    send: mock(async () => {}),
    read: mock(() => ""),
    stop: mock(() => undefined),
    relabel: mock(() => undefined),
    closeTab: mock(() => undefined),
  };
}

const agentBody = {
  agents: [
    {
      terminal_id: "t1",
      agent: "claude",
      agent_status: "working",
      cwd: "/repo/worktree",
      name: "TASK-01",
      pane_id: "p1",
      tab_id: "tab1",
      workspace_id: "w1",
    },
  ],
};
const parsedAgent: HerdrAgent = {
  agent: "claude",
  agentStatus: "working",
  cwd: "/repo/worktree",
  name: "TASK-01",
  paneId: "p1",
  tabId: "tab1",
  terminalId: "t1",
  workspaceId: "w1",
};

describe("SocketHerdrDriver — socket-backed async reads", () => {
  it("listAsync() requests agent.list and returns the parsed agents", async () => {
    const client = fakeClient(() => agentBody);
    const cli = fakeCli();
    const driver = new SocketHerdrDriver(client, cli as unknown as HerdrDriver);

    const result = await driver.listAsync();

    expect(result).toEqual([parsedAgent]);
    expect(client.request).toHaveBeenCalledWith("agent.list", {});
  });

  it('readAsync("t","visible",50) requests agent.read and returns result.read.text', async () => {
    const client = fakeClient(() => ({ read: { text: "hello world" } }));
    const cli = fakeCli();
    const driver = new SocketHerdrDriver(client, cli as unknown as HerdrDriver);

    const result = await driver.readAsync("t", "visible", 50);

    expect(result).toBe("hello world");
    expect(client.request).toHaveBeenCalledWith("agent.read", {
      target: "t",
      source: "visible",
      lines: 50,
      format: "text",
    });
  });

  it("paneForegroundProcs(p) requests pane.process_info and returns process names", async () => {
    const client = fakeClient(() => ({
      process_info: { foreground_processes: [{ name: "claude" }, { name: "zsh" }] },
    }));
    const cli = fakeCli();
    const driver = new SocketHerdrDriver(client, cli as unknown as HerdrDriver);

    const result = await driver.paneForegroundProcs("p");

    expect(result).toEqual(["claude", "zsh"]);
    expect(client.request).toHaveBeenCalledWith("pane.process_info", { pane_id: "p" });
  });

  it("paneForegroundProcs(p) propagates a rejected request() (does not swallow)", async () => {
    const client = fakeClient(() => {
      throw new Error("boom");
    });
    const cli = fakeCli();
    const driver = new SocketHerdrDriver(client, cli as unknown as HerdrDriver);

    await expect(driver.paneForegroundProcs("p")).rejects.toThrow("boom");
  });
});

describe("SocketHerdrDriver — delegation to the CLI driver", () => {
  function setup() {
    const client = fakeClient(() => {
      throw new Error("socket must not be used for delegated methods");
    });
    const cli = fakeCli();
    const driver = new SocketHerdrDriver(client, cli as unknown as HerdrDriver);
    return { client, cli, driver };
  }

  it("list() delegates to cli.list()", () => {
    const { client, cli, driver } = setup();
    cli.list.mockReturnValue([parsedAgent]);

    expect(driver.list()).toEqual([parsedAgent]);
    expect(cli.list).toHaveBeenCalledWith();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("read() delegates to cli.read() with forwarded args", () => {
    const { client, cli, driver } = setup();
    cli.read.mockReturnValue("buffer text");

    expect(driver.read("t", "recent", 10)).toBe("buffer text");
    expect(cli.read).toHaveBeenCalledWith("t", "recent", 10);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("tabs() delegates to cli.tabs()", () => {
    const { client, cli, driver } = setup();
    const tabs: HerdrTab[] = [
      { tabId: "tab1", label: "l", agentStatus: "working", workspaceId: "w1" },
    ];
    cli.tabs.mockReturnValue(tabs);

    expect(driver.tabs()).toEqual(tabs);
    expect(cli.tabs).toHaveBeenCalledWith();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("panes() delegates to cli.panes()", () => {
    const { client, cli, driver } = setup();
    const panes: HerdrPane[] = [
      { paneId: "p1", tabId: "tab1", label: "l", cwd: "/c", agentStatus: "working" },
    ];
    cli.panes.mockReturnValue(panes);

    expect(driver.panes()).toEqual(panes);
    expect(cli.panes).toHaveBeenCalledWith();
    expect(client.request).not.toHaveBeenCalled();
  });
});

/** Route a socket `request(method, params)` to the right herdr `result` payload for the
 *  write surface. `recorded` captures the (method, params) sequence for assertions. */
function writeClient(
  recorded: { method: string; params: unknown }[],
  opts: { workspaces?: unknown[]; startResult?: unknown; onAgentStart?: () => void } = {},
): HerdrSocketClient {
  const impl = (method: string, params: unknown): unknown => {
    recorded.push({ method, params });
    switch (method) {
      case "agent.list":
        return agentBody;
      case "workspace.list":
        return { type: "workspace_list", workspaces: opts.workspaces ?? [{ workspace_id: "w1" }] };
      case "workspace.create":
        return { type: "workspace_created" };
      case "tab.create":
        return {
          type: "tab_created",
          tab: { tab_id: "tab_new" },
          root_pane: { pane_id: "p_root" },
        };
      case "agent.start":
        opts.onAgentStart?.();
        return { type: "agent_started", agent: opts.startResult ?? agentBody.agents[0] };
      default:
        return { type: "ok" };
    }
  };
  return { request: mock(impl), requestLegacy: mock(impl) } as unknown as HerdrSocketClient;
}

describe("SocketHerdrDriver — socket-backed async writes (#1553, #1567)", () => {
  it("send() issues agent.send over the socket (no CLI)", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const cli = fakeCli();
    const driver = new SocketHerdrDriver(writeClient(rec), cli as unknown as HerdrDriver);

    await driver.send("t", "hello");

    expect(rec).toEqual([{ method: "agent.send", params: { target: "t", text: "hello" } }]);
    expect(cli.send).not.toHaveBeenCalled();
  });

  it("send() propagates a rejected request() (a failed steer is never silently swallowed)", async () => {
    const client = fakeClient(() => {
      throw new HerdrSocketError("agent_not_found", "no such agent");
    });
    const driver = new SocketHerdrDriver(client, fakeCli() as unknown as HerdrDriver);

    await expect(driver.send("dead", "hi")).rejects.toThrow("no such agent");
  });

  it("closeTab() issues tab.close over the socket (no CLI)", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const cli = fakeCli();
    const driver = new SocketHerdrDriver(writeClient(rec), cli as unknown as HerdrDriver);

    await driver.closeTab("tabX");

    expect(rec).toEqual([{ method: "tab.close", params: { tab_id: "tabX" } }]);
    expect(cli.closeTab).not.toHaveBeenCalled();
  });

  it("stop() resolves the tab from a fresh agent.list, then tab.close", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const driver = new SocketHerdrDriver(writeClient(rec), fakeCli() as unknown as HerdrDriver);

    await driver.stop("t1");

    expect(rec.map((r) => r.method)).toEqual(["agent.list", "tab.close"]);
    expect(rec[1]!.params).toEqual({ tab_id: "tab1" });
  });

  it("stop() is a no-op for an unknown terminal id (no tab.close)", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const driver = new SocketHerdrDriver(writeClient(rec), fakeCli() as unknown as HerdrDriver);

    await driver.stop("t_missing");

    expect(rec.map((r) => r.method)).toEqual(["agent.list"]);
  });

  it("relabel() renames the agent AND its looked-up tab", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const driver = new SocketHerdrDriver(writeClient(rec), fakeCli() as unknown as HerdrDriver);

    await driver.relabel("t1", "fresh");

    expect(rec.map((r) => r.method)).toEqual(["agent.list", "agent.rename", "tab.rename"]);
    expect(rec[1]!.params).toEqual({ target: "t1", name: "fresh" });
    expect(rec[2]!.params).toEqual({ tab_id: "tab1", label: "fresh" });
  });

  it("start() orchestrates workspace.list → tab.create → agent.start → pane.close, resolving from agent_started", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const driver = new SocketHerdrDriver(writeClient(rec), fakeCli() as unknown as HerdrDriver);

    const agent = await driver.start("TASK-01", "/repo/worktree", ["claude", "go"]);

    // resolved DIRECTLY from the agent.start reply — no post-start agent.list
    expect(agent).toEqual(parsedAgent);
    expect(rec.map((r) => r.method)).toEqual([
      "workspace.list",
      "tab.create",
      "agent.start",
      "pane.close",
    ]);
    const startCall = rec.find((r) => r.method === "agent.start")!.params as {
      name: string;
      argv: string[];
      cwd: string;
      tab_id: string;
      focus: boolean;
    };
    expect(startCall.name).toBe("TASK-01");
    expect(startCall.tab_id).toBe("tab_new");
    expect(startCall.cwd).toBe("/repo/worktree");
    expect(startCall.focus).toBe(false);
    // byte-identical wrapped argv (env shim + classic-renderer pin) ends with the raw argv
    expect(startCall.argv[0]).toBe("env");
    expect(startCall.argv.some((t: string) => t.startsWith("NODE_COMPILE_CACHE="))).toBe(true);
    expect(startCall.argv.slice(-2)).toEqual(["claude", "go"]);
  });

  it("start() keeps the root pane for a headless codex exec role", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const driver = new SocketHerdrDriver(writeClient(rec), fakeCli() as unknown as HerdrDriver);

    await driver.start("plan-review TASK-707", "/repo/worktree", [
      "bwrap",
      "--die-with-parent",
      "--",
      "codex",
      "exec",
      "go",
    ]);

    expect(rec.map((r) => r.method)).toEqual(["workspace.list", "tab.create", "agent.start"]);
  });

  it("start() bootstraps a 'shepherd' workspace when herdr has none", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const driver = new SocketHerdrDriver(
      writeClient(rec, { workspaces: [] }),
      fakeCli() as unknown as HerdrDriver,
    );

    await driver.start("TASK-01", "/repo/worktree", ["claude"]);

    expect(rec[0]!.method).toBe("workspace.list");
    expect(rec[1]).toEqual({
      method: "workspace.create",
      params: { cwd: "/repo/worktree", label: "shepherd", focus: false },
    });
  });

  it("start() evicts a same-named squatter on agent_name_taken, then retries", async () => {
    const rec: { method: string; params: unknown }[] = [];
    let attempts = 0;
    const client = writeClient(rec, {
      onAgentStart: () => {
        attempts++;
        if (attempts === 1) throw new HerdrSocketError("agent_name_taken", "name in use");
      },
    });
    const driver = new SocketHerdrDriver(client, fakeCli() as unknown as HerdrDriver);

    const agent = await driver.start("TASK-01", "/repo/worktree", ["claude"]);

    expect(agent).toEqual(parsedAgent);
    expect(attempts).toBe(2);
    // eviction path: after the collision it lists agents by name and closes the squatter's tab
    const methods = rec.map((r) => r.method);
    expect(methods).toContain("agent.list");
    expect(methods).toContain("tab.close");
  });

  it("start() rolls back its freshly created tab on a non-collision failure", async () => {
    const rec: { method: string; params: unknown }[] = [];
    const client = writeClient(rec, {
      onAgentStart: () => {
        throw new HerdrSocketError("spawn_failed", "boom");
      },
    });
    const driver = new SocketHerdrDriver(client, fakeCli() as unknown as HerdrDriver);

    await expect(driver.start("TASK-01", "/repo/worktree", ["claude"])).rejects.toThrow();
    // the orphan tab (tab_new) is closed before the error propagates
    expect(rec).toContainEqual({ method: "tab.close", params: { tab_id: "tab_new" } });
  });

  it("start() is serialized: two concurrent starts don't double-create the workspace", async () => {
    const rec: { method: string; params: unknown }[] = [];
    // Empty workspace list forces a create; a shared mutable flag proves ordering.
    let created = 0;
    const impl = (method: string, params: unknown): unknown => {
      rec.push({ method, params });
      if (method === "workspace.list")
        return { type: "workspace_list", workspaces: created > 0 ? [{ workspace_id: "w1" }] : [] };
      if (method === "workspace.create") {
        created++;
        return { type: "workspace_created" };
      }
      if (method === "tab.create")
        return { type: "tab_created", tab: { tab_id: "tab_new" }, root_pane: { pane_id: "p" } };
      if (method === "agent.start") return { type: "agent_started", agent: agentBody.agents[0] };
      return { type: "ok" };
    };
    const client = {
      request: mock(impl),
      requestLegacy: mock(impl),
    } as unknown as HerdrSocketClient;
    const driver = new SocketHerdrDriver(client, fakeCli() as unknown as HerdrDriver);

    await Promise.all([
      driver.start("A", "/repo/worktree", ["claude"]),
      driver.start("B", "/repo/worktree", ["claude"]),
    ]);

    // Serialized: the first start creates the workspace, the second sees it and does NOT.
    expect(created).toBe(1);
  });
});

describe("SocketHerdrDriver — spawn-handle ledger (#1852)", () => {
  // Transport parity for the recorded-tab-first stop(); the full behavior matrix lives in
  // test/herdr.test.ts — these pin that the socket driver records at start and closes via
  // tab.list verification, agent-list-free on the normal path.

  /** Client whose tab.list / agent.list replies are supplied per test; start() replies
   *  are wired so the ledger records t1 → tab_new under the label "TASK-01". */
  function ledgerClient(tabs: () => unknown[], agents: () => unknown[]) {
    const rec: { method: string; params: unknown }[] = [];
    const impl = (method: string, params: unknown): unknown => {
      rec.push({ method, params });
      switch (method) {
        case "workspace.list":
          return { type: "workspace_list", workspaces: [{ workspace_id: "w1" }] };
        case "tab.create":
          return { type: "tab_created", tab: { tab_id: "tab_new" }, root_pane: { pane_id: "p" } };
        case "agent.start":
          return { type: "agent_started", agent: { ...agentBody.agents[0], tab_id: "tab_new" } };
        case "tab.list":
          return { type: "tab_list", tabs: tabs() };
        case "agent.list":
          return { agents: agents() };
        default:
          return { type: "ok" };
      }
    };
    return {
      rec,
      client: { request: mock(impl), requestLegacy: mock(impl) } as unknown as HerdrSocketClient,
    };
  }

  it("tabsAsync() requests tab.list and returns the parsed tabs", async () => {
    const client = fakeClient(() => ({
      tabs: [{ tab_id: "w:1", label: "recap TASK-2", agent_status: "unknown", workspace_id: "w" }],
    }));
    const driver = new SocketHerdrDriver(client, fakeCli() as unknown as HerdrDriver);

    expect(await driver.tabsAsync()).toEqual([
      { tabId: "w:1", label: "recap TASK-2", agentStatus: "unknown", workspaceId: "w" },
    ]);
    expect(client.request).toHaveBeenCalledWith("tab.list", {});
  });

  it("stop() closes the spawn-recorded tab with zero agent.list calls when the agent is gone", async () => {
    const { rec, client } = ledgerClient(
      () => [{ tab_id: "tab_new", label: "TASK-01" }],
      () => [], // helper exited — absent from agent.list; only its husk tab remains
    );
    const driver = new SocketHerdrDriver(client, fakeCli() as unknown as HerdrDriver);
    await driver.start("TASK-01", "/repo/worktree", ["claude", "go"]);
    const startEnd = rec.length;

    await driver.stop("t1");

    expect(rec.slice(startEnd).map((r) => r.method)).toEqual(["tab.list", "tab.close"]);
    expect(rec.at(-1)!.params).toEqual({ tab_id: "tab_new" });
  });

  it("stop() spares a label-mismatched recorded tab and falls back to agent.list truth", async () => {
    const { rec, client } = ledgerClient(
      () => [{ tab_id: "tab_new", label: "someone-elses-session" }],
      () => [{ terminal_id: "t1", tab_id: "tab_current" }],
    );
    const driver = new SocketHerdrDriver(client, fakeCli() as unknown as HerdrDriver);
    await driver.start("TASK-01", "/repo/worktree", ["claude", "go"]);
    const startEnd = rec.length;

    await driver.stop("t1");

    const stopCalls = rec.slice(startEnd);
    expect(stopCalls.map((r) => r.method)).toEqual(["tab.list", "agent.list", "tab.close"]);
    expect(stopCalls.at(-1)!.params).toEqual({ tab_id: "tab_current" });
  });
});

/** Fake socket client exposing controllable `ping`/`close` spies for `selectHerdrDriver`. */
function fakePingClient(impl: () => Promise<{ protocol: number }>) {
  return {
    ping: mock(impl),
    close: mock(() => undefined),
  };
}

describe("selectHerdrDriver", () => {
  it("enabled:false returns the cli instance; makeClient never called", async () => {
    const cliInstance = fakeCli() as unknown as HerdrDriver;
    const makeCli = mock(() => cliInstance);
    const makeClient = mock(
      () => fakePingClient(() => Promise.resolve({ protocol: 16 })) as unknown as HerdrSocketClient,
    );

    const driver = await selectHerdrDriver({ enabled: false, makeCli, makeClient });

    expect(driver).toBe(cliInstance);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("enabled:true, supported protocol returns a SocketHerdrDriver; client.close NOT called", async () => {
    const cliInstance = fakeCli() as unknown as HerdrDriver;
    const client = fakePingClient(() => Promise.resolve({ protocol: 16 }));
    const makeCli = mock(() => cliInstance);
    const makeClient = mock(() => client as unknown as HerdrSocketClient);

    const driver = await selectHerdrDriver({
      enabled: true,
      supportedProtocols: new Set([16]),
      makeCli,
      makeClient,
    });

    expect(driver).toBeInstanceOf(SocketHerdrDriver);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("enabled:true, unsupported protocol returns the cli; client.close called once", async () => {
    const cliInstance = fakeCli() as unknown as HerdrDriver;
    const client = fakePingClient(() => Promise.resolve({ protocol: 99 }));
    const makeCli = mock(() => cliInstance);
    const makeClient = mock(() => client as unknown as HerdrSocketClient);

    const driver = await selectHerdrDriver({
      enabled: true,
      supportedProtocols: new Set([16]),
      makeCli,
      makeClient,
    });

    expect(driver).toBe(cliInstance);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("enabled:true, ping rejects returns the cli; client.close called once", async () => {
    const cliInstance = fakeCli() as unknown as HerdrDriver;
    const client = fakePingClient(() => Promise.reject(new Error("no socket")));
    const makeCli = mock(() => cliInstance);
    const makeClient = mock(() => client as unknown as HerdrSocketClient);

    const driver = await selectHerdrDriver({
      enabled: true,
      supportedProtocols: new Set([16]),
      makeCli,
      makeClient,
    });

    expect(driver).toBe(cliInstance);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
