import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { reconcile } from "../src/reconcile";

const base = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
};

test("reconcile marks sessions whose herdr agent is gone as done", async () => {
  const store = new SessionStore(":memory:");
  const live = store.create({ ...base, herdrAgentId: "term_live" });
  const dead = store.create({ ...base, herdrAgentId: "term_dead" });

  await reconcile(store, {
    listAsync: async () => [
      {
        name: "",
        terminalId: "term_live",
        agentStatus: "working",
        agent: "claude",
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      },
    ],
  } as any);

  expect(store.get(live.id)?.status).toBe("running");
  expect(store.get(dead.id)?.status).toBe("done");
});

test("reconcile degrades gracefully when herdr is down: no throw, session state untouched", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...base, herdrAgentId: "term_live" });

  // herdr server/socket down → `agent list` throws (the cold-boot crash-loop of #315).
  await expect(
    reconcile(store, {
      listAsync: async () => {
        throw new Error("Os { code: 2, kind: NotFound }");
      },
    } as any),
  ).resolves.toBeUndefined();

  // must NOT reap a live session to "done" on a transient herdr hiccup — the
  // 1s poller reconciles once herdr is reachable again.
  expect(store.get(s.id)?.status).toBe("running");
});

test("reconcile re-pairs a session whose terminalId went stale but agent is live at the same cwd", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...base, worktreePath: "/wt/z", herdrAgentId: "term_stale" });

  await reconcile(store, {
    listAsync: async () => [
      {
        name: "x",
        terminalId: "term_fresh",
        agentStatus: "working",
        agent: "claude",
        cwd: "/wt/z",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      },
    ],
  } as any);

  const out = store.get(s.id);
  expect(out?.status).toBe("running");
  expect(out?.herdrAgentId).toBe("term_fresh"); // adopted the new id
});

test("reconcile never reaps a session created while `agent list` was in flight", async () => {
  const store = new SessionStore(":memory:");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pending = reconcile(store, {
    listAsync: async () => {
      await gate;
      return []; // the listing predates the session below, so it can't contain its agent
    },
  } as any);
  // Spawned while herdr was still answering the boot-time list.
  const fresh = store.create({ ...base, herdrAgentId: "term_fresh" });
  release();
  await pending;
  expect(store.get(fresh.id)?.status).not.toBe("done");
});
