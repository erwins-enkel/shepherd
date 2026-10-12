// Operator Assistant lifecycle (#1446): ensure / reset / resume through the SessionService with a
// fake herdr, the 0700 assistant dir, the read-only argv, and the per-task verb fences.
import { test, expect } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { OperatorAssistantSessionError, SessionService } from "../src/service";
import { OPERATOR_ASSISTANT_CAPABILITIES, type AgentCapabilities } from "../src/agent-control";
import { operatorAssistantPermissions } from "../src/operator-assistant-core";
import { SESSION_MARKER_ENV } from "../src/process-reaper";
import { config } from "../src/config";
import type { HerdrAgent } from "../src/herdr";
import type { SpawnDescriptor, SpawnPatch } from "../src/plugins/types";
import type { Session } from "../src/types";

type Start = { name: string; cwd: string; argv: string[]; caps: AgentCapabilities | null };

function harness(
  opts: { transcript?: boolean; runSpawnHooks?: (d: SpawnDescriptor) => Promise<SpawnPatch> } = {},
) {
  const store = new SessionStore(":memory:");
  const dir = join(mkdtempSync(join(tmpdir(), "operator-assistant-")), "assistant");
  const calls = {
    starts: [] as Start[],
    stops: [] as string[],
    trusts: [] as { configPath: string; dir: string }[],
  };
  const fake = {
    agents: [] as HerdrAgent[],
    procs: ["claude"],
    /** When set, every herdr.start waits on it — holds a spawn in flight. */
    gate: null as Promise<void> | null,
  };
  let n = 0;
  const svc: SessionService = new SessionService({
    store,
    namer: async () => "unused",
    transcriptExists: () => opts.transcript ?? true,
    runSpawnHooks: opts.runSpawnHooks,
    operatorAssistantDir: dir,
    trustDir: async (configPath, d) => {
      calls.trusts.push({ configPath, dir: d });
    },
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => {
        throw new Error("the operator assistant never gets a worktree");
      },
      remove: () => {
        throw new Error("the operator assistant has no worktree to remove");
      },
    } as any,
    herdr: {
      start: async (name: string, cwd: string, argv: string[], env: Record<string, string>) => {
        calls.starts.push({
          name,
          cwd,
          argv,
          caps: svc.spawningAgentCapabilities(env[SESSION_MARKER_ENV]!),
        });
        if (fake.gate) await fake.gate;
        n++;
        return { terminalId: `term_${n}`, cwd, agentStatus: "idle", paneId: `p${n}` } as any;
      },
      list: () => fake.agents,
      stop: async (id: string) => {
        calls.stops.push(id);
      },
      paneForegroundProcs: async () => fake.procs,
      closeTab: async () => {},
    } as any,
  });
  /** Make `s`'s pane show up in `herdr agent list` (status `done`: turn over, claude waiting). */
  const live = (s: Session, over: Partial<HerdrAgent> = {}) => {
    fake.agents = [
      {
        agent: "claude",
        agentStatus: "done",
        cwd: s.worktreePath,
        paneId: "p_live",
        tabId: "t_live",
        terminalId: s.herdrAgentId,
        workspaceId: "w",
        ...over,
      },
    ];
  };
  return { store, svc, dir, calls, fake, live };
}

