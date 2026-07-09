// Locus B of the herdr-restart account-loss fix (task 3): a non-forced resume() of a
// herdr-restored ACCOUNT pane must re-drive through onSpawn instead of adopting the
// wrong-account husk. Simulates the production sequence: session spawned on an owning
// account (spawnAccountDir/spawnTerminalId stamped), herdr restarts, the poller re-points
// herdrAgentId to the restored husk under a NEW terminalId — matchAgents/liveAgentFor now
// resolves that husk as "live". needsAccountRedrive must catch this and fall through to
// the existing teardown + prepareResumeSpawn path (never call reDriveAccount from here —
// that would deadlock on the per-session resume() guard, see task-3-brief.md).
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import type { HerdrAgent } from "../src/herdr";
import type { SpawnDescriptor, SpawnPatch } from "../src/plugins/types";

type Hooks = (d: SpawnDescriptor) => Promise<SpawnPatch>;

function makeService(hooks: { fn: Hooks }) {
  const store = new SessionStore(":memory:");
  let startCount = 0;
  const startCalls: { env: Record<string, string | undefined> }[] = [];
  const stopCalls: string[] = [];
  const liveAgent: { current: HerdrAgent | null } = { current: null };
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    runSpawnHooks: (d) => hooks.fn(d),
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => ({ worktreePath: "/wt/repo-x", branch: "shepherd/repo-x", isolated: true }),
      remove: () => {},
    } as never,
    herdr: {
      // Unique terminalId per call, like Task 2's harness — needsAccountRedrive assertions
      // depend on the fresh id differing from both the stale spawnTerminalId and the husk.
      start: async (
        _name: string,
        _cwd: string,
        _argv: string[],
        env: Record<string, string | undefined>,
      ) => {
        startCount++;
        startCalls.push({ env });
        return { terminalId: `term_${startCount}` };
      },
      stop: async (terminalId: string) => {
        stopCalls.push(terminalId);
      },
      list: () => (liveAgent.current ? [liveAgent.current] : []),
    } as never,
  });
  return { service, store, startCount: () => startCount, startCalls, stopCalls, liveAgent };
}

async function makeResumableSession(service: SessionService, store: SessionStore) {
  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  store.update(s.id, { status: "done" });
  return s.id;
}

/** Fill in the HerdrAgent fields the tests don't otherwise care about. */
function fakeAgent(terminalId: string, cwd: string): HerdrAgent {
  return {
    agent: "",
    agentStatus: "done",
    cwd,
    name: "repo-x",
    paneId: "pane-1",
    tabId: "tab-1",
    terminalId,
    workspaceId: "ws-1",
  };
}

test("Locus B: non-force resume() of a herdr-restored account pane re-drives, does not adopt", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct" }) };
  const { service, store, stopCalls, startCalls, liveAgent } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);
  expect(before?.spawnAccountDir).toBe("/acct");
  const spawnTerminalId = before?.spawnTerminalId;
  expect(spawnTerminalId).toBeTruthy();
  const startsBefore = startCalls.length; // create() itself already spawned once

  // Poller re-points herdrAgentId to the herdr-restored husk under a NEW terminalId.
  store.update(id, { herdrAgentId: "T2" });
  liveAgent.current = fakeAgent("T2", "/wt/repo-x");

  const result = await service.resume(id);

  expect(stopCalls).toContain("T2"); // husk torn down
  expect(startCalls.length - startsBefore).toBe(1); // re-driven through onSpawn
  expect(startCalls.at(-1)?.env.CLAUDE_CONFIG_DIR).toBe("/acct");
  expect(result?.herdrAgentId).not.toBe("T2"); // did NOT adopt the husk
});

test("default session (no owning account) still adopts a herdr-restored pane", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({}) }; // no credentialDir -> default session
  const { service, store, stopCalls, startCalls, liveAgent } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);
  expect(before?.spawnAccountDir).toBeNull();
  const startsBefore = startCalls.length;

  store.update(id, { herdrAgentId: "T2" });
  liveAgent.current = fakeAgent("T2", "/wt/repo-x");

  const result = await service.resume(id);

  expect(stopCalls).toEqual([]); // no teardown
  expect(startCalls.length - startsBefore).toBe(0); // no re-spawn
  expect(result?.herdrAgentId).toBe("T2"); // adopted
});

test("genuinely-live account pane (terminalId unchanged) adopts, no re-drive", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct" }) };
  const { service, store, stopCalls, startCalls, liveAgent } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);
  const spawnTerminalId = before?.spawnTerminalId;
  expect(spawnTerminalId).toBeTruthy();
  const startsBefore = startCalls.length;

  // herdrAgentId still points at the same terminal Shepherd last spawned — genuinely live.
  liveAgent.current = fakeAgent(spawnTerminalId!, "/wt/repo-x");

  const result = await service.resume(id);

  expect(stopCalls).toEqual([]);
  expect(startCalls.length - startsBefore).toBe(0);
  expect(result?.herdrAgentId).toBe(spawnTerminalId!);
});
