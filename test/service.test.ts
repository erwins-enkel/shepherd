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

test("setReadyToMerge persists the flag and emits session:ready", () => {
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
    herdrAgentId: "term_a",
  });
  const emitted: { event: string; data: unknown }[] = [];
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: { start: () => ({}) as any, list: () => [] } as any,
    events: { emit: (event, data) => emitted.push({ event, data }) },
  });

  service.setReadyToMerge(s.id, true);
  expect(store.get(s.id)?.readyToMerge).toBe(true);
  expect(emitted).toEqual([{ event: "session:ready", data: { id: s.id, ready: true } }]);

  service.setReadyToMerge(s.id, false);
  expect(store.get(s.id)?.readyToMerge).toBe(false);
  expect(emitted[1]).toEqual({ event: "session:ready", data: { id: s.id, ready: false } });
});

test("syncWorktreeBranch adopts the agent's renamed branch, syncs name + tab, emits", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "view-refresh",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/view-refresh",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
  });
  const emitted: { event: string; data: unknown }[] = [];
  const relabels: { id: string; label: string }[] = [];
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { currentBranch: () => "shepherd/refresh-on-wake" } as any,
    herdr: {
      relabel: (id: string, label: string) => relabels.push({ id, label }),
      list: () => [],
    } as any,
    events: { emit: (event, data) => emitted.push({ event, data }) },
  });

  const adopted = service.syncWorktreeBranch(s.id);
  expect(adopted).toBe("shepherd/refresh-on-wake");
  const row = store.get(s.id)!;
  expect(row.branch).toBe("shepherd/refresh-on-wake");
  expect(row.name).toBe("refresh-on-wake"); // shepherd/ prefix stripped for display
  expect(relabels).toEqual([{ id: "term_a", label: "refresh-on-wake" }]);
  expect(emitted).toEqual([
    {
      event: "session:renamed",
      data: { id: s.id, name: "refresh-on-wake", branch: "shepherd/refresh-on-wake" },
    },
  ]);
});

test("syncWorktreeBranch adopts the branch but preserves a chosen display name", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "nice-human-name", // diverged from the branch slug → a chosen name
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/view-refresh",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
  });
  const emitted: { event: string; data: unknown }[] = [];
  const relabels: unknown[] = [];
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { currentBranch: () => "shepherd/refresh-on-wake" } as any,
    herdr: { relabel: (...a: unknown[]) => relabels.push(a), list: () => [] } as any,
    events: { emit: (event, data) => emitted.push({ event, data }) },
  });

  expect(service.syncWorktreeBranch(s.id)).toBe("shepherd/refresh-on-wake");
  const row = store.get(s.id)!;
  expect(row.branch).toBe("shepherd/refresh-on-wake"); // branch adopted (fixes PR recognition)
  expect(row.name).toBe("nice-human-name"); // chosen name outranks the raw branch slug
  expect(relabels).toHaveLength(0); // tab label left alone
  expect(emitted).toEqual([
    {
      event: "session:renamed",
      data: { id: s.id, name: "nice-human-name", branch: "shepherd/refresh-on-wake" },
    },
  ]);
});

test("syncWorktreeBranch de-dupes the adopted name against live tab labels", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "view-refresh",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/view-refresh",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
  });
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { currentBranch: () => "shepherd/refresh-on-wake" } as any,
    // a sibling already owns the bare slug → uniqueName suffixes it
    herdr: { relabel: () => {}, list: () => [{ name: "refresh-on-wake" }] } as any,
  });

  expect(service.syncWorktreeBranch(s.id)).toBe("shepherd/refresh-on-wake");
  const row = store.get(s.id)!;
  expect(row.branch).toBe("shepherd/refresh-on-wake"); // branch still the live one
  expect(row.name).toBe("refresh-on-wake-2"); // display name de-duped
});

test("syncWorktreeBranch is a no-op when the live branch matches the stored one", () => {
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
    herdrAgentId: "term_a",
  });
  const emitted: unknown[] = [];
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { currentBranch: () => "shepherd/x" } as any,
    herdr: { relabel: () => {} } as any,
    events: { emit: (...args: unknown[]) => emitted.push(args) },
  });

  expect(service.syncWorktreeBranch(s.id)).toBeNull();
  expect(store.get(s.id)?.name).toBe("x");
  expect(emitted).toHaveLength(0);
});

