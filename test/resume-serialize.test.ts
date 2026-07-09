// Per-session resume() serialization guard (herdr-restart account-loss fix, task 2):
// proves concurrent resume() calls for the same session id coalesce onto a single spawn,
// that the guard releases once settled, and the reDriveAccount() healed/unhealed/refused
// verdicts built on top of it (task 1's persistSpawnIdentity sticky rule).
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { PluginSpawnAborted, type SpawnDescriptor, type SpawnPatch } from "../src/plugins/types";

type Hooks = (d: SpawnDescriptor) => Promise<SpawnPatch>;

function makeService(hooks: { fn: Hooks }) {
  const store = new SessionStore(":memory:");
  let startCount = 0;
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
      // Unique terminalId per call — real herdr terminalIds are unique per spawn, and the
      // reDriveAccount healed/unhealed inference depends on spawnTerminalId actually changing.
      start: async () => ({ terminalId: `term_${++startCount}` }) as never,
      stop: async () => {},
      list: () => [],
    } as never,
  });
  return { service, store, startCount: () => startCount };
}

const NOOP_HOOKS = { fn: async () => ({}) as SpawnPatch };

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

test("resume() coalesces concurrent calls for the same session id (no double-spawn)", async () => {
  const { service, store, startCount } = makeService(NOOP_HOOKS);
  const id = await makeResumableSession(service, store);
  const before = startCount();

  const [a, b] = await Promise.all([
    service.resume(id, { force: true }),
    service.resume(id, { force: true }),
  ]);

  expect(startCount() - before).toBe(1); // exactly one herdr.start for both callers
  expect(a).not.toBeNull();
  expect(a?.herdrAgentId).toBe(b?.herdrAgentId); // same resulting session
});

test("resume() guard releases after settling: a later resume spawns again", async () => {
  const { service, store, startCount } = makeService(NOOP_HOOKS);
  const id = await makeResumableSession(service, store);
  const before = startCount();

  await service.resume(id, { force: true });
  expect(startCount() - before).toBe(1);

  await service.resume(id, { force: true });
  expect(startCount() - before).toBe(2); // guard cleared, spawns again
});

test("reDriveAccount: same credentialDir re-applied -> healed, spawnTerminalId advances", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct/1" }) };
  const { service, store } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);
  expect(before?.spawnAccountDir).toBe("/acct/1"); // established at create

  const verdict = await (service as never as { reDriveAccount: (id: string) => Promise<string> })[
    "reDriveAccount"
  ](id);

  expect(verdict).toBe("healed");
  const after = store.get(id);
  expect(after?.spawnAccountDir).toBe("/acct/1");
  expect(after?.spawnTerminalId).not.toBe(before?.spawnTerminalId);
});

test("reDriveAccount: onSpawn folds null over a non-null prior -> unhealed, marker preserved", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct/1" }) };
  const { service, store } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);

  hooks.fn = async () => ({}); // this re-drive fails to re-derive the account
  const verdict = await (service as never as { reDriveAccount: (id: string) => Promise<string> })[
    "reDriveAccount"
  ](id);

  expect(verdict).toBe("unhealed");
  const after = store.get(id);
  expect(after?.spawnAccountDir).toBe("/acct/1"); // preserved, not nulled
  expect(after?.spawnTerminalId).toBe(before?.spawnTerminalId); // NOT advanced
});

test("reDriveAccount: resume refused -> refused, husk/marker untouched", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct/1" }) };
  const { service, store } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);

  hooks.fn = async () => Promise.reject(new PluginSpawnAborted("no creds", "swap"));
  const verdict = await (service as never as { reDriveAccount: (id: string) => Promise<string> })[
    "reDriveAccount"
  ](id);

  expect(verdict).toBe("refused");
  const after = store.get(id);
  expect(after?.spawnTerminalId).toBe(before?.spawnTerminalId);
  expect(after?.spawnAccountDir).toBe(before?.spawnAccountDir);
});

test("reDriveAccount: unknown session id -> refused", async () => {
  const { service } = makeService(NOOP_HOOKS);
  const verdict = await (service as never as { reDriveAccount: (id: string) => Promise<string> })[
    "reDriveAccount"
  ]("nonexistent");
  expect(verdict).toBe("refused");
});
