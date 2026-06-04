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

test("reconcile marks sessions whose herdr agent is gone as done", () => {
  const store = new SessionStore(":memory:");
  const live = store.create({ ...base, herdrAgentId: "term_live" });
  const dead = store.create({ ...base, herdrAgentId: "term_dead" });

  reconcile(store, {
    list: () => [
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

test("reconcile re-pairs a session whose terminalId went stale but agent is live at the same cwd", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...base, worktreePath: "/wt/z", herdrAgentId: "term_stale" });

  reconcile(store, {
    list: () => [
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
