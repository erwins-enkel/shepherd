// Operator Assistant lifecycle (#1446): ensure / reset / close / resume through the SessionService
// with a fake herdr, the 0700 assistant dir, the read-only argv, the per-task verb fences, and the
// repo scopes (one global assistant plus one per repo).
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrowserTokenSigner } from "../src/browser-token";
import { SessionStore } from "../src/store";
import {
  OperatorAssistantNotFoundError,
  OperatorAssistantSessionError,
  SessionService,
} from "../src/service";
import { OPERATOR_ASSISTANT_CAPABILITIES, type AgentCapabilities } from "../src/agent-control";
import { operatorAssistantPermissions } from "../src/operator-assistant-core";
import {
  assistantPermissionRules,
  DEFAULT_ASSISTANT_PERMISSIONS,
} from "../src/operator-assistant-permissions";
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
  const spawnDir = join(dirname(dir), "assistant-spawn");
  const signer = new BrowserTokenSigner(Buffer.alloc(32, 7));
  const svc: SessionService = new SessionService({
    store,
    assistantSpawnDir: spawnDir,
    assistantIngress: signer,
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
      listAsync: async () => fake.agents,
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
  return { store, svc, dir, calls, fake, live, spawnDir, signer };
}

/** The JSON file an argv flag points at. */
const fileAfter = (argv: string[], flag: string) =>
  JSON.parse(readFileSync(after(argv, flag)!, "utf8"));

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
  expect(fileAfter(argv, "--mcp-config").mcpServers.shepherd.url).toEndWith(
    `/api/sessions/${s.id}/mcp`,
  );
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(fileAfter(argv, "--settings").permissions).toEqual(operatorAssistantPermissions());
  // #3161: the operator's view rides each message through its UserPromptSubmit hook.
  expect(fileAfter(argv, "--settings").hooks.UserPromptSubmit[0].hooks[0].url).toEndWith(
    `/api/sessions/${s.id}/assistant-view`,
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

/** The assistant's dynamic permission file, parsed. */
const localSettings = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));

test("spawn, resume and every sync write the Settings → Assistant rules, 0600", async () => {
  const saved = config.assistantPermissions;
  try {
    config.assistantPermissions = { ...DEFAULT_ASSISTANT_PERMISSIONS };
    const { svc, dir, fake } = harness();
    await svc.ensureOperatorAssistant();
    const file = join(dir, ".claude", "settings.local.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(localSettings(dir)).toEqual({
      permissions: assistantPermissionRules(DEFAULT_ASSISTANT_PERMISSIONS),
    });

    // A settings change reaches the running conversation through the same file.
    config.assistantPermissions = { ...DEFAULT_ASSISTANT_PERMISSIONS, steer: "allow" };
    svc.syncOperatorAssistantPermissions();
    expect(localSettings(dir).permissions.allow).toContain("mcp__shepherd__session_steer");

    // A resume rewrites it from the current settings too.
    config.assistantPermissions = { ...DEFAULT_ASSISTANT_PERMISSIONS, steer: "off" };
    fake.agents = [];
    await svc.ensureOperatorAssistant();
    expect(localSettings(dir).permissions.deny).toContain("mcp__shepherd__session_steer");
  } finally {
    config.assistantPermissions = saved;
  }
});

