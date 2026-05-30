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
