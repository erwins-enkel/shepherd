import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService, spawnSettingsOverlay } from "../src/service";
import { config } from "../src/config";

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
    "--settings",
    spawnSettingsOverlay(),
    "flatten it",
  ]);
  expect(s.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(store.get(s.id)?.claudeSessionId).toBe(s.claudeSessionId);
});

test("spawnSettingsOverlay pins remoteControlAtStartup from config (default off)", () => {
  const prev = config.remoteControlAtStartup;
  try {
    config.remoteControlAtStartup = false;
    expect(JSON.parse(spawnSettingsOverlay())).toEqual({ remoteControlAtStartup: false });
    config.remoteControlAtStartup = true;
    expect(JSON.parse(spawnSettingsOverlay())).toEqual({ remoteControlAtStartup: true });
  } finally {
    config.remoteControlAtStartup = prev;
  }
});

test("createSession: suffixes the name when herdr already runs an agent with it", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
    // namer is deterministic, so a resubmitted prompt collides with a live agent's name
    namer: async () => "koennen-wir-schon",
    worktree: {
      create: (_repo: string, _base: string, name: string) => {
        calls.wtName = name;
        return { worktreePath: `/wt/${name}`, branch: `shepherd/${name}`, isolated: true };
      },
      remove: () => {},
    } as any,
    herdr: {
      start: (name: string) => {
        calls.startName = name;
        return { terminalId: "term_z", cwd: `/wt/${name}`, agentStatus: "working" };
      },
      // koennen-wir-schon is taken; koennen-wir-schon-2 is free
      list: () => [{ name: "koennen-wir-schon" }, { name: "other" }],
    } as any,
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "Können wir schon ...",
    model: null,
    images: [],
  });
  // worktree, branch, agent name all share the deduped name — no collision
  expect(s.name).toBe("koennen-wir-schon-2");
  expect(calls.wtName).toBe("koennen-wir-schon-2");
  expect(calls.startName).toBe("koennen-wir-schon-2");
  expect(s.branch).toBe("shepherd/koennen-wir-schon-2");
});

test("createSession: keeps the base name when no agent holds it", async () => {
  const store = new SessionStore(":memory:");
  const service = new SessionService({
    store,
    namer: async () => "fresh-name",
    worktree: {
      create: (_r: string, _b: string, name: string) => ({
        worktreePath: `/wt/${name}`,
        branch: `shepherd/${name}`,
        isolated: true,
      }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({ terminalId: "term_z", cwd: "/wt/fresh-name", agentStatus: "working" }),
      list: () => [{ name: "something-else" }, { name: "" }],
    } as any,
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do a fresh thing",
    model: null,
    images: [],
  });
  expect(s.name).toBe("fresh-name");
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
    "--settings",
    spawnSettingsOverlay(),
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

test("createSession: rolls back the worktree when the agent fails to start", async () => {
  const store = new SessionStore(":memory:");
  const removed: { path: string; opts: any }[] = [];
  const service = new SessionService({
    store,
    namer: async () => "boom",
    worktree: {
      create: (_r: string, _b: string, name: string) => ({
        worktreePath: `/wt/${name}`,
        branch: `shepherd/${name}`,
        isolated: true,
      }),
      remove: (path: string, opts: any) => removed.push({ path, opts }),
    } as any,
    herdr: {
      // mirrors herdr rejecting `tab create` with "no active workspace"
      start: () => {
        throw new Error("no active workspace");
      },
      list: () => [],
    } as any,
  });

  await expect(
    service.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "go",
      model: null,
      images: [],
    }),
  ).rejects.toThrow("no active workspace"); // original failure is surfaced, not a cleanup error
  // the orphan worktree we created is removed, with branch + baseBranch for branch deletion
  expect(removed).toEqual([
    { path: "/wt/boom", opts: { branch: "shepherd/boom", baseBranch: "main" } },
  ]);
});

test("createSession: skips worktree rollback when the cwd fallback isn't isolated", async () => {
  const store = new SessionStore(":memory:");
  let removeCalls = 0;
  const service = new SessionService({
    store,
    namer: async () => "boom",
    worktree: {
      // non-git repoPath → herdr runs in-place, no worktree to clean up
      create: () => ({ worktreePath: "/repo", branch: null, isolated: false }),
      remove: () => {
        removeCalls++;
      },
    } as any,
    herdr: {
      start: () => {
        throw new Error("no active workspace");
      },
      list: () => [],
    } as any,
  });

  await expect(
    service.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "go",
      model: null,
      images: [],
    }),
  ).rejects.toThrow("no active workspace");
  expect(removeCalls).toBe(0);
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

function resumable(store: SessionStore, over: Partial<Parameters<SessionStore["create"]>[0]> = {}) {
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "abc-123",
    ...over,
  });
  store.update(s.id, { status: "done", lastState: "done" });
  return s;
}