/** The value following `flag` in `argv`. */
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test("ensure creates the assistant: 0700 dir, trust seeded, read-only argv, fenced row", async () => {
  const { store, svc, dir, calls } = harness();
  const s = await svc.ensureOperatorAssistant();

  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(calls.trusts.map((t) => t.dir)).toEqual([dir]);
  expect(calls.starts).toHaveLength(1);
  const { argv, cwd, name } = calls.starts[0]!;
  expect(cwd).toBe(dir);
  expect(name).toBe("operator-assistant");
  expect(argv.slice(0, 2)).toEqual(["claude", "--add-dir"]);
  expect(after(argv, "--session-id")).toBe(s.claudeSessionId);
  expect(after(argv, "--permission-mode")).toBe("default");
  expect(after(argv, "--setting-sources")).toBe("project,local");
  expect(argv).toContain("--strict-mcp-config");
  expect(after(argv, "--mcp-config")).toContain(`/api/sessions/${s.id}/mcp`);
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(JSON.parse(after(argv, "--settings")!).permissions).toEqual(
    operatorAssistantPermissions(),
  );

  expect(s).toMatchObject({
    operatorAssistant: true,
    isolated: false,
    branch: null,
    baseBranch: "",
    prompt: "",
    repoPath: dir,
    worktreePath: dir,
    auto: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoMergeEnabled: false,
    planPhase: null,
    issueNumber: null,
    sandboxApplied: "trusted",
    herdrAgentId: "term_1",
  });
  expect(store.getLiveOperatorAssistant()?.id).toBe(s.id);
});

test("the spawn serves the diagnostic MCP capabilities before the row exists", async () => {
  const { svc, calls } = harness();
  const s = await svc.ensureOperatorAssistant();
  expect(calls.starts[0]!.caps).toEqual(OPERATOR_ASSISTANT_CAPABILITIES);
  expect(svc.spawningAgentCapabilities(s.id)).toBeNull(); // cleared once the row exists
});

test("model and effort are Shepherd's configured Claude defaults", async () => {
  const prev = { model: config.defaultModel, effort: config.defaultClaudeEffort };
  config.defaultModel = "opus";
  config.defaultClaudeEffort = "high";
  try {
    const { svc, calls } = harness();
    const s = await svc.ensureOperatorAssistant();
    expect(calls.starts[0]!.argv.slice(-4)).toEqual(["--model", "opus", "--effort", "high"]);
    expect(s).toMatchObject({ model: "opus", effort: "high" });
  } finally {
    config.defaultModel = prev.model;
    config.defaultClaudeEffort = prev.effort;
  }
});

test("two concurrent ensures spawn once and share the row", async () => {
  const { svc, calls, fake } = harness();
  let release!: () => void;
  fake.gate = new Promise((r) => (release = r));
  const a = svc.ensureOperatorAssistant();
  const b = svc.ensureOperatorAssistant();
  release();
  const [sa, sb] = await Promise.all([a, b]);
  expect(calls.starts).toHaveLength(1);
  expect(sb.id).toBe(sa.id);
});

test("ensure returns the live row without spawning while its claude waits at the prompt", async () => {
  const { svc, calls, live } = harness();
  const s = await svc.ensureOperatorAssistant();
  live(s); // status done = turn finished, NOT dead
  const again = await svc.ensureOperatorAssistant();
  expect(again.id).toBe(s.id);
  expect(calls.starts).toHaveLength(1);
});

test("ensure resumes a gone pane in place with --resume", async () => {
  const { store, svc, calls, fake } = harness();
  const s = await svc.ensureOperatorAssistant();
  fake.agents = []; // herdr lost the pane (restart, closed tab)
  const resumed = await svc.ensureOperatorAssistant();
  expect(resumed.id).toBe(s.id); // same row, same conversation
  expect(calls.starts).toHaveLength(2);
  const argv = calls.starts[1]!.argv;
  expect(after(argv, "--resume")).toBe(s.claudeSessionId);
  expect(argv).not.toContain("--session-id");
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(after(argv, "--permission-mode")).toBe("default");
  expect(store.get(s.id)!.herdrAgentId).toBe("term_2");
});

test("plugin onSpawn hooks never patch the assistant's argv or env, on create or resume", async () => {
  const hooked: SpawnDescriptor[] = [];
  const { svc, calls, fake } = harness({
    runSpawnHooks: async (d) => {
      hooked.push(d);
      return { extraArgs: ["--dangerously-skip-permissions"], env: { PLUGIN_ENV: "1" } };
    },
  });
  await svc.ensureOperatorAssistant();
  fake.agents = []; // force a resume
  await svc.ensureOperatorAssistant();
  expect(calls.starts).toHaveLength(2);
  expect(hooked).toHaveLength(0);
  for (const start of calls.starts)
    expect(start.argv).not.toContain("--dangerously-skip-permissions");
});