test("syncWorktreeBranch returns null on a detached HEAD (currentBranch null)", () => {
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
    herdrAgentId: "term_a",
  });
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { currentBranch: () => null } as any,
    herdr: { relabel: () => {} } as any,
  });
  expect(service.syncWorktreeBranch(s.id)).toBeNull();
  expect(store.get(s.id)?.branch).toBe("shepherd/x");
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

test("createSession: uses herd-qualified name on collision with a different-repo session", async () => {
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
      // koennen-wir-schon is taken; koennen-wir-schon-repo (herd-qualified) is free
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
  // herd slug from basename('/repo') = slugifyManual('repo') = 'repo'
  // base 'koennen-wir-schon' is taken → try 'koennen-wir-schon-repo' (free) → use it
  expect(s.name).toBe("koennen-wir-schon-repo");
  expect(calls.wtName).toBe("koennen-wir-schon-repo");
  expect(calls.startName).toBe("koennen-wir-schon-repo");
  expect(s.branch).toBe("shepherd/koennen-wir-schon-repo");
});

test("createSession: falls back to numeric suffix when base AND herd-qualified name are taken", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
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
      // both base and herd-qualified are taken → numeric suffix on the composed name
      list: () => [{ name: "koennen-wir-schon" }, { name: "koennen-wir-schon-repo" }],
    } as any,
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "Können wir schon ...",
    model: null,
    images: [],
  });
  // 'koennen-wir-schon' taken, 'koennen-wir-schon-repo' taken → 'koennen-wir-schon-repo-2'
  expect(s.name).toBe("koennen-wir-schon-repo-2");
  expect(calls.wtName).toBe("koennen-wir-schon-repo-2");
  expect(calls.startName).toBe("koennen-wir-schon-repo-2");
  expect(s.branch).toBe("shepherd/koennen-wir-schon-repo-2");
});

test("createSession: falls back to numeric-only suffix when repoPath has no usable basename", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
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
      // base is taken; no usable herd → classic numeric fallback
      list: () => [{ name: "koennen-wir-schon" }],
    } as any,
  });

  const s = await service.create({
    // '/' has no usable basename (split('/').filter(Boolean).at(-1) === undefined)
    // → herdSlug is undefined → numeric-only fallback
    repoPath: "/",
    baseBranch: "main",
    prompt: "Können wir schon ...",
    model: null,
    images: [],
  });
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

test("createSession: appends the issueRef body out-of-band, keeps the stored prompt clean", async () => {
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

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "fix it",
    model: null,
    images: [],
    issueRef: {
      number: 42,
      url: "https://github.com/o/r/issues/42",
      title: "Soft-delete users",
      body: "the long issue body",
    },
  });

  // argv carries the human prompt + the out-of-band issue body
  expect(calls.argv[calls.argv.length - 1]).toBe(
    "fix it\n\nGitHub Issue #42: Soft-delete users\nhttps://github.com/o/r/issues/42\n\nthe long issue body",
  );
  // stored prompt stays the clean human text — the body never lands in it
  expect(store.get(s.id)?.prompt).toBe("fix it");
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

test("archive without a reaper just closes the session (no leftover handling)", () => {
  const store = new SessionStore(":memory:");
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      remove: () => {},
      branchExists: () => false,
      renameBranch: () => {},
      commitsAhead: () => 0,
      currentBranch: () => null,
    },
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {} } as any,
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
  svc.archive(s.id, ["process:1"]); // keys ignored without a reaper
  expect(store.get(s.id)?.status).toBe("archived");
});

test("leftovers proxies to the reaper for the session; [] for unknown id", () => {
  const store = new SessionStore(":memory:");
  const detect = (sess: any) => [
    {
      kind: "process",
      name: "vite",
      port: 5174,
      pid: 9,
      key: "process:9",
      worktree: sess.worktreePath,
    },
  ];
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      remove: () => {},
      branchExists: () => false,
      renameBranch: () => {},
      commitsAhead: () => 0,
      currentBranch: () => null,
    },
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {} } as any,
    reaper: { detect: detect as any, reap: () => {} },
  });
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  expect(svc.leftovers(s.id)).toHaveLength(1);
  expect(svc.leftovers("ghost")).toEqual([]);
});

