import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";

test("createSession: names, makes worktree, starts herdr, persists", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
    namer: async () => "repo-flatten",
    worktree: {
      create: (repo: string, base: string, name: string) => {
        calls.wt = { repo, base, name };
        return {
          worktreePath: "/wt/repo-flatten",
          branch: "shepherd/repo-flatten",
          isolated: true,
        };
      },
      remove: () => {},
    } as any,
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        calls.start = { name, cwd, argv };
        return {
          terminalId: "term_z",
          cwd,
          agent: "claude",
          agentStatus: "working",
          paneId: "p",
          tabId: "t",
          workspaceId: "w",
        };
      },
      list: () => [],
    } as any,
  });

  const s = await service.create({ repoPath: "/repo", baseBranch: "main", prompt: "flatten it" });
  expect(s.name).toBe("repo-flatten");
  expect(s.worktreePath).toBe("/wt/repo-flatten");
  expect(s.herdrAgentId).toBe("term_z");
  expect(calls.start.argv).toEqual(["claude", "--dangerously-skip-permissions", "flatten it"]);
  expect(store.get(s.id)).toBeTruthy();
});
