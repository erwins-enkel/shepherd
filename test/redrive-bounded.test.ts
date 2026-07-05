// Bounded-attempt bookkeeping for reDriveAccount (herdr-restart account-loss fix, task 4a).
// A persistently-failing account re-drive (e.g. usage-halted: the auto-gate refuses BEFORE
// teardown so spawnTerminalId never advances) must give up after REDRIVE_CAP attempts instead of
// re-firing every poller tick forever. The counter is anchored on spawnTerminalId, NOT the
// husk/live terminalId — an UNHEALED re-drive (onSpawn folds to `{}`) spawns a fresh pane (and
// thus a fresh terminalId) on every attempt, so a husk-keyed counter would reset every time and
// never reach the cap.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { needsAccountRedrive } from "../src/herdr";
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
      // Unique terminalId per call — needed so an unhealed re-drive's fresh pane (and thus
      // fresh live terminalId) is distinguishable from the prior husk/anchor.
      start: () => ({ terminalId: `term_${++startCount}` }) as never,
      stop: () => {},
      list: () => [],
    } as never,
  });
  return { service, store, startCount: () => startCount };
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

test("heal clears the counter + a subsequent needsAccountRedrive is false", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct" }) };
  const { service, store } = makeService(hooks);
  const id = await makeResumableSession(service, store);

  const verdict = await service.reDriveAccount(id);
  expect(verdict).toBe("healed");

  const after = store.get(id);
  expect(after).not.toBeNull();
  // Anchor advanced -> the live agent at the fresh terminalId is no longer "needs redrive".
  expect(needsAccountRedrive(after!, { terminalId: after!.spawnTerminalId! })).toBe(false);

  // Calling reDriveAccount again after a heal is a FRESH count (not already-degraded): it
  // re-drives again rather than short-circuiting to "degraded".
  const again = await service.reDriveAccount(id);
  expect(again).toBe("healed");
});

test("bounded -> degraded: refused variant, anchor-keyed counter reaches CAP", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct" }) };
  const { service, store, startCount } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);
  const anchor = before?.spawnTerminalId;

  // Every re-drive attempt now fails BEFORE teardown (auto-gate style refusal): spawnTerminalId
  // never advances, so needsAccountRedrive would stay true forever without the cap.
  hooks.fn = async () => Promise.reject(new PluginSpawnAborted("no creds", "swap"));

  const startsBefore = startCount();
  // Attempts 1..CAP (3) return "refused" and never spawn (the refusal is pre-teardown).
  expect(await service.reDriveAccount(id)).toBe("refused");
  expect(await service.reDriveAccount(id)).toBe("refused");
  expect(await service.reDriveAccount(id)).toBe("refused");
  expect(store.get(id)?.spawnTerminalId).toBe(anchor); // never advanced

  // The (CAP+1)-th call gives up WITHOUT calling herdr.start again.
  const verdict = await service.reDriveAccount(id);
  expect(verdict).toBe("degraded");
  expect(startCount()).toBe(startsBefore); // no additional spawn attempted
});

test("bounded -> degraded: unhealed variant (the wedge test) — anchor-keyed, not husk-keyed", async () => {
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct" }) };
  const { service, store, startCount } = makeService(hooks);
  const id = await makeResumableSession(service, store);
  const before = store.get(id);
  const anchor = before?.spawnTerminalId;
  expect(anchor).toBeTruthy();

  // Every re-drive re-spawns (a NEW live terminalId each time, per the unique-id harness) but
  // onSpawn folds to {} -> the owning account never comes back -> "unhealed", and
  // persistSpawnIdentity's sticky rule PRESERVES spawnTerminalId (does not advance it) so the
  // anchor stays stable across attempts even though the live/husk terminalId changes every time.
  hooks.fn = async () => ({});

  const startsBefore = startCount();
  expect(await service.reDriveAccount(id)).toBe("unhealed");
  expect(await service.reDriveAccount(id)).toBe("unhealed");
  expect(await service.reDriveAccount(id)).toBe("unhealed");
  // Anchor (spawnTerminalId) never advanced across the 3 unhealed attempts — proves the counter
  // is keyed on the STABLE anchor, not the churning live terminalId (which would never reach CAP).
  expect(store.get(id)?.spawnTerminalId).toBe(anchor);
  expect(startCount()).toBe(startsBefore + 3); // each attempt DID spawn a fresh (unhealed) pane

  // The (CAP+1)-th call gives up WITHOUT spawning again.
  const verdict = await service.reDriveAccount(id);
  expect(verdict).toBe("degraded");
  expect(startCount()).toBe(startsBefore + 3); // no additional spawn on the degraded call
});

test("new husk resets the counter: heal after degraded starts a fresh count at 1", async () => {
  // Establish an owning account at create() so the session has a non-null spawnAccountDir —
  // otherwise a folded-null outcome would read as "default session" (healed) rather than
  // "unhealed", per persistSpawnIdentity's sticky rule.
  const hooks: { fn: Hooks } = { fn: async () => ({ credentialDir: "/acct" }) };
  const { service, store } = makeService(hooks);
  const id = await makeResumableSession(service, store);

  hooks.fn = async () => ({}); // now every re-drive fails to re-derive the account
  // Drive to degraded (CAP unhealed attempts + 1 give-up call).
  await service.reDriveAccount(id);
  await service.reDriveAccount(id);
  await service.reDriveAccount(id);
  expect(await service.reDriveAccount(id)).toBe("degraded");

  // Now simulate a fresh heal->re-break. Once degraded, reDriveAccount itself will keep
  // short-circuiting to "degraded" forever for this SAME anchor (that's the give-up contract —
  // the automatic re-drive path stops trying). The heal instead comes from outside that path: the
  // session stays steerable as today (no steer-defer guard in this task), so an operator/explicit
  // `resume({force: true})` — bypassing reDriveAccount's bounded map entirely — can still heal it.
  hooks.fn = async () => ({ credentialDir: "/acct" });
  const healed = await service.resume(id, { force: true });
  expect(healed?.spawnAccountDir).toBe("/acct");
  const healedAnchor = healed?.spawnTerminalId;
  expect(healedAnchor).toBeTruthy();

  // ...then the account breaks again (a subsequent failed re-drive). This must start a NEW
  // count at 1, not resume the already-exhausted prior count (which would immediately degrade).
  hooks.fn = async () => ({});
  const verdict = await service.reDriveAccount(id);
  expect(verdict).toBe("unhealed"); // NOT "degraded" — the new anchor gets a fresh budget
  expect(store.get(id)?.spawnTerminalId).toBe(healedAnchor); // preserved (unhealed didn't advance)
});