test("sync writes nothing before an assistant dir exists", () => {
  const { svc, dir } = harness();
  svc.syncOperatorAssistantPermissions();
  expect(existsSync(dir)).toBe(false);
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

test("F08: the assistant's ingress URLs and key ride 0600 files, never argv; archive removes them", async () => {
  const { svc, calls, spawnDir, signer } = harness();
  const s = await svc.ensureOperatorAssistant();
  const { argv } = calls.starts[0]!;
  const key = signer.sign(s.id);
  for (const arg of argv) {
    expect(arg).not.toContain(`/api/sessions/${s.id}`);
    expect(arg).not.toContain(key);
  }
  expect(statSync(spawnDir).mode & 0o777).toBe(0o700);
  for (const flag of ["--settings", "--mcp-config"]) {
    expect(dirname(after(argv, flag)!)).toBe(spawnDir);
    expect(statSync(after(argv, flag)!).mode & 0o777).toBe(0o600);
  }
  expect(fileAfter(argv, "--mcp-config").mcpServers.shepherd.headers).toEqual({
    "x-shepherd-ingress-key": key,
  });
  const viewHook = fileAfter(argv, "--settings").hooks.UserPromptSubmit[0].hooks[0];
  expect(viewHook.headers["x-shepherd-ingress-key"]).toBe(key);
  await svc.archive(s.id);
  expect(existsSync(after(argv, "--settings")!)).toBe(false);
  expect(existsSync(after(argv, "--mcp-config")!)).toBe(false);
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

// ── Repo-scoped assistants ──────────────────────────────────────────────────────────────────

/** The `--append-system-prompt` brief of a start. */
const briefOf = (start: Start) => after(start.argv, "--append-system-prompt")!;

test("a repo assistant is its own scope: own row, name and brief; the global one is untouched", async () => {
  const { store, svc, dir, calls } = harness();
  const global = await svc.ensureOperatorAssistant();
  const alpha = await svc.ensureOperatorAssistant("/r/alpha");
  expect(alpha.id).not.toBe(global.id);
  expect(alpha).toMatchObject({
    operatorAssistant: true,
    assistantRepo: "/r/alpha",
    repoPath: dir, // the shared assistant dir, never the repo
    worktreePath: dir,
    name: "operator-assistant-alpha",
  });
  expect(global.assistantRepo).toBeNull();
  expect(calls.starts.map((s) => s.name)).toEqual([
    "operator-assistant",
    "operator-assistant-alpha",
  ]);
  expect(briefOf(calls.starts[0]!)).not.toContain("<assistant-scope>");
  expect(briefOf(calls.starts[1]!)).toContain("alpha (/r/alpha)");
  expect(store.getLiveOperatorAssistant()?.id).toBe(global.id);
  expect(store.getLiveOperatorAssistant("/r/alpha")?.id).toBe(alpha.id);
  // Ensuring a scope again returns its row; the other scope is never consulted.
  expect((await svc.ensureOperatorAssistant("/r/alpha")).id).toBe(alpha.id);
});

test("a repo assistant resumes with its scope's brief", async () => {
  const { svc, calls, fake } = harness();
  const alpha = await svc.ensureOperatorAssistant("/r/alpha");
  fake.agents = [];
  const resumed = await svc.ensureOperatorAssistant("/r/alpha");
  expect(resumed.id).toBe(alpha.id);
  expect(after(calls.starts[1]!.argv, "--resume")).toBe(alpha.claudeSessionId);
  expect(briefOf(calls.starts[1]!)).toContain("alpha (/r/alpha)");
});

test("single-flight is per scope: same scope shares a run, different scopes each spawn", async () => {
  const { svc, calls, fake } = harness();
  let release!: () => void;
  fake.gate = new Promise((r) => (release = r));
  const a1 = svc.ensureOperatorAssistant("/r/alpha");
  const a2 = svc.ensureOperatorAssistant("/r/alpha");
  const g = svc.ensureOperatorAssistant();
  const b = svc.ensureOperatorAssistant("/r/beta");
  release();
  const [sa1, sa2, sg, sb] = await Promise.all([a1, a2, g, b]);
  expect(sa2.id).toBe(sa1.id);
  expect(new Set([sa1.id, sg.id, sb.id]).size).toBe(3);
  expect(calls.starts).toHaveLength(3);
});

test("reset of a repo scope replaces only that scope's assistant", async () => {
  const { store, svc } = harness();
  const global = await svc.ensureOperatorAssistant();
  const alpha = await svc.ensureOperatorAssistant("/r/alpha");
  const fresh = await svc.resetOperatorAssistant("/r/alpha");
  expect(fresh.id).not.toBe(alpha.id);
  expect(fresh.assistantRepo).toBe("/r/alpha");
  expect(store.get(alpha.id)!.status).toBe("archived");
  expect(store.get(global.id)!.status).not.toBe("archived");
  expect(store.getLiveOperatorAssistant()?.id).toBe(global.id);
});

test("close archives a repo assistant; a scope with none live is a not-found error", async () => {
  const { store, svc, calls } = harness();
  const global = await svc.ensureOperatorAssistant();
  const alpha = await svc.ensureOperatorAssistant("/r/alpha");
  await svc.closeOperatorAssistant("/r/alpha");
  expect(store.get(alpha.id)).toMatchObject({ status: "archived", archiveReason: "operator" });
  expect(calls.stops).toContain(alpha.herdrAgentId);
  expect(store.getLiveOperatorAssistant("/r/alpha")).toBeNull();
  expect(store.getLiveOperatorAssistant()?.id).toBe(global.id);
  await expect(svc.closeOperatorAssistant("/r/alpha")).rejects.toBeInstanceOf(
    OperatorAssistantNotFoundError,
  );
  // The slot is free again.
  const again = await svc.ensureOperatorAssistant("/r/alpha");
  expect(again.id).not.toBe(alpha.id);
});