test("archive reaps only the selected leftovers, re-detected (no trusting raw client keys)", () => {
  const store = new SessionStore(":memory:");
  const reaped: string[][] = [];
  const detected = [
    { kind: "process", name: "vite", port: 5174, pid: 9, key: "process:9" },
    {
      kind: "system",
      name: "tailscale serve",
      port: 5174,
      command: { bin: "tailscale", args: ["serve", "--https=5174", "off"] },
      key: "system:tailscale serve:5174",
    },
  ];
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      remove: () => {},
      branchExists: () => false,
      renameBranch: () => {},
      commitsAhead: () => 0,
      currentBranch: () => null,
    },
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {} } as any,
    reaper: {
      detect: () => detected as any,
      reap: (ls: any[]) => reaped.push(ls.map((l) => l.key)),
    },
  });
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  // ask to reap the tailscale proxy + a forged key that isn't in the detected set
  svc.archive(s.id, ["system:tailscale serve:5174", "process:99999"]);
  // only the genuinely-detected, selected leftover is reaped — the forged key is dropped
  expect(reaped).toEqual([["system:tailscale serve:5174"]]);
  expect(store.get(s.id)?.status).toBe("archived");
});

test("archive with no reap keys never calls the reaper", () => {
  const store = new SessionStore(":memory:");
  let reapCalls = 0;
  let detectCalls = 0;
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      remove: () => {},
      branchExists: () => false,
      renameBranch: () => {},
      commitsAhead: () => 0,
      currentBranch: () => null,
    },
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {} } as any,
    reaper: {
      detect: () => {
        detectCalls++;
        return [];
      },
      reap: () => {
        reapCalls++;
      },
    },
  });
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  svc.archive(s.id);
  expect(detectCalls).toBe(0);
  expect(reapCalls).toBe(0);
});

test("resume respawns claude --resume in the worktree and re-points the agent", () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
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
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
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
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
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
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {}, send: () => {} } as any,
  });
  expect(svc.resume("ghost")).toBeNull(); // unknown id

  const archived = resumable(store);
  store.archive(archived.id);
  expect(svc.resume(archived.id)).toBeNull(); // worktree already removed

  const preFeature = resumable(store, { claudeSessionId: "" });
  expect(svc.resume(preFeature.id)).toBeNull(); // nothing pinned to resume
});

test("reply types the text, then submits with a separate carriage return", () => {
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
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => [],
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
  });

  expect(svc.reply(s.id, "1")).toBe(true);
  // Enter is a discrete second write so Claude Code submits it instead of
  // absorbing the CR into a paste-buffered multi-line blob.
  expect(sent).toEqual([
    { target: "term_z", text: "1" },
    { target: "term_z", text: "\r" },
  ]);
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
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
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
    { target: "term_a", text: "run tests" },
    { target: "term_a", text: "\r" },
    { target: "term_b", text: "run tests" },
    { target: "term_b", text: "\r" },
  ]);
});

function svcDeps(over: any = {}) {
  const store = new SessionStore(":memory:");
  const events: any = {
    emitted: [] as any[],
    emit(e: string, d: unknown) {
      this.emitted.push({ e, d });
    },
  };
  const relabelled: any[] = [];
  const renamedBranches: any[] = [];
  const worktree = {
    create: (_r: string, _b: string, name: string) => ({
      worktreePath: `/wt/${name}`,
      branch: `shepherd/${name}`,
      isolated: true,
    }),
    remove: () => {},
    renameBranch: (_r: string, _o: string, n: string) => renamedBranches.push(n),
    commitsAhead: () => 0,
    branchExists: () => false,
  };
  const base = {
    store,
    namer: async () => "even-two-recent-prs",
    worktree,
    herdr: {
      start: () => ({
        terminalId: "term_real",
        cwd: "/wt",
        agent: "",
        agentStatus: "working",
        name: "",
        paneId: "",
        tabId: "",
        workspaceId: "",
      }),
      list: () => [],
      stop: () => {},
      send: () => {},
      relabel: (id: string, name: string) => relabelled.push({ id, name }),
    },
    events,
    refineName: async () => "session-naming",
    ...over,
  };
  return { store, events, relabelled, renamedBranches, deps: base as any };
}

