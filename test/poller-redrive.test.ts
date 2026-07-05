// Poller-side wiring for the herdr-restart account-loss fix (task 4a): tick() proactively
// fires a re-drive for a herdr-restored account pane (spawnTerminalId no longer matches the live
// agent's terminalId), via the injectable `poller.reDrive` field. Fire-and-forget — the actual
// re-drive (SessionService.reDriveAccount) is exercised separately in
// test/redrive-bounded.test.ts; here we only prove the poller detects the condition and calls
// the hook with the right session id.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";

const baseSession = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "T1",
};

function fakeAgent(terminalId: string): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt",
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId,
    workspaceId: "w",
  };
}

test("poller fires reDrive for a herdr-restored account pane (spawnTerminalId != live terminalId)", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  store.setSpawnIdentity(s.id, "T1", "/acct"); // owning account, spawned on T1

  // herdr restarted and re-created the pane under a NEW terminalId T2.
  const agents: HerdrAgent[] = [fakeAgent("T2")];
  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as never,
    () => {},
    () => {},
  );

  const redriveCalls: string[] = [];
  poller.reDrive = (id) => redriveCalls.push(id);

  poller.tick();

  expect(redriveCalls).toEqual([s.id]);
});

test("poller does NOT fire reDrive for a default session (spawnAccountDir=null)", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  // spawnAccountDir defaults to null (no owning account) — a fresh terminalId here is just the
  // ordinary herdr-restart-adopt case (Locus A path), not an account re-drive.
  store.setSpawnIdentity(s.id, "T1", null);

  const agents: HerdrAgent[] = [fakeAgent("T2")];
  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as never,
    () => {},
    () => {},
  );

  const redriveCalls: string[] = [];
  poller.reDrive = (id) => redriveCalls.push(id);

  poller.tick();

  expect(redriveCalls).toEqual([]);
});

test("poller tick() never throws even when reDrive itself throws (fire-and-forget dispatch)", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  store.setSpawnIdentity(s.id, "T1", "/acct");

  const agents: HerdrAgent[] = [fakeAgent("T2")];
  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as never,
    () => {},
    () => {},
  );

  poller.reDrive = () => {
    throw new Error("boom");
  };

  expect(() => poller.tick()).not.toThrow();
});
