import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SocketHerdrDriver, selectHerdrDriver } from "../src/herdr-socket-driver";
import {
  buildWrappedArgv,
  posixShellJoin,
  sanitizeHerdrAgentName,
  type HerdrDriver,
} from "../src/herdr";
import { HerdrSocketError, type HerdrSocketClient } from "../src/herdr-socket-client";
import { setDetectedHerdrVersion } from "../src/herdr-capabilities";

// ── captured 0.7.5 (protocol 17) reply fixtures (shared with test/herdr-075.test.ts) ────────────
// The socket client returns `res.result`, so the driver receives the INNER result object — unwrap
// the fixtures' `{ result }` envelope here.
const FIX = join(import.meta.dir, "fixtures/herdr-responses/v0.7.5");
const result = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")).result;

/** Fake socket client routing `request`/`requestLegacy` by method to the captured p17 replies.
 *  `agents`/`tabs` override the `agent.list`/`tab.list` bodies; `onReport`/`onSendText` inject faults. */
function mkClient(
  opts: {
    agents?: () => unknown[];
    tabs?: () => unknown[];
    onReport?: () => void;
    onSendText?: () => void;
  } = {},
) {
  const rec: { method: string; params: unknown }[] = [];
  const registered = result("agent-list-registered").agents as unknown[];
  const tabListing = result("tab-list").tabs as unknown[];
  const impl = (method: string, params: unknown): unknown => {
    rec.push({ method, params });
    switch (method) {
      case "workspace.list":
        return result("workspace-list");
      case "workspace.create":
        return { type: "workspace_created" };
      case "tab.create":
        return result("tab-create");
      case "pane.send_text":
        opts.onSendText?.();
        return result("pane-send-text");
      case "pane.send_keys":
        return result("pane-send-keys");
      case "pane.report_agent_session":
        return result("report-agent-session");
      case "pane.report_agent":
        opts.onReport?.();
        return result("report-agent");
      case "agent.list":
        return { type: "agent_list", agents: opts.agents ? opts.agents() : registered };
      case "agent.read":
        return result("agent-read");
      case "tab.list":
        return { type: "tab_list", tabs: opts.tabs ? opts.tabs() : tabListing };
      default:
        return { type: "ok" };
    }
  };
  const client = { request: mock(impl), requestLegacy: mock(impl) } as unknown as HerdrSocketClient;
  return { rec, client };
}

const noCli = {} as unknown as HerdrDriver;

