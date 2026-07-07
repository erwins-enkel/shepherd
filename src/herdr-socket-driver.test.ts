import { describe, expect, it, mock } from "bun:test";
import { SocketHerdrDriver, selectHerdrDriver } from "./herdr-socket-driver";
import type { HerdrDriver, HerdrAgent, HerdrTab, HerdrPane } from "./herdr";
import type { HerdrSocketClient } from "./herdr-socket-client";

/** Fake client exposing a controllable `request` spy. Cast through `unknown` (no
 *  explicit `any`) since the driver only ever calls `.request(...)` on it. */
function fakeClient(impl: (method: string, params: unknown) => unknown): HerdrSocketClient {
  return { request: mock(impl) } as unknown as HerdrSocketClient;
}

/** Fake CLI driver where every `IHerdrDriver` method is a spy. Cast through `unknown`
 *  since the real `HerdrDriver` class has private fields this plain object lacks. */
function fakeCli() {
  return {
    list: mock(() => [] as HerdrAgent[]),
    tabs: mock(() => [] as HerdrTab[]),
    panes: mock(() => [] as HerdrPane[]),
    start: mock(() => ({}) as HerdrAgent),
    send: mock(() => undefined),
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

  it("start() delegates to cli.start() with forwarded args", () => {
    const { client, cli, driver } = setup();
    cli.start.mockReturnValue(parsedAgent);

    const env = { FOO: "bar" };
    expect(driver.start("name", "/cwd", ["claude"], env)).toEqual(parsedAgent);
    expect(cli.start).toHaveBeenCalledWith("name", "/cwd", ["claude"], env);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("send() delegates to cli.send() with forwarded args", () => {
    const { client, cli, driver } = setup();

    driver.send("t", "hello");

    expect(cli.send).toHaveBeenCalledWith("t", "hello");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("stop() delegates to cli.stop() with forwarded args", () => {
    const { client, cli, driver } = setup();

    driver.stop("t1");

    expect(cli.stop).toHaveBeenCalledWith("t1");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("relabel() delegates to cli.relabel() with forwarded args", () => {
    const { client, cli, driver } = setup();

    driver.relabel("t1", "new name");

    expect(cli.relabel).toHaveBeenCalledWith("t1", "new name");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("closeTab() delegates to cli.closeTab() with forwarded args", () => {
    const { client, cli, driver } = setup();

    driver.closeTab("tab1");

    expect(cli.closeTab).toHaveBeenCalledWith("tab1");
    expect(client.request).not.toHaveBeenCalled();
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
