import { describe, expect, it, mock } from "bun:test";
import { HerdrDriver, buildWrappedArgv, parseAgentInfo, parseAgents } from "../src/herdr";
import { SocketHerdrDriver } from "../src/herdr-socket-driver";
import type { HerdrSocketClient } from "../src/herdr-socket-client";

/**
 * Guards against the CLI and socket drivers' shared `parseAgents` ever diverging: both
 * paths must map the SAME herdr `agent list` body to an IDENTICAL `HerdrAgent[]`.
 */
describe("CLI/socket parity — agent list", () => {
  it("HerdrDriver.list() and SocketHerdrDriver.listAsync() agree on the same body", async () => {
    const body = {
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
        {
          terminal_id: "t2",
          agent: "claude",
          agent_status: "blocked",
          cwd: "/repo/other",
          name: "",
          pane_id: "p2",
          tab_id: "tab2",
          workspace_id: "w1",
        },
      ],
    };

    const cli = new HerdrDriver(
      () => JSON.stringify({ result: body }),
      async () => JSON.stringify({ result: body }),
    );
    const cliResult = cli.list();

    const client = { request: mock(() => body) } as unknown as HerdrSocketClient;
    const socketDriver = new SocketHerdrDriver(client, cli);
    const socketResult = await socketDriver.listAsync();

    expect(socketResult).toEqual(cliResult);
  });
});

/**
 * `parseAgentInfo` (socket `start` resolves from the `agent.start` reply) must map a single
 * AgentInfo IDENTICALLY to how `parseAgents` maps that same object as a list element — so the
 * socket `start`'s no-relist resolution can never diverge from the list path's field mapping.
 */
describe("CLI/socket parity — parseAgentInfo ≡ parseAgents (per element)", () => {
  it("maps one AgentInfo the same as the list mapping", () => {
    const raw = {
      terminal_id: "term_x",
      agent: "claude",
      agent_status: "working",
      cwd: "/wt/a",
      name: "TASK-07",
      pane_id: "p9",
      tab_id: "tab9",
      workspace_id: "w1",
    };
    expect(parseAgentInfo(raw)).toEqual(parseAgents({ agents: [raw] })[0]!);
  });

  it("fills required-string fields with '' when herdr omits them (same as parseAgents)", () => {
    const raw = { terminal_id: "t0" };
    expect(parseAgentInfo(raw)).toEqual(parseAgents({ agents: [raw] })[0]!);
    expect(parseAgentInfo(raw).name).toBe("");
  });
});

/**
 * `buildWrappedArgv` is the single source of the spawned process's argv, shared by BOTH
 * drivers so a socket `start` spawns a byte-identical process to the CLI path.
 */
describe("buildWrappedArgv — shared spawn argv", () => {
  it("wraps argv in the env shim + classic-renderer pin, argv last", () => {
    const w = buildWrappedArgv(["claude", "go"]);
    expect(w[0]).toBe("env");
    expect(w).toContain("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1");
    expect(w.slice(-2)).toEqual(["claude", "go"]);
  });

  it("injects caller env sorted by key, and omits the pin when the caller set a renderer", () => {
    const w = buildWrappedArgv(["claude"], { FOO: "b", CLAUDE_CODE_NO_FLICKER: "1" });
    expect(w).not.toContain("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1");
    expect(w).toContain("CLAUDE_CODE_NO_FLICKER=1");
    // sorted-key order: CLAUDE_CODE_NO_FLICKER < FOO
    expect(w.indexOf("CLAUDE_CODE_NO_FLICKER=1")).toBeLessThan(w.indexOf("FOO=b"));
  });
});