describe("SocketHerdrDriver — 0.7.5 (protocol 17) external-registration spawn", () => {
  let prevNcc: string | undefined;
  let prevAgentTmp: string | undefined;
  beforeEach(() => {
    // Arm the external-registration branch and pin the wrapped-argv env so the `pane.send_text`
    // command-line assertion is deterministic (mirrors test/herdr-075.test.ts).
    setDetectedHerdrVersion("0.7.5");
    prevNcc = process.env.SHEPHERD_NODE_COMPILE_CACHE;
    process.env.SHEPHERD_NODE_COMPILE_CACHE = "/disk/ncc";
    prevAgentTmp = process.env.SHEPHERD_AGENT_TMPDIR;
    process.env.SHEPHERD_AGENT_TMPDIR = "";
  });
  afterEach(() => {
    setDetectedHerdrVersion(null);
    if (prevNcc === undefined) delete process.env.SHEPHERD_NODE_COMPILE_CACHE;
    else process.env.SHEPHERD_NODE_COMPILE_CACHE = prevNcc;
    if (prevAgentTmp === undefined) delete process.env.SHEPHERD_AGENT_TMPDIR;
    else process.env.SHEPHERD_AGENT_TMPDIR = prevAgentTmp;
  });

  it("start() SANDBOXED: runs the wrapped argv in the root pane, registers, resolves by pane_id (no pane.close)", async () => {
    const { rec, client } = mkClient();
    const driver = new SocketHerdrDriver(client, noCli, async () => {});

    // bwrap in argv → sandboxed → herdr can't observe it → must register.
    const agent = await driver.start("review-task-09", "/wt/a", ["bwrap", "--", "claude", "go"]);

    // resolved from agent.list by the pane we ran in — its terminal_id is the id Shepherd keys on
    expect(agent.terminalId).toBe("term_075");
    expect(agent.paneId).toBe("p_075");
    expect(rec.map((r) => r.method)).toEqual([
      "workspace.list",
      "tab.create",
      "pane.send_text",
      "pane.send_keys",
      "pane.report_agent_session",
      "pane.report_agent",
      "agent.list",
    ]);
    // the run reuses the root pane — no leftover shell pane to close
    expect(rec.some((r) => r.method === "pane.close")).toBe(false);

    // the wrapped argv is typed into the root pane as a POSIX-quoted command line, then submitted
    const sendText = rec.find((r) => r.method === "pane.send_text")!.params as {
      pane_id: string;
      text: string;
    };
    expect(sendText.pane_id).toBe("p_075");
    expect(sendText.text).toBe(posixShellJoin(buildWrappedArgv(["bwrap", "--", "claude", "go"])));
    expect(rec.find((r) => r.method === "pane.send_keys")!.params).toEqual({
      pane_id: "p_075",
      keys: ["Enter"],
    });

    // register pair carries the sanitized name + a stable per-pane session id
    expect(rec.find((r) => r.method === "pane.report_agent_session")!.params).toMatchObject({
      pane_id: "p_075",
      source: "shepherd",
      agent: sanitizeHerdrAgentName("review-task-09"),
      agent_session_id: "shepherd-p_075",
    });
    expect(rec.find((r) => r.method === "pane.report_agent")!.params).toMatchObject({
      pane_id: "p_075",
      source: "shepherd",
      agent: sanitizeHerdrAgentName("review-task-09"),
      state: "working",
    });
  });

  it("start() TRUSTED: registers NOTHING and resolves by herdr auto-detection", async () => {
    const { rec, client } = mkClient();
    const driver = new SocketHerdrDriver(client, noCli, async () => {});

    // no bwrap → trusted → herdr auto-detects it → register nothing (a push would freeze it).
    const agent = await driver.start("review-task-09", "/wt/a", ["claude", "go"]);
    expect(agent.terminalId).toBe("term_075");
    expect(rec.some((r) => r.method === "pane.report_agent_session")).toBe(false);
    expect(rec.some((r) => r.method === "pane.report_agent")).toBe(false);
    // still typed the argv + resolved via agent.list
    expect(rec.some((r) => r.method === "pane.send_text")).toBe(true);
    expect(rec.some((r) => r.method === "agent.list")).toBe(true);
  });

  it("start() SANDBOXED: rolls back the freshly created tab when registration fails", async () => {
    const { rec, client } = mkClient({
      onReport: () => {
        throw new HerdrSocketError("report_failed", "boom");
      },
    });
    const driver = new SocketHerdrDriver(client, noCli, async () => {});

    await expect(driver.start("t", "/wt/a", ["bwrap", "--", "claude"])).rejects.toThrow();
    expect(rec).toContainEqual({ method: "tab.close", params: { tab_id: "t_075" } });
  });

  it("start() records the spawn handle: a later stop() closes the recorded tab (agent-list-free)", async () => {
    // tab.list label matches the start name so the recorded-tab-first close fires without agent.list
    const { rec, client } = mkClient({
      tabs: () => [{ tab_id: "t_075", label: "review-task-09" }],
    });
    const driver = new SocketHerdrDriver(client, noCli);
    await driver.start("review-task-09", "/wt/a", ["claude"]);
    const startEnd = rec.length;

    await driver.stop("term_075");

    expect(rec.slice(startEnd).map((r) => r.method)).toEqual(["tab.list", "tab.close"]);
    expect(rec.at(-1)!.params).toEqual({ tab_id: "t_075" });
  });

  it("send() writes literal text to the resolved pane via pane.send_text", async () => {
    const { rec, client } = mkClient();
    const driver = new SocketHerdrDriver(client, noCli);

    await driver.send("term_075", "hello");

    expect(rec.map((r) => r.method)).toEqual(["agent.list", "pane.send_text"]);
    expect(rec[1]!.params).toEqual({ pane_id: "p_075", text: "hello" });
  });

  it("send() maps a lone CR to pane.send_keys Enter", async () => {
    const { rec, client } = mkClient();
    const driver = new SocketHerdrDriver(client, noCli);

    await driver.send("term_075", "\r");

    expect(rec.map((r) => r.method)).toEqual(["agent.list", "pane.send_keys"]);
    expect(rec[1]!.params).toEqual({ pane_id: "p_075", keys: ["Enter"] });
  });

  it("send() throws when the terminal has no live pane (never a silent drop)", async () => {
    const { client } = mkClient({ agents: () => [] });
    const driver = new SocketHerdrDriver(client, noCli);

    await expect(driver.send("gone", "hi")).rejects.toThrow(/no live pane/);
  });

  it("readAsync() resolves the pane_id and reads it", async () => {
    const { rec, client } = mkClient();
    const driver = new SocketHerdrDriver(client, noCli);

    const text = await driver.readAsync("term_075", "visible", 50);

    expect(text).toBe("● Ready.\n> ");
    expect(rec.map((r) => r.method)).toEqual(["agent.list", "agent.read"]);
    expect(rec[1]!.params).toEqual({
      target: "p_075",
      source: "visible",
      lines: 50,
      format: "text",
    });
  });

  it("readAsync() returns '' when the pane is gone", async () => {
    const { client } = mkClient({ agents: () => [] });
    const driver = new SocketHerdrDriver(client, noCli);

    expect(await driver.readAsync("gone")).toBe("");
  });

  it("relabel() renames the pane with a sanitized label and the tab with the raw label", async () => {
    const { rec, client } = mkClient();
    const driver = new SocketHerdrDriver(client, noCli);

    await driver.relabel("term_075", "Fresh Name!");

    expect(rec.map((r) => r.method)).toEqual(["agent.list", "agent.rename", "tab.rename"]);
    expect(rec[1]!.params).toEqual({
      target: "p_075",
      name: sanitizeHerdrAgentName("Fresh Name!"),
    });
    expect(rec[2]!.params).toEqual({ tab_id: "t_075", label: "Fresh Name!" });
  });
});

describe("selectHerdrDriver — protocol 17", () => {
  it("activates the socket driver on protocol 17 via the default supported set", async () => {
    const client = {
      ping: mock(() => Promise.resolve({ protocol: 17 })),
      close: mock(() => undefined),
    };
    const driver = await selectHerdrDriver({
      enabled: true,
      makeCli: () => noCli,
      makeClient: () => client as unknown as HerdrSocketClient,
    });

    expect(driver).toBeInstanceOf(SocketHerdrDriver);
    expect(client.close).not.toHaveBeenCalled();
  });
});
