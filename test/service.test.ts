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

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "flatten it",
    model: null,
  });
  expect(s.name).toBe("repo-flatten");
  expect(s.worktreePath).toBe("/wt/repo-flatten");
  expect(s.herdrAgentId).toBe("term_z");
  expect(s.model).toBeNull();
  // no --model flag when model is null (claude uses its own default)
  expect(calls.start.argv).toEqual(["claude", "--dangerously-skip-permissions", "flatten it"]);
  expect(store.get(s.id)).toBeTruthy();
});

test("createSession: passes --model and persists it when a model is chosen", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
    namer: async () => "repo-flatten",
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: (_n: string, _c: string, argv: string[]) => {
        calls.argv = argv;
        return { terminalId: "term_z", cwd: "/wt/x", agentStatus: "working" };
      },
      list: () => [],
    } as any,
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: "opus",
  });
  expect(s.model).toBe("opus");
  expect(calls.argv).toEqual(["claude", "--dangerously-skip-permissions", "--model", "opus", "go"]);
  expect(store.get(s.id)?.model).toBe("opus");
});

test("archive stops the herdr agent, removes the worktree, and archives the row", () => {
  const store = new SessionStore(":memory:");
  const calls: any = { stopped: [], removed: [] };
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}), remove: (p: string) => calls.removed.push(p) } as any,
    herdr: { start: () => ({}), list: () => [], stop: (t: string) => calls.stopped.push(t) } as any,
  });
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  service.archive(s.id);
  expect(calls.stopped).toEqual(["term_z"]); // agent stopped (no leak)
  expect(calls.removed).toEqual(["/wt"]); // worktree removed
  expect(store.get(s.id)?.status).toBe("archived");
});
