// Persist spawn identity (issue: "herdr restart loses a claude-swap session's account").
// Covers the foundational persistence layer only: the two new session columns
// (spawnTerminalId/spawnAccountDir), the setSpawnIdentity store setter, and the
// persistSpawnIdentity service helper's sticky/conditional write table. No poller/resume
// re-drive logic lives here — that's a later task.
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import type { SpawnDescriptor, SpawnPatch } from "../src/plugins/types";

const base = {
  name: "spawn-identity-test",
  prompt: "test session",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/spawn-identity-test",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

// ── store: column defaults + setSpawnIdentity ─────────────────────────────────

test("freshly created session has spawnTerminalId=null, spawnAccountDir=null", () => {
  const store = new SessionStore(":memory:");
  const row = store.create(base);
  expect(row.spawnTerminalId).toBeNull();
  expect(row.spawnAccountDir).toBeNull();
});

test("setSpawnIdentity persists both fields", () => {
  const store = new SessionStore(":memory:");
  const row = store.create(base);
  store.setSpawnIdentity(row.id, "term_9", "/acct");
  const got = store.get(row.id);
  expect(got?.spawnTerminalId).toBe("term_9");
  expect(got?.spawnAccountDir).toBe("/acct");
});

test("setSpawnIdentity with nulls clears both fields", () => {
  const store = new SessionStore(":memory:");
  const row = store.create(base);
  store.setSpawnIdentity(row.id, "term_9", "/acct");
  store.setSpawnIdentity(row.id, null, null);
  const got = store.get(row.id);
  expect(got?.spawnTerminalId).toBeNull();
  expect(got?.spawnAccountDir).toBeNull();
});

test("spawn identity fields persist across store reopen (migration + round-trip)", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-spawn-identity-test-"));
  const dbPath = join(dir, "test.db");
  try {
    const s1 = new SessionStore(dbPath);
    const row = s1.create(base);
    s1.setSpawnIdentity(row.id, "term_9", "/acct");

    // reopen same DB — proves migrateSessionColumns() ADDs the columns onto a pre-existing DB.
    const s2 = new SessionStore(dbPath);
    const got = s2.get(row.id);
    expect(got?.spawnTerminalId).toBe("term_9");
    expect(got?.spawnAccountDir).toBe("/acct");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── service: persistSpawnIdentity via real spawns ─────────────────────────────

type Hooks = (d: SpawnDescriptor) => Promise<SpawnPatch>;

function makeService(hooks: { fn: Hooks }) {
  const store = new SessionStore(":memory:");
  let counter = 0;
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
      start: () => ({ terminalId: `term_${++counter}` }) as never,
      stop: () => {},
      list: () => [],
    } as never,
  });
  return { service, store };
}

const CREATE_INPUT = {
  repoPath: "/repo",
  baseBranch: "main",
  prompt: "go",
  model: null,
  images: [],
};

test("1. onSpawn credentialDir folds into spawnAccountDir + advances spawnTerminalId", async () => {
  const hooks = { fn: async () => ({ credentialDir: "/acct" }) as SpawnPatch };
  const { service, store } = makeService(hooks);
  const s = await service.create(CREATE_INPUT);
  const row = store.get(s.id)!;
  expect(row.spawnAccountDir).toBe("/acct");
  expect(row.spawnTerminalId).toBe(row.herdrAgentId);
});

test("2. empty patch on a new session sets spawnAccountDir=null, spawnTerminalId set", async () => {
  const hooks = { fn: async () => ({}) as SpawnPatch };
  const { service, store } = makeService(hooks);
  const s = await service.create(CREATE_INPUT);
  const row = store.get(s.id)!;
  expect(row.spawnAccountDir).toBeNull();
  expect(row.spawnTerminalId).toBe(row.herdrAgentId);
  expect(row.spawnTerminalId).not.toBeNull();
});

test("3. sticky/loud: resume with folded=null preserves prior owning-account identity + warns", async () => {
  const hooks = { fn: async () => ({}) as SpawnPatch }; // folded account is always null
  const { service, store } = makeService(hooks);
  const s = await service.create(CREATE_INPUT);
  // Simulate a prior verified owning-account spawn (e.g. from before a herdr restart).
  store.setSpawnIdentity(s.id, "T1", "/acct");

  const warnSpy = spyOn(console, "warn");
  try {
    const resumed = await service.resume(s.id);
    expect(resumed).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled(); // loud: owning account not restored
  } finally {
    warnSpy.mockRestore();
  }

  const row = store.get(s.id)!;
  expect(row.spawnAccountDir).toBe("/acct"); // NOT nulled
  expect(row.spawnTerminalId).toBe("T1"); // NOT advanced
});

test("4. healed: resume with folded matching prior advances spawnTerminalId", async () => {
  const hooks = { fn: async () => ({ credentialDir: "/acct" }) as SpawnPatch };
  const { service, store } = makeService(hooks);
  const s = await service.create(CREATE_INPUT);
  store.setSpawnIdentity(s.id, "T1", "/acct");

  const resumed = await service.resume(s.id);
  expect(resumed).not.toBeNull();

  const row = store.get(s.id)!;
  expect(row.spawnAccountDir).toBe("/acct");
  expect(row.spawnTerminalId).not.toBe("T1"); // advanced to the new spawn's terminalId
  expect(row.spawnTerminalId).toBe(row.herdrAgentId);
});
