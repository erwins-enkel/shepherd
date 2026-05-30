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
    images: [],
  });
  expect(s.name).toBe("repo-flatten");
  expect(s.worktreePath).toBe("/wt/repo-flatten");
  expect(s.herdrAgentId).toBe("term_z");
  expect(s.model).toBeNull();
  // pins a claude session id; no --model flag when model is null (claude's own default)
  expect(calls.start.argv).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--session-id",
    s.claudeSessionId,
    "flatten it",
  ]);
  expect(s.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(store.get(s.id)?.claudeSessionId).toBe(s.claudeSessionId);
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
    images: [],
  });
  expect(s.model).toBe("opus");
  expect(calls.argv).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--session-id",
    s.claudeSessionId,
    "--model",
    "opus",
    "go",
  ]);
  expect(store.get(s.id)?.model).toBe("opus");
});

test("createSession: moves images into worktree and appends paths to the prompt", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    worktree: {
      create: () => ({ worktreePath: "/wt/repo-x", branch: "shepherd/repo-x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        calls.argv = argv;
        return {
          terminalId: "term_y",
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
    moveUploads: (images: string[], worktreePath: string) =>
      images.map((i) => `${worktreePath}/.shepherd-uploads/${i.split("/").pop()}`),
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "look at this",
    model: null,
    images: ["/stage/a.png", "/stage/b.png"],
  });

  // prompt argv (last element) carries the user text + the moved image paths
  expect(calls.argv[calls.argv.length - 1]).toBe(
    "look at this\n\nAttached images:\n/wt/repo-x/.shepherd-uploads/a.png\n/wt/repo-x/.shepherd-uploads/b.png",
  );
  // stored prompt stays the clean user text
  expect(store.get(s.id)?.prompt).toBe("look at this");
});

test("createSession: no images leaves the prompt argv unchanged", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: (_n: string, _c: string, argv: string[]) => {
        calls.argv = argv;
        return {
          terminalId: "t",
          cwd: "/wt/x",
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
  await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  expect(calls.argv[calls.argv.length - 1]).toBe("go");
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

test("reply types the text plus Enter into the agent's PTY", () => {
  const sent: { target: string; text: string }[] = [];
  const store = new SessionStore(":memory:");
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
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} },
    herdr: {
      start: () => ({}) as any,
      list: () => [],
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
  });

  expect(svc.reply(s.id, "1")).toBe(true);
  expect(sent).toEqual([{ target: "term_z", text: "1\r" }]);
  expect(svc.reply("nope", "1")).toBe(false);
});
