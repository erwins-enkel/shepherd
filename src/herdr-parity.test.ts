import { describe, expect, it, mock } from "bun:test";
import { HerdrDriver } from "./herdr";
import { SocketHerdrDriver } from "./herdr-socket-driver";
import type { HerdrSocketClient } from "./herdr-socket-client";

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