test("create schedules a refine that renames session, branch, and herdr tab", async () => {
  const { store, events, relabelled, renamedBranches, deps } = svcDeps();
  const svc = new SessionService(deps);
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "Even with the two recent PRs...",
    model: null,
    images: [],
  });
  expect(s.name).toBe("even-two-recent-prs");
  await new Promise((r) => setTimeout(r, 10));
  expect(store.get(s.id)?.name).toBe("session-naming");
  expect(store.get(s.id)?.branch).toBe("shepherd/session-naming");
  expect(renamedBranches).toContain("shepherd/session-naming");
  expect(relabelled).toContainEqual({ id: "term_real", name: "session-naming" });
  expect(
    events.emitted.some((x: any) => x.e === "session:renamed" && x.d.name === "session-naming"),
  ).toBe(true);
});

test("refine updates display name only (no branch rename) once commits exist", async () => {
  const { store, renamedBranches, deps } = svcDeps();
  deps.worktree.commitsAhead = () => 2;
  const svc = new SessionService(deps);
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "p",
    model: null,
    images: [],
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(store.get(s.id)?.name).toBe("session-naming");
  expect(store.get(s.id)?.branch).toBe("shepherd/even-two-recent-prs");
  expect(renamedBranches).toHaveLength(0);
});

test("refine renames display only when the target branch already exists", async () => {
  const { store, renamedBranches, events, deps } = svcDeps();
  // a leftover/archived branch already occupies shepherd/session-naming
  deps.worktree.branchExists = (_r: string, b: string) => b === "shepherd/session-naming";
  const svc = new SessionService(deps);
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "p",
    model: null,
    images: [],
  });
  await new Promise((r) => setTimeout(r, 10));
  // the better display name still lands — the refine is NOT abandoned
  expect(store.get(s.id)?.name).toBe("session-naming");
  // but the branch stays put (no `git branch -m` onto an existing branch)
  expect(store.get(s.id)?.branch).toBe("shepherd/even-two-recent-prs");
  expect(renamedBranches).toHaveLength(0);
  expect(
    events.emitted.some((x: any) => x.e === "session:renamed" && x.d.name === "session-naming"),
  ).toBe(true);
});

test("refine does not clobber a manual rename that landed during the window", async () => {
  const { store, events, deps } = svcDeps();
  let resolveRefine: (v: string) => void = () => {};
  deps.refineName = () => new Promise<string>((res) => (resolveRefine = res));
  const svc = new SessionService(deps);
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "p",
    model: null,
    images: [],
  });
  // user manually renames while the namer is still "thinking"
  store.update(s.id, { name: "my-manual-name", branch: "shepherd/my-manual-name" });
  // the namer now returns its (now-stale) guess
  resolveRefine("session-naming");
  await new Promise((r) => setTimeout(r, 10));
  expect(store.get(s.id)?.name).toBe("my-manual-name"); // manual rename preserved
  expect(events.emitted.some((x: any) => x.e === "session:renamed")).toBe(false);
});

test("refine degrades to display-only when the branch move itself throws (TOCTOU)", async () => {
  const { store, events, deps } = svcDeps();
  // branchExists reports free, but the move races and throws between check and `git branch -m`
  deps.worktree.branchExists = () => false;
  deps.worktree.renameBranch = () => {
    throw new Error("branch exists");
  };
  const svc = new SessionService(deps);
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "p",
    model: null,
    images: [],
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(store.get(s.id)?.name).toBe("session-naming"); // better name still lands
  expect(store.get(s.id)?.branch).toBe("shepherd/even-two-recent-prs"); // branch left put
  expect(
    events.emitted.some((x: any) => x.e === "session:renamed" && x.d.name === "session-naming"),
  ).toBe(true);
});

test("refine is a no-op when the comprehended slug equals the heuristic name", async () => {
  const { events, deps } = svcDeps({ refineName: async () => "even-two-recent-prs" });
  const svc = new SessionService(deps);
  await svc.create({ repoPath: "/repo", baseBranch: "main", prompt: "p", model: null, images: [] });
  await new Promise((r) => setTimeout(r, 10));
  expect(events.emitted.some((x: any) => x.e === "session:renamed")).toBe(false);
});

test("refine skipped entirely when refineName dep is absent", async () => {
  const { store, events, deps } = svcDeps({ refineName: undefined });
  const svc = new SessionService(deps);
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "p",
    model: null,
    images: [],
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(store.get(s.id)?.name).toBe("even-two-recent-prs");
  expect(events.emitted.some((x: any) => x.e === "session:renamed")).toBe(false);
});