test("ensure force-resumes a pane where only a shell is left", async () => {
  const { svc, calls, fake, live } = harness();
  const s = await svc.ensureOperatorAssistant();
  live(s, { agentStatus: "idle" });
  fake.procs = ["zsh"]; // claude exited; herdr kept the tab
  const resumed = await svc.ensureOperatorAssistant();
  expect(resumed.id).toBe(s.id);
  expect(calls.stops).toEqual(["term_1"]); // the husk is torn down first
  expect(after(calls.starts[1]!.argv, "--resume")).toBe(s.claudeSessionId);
});

test("ensure replaces a gone assistant that never had a turn (no transcript to resume)", async () => {
  const { store, svc, calls, fake } = harness({ transcript: false });
  const s = await svc.ensureOperatorAssistant();
  fake.agents = [];
  const fresh = await svc.ensureOperatorAssistant();
  expect(fresh.id).not.toBe(s.id);
  expect(store.get(s.id)!.status).toBe("archived");
  expect(after(calls.starts[1]!.argv, "--session-id")).toBe(fresh.claudeSessionId);
});

test("reset archives the live assistant and spawns a fresh one", async () => {
  const { store, svc, calls } = harness();
  const s = await svc.ensureOperatorAssistant();
  const fresh = await svc.resetOperatorAssistant();
  expect(fresh.id).not.toBe(s.id);
  expect(store.get(s.id)).toMatchObject({ status: "archived", archiveReason: "operator" });
  expect(calls.stops).toContain("term_1");
  expect(store.getLiveOperatorAssistant()?.id).toBe(fresh.id);
  expect(calls.starts).toHaveLength(2);
});

test("a reset requested while ensure is spawning runs after it", async () => {
  const { store, svc, calls, fake } = harness();
  let release!: () => void;
  fake.gate = new Promise((r) => (release = r));
  const ensuring = svc.ensureOperatorAssistant();
  const resetting = svc.resetOperatorAssistant();
  release();
  const [ensured, reset] = await Promise.all([ensuring, resetting]);
  expect(reset.id).not.toBe(ensured.id);
  expect(store.get(ensured.id)!.status).toBe("archived");
  expect(store.getLiveOperatorAssistant()?.id).toBe(reset.id);
  expect(calls.starts).toHaveLength(2);
});

test("a failed spawn leaves no row and frees the next ensure to retry", async () => {
  const { store, svc, calls } = harness();
  const prev = svc["deps"].herdr.start;
  svc["deps"].herdr.start = async () => {
    throw new Error("herdr down");
  };
  await expect(svc.ensureOperatorAssistant()).rejects.toThrow("herdr down");
  expect(store.getLiveOperatorAssistant()).toBeNull();
  svc["deps"].herdr.start = prev;
  await svc.ensureOperatorAssistant();
  expect(calls.starts).toHaveLength(1);
});

test("relaunch, replace, variant and restore refuse the assistant", async () => {
  const { store, svc } = harness();
  const s = await svc.ensureOperatorAssistant();
  await expect(svc.relaunch(s.id)).rejects.toBeInstanceOf(OperatorAssistantSessionError);
  await expect(svc.replaceAgent(s.id, { model: null })).rejects.toBeInstanceOf(
    OperatorAssistantSessionError,
  );
  await expect(svc.startVariant(s.id, { model: null })).rejects.toBeInstanceOf(
    OperatorAssistantSessionError,
  );
  expect(store.get(s.id)!.experimentId).toBeNull(); // refused before the experiment stamp
  store.archive(s.id);
  await expect(svc.restore(s.id)).rejects.toBeInstanceOf(OperatorAssistantSessionError);
});