test("resume respawns claude --resume in the worktree and re-points the agent", () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} },
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        calls.start = { name, cwd, argv };
        return { terminalId: "term_new", cwd, agentStatus: "working" } as any;
      },
      list: () => [], // old agent gone → respawn
      stop: () => {},
      send: () => {},
    } as any,
  });
  const s = resumable(store, { model: "opus" });

  const out = svc.resume(s.id);
  expect(out?.herdrAgentId).toBe("term_new"); // re-pointed at the fresh agent
  expect(out?.status).toBe("running");
  expect(calls.start.cwd).toBe("/wt/x");
  expect(calls.start.argv).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--resume",
    "abc-123",
    "--settings",
    spawnSettingsOverlay(),
    "--model",
    "opus",
  ]);
});

test("resume omits --model when the session had none", () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} },
    herdr: {
      start: (_n: string, _c: string, argv: string[]) => {
        calls.argv = argv;
        return { terminalId: "term_new", agentStatus: "working" } as any;
      },
      list: () => [],
      stop: () => {},
      send: () => {},
    } as any,
  });
  const s = resumable(store, { model: null });
  svc.resume(s.id);
  expect(calls.argv).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--resume",
    "abc-123",
    "--settings",
    spawnSettingsOverlay(),
  ]);
});

test("resume re-uses a still-live agent instead of spawning a duplicate", () => {
  const store = new SessionStore(":memory:");
  let started = 0;
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} },
    herdr: {
      start: () => {
        started++;
        return {} as any;
      },
      list: () => [{ terminalId: "term_old" }] as any, // still attachable
      stop: () => {},
      send: () => {},
    } as any,
  });
  const s = resumable(store);
  const out = svc.resume(s.id);
  expect(started).toBe(0); // no second claude
  expect(out?.id).toBe(s.id);
  expect(out?.herdrAgentId).toBe("term_old");
});

test("resume returns null for unknown, archived, or pre-feature sessions", () => {
  const store = new SessionStore(":memory:");
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} },
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {}, send: () => {} } as any,
  });
  expect(svc.resume("ghost")).toBeNull(); // unknown id

  const archived = resumable(store);
  store.archive(archived.id);
  expect(svc.resume(archived.id)).toBeNull(); // worktree already removed

  const preFeature = resumable(store, { claudeSessionId: "" });
  expect(svc.resume(preFeature.id)).toBeNull(); // nothing pinned to resume
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

test("broadcast fans the text out to known sessions, skips unknown ids", () => {
  const sent: { target: string; text: string }[] = [];
  const store = new SessionStore(":memory:");
  const mk = (name: string, agent: string) =>
    store.create({
      name,
      prompt: "x",
      repoPath: "/r",
      baseBranch: "main",
      branch: `shepherd/${name}`,
      worktreePath: `/wt/${name}`,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: agent,
    });
  const a = mk("a", "term_a");
  const b = mk("b", "term_b");
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

  const res = svc.broadcast([a.id, "ghost", b.id], "run tests");
  expect(res).toEqual({ sent: 2, total: 3 });
  expect(sent).toEqual([
    { target: "term_a", text: "run tests\r" },
    { target: "term_b", text: "run tests\r" },
  ]);
});
