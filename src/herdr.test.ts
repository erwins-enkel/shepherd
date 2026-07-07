import { describe, expect, it } from "bun:test";
import { HerdrDriver, parseAgents, parseProcs, parseReadText } from "./herdr";

// ── parseAgents ──────────────────────────────────────────────────────────────

describe("parseAgents", () => {
  it("maps a representative result.agents payload to HerdrAgent[]", () => {
    const result = {
      type: "agent_list",
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
    expect(parseAgents(result)).toEqual([
      {
        agent: "claude",
        agentStatus: "working",
        cwd: "/repo/worktree",
        name: "TASK-01",
        paneId: "p1",
        tabId: "tab1",
        terminalId: "t1",
        workspaceId: "w1",
      },
    ]);
  });

  it("returns [] for missing/empty result", () => {
    expect(parseAgents(undefined)).toEqual([]);
    expect(parseAgents(null)).toEqual([]);
    expect(parseAgents({})).toEqual([]);
    expect(parseAgents({ agents: [] })).toEqual([]);
  });
});

// ── parseReadText ────────────────────────────────────────────────────────────

describe("parseReadText", () => {
  it("returns result.read.text", () => {
    expect(parseReadText({ type: "pane_read", read: { text: "hello world" } })).toBe("hello world");
  });

  it('returns "" when absent', () => {
    expect(parseReadText(undefined)).toBe("");
    expect(parseReadText({})).toBe("");
    expect(parseReadText({ read: {} })).toBe("");
  });
});

// ── parseProcs ───────────────────────────────────────────────────────────────

describe("parseProcs", () => {
  it("maps foreground_processes[].name", () => {
    const result = {
      type: "pane_process_info",
      process_info: {
        foreground_processes: [
          { name: "claude", pid: 123 },
          { name: "zsh", pid: 456 },
        ],
      },
    };
    expect(parseProcs(result)).toEqual(["claude", "zsh"]);
  });

  it("returns [] when absent", () => {
    expect(parseProcs(undefined)).toEqual([]);
    expect(parseProcs({})).toEqual([]);
    expect(parseProcs({ process_info: {} })).toEqual([]);
  });
});

// ── HerdrDriver.listAsync ────────────────────────────────────────────────────

describe("HerdrDriver.listAsync", () => {
  it("resolves to the parsed HerdrAgent[] from an injected asyncRunner", async () => {
    const canned = JSON.stringify({
      id: 1,
      result: {
        type: "agent_list",
        agents: [
          {
            terminal_id: "t2",
            agent: "claude",
            agent_status: "blocked",
            cwd: "/repo/other",
            name: "TASK-02",
            pane_id: "p2",
            tab_id: "tab2",
            workspace_id: "w2",
          },
        ],
      },
    });
    const fakeRunner = () => {
      throw new Error("sync runner must not be called by listAsync");
    };
    const fakeAsyncRunner = async (args: string[]) => {
      expect(args).toEqual(["agent", "list"]);
      return canned;
    };
    const driver = new HerdrDriver(fakeRunner, fakeAsyncRunner);
    await expect(driver.listAsync()).resolves.toEqual([
      {
        agent: "claude",
        agentStatus: "blocked",
        cwd: "/repo/other",
        name: "TASK-02",
        paneId: "p2",
        tabId: "tab2",
        terminalId: "t2",
        workspaceId: "w2",
      },
    ]);
  });
});