test("archiveMany clears each session, reaping all its leftovers", () => {
  const store = new SessionStore(":memory:");
  const calls: any = { stopped: [], removed: [], reaped: [] };
  const detect = (sess: any): any[] => [
    { kind: "process", key: `process:${sess.name}`, name: "vite", port: null },
  ];
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: (p: string) => calls.removed.push(p) } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => [],
      stop: (t: string) => calls.stopped.push(t),
    } as any,
    reaper: { detect, reap: (ls: any[]) => calls.reaped.push(...ls.map((l) => l.key)) },
  });
  const mk = (name: string, term: string) =>
    store.create({
      name,
      prompt: "p",
      repoPath: "/r",
      baseBranch: "main",
      branch: `shepherd/${name}`,
      worktreePath: `/wt/${name}`,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: term,
    });
  const a = mk("a", "term_a");
  const b = mk("b", "term_b");

  const res = svc.archiveMany([a.id, b.id, "missing-id"]);

  expect(res.cleared).toEqual([a.id, b.id]); // missing id skipped
  expect(res.leftovers).toBe(2); // one leftover each, both counted
  expect(calls.stopped).toEqual(["term_a", "term_b"]); // both agents stopped
  expect(calls.reaped).toEqual(["process:a", "process:b"]); // each session's leftovers killed
  expect(store.get(a.id)?.status).toBe("archived");
  expect(store.get(b.id)?.status).toBe("archived");
});

function injectDeps(store: SessionStore, captured: { argv?: string[] }) {
  return {
    store,
    namer: async () => "repo-task",
    worktree: {
      create: () => ({
        worktreePath: "/wt/repo-task",
        branch: "shepherd/repo-task",
        isolated: true,
      }),
      remove: () => {},
    } as any,
    herdr: {
      start: (_n: string, _c: string, argv: string[]) => {
        captured.argv = argv;
        return { terminalId: "t1" };
      },
      list: () => [],
    } as any,
  };
}

test("create prepends active+promoted house rules to the prompt", async () => {
  const store = new SessionStore(":memory:");
  const a = store.addLearning({
    repoPath: "/repo",
    rule: "Use bun, not npm",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(a.id, "active");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  const promptArg = captured.argv!.at(-1)!;
  expect(promptArg).toContain("Project house rules");
  expect(promptArg).toContain("- Use bun, not npm");
  expect(promptArg.endsWith("do the thing")).toBe(true); // user text stays last
});

test("create omits the house-rules block when no active rules exist", async () => {
  const store = new SessionStore(":memory:");
  store.addLearning({ repoPath: "/repo", rule: "still proposed", rationale: "", evidence: [] }); // proposed, not injected
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  expect(captured.argv!.at(-1)).toBe("do the thing");
});

test("create omits house rules when learnings disabled for the repo", async () => {
  const store = new SessionStore(":memory:");
  const a = store.addLearning({ repoPath: "/repo", rule: "Use bun", rationale: "", evidence: [] });
  store.setLearningStatus(a.id, "active");
  store.setRepoConfig("/repo", { criticEnabled: true, learningsEnabled: false });
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  expect(captured.argv!.at(-1)).toBe("do the thing");
});

test("archiveMany isolates a failing session: others still clear, the failed id is excluded", () => {
  const store = new SessionStore(":memory:");
  const detect = (): any[] => [];
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      // session b's worktree teardown blows up mid-loop
      remove: (p: string) => {
        if (p === "/wt/b") throw new Error("worktree locked");
      },
    } as any,
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {} } as any,
    reaper: { detect, reap: () => {} },
  });
  const mk = (name: string) =>
    store.create({
      name,
      prompt: "p",
      repoPath: "/r",
      baseBranch: "main",
      branch: `shepherd/${name}`,
      worktreePath: `/wt/${name}`,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: `term_${name}`,
    });
  const a = mk("a");
  const b = mk("b");
  const c = mk("c");

  const res = svc.archiveMany([a.id, b.id, c.id]);

  expect(res.cleared).toEqual([a.id, c.id]); // b's failure didn't abort the loop, and b is excluded
  expect(store.get(a.id)?.status).toBe("archived");
  expect(store.get(c.id)?.status).toBe("archived");
  expect(store.get(b.id)?.status).not.toBe("archived"); // b stays active (teardown threw)
});
