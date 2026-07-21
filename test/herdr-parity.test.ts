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

/**
 * #1875: the shim points trusted agents at the disk-backed TMPDIR and strips the inherited
 * CLAUDE_CODE_TMPDIR (which claude would double-suffix). These assertions run on the UNWRAPPED
 * (trusted) argv shape — the token is effective ONLY when it directly precedes the agent with no
 * `bwrap --clearenv` between them; asserting it on a bwrap-wrapped argv would falsely pass while the
 * variable is inert inside the sandbox.
 */
describe("buildWrappedArgv — disk TMPDIR redirect (#1875)", () => {
  const KEY = "SHEPHERD_AGENT_TMPDIR";
  function withEnv(val: string | undefined, fn: () => void) {
    const prev = process.env[KEY];
    if (val === undefined) delete process.env[KEY];
    else process.env[KEY] = val;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  it("adds `-u CLAUDE_CODE_TMPDIR` then `TMPDIR=<disk>`, before NODE_COMPILE_CACHE, unwrapped", () => {
    withEnv("/disk/agent", () => {
      const w = buildWrappedArgv(["claude", "go"]);
      expect(w).not.toContain("bwrap"); // trusted/unwrapped shape — where the token is effective
      const uIdx = w.indexOf("-u");
      expect(uIdx).toBeGreaterThan(0);
      expect(w[uIdx + 1]).toBe("CLAUDE_CODE_TMPDIR");
      const tmpIdx = w.indexOf("TMPDIR=/disk/agent");
      const nccIdx = w.findIndex((t) => t.startsWith("NODE_COMPILE_CACHE="));
      expect(tmpIdx).toBeGreaterThan(uIdx);
      expect(tmpIdx).toBeLessThan(nccIdx); // options + TMPDIR precede the other assignments
      expect(w.slice(-2)).toEqual(["claude", "go"]);
    });
  });

  it("omits both the `-u` and the TMPDIR token when disabled (empty string)", () => {
    withEnv("", () => {
      const w = buildWrappedArgv(["claude"]);
      expect(w).not.toContain("-u");
      expect(w.some((t) => t.startsWith("TMPDIR="))).toBe(false);
    });
  });

  it("still strips CLAUDE_CODE_TMPDIR but skips our token when the caller set TMPDIR", () => {
    withEnv("/disk/agent", () => {
      const w = buildWrappedArgv(["claude"], { TMPDIR: "/caller/tmp" });
      expect(w[w.indexOf("-u") + 1]).toBe("CLAUDE_CODE_TMPDIR"); // always strip when enabled
      expect(w).toContain("TMPDIR=/caller/tmp"); // caller's value, via the sorted env tokens
      expect(w).not.toContain("TMPDIR=/disk/agent"); // our token is skipped
    });
  });
});
