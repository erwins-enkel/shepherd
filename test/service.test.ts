import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import {
  SessionService,
  spawnSettingsOverlay,
  composeSystemPrompt,
  readInstalledPluginIds,
  installedPluginIds,
  MERGE_STALE_MS,
  TRAIN_TRACKER_MAX_MS,
  DRAFT_PR_NOTE,
  planGoSteer,
  PREVIEW_START_STEER,
} from "../src/service";
import { HOUSE_RULES_TAG } from "../src/house-rules";
import { config, parseTrimAutoContext } from "../src/config";

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
    "--append-system-prompt",
    composeSystemPrompt(null, false, { previewHint: true }), // no learnings → engineering-posture + branch-rename notice, no house-rules block
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

test("spawnSettingsOverlay pins remoteControlAtStartup + disables claude.ai connector MCP", () => {
  const prev = config.remoteControlAtStartup;
  const connectorEnv = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  try {
    config.remoteControlAtStartup = false;
    expect(JSON.parse(spawnSettingsOverlay())).toEqual({
      remoteControlAtStartup: false,
      env: connectorEnv,
    });
    config.remoteControlAtStartup = true;
    expect(JSON.parse(spawnSettingsOverlay())).toEqual({
      remoteControlAtStartup: true,
      env: connectorEnv,
    });
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
    "--append-system-prompt",
    composeSystemPrompt(null, false, { previewHint: true }), // no learnings → engineering-posture + branch-rename notice, no house-rules block
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

test("createSession: persists auto=true and issueNumber from issueRef.number", async () => {
  const store = new SessionStore(":memory:");
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({ terminalId: "t", cwd: "/wt/x", agentStatus: "working" }),
      list: () => [],
    } as any,
    pluginIds: async () => [], // hermetic: auto+trim must not read the operator's real settings
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "drain task",
    model: null,
    images: [],
    auto: true,
    issueRef: { number: 42, url: "https://github.com/o/r/issues/42", title: "Fix it", body: "" },
  });

  expect(s.auto).toBe(true);
  expect(s.issueNumber).toBe(42);
  // values round-trip through the store
  expect(store.get(s.id)?.auto).toBe(true);
  expect(store.get(s.id)?.issueNumber).toBe(42);
});

test("createSession: defaults auto=false and issueNumber=null when not provided", async () => {
  const store = new SessionStore(":memory:");
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({ terminalId: "t", cwd: "/wt/x", agentStatus: "working" }),
      list: () => [],
    } as any,
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "manual task",
    model: null,
    images: [],
  });

  expect(s.auto).toBe(false);
  expect(s.issueNumber).toBeNull();
  expect(store.get(s.id)?.auto).toBe(false);
  expect(store.get(s.id)?.issueNumber).toBeNull();
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
    reaper: { detect: detect as any, reap: () => {}, stopListenersOnPort: () => 0 },
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
      stopListenersOnPort: () => 0,
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
      stopListenersOnPort: () => 0,
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

test("resume respawns claude --resume in the worktree and re-points the agent", async () => {
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

  const out = await svc.resume(s.id);
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

test("resume omits --model when the session had none", async () => {
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
  await svc.resume(s.id);
  expect(calls.argv).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--resume",
    "abc-123",
    "--settings",
    spawnSettingsOverlay(),
  ]);
});

test("resume re-uses a still-live agent instead of spawning a duplicate", async () => {
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
  const out = await svc.resume(s.id);
  expect(started).toBe(0); // no second claude
  expect(out?.id).toBe(s.id);
  expect(out?.herdrAgentId).toBe("term_old");
});

test("resume force=true stops the live husk agent and respawns claude", async () => {
  const store = new SessionStore(":memory:");
  let started = 0;
  const stopped: string[] = [];
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: () => {
        started++;
        return { terminalId: "term_new", agentStatus: "working" } as any;
      },
      // agent still listed (claude exited but its herdr tab survives as a shell)
      list: () => [{ terminalId: "term_old", cwd: "/wt/x", name: "x" }] as any,
      stop: (id: string) => stopped.push(id),
      send: () => {},
    } as any,
  });
  const s = resumable(store);
  const out = await svc.resume(s.id, { force: true });
  expect(stopped).toEqual(["term_old"]); // tore down the husk first
  expect(started).toBe(1); // then respawned a fresh claude
  expect(out?.herdrAgentId).toBe("term_new");
  expect(out?.status).toBe("running");
});

test("resume returns null for unknown, archived, or pre-feature sessions", async () => {
  const store = new SessionStore(":memory:");
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {}, send: () => {} } as any,
  });
  expect(await svc.resume("ghost")).toBeNull(); // unknown id

  const archived = resumable(store);
  store.archive(archived.id);
  expect(await svc.resume(archived.id)).toBeNull(); // worktree already removed

  const preFeature = resumable(store, { claudeSessionId: "" });
  expect(await svc.resume(preFeature.id)).toBeNull(); // nothing pinned to resume
});

test("reply delivers the text as a bracketed paste, then submits with a carriage return", () => {
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
      list: () => [{ terminalId: "term_z" }], // pane is live
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
  });

  expect(svc.reply(s.id, "1")).toBe(true);
  // Wrapping in bracketed-paste markers gives an explicit paste-end, so the trailing
  // CR registers as Enter even when herdr coalesces the two writes into one PTY read
  // (a bare multi-line blob + "\r" trips Claude Code's paste heuristic and swallows
  // the CR, leaving the message typed-but-unsent).
  expect(sent).toEqual([
    { target: "term_z", text: "\x1b[200~1\x1b[201~" },
    { target: "term_z", text: "\r" },
  ]);
  expect(svc.reply("nope", "1")).toBe(false);

  // Stray paste markers in the payload are stripped: a leaked end-marker would close
  // the paste early; the start-marker is dropped for symmetry.
  sent.length = 0;
  expect(svc.reply(s.id, "a\x1b[201~b\x1b[200~c")).toBe(true);
  expect(sent[0]).toEqual({ target: "term_z", text: "\x1b[200~abc\x1b[201~" });
});

test("reply returns false for a live-in-store session whose pane is dead (no throw, no send)", () => {
  const sent: unknown[] = [];
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
    herdrAgentId: "term_dead",
  });
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => [{ terminalId: "term_other" }], // session's pane is NOT listed → dead
      stop: () => {},
      send: () => sent.push("sent"),
    } as any,
  });
  // honest boolean instead of letting herdr.send throw, and no steer is attempted
  expect(svc.reply(s.id, "hi")).toBe(false);
  expect(sent).toEqual([]);
  expect(store.listSignals("/r").length).toBe(0); // undelivered steer records no signal
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
      list: () => [{ terminalId: "term_a" }, { terminalId: "term_b" }], // both panes live
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
  });

  const res = svc.broadcast([a.id, "ghost", b.id], "run tests");
  expect(res).toEqual({ sent: 2, total: 3 });
  expect(sent).toEqual([
    { target: "term_a", text: "\x1b[200~run tests\x1b[201~" },
    { target: "term_a", text: "\r" },
    { target: "term_b", text: "\x1b[200~run tests\x1b[201~" },
    { target: "term_b", text: "\r" },
  ]);
});

test("haltAll sends a lone ESC only to working panes; idle/blocked/dead untouched; emits count", () => {
  const sent: { target: string; text: string }[] = [];
  const emitted: { e: string; d: unknown }[] = [];
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
  mk("a", "term_a"); // working → halted
  mk("b", "term_b"); // idle → skipped
  mk("c", "term_c"); // blocked → skipped
  mk("d", "term_d"); // working → halted
  mk("e", "term_dead"); // not in live list (dead pane) → skipped
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    events: { emit: (e: string, d: unknown) => emitted.push({ e, d }) } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => [
        { terminalId: "term_a", agentStatus: "working", cwd: "/wt/a", name: "" },
        { terminalId: "term_b", agentStatus: "idle", cwd: "/wt/b", name: "" },
        { terminalId: "term_c", agentStatus: "blocked", cwd: "/wt/c", name: "" },
        { terminalId: "term_d", agentStatus: "working", cwd: "/wt/d", name: "" },
      ],
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
  });

  // Only the two `working` panes are interrupted, each with a single ESC (the Claude
  // Code interrupt key) — no bracketed paste, no trailing CR. A lone ESC halts the
  // current turn without clearing input or quitting.
  expect(svc.haltAll()).toEqual({ halted: 2 });
  expect(sent).toEqual([
    { target: "term_a", text: "\x1b" },
    { target: "term_d", text: "\x1b" },
  ]);
  expect(emitted).toContainEqual({ e: "halt:done", d: { halted: 2 } });
});

test("haltAll keeps interrupting after one pane's send throws; counts only the landed ones", () => {
  const sent: string[] = [];
  const emitted: { e: string; d: unknown }[] = [];
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
  mk("a", "term_a"); // working → lands
  mk("b", "term_b"); // working → send throws (died between list and send)
  mk("c", "term_c"); // working → lands (must NOT be skipped by b's failure)
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    events: { emit: (e: string, d: unknown) => emitted.push({ e, d }) } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => [
        { terminalId: "term_a", agentStatus: "working", cwd: "/wt/a", name: "" },
        { terminalId: "term_b", agentStatus: "working", cwd: "/wt/b", name: "" },
        { terminalId: "term_c", agentStatus: "working", cwd: "/wt/c", name: "" },
      ],
      stop: () => {},
      send: (target: string) => {
        if (target === "term_b") throw new Error("agent_not_found");
        sent.push(target);
      },
    } as any,
  });

  expect(svc.haltAll()).toEqual({ halted: 2 }); // only the two that landed
  expect(sent).toEqual(["term_a", "term_c"]); // b's failure didn't abort the sweep
  expect(emitted).toContainEqual({ e: "halt:done", d: { halted: 2 } });
});

test("haltAll throws (no emit) when herdr can't be reached — never a silent no-op", () => {
  const emitted: { e: string; d: unknown }[] = [];
  const sent: unknown[] = [];
  const store = new SessionStore(":memory:");
  store.create({
    name: "a",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/a",
    worktreePath: "/wt/a",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
  });
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    events: { emit: (e: string, d: unknown) => emitted.push({ e, d }) } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => {
        throw new Error("herdr down");
      },
      stop: () => {},
      send: () => sent.push("sent"),
    } as any,
  });

  // Propagates instead of returning {halted:0}: the route turns it into a 500 so the
  // UI surfaces halt_failed + Retry rather than a success-looking "Halted 0 agents".
  expect(() => svc.haltAll()).toThrow("herdr down");
  expect(sent).toEqual([]);
  expect(emitted).toEqual([]); // no halt:done on a stop that never ran
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
    reaper: {
      detect,
      reap: (ls: any[]) => calls.reaped.push(...ls.map((l) => l.key)),
      stopListenersOnPort: () => 0,
    },
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

function injectDeps(store: SessionStore, captured: { argv?: string[] }, isolated = true) {
  return {
    store,
    namer: async () => "repo-task",
    worktree: {
      create: () => ({
        worktreePath: "/wt/repo-task",
        branch: isolated ? "shepherd/repo-task" : null,
        isolated,
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

/** The value passed to --append-system-prompt (the flag's following argv element). */
function sysPrompt(argv: string[]): string {
  const i = argv.indexOf("--append-system-prompt");
  return argv[i + 1]!;
}

/** Just the <shepherd-house-rules>…</shepherd-house-rules> slice of the system prompt. */
function houseRulesBlock(argv: string[]): string {
  const sp = sysPrompt(argv);
  const open = `<${HOUSE_RULES_TAG}>`;
  const close = `</${HOUSE_RULES_TAG}>`;
  const start = sp.indexOf(open);
  return sp.slice(start, sp.indexOf(close) + close.length);
}

test("create injects active+promoted house rules into the system prompt, task stays clean", async () => {
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
  // Rules ride the system prompt, XML-wrapped — not the human turn.
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain(`<${HOUSE_RULES_TAG}>`);
  expect(sp).toContain("- Use bun, not npm");
  // The human prompt (last argv) is exactly the user's task — no rules bleed in.
  expect(captured.argv!.at(-1)).toBe("do the thing");
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
  // System prompt carries posture + branch-rename notice, no house-rules tag.
  expect(sysPrompt(captured.argv!)).toBe(composeSystemPrompt(null, false, { previewHint: true }));
});

test("create omits house rules when learnings disabled for the repo", async () => {
  const store = new SessionStore(":memory:");
  const a = store.addLearning({ repoPath: "/repo", rule: "Use bun", rationale: "", evidence: [] });
  store.setLearningStatus(a.id, "active");
  store.setRepoConfig("/repo", {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
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
  expect(sysPrompt(captured.argv!)).toBe(composeSystemPrompt(null, false, { previewHint: true }));
});

test("composeSystemPrompt adds the autopilot directive only when active", () => {
  expect(composeSystemPrompt(null)).not.toContain("<autopilot-directive>");
  expect(composeSystemPrompt(null, false)).not.toContain("<autopilot-directive>");
  const on = composeSystemPrompt(null, true);
  expect(on).toContain("<autopilot-directive>");
  expect(on).toContain("Shepherd autopilot");
  expect(on).toContain("<branch-rename-notice>"); // still present alongside
});

test("create seeds the autopilot directive when the repo has autopilot on", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: true,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  // The agent learns up front it's unattended, so it won't stop to ask "commit + open a PR?".
  expect(sysPrompt(captured.argv!)).toContain("<autopilot-directive>");
  // The human turn stays exactly the user's task — the directive rides the system prompt.
  expect(captured.argv!.at(-1)).toBe("do the thing");
});

test("create omits the autopilot directive when the repo has autopilot off", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  expect(sysPrompt(captured.argv!)).not.toContain("<autopilot-directive>");
});

test("create injects only the planned house rules and drops the over-budget ones", async () => {
  const store = new SessionStore(":memory:");
  // Many 160-char rules so the combined block blows past the default 4000-char budget
  // (~25 max-length rules fit). 40 rules → ~6.6 KB worth, well over budget.
  for (let i = 0; i < 40; i++) {
    const r = store.addLearning({
      repoPath: "/repo",
      rule: `R${String(i).padStart(2, "0")}-` + "x".repeat(150),
      rationale: "",
      evidence: [],
    });
    store.setLearningStatus(r.id, "active");
  }
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  // Human prompt stays clean; rules live in the system prompt.
  expect(captured.argv!.at(-1)).toBe("do the thing");
  const block = houseRulesBlock(captured.argv!);
  // Block (XML-wrapped) must stay within the 4000-char budget.
  expect(block.length).toBeLessThanOrEqual(4000);
  // Some rules injected, some dropped (not all 40 fit).
  const injectedCount = (block.match(/^- /gm) ?? []).length;
  expect(injectedCount).toBeGreaterThan(0);
  expect(injectedCount).toBeLessThan(40);
});

test("composeSystemPrompt always injects the engineering-posture block, with or without house rules", () => {
  // Posture is universal standing guidance (not a per-repo learning), so it must ride every
  // spawn regardless of the learnings toggle / house-rules state — i.e. even when houseRules is null.
  const withoutRules = composeSystemPrompt(null);
  const withRules = composeSystemPrompt(
    `<${HOUSE_RULES_TAG}>\nintro\n- Use bun\n</${HOUSE_RULES_TAG}>`,
  );

  for (const sp of [withoutRules, withRules]) {
    expect(sp).toContain("<engineering-posture>");
    expect(sp).toContain("</engineering-posture>");
    // The four Karpathy principles, by their distinguishing wording.
    expect(sp).toContain("Think before coding");
    expect(sp).toContain("Simplicity first");
    expect(sp).toContain("Surgical changes");
    expect(sp).toContain("Goal-driven execution");
    // Branch-rename notice still rides alongside.
    expect(sp).toContain("<branch-rename-notice>");
  }
  // Repo house rules still appear when present, distinct from posture.
  expect(withRules).toContain(`<${HOUSE_RULES_TAG}>`);
  expect(withoutRules).not.toContain(`<${HOUSE_RULES_TAG}>`);
});

test("composeSystemPrompt always injects the research-first notice, with or without house rules", () => {
  // Fixed standing guidance (issue #347), not a per-repo learning, so it rides every spawn
  // regardless of the learnings toggle / house-rules state — i.e. even when houseRules is null.
  const withoutRules = composeSystemPrompt(null);
  const withRules = composeSystemPrompt(
    `<${HOUSE_RULES_TAG}>\nintro\n- Use bun\n</${HOUSE_RULES_TAG}>`,
  );
  for (const sp of [withoutRules, withRules]) {
    expect(sp).toContain("<research-first-notice>");
    expect(sp).toContain("</research-first-notice>");
    // Scoped to non-trivial external API work, with the "note what you found" half intact.
    expect(sp).toContain("do a quick web search to confirm the present best approach");
    expect(sp).toContain("Skip this for trivial edits");
  }
  // Rides unconditionally, like the autopilot-independent posture/branch blocks.
  expect(composeSystemPrompt(null, true)).toContain("<research-first-notice>");
});

test("resume adopts a live agent found by cwd under a new terminalId — no duplicate spawn", async () => {
  const store = new SessionStore(":memory:");
  let startCalls = 0;
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: () => {
        startCalls++;
        return { terminalId: "term_should_not_happen" } as any;
      },
      list: () => [
        {
          agent: "claude",
          agentStatus: "working",
          cwd: "/wt/x",
          name: "x",
          paneId: "p",
          tabId: "t",
          terminalId: "term_fresh",
          workspaceId: "w",
        },
      ],
      stop: () => {},
      send: () => {},
    } as any,
  });
  const s = resumable(store, { model: "opus" }); // worktreePath "/wt/x", herdrAgentId "term_old"

  const out = await svc.resume(s.id);
  expect(startCalls).toBe(0); // agent already live → must NOT respawn
  expect(out?.herdrAgentId).toBe("term_fresh"); // adopted the new id
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
    reaper: { detect, reap: () => {}, stopListenersOnPort: () => 0 },
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

function mergeSvc() {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: any }[] = [];
  const refreshed: string[] = [];
  const service = new SessionService({
    store,
    namer: async () => "n",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "b", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({
        terminalId: "t",
        cwd: "/",
        agent: "claude",
        agentStatus: "idle",
        paneId: "p",
        tabId: "x",
        workspaceId: "w",
      }),
      list: () => [],
      stop: () => {},
    } as any,
    events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) } as any,
    refreshPr: (id: string) => refreshed.push(id),
  });
  return { store, service, emitted, refreshed };
}

async function mkSession(service: SessionService) {
  return service.create({
    repoPath: "/r",
    baseBranch: "main",
    prompt: "p",
    model: null,
    images: [],
  });
}

test("setMerging stamps each id and emits session:merging; skips unknown ids", async () => {
  const { store, service, emitted } = mergeSvc();
  const a = await mkSession(service);
  service.setMerging([a.id, "ghost"], "train-9");
  expect(store.get(a.id)!.mergingSince).toBeGreaterThan(0);
  expect(store.get(a.id)!.mergingTrainId).toBe("train-9");
  const ev = emitted.filter((e) => e.event === "session:merging");
  expect(ev).toHaveLength(1);
  expect(ev[0]!.data).toMatchObject({ id: a.id, trainId: "train-9" });
  expect(typeof ev[0]!.data.since).toBe("number");
});

test("clearMerging nulls the fields and emits since:null; no-op when not merging", async () => {
  const { store, service, emitted } = mergeSvc();
  const a = await mkSession(service);
  service.clearMerging(a.id);
  expect(emitted.filter((e) => e.event === "session:merging")).toHaveLength(0);
  service.setMerging([a.id], "t1");
  service.clearMerging(a.id);
  expect(store.get(a.id)!.mergingSince).toBeNull();
  expect(store.get(a.id)!.mergingTrainId).toBeNull();
  const last = emitted.filter((e) => e.event === "session:merging").at(-1)!;
  expect(last.data).toEqual({ id: a.id, since: null, trainId: null });
});

test("clearMergingForTrain clears every member of one train, leaves others", async () => {
  const { store, service } = mergeSvc();
  const a = await mkSession(service);
  const b = await mkSession(service);
  service.setMerging([a.id], "train-A");
  service.setMerging([b.id], "train-B");
  service.clearMergingForTrain("train-A");
  expect(store.get(a.id)!.mergingSince).toBeNull();
  expect(store.get(b.id)!.mergingSince).toBeGreaterThan(0);
});

test("sweepStaleMerging clears marks older than the TTL, keeps fresh ones", async () => {
  const { store, service } = mergeSvc();
  const a = await mkSession(service);
  service.setMerging([a.id], "t");
  const now = Date.now();
  service.sweepStaleMerging(now);
  expect(store.get(a.id)!.mergingSince).toBeGreaterThan(0);
  service.sweepStaleMerging(now + MERGE_STALE_MS + 1);
  expect(store.get(a.id)!.mergingSince).toBeNull();
});

// ── mergetrain:landed completion tracker ──────────────────────────────────────

function landed(emitted: { event: string; data: any }[]) {
  return emitted.filter((e) => e.event === "mergetrain:landed");
}

test("merge-before-archive: member merges, then train archives → one mergetrain:landed", async () => {
  const { service, emitted } = mergeSvc();
  const a = await mkSession(service); // repoPath "/r", isolated
  service.setMerging([a.id], "train-X");
  service.resolveMerging(a.id, true); // credited, but no emit yet (train still live)
  expect(landed(emitted)).toHaveLength(0);
  service.clearMergingForTrain("train-X");
  const ev = landed(emitted);
  expect(ev).toHaveLength(1);
  expect(ev[0]!.data).toEqual({ repoPath: "/r" });
  // idempotence: a second archive call is a no-op (entry already finalized)
  service.clearMergingForTrain("train-X");
  expect(landed(emitted)).toHaveLength(1);
});

test("archive-before-merge (the race): archive defers + nudges, late merge fires once", async () => {
  const { service, emitted, refreshed } = mergeSvc();
  const a = await mkSession(service);
  const b = await mkSession(service);
  service.setMerging([a.id, b.id], "train-R");
  service.clearMergingForTrain("train-R"); // archives first, merged still false
  expect(landed(emitted)).toHaveLength(0); // deferred — no emit yet
  expect(refreshed.sort()).toEqual([a.id, b.id].sort()); // nudged each live member
  service.resolveMerging(a.id, true); // late credit → fires
  const ev = landed(emitted);
  expect(ev).toHaveLength(1);
  expect(ev[0]!.data).toEqual({ repoPath: "/r" });
  // entry cleared: a later resolve for the other member does not re-fire
  service.resolveMerging(b.id, true);
  expect(landed(emitted)).toHaveLength(1);
});

test("nothing merged: all resolve false, archive, TTL sweep → never emits", async () => {
  const { service, emitted } = mergeSvc();
  const a = await mkSession(service);
  service.setMerging([a.id], "train-N");
  service.resolveMerging(a.id, false);
  service.clearMergingForTrain("train-N");
  expect(landed(emitted)).toHaveLength(0);
  service.sweepStaleMerging(Date.now() + MERGE_STALE_MS + 1);
  expect(landed(emitted)).toHaveLength(0);
});

test("isolated guard: a sole non-isolated merged member never emits", async () => {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: any }[] = [];
  const service = new SessionService({
    store,
    namer: async () => "n",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: null, isolated: false }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({
        terminalId: "t",
        cwd: "/",
        agent: "claude",
        agentStatus: "idle",
        paneId: "p",
        tabId: "x",
        workspaceId: "w",
      }),
      list: () => [],
      stop: () => {},
    } as any,
    events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) } as any,
  });
  const a = await mkSession(service); // non-isolated (worktree mock)
  expect(store.get(a.id)!.isolated).toBe(false);
  service.setMerging([a.id], "train-NI");
  service.resolveMerging(a.id, true); // not credited (non-isolated)
  expect(landed(emitted)).toHaveLength(0);
  service.clearMergingForTrain("train-NI"); // archive with merged still false
  expect(landed(emitted)).toHaveLength(0);
});

test("pre-archive credit alone does not emit (fires on completion, not first merge)", async () => {
  const { service, emitted } = mergeSvc();
  const a = await mkSession(service);
  service.setMerging([a.id], "train-P");
  service.resolveMerging(a.id, true);
  expect(landed(emitted)).toHaveLength(0); // train still live
});

test("sweep eviction: stale awaiting entry evicted with no emit; fresh entry untouched", async () => {
  const { service, emitted } = mergeSvc();
  const a = await mkSession(service);
  service.setMerging([a.id], "train-S");
  service.clearMergingForTrain("train-S"); // archived, merged false → awaiting
  // evict by age; verify no emit and that the memberToTrain row is cleared
  service.sweepStaleMerging(Date.now() + MERGE_STALE_MS + 1);
  expect(landed(emitted)).toHaveLength(0);
  // a later credit can no longer fire (entry + memberToTrain row gone)
  service.resolveMerging(a.id, true);
  expect(landed(emitted)).toHaveLength(0);

  // a LIVE (un-archived) entry is never swept — even by a sweep far past launch+TTL
  const b = await mkSession(service);
  service.setMerging([b.id], "train-F");
  service.sweepStaleMerging(Date.now() + 10 * MERGE_STALE_MS); // live → not evicted
  service.clearMergingForTrain("train-F"); // would only fire if entry survived
  // merged false so still no emit, but entry must still exist (not evicted):
  service.resolveMerging(b.id, true);
  expect(landed(emitted)).toHaveLength(1);
});

test("slow/long run: a still-running train is never swept, however long it takes (no activity, no archive)", async () => {
  const { service, emitted } = mergeSvc();
  const a = await mkSession(service);
  service.setMerging([a.id], "train-Slow"); // live; first PR's CI is slow — no member has resolved yet
  const t0 = Date.now();
  // The critic's case: no member activity and no archive for well past MERGE_STALE_MS.
  // A live entry must NOT be reclaimed (a launch-/activity-keyed TTL would drop it here).
  service.sweepStaleMerging(t0 + 5 * MERGE_STALE_MS);
  // The first PR finally lands, then the train archives → entry intact, fires once.
  service.resolveMerging(a.id, true);
  service.clearMergingForTrain("train-Slow", t0 + 5 * MERGE_STALE_MS + 1);
  expect(landed(emitted)).toHaveLength(1);
});

test("repeat archive is idempotent: doesn't restart the await window or re-nudge members", async () => {
  const { service, emitted, refreshed } = mergeSvc();
  const a = await mkSession(service);
  service.setMerging([a.id], "train-Re");
  const t0 = Date.now();
  service.clearMergingForTrain("train-Re", t0); // archived, awaiting (merged false) → window starts at t0
  // A second session:archived for the same train must be ignored — it must NOT
  // restart the await window or fire refreshPr again.
  service.clearMergingForTrain("train-Re", t0 + MERGE_STALE_MS / 2);
  expect(refreshed).toEqual([a.id]); // nudged exactly once across both calls
  // Window stays anchored at t0, so a sweep at t0+TTL+1 evicts (it would NOT have if reset).
  service.sweepStaleMerging(t0 + MERGE_STALE_MS + 1);
  service.resolveMerging(a.id, true); // entry gone → no late credit
  expect(landed(emitted)).toHaveLength(0);
});

test("dead-train backstop: a live entry orphaned past TRAIN_TRACKER_MAX_MS is reclaimed (no emit)", async () => {
  const { service, emitted } = mergeSvc();
  const a = await mkSession(service);
  // `base` is captured BEFORE setMerging, so launchedAt >= base; the ±1min margins
  // dwarf any sub-ms drift, keeping the boundary checks non-flaky.
  const base = Date.now();
  service.setMerging([a.id], "train-Dead"); // launchedAt ≈ base; train session then dies w/o session:archived
  // Below the backstop while live → NOT reclaimed.
  service.sweepStaleMerging(base + TRAIN_TRACKER_MAX_MS - 60_000);
  // Past the backstop → reclaimed with no emit (no session:archived ever arrived).
  service.sweepStaleMerging(base + TRAIN_TRACKER_MAX_MS + 60_000);
  // Entry gone: a later merge + archive can no longer fire an offer.
  service.resolveMerging(a.id, true);
  service.clearMergingForTrain("train-Dead", base + TRAIN_TRACKER_MAX_MS + 120_000);
  expect(landed(emitted)).toHaveLength(0);
});

test("setMerging with all-unknown ids creates no entry; later archive is a no-op", async () => {
  const { service, emitted } = mergeSvc();
  service.setMerging(["ghost"], "train-G"); // no resolvable member
  expect(() => service.clearMergingForTrain("train-G")).not.toThrow();
  expect(landed(emitted)).toHaveLength(0);
});

test("untracked passthrough: resolveMerging/clearMergingForTrain on unknown ids no-op, still clear marks", async () => {
  const { store, service, emitted } = mergeSvc();
  const a = await mkSession(service);
  // resolveMerging on a session never registered with a train: clears mark, no emit
  service.setMerging([a.id], "train-U");
  // simulate an untracked member by resolving a truly unknown id
  expect(() => service.resolveMerging("nobody", true)).not.toThrow();
  expect(() => service.clearMergingForTrain("no-such-train")).not.toThrow();
  expect(landed(emitted)).toHaveLength(0);
  // marks for the real session still clearable via resolveMerging
  service.resolveMerging(a.id, false);
  expect(store.get(a.id)!.mergingSince).toBeNull();
});

// ── build queue ──────────────────────────────────────────────────────────────

test("composeSystemPrompt includes <build-queue> block when directive is given", () => {
  const sp = composeSystemPrompt(null, false, { buildQueue: "directive text" });
  expect(sp).toContain("<build-queue>");
  expect(sp).toContain("directive text");
  expect(sp).toContain("</build-queue>");
});

test("composeSystemPrompt omits <build-queue> block when null (1-arg backward compat)", () => {
  expect(composeSystemPrompt(null)).not.toContain("<build-queue>");
  expect(composeSystemPrompt(null, false)).not.toContain("<build-queue>");
  expect(composeSystemPrompt(null, true)).not.toContain("<build-queue>");
});

test("composeSystemPrompt places <build-queue> after <autopilot-directive>", () => {
  const sp = composeSystemPrompt(null, true, { buildQueue: "bq-text" });
  const autopilotPos = sp.indexOf("<autopilot-directive>");
  const bqPos = sp.indexOf("<build-queue>");
  expect(autopilotPos).toBeGreaterThan(-1);
  expect(bqPos).toBeGreaterThan(autopilotPos);
});

test("composeSystemPrompt places <build-queue> after branch-rename-notice (no autopilot)", () => {
  const sp = composeSystemPrompt(null, false, { buildQueue: "bq-text" });
  const branchPos = sp.indexOf("<branch-rename-notice>");
  const bqPos = sp.indexOf("<build-queue>");
  expect(branchPos).toBeGreaterThan(-1);
  expect(bqPos).toBeGreaterThan(branchPos);
  expect(sp).not.toContain("<autopilot-directive>");
});

test("composeSystemPrompt omits <preview-hint-notice> when previewHint is unset/false", () => {
  expect(composeSystemPrompt(null)).not.toContain("<preview-hint-notice>");
  expect(composeSystemPrompt(null, false)).not.toContain("<preview-hint-notice>");
  expect(composeSystemPrompt(null, true)).not.toContain("<preview-hint-notice>");
});

test("composeSystemPrompt includes <preview-hint-notice> when previewHint is true", () => {
  const sp = composeSystemPrompt(null, false, { previewHint: true });
  expect(sp).toContain("<preview-hint-notice>");
  expect(sp).toContain(".shepherd-preview");
  expect(sp).toContain("</preview-hint-notice>");
});

test("composeSystemPrompt places <preview-hint-notice> after <build-queue> when both present", () => {
  const sp = composeSystemPrompt(null, true, { buildQueue: "bq-text", previewHint: true });
  const bqPos = sp.indexOf("<build-queue>");
  const phPos = sp.indexOf("<preview-hint-notice>");
  expect(bqPos).toBeGreaterThan(-1);
  expect(phPos).toBeGreaterThan(bqPos);
});

test("composeSystemPrompt places <preview-hint-notice> after <branch-rename-notice> when no build-queue", () => {
  const sp = composeSystemPrompt(null, false, { previewHint: true });
  const branchPos = sp.indexOf("<branch-rename-notice>");
  const phPos = sp.indexOf("<preview-hint-notice>");
  expect(branchPos).toBeGreaterThan(-1);
  expect(phPos).toBeGreaterThan(branchPos);
  expect(sp).not.toContain("<build-queue>");
});

test("isolated spawn argv carries <preview-hint-notice> in system prompt", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  expect(sysPrompt(captured.argv!)).toContain("<preview-hint-notice>");
});

test("non-isolated spawn argv does NOT carry <preview-hint-notice> in system prompt", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured, false) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    images: [],
  });
  expect(sysPrompt(captured.argv!)).not.toContain("<preview-hint-notice>");
});

function buildQueueDeps(
  store: SessionStore,
  captured: { argv?: string[] },
  repoConfig?: Partial<Parameters<SessionStore["setRepoConfig"]>[1]>,
) {
  if (repoConfig) {
    store.setRepoConfig("/repo", {
      criticEnabled: true,
      autoAddressEnabled: false,
      learningsEnabled: false,
      autopilotEnabled: false,
      planGateEnabled: false,
      autoDrainEnabled: false,
      autoMergeEnabled: false,
      buildQueueEnabled: false,
      draftMode: false,
      signoffAuthority: "human",
      maxAuto: 1,
      autoLabel: "shepherd:auto",
      usageCeilingPct: 80,
      ...repoConfig,
    });
  }
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

test("create with buildQueueEnabled=true: system prompt contains <build-queue> block", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(
    buildQueueDeps(store, captured, { buildQueueEnabled: true }) as any,
  );
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain("<build-queue>");
  expect(sp).toContain("</build-queue>");
});

test("create with buildQueueEnabled=true: system prompt contains the real session id and queue endpoint", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(
    buildQueueDeps(store, captured, { buildQueueEnabled: true }) as any,
  );
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain(`/api/sessions/${s.id}/queue`);
});

test("create with buildQueueEnabled=false: system prompt has no <build-queue> block", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(
    buildQueueDeps(store, captured, { buildQueueEnabled: false }) as any,
  );
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  const sp = sysPrompt(captured.argv!);
  expect(sp).not.toContain("<build-queue>");
});

test("create with buildQueueEnabled=true + autopilot on: directive contains auto-approve phrasing", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(
    buildQueueDeps(store, captured, { buildQueueEnabled: true, autopilotEnabled: true }) as any,
  );
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain("auto-approved");
  expect(sp).toContain("immediately begin");
  expect(sp).not.toContain("STOP and wait");
});

test("create with buildQueueEnabled=true + autopilot off: directive contains stop-and-wait phrasing", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(
    buildQueueDeps(store, captured, { buildQueueEnabled: true, autopilotEnabled: false }) as any,
  );
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain("STOP and wait");
  expect(sp).not.toContain("immediately begin");
});

test("create with buildQueueEnabled=true + autopilot on: queue is auto-approved", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(
    buildQueueDeps(store, captured, { buildQueueEnabled: true, autopilotEnabled: true }) as any,
  );
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  expect(store.getBuildQueue(s.id).approved).toBe(true);
});

test("create with buildQueueEnabled=true + autopilot off: queue is NOT auto-approved", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(
    buildQueueDeps(store, captured, { buildQueueEnabled: true, autopilotEnabled: false }) as any,
  );
  const s = await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  expect(store.getBuildQueue(s.id).approved).toBe(false);
});

// ── draft mode ───────────────────────────────────────────────────────────────

test("composeSystemPrompt includes <draft-mode> block when draftMode=true", () => {
  const sp = composeSystemPrompt(null, false, { draftMode: true });
  expect(sp).toContain("<draft-mode>");
  expect(sp).toContain(DRAFT_PR_NOTE);
  expect(sp).toContain("</draft-mode>");
});

test("composeSystemPrompt omits <draft-mode> block when draftMode false/omitted", () => {
  expect(composeSystemPrompt(null)).not.toContain("<draft-mode>");
  expect(composeSystemPrompt(null, false)).not.toContain("<draft-mode>");
  expect(composeSystemPrompt(null, true)).not.toContain("<draft-mode>");
  expect(composeSystemPrompt(null, false, { draftMode: false })).not.toContain("<draft-mode>");
});

test("composeSystemPrompt <draft-mode> block is present alongside autopilot directive", () => {
  const sp = composeSystemPrompt(null, true, { draftMode: true });
  expect(sp).toContain("<autopilot-directive>");
  expect(sp).toContain("<draft-mode>");
});

test("planGoSteer(false) matches the base text exactly (no draft note)", () => {
  const steer = planGoSteer(false);
  expect(steer).toContain("gh pr create");
  expect(steer).not.toContain(DRAFT_PR_NOTE);
});

test("planGoSteer(true) appends the draft note to the base text", () => {
  const steer = planGoSteer(true);
  expect(steer).toContain("gh pr create");
  expect(steer).toContain(DRAFT_PR_NOTE);
});

test("create with draftMode=true: system prompt contains <draft-mode> block", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(buildQueueDeps(store, captured, { draftMode: true }) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain("<draft-mode>");
  expect(sp).toContain(DRAFT_PR_NOTE);
});

test("create with draftMode=false: system prompt has no <draft-mode> block", async () => {
  const store = new SessionStore(":memory:");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(buildQueueDeps(store, captured, { draftMode: false }) as any);
  await svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "do it",
    model: null,
    images: [],
  });
  expect(sysPrompt(captured.argv!)).not.toContain("<draft-mode>");
});

// ── startPreview ──────────────────────────────────────────────────────────────

function makePreviewSvc(opts: { terminalId: string; liveIds: string[] }) {
  const sent: { target: string; text: string }[] = [];
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "preview-test",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/preview-test",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: opts.terminalId,
  });
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: () => ({}) as any,
      list: () => opts.liveIds.map((id) => ({ terminalId: id })),
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
  });
  return { svc, store, s, sent };
}

test("startPreview: sends PREVIEW_START_STEER as bracketed paste + CR, returns true", () => {
  const { svc, s, sent } = makePreviewSvc({ terminalId: "term_p", liveIds: ["term_p"] });
  const result = svc.startPreview(s.id, "bun run dev");
  expect(result).toBe(true);
  // Two sends: paste-wrapped steer then CR
  expect(sent).toHaveLength(2);
  const [paste, cr] = sent;
  expect(cr!.text).toBe("\r");
  // The paste payload must contain the command
  expect(paste!.text).toContain("bun run dev");
  // Must instruct backgrounding
  const steer = PREVIEW_START_STEER("bun run dev");
  expect(steer).toContain("background");
  expect(steer).toContain("bun run dev");
});

test("startPreview: steer contains the command in backticks", () => {
  const steer = PREVIEW_START_STEER("cd ui && npm run dev");
  expect(steer).toContain("`cd ui && npm run dev`");
});

test("startPreview: steer demands the tailnet HTTPS URL, not just localhost", () => {
  const steer = PREVIEW_START_STEER("bun run dev");
  expect(steer).toContain("tailnet HTTPS URL");
  expect(steer).toContain("tailscale serve --bg --https");
  // FQDN must be resolved at runtime, never baked into the prompt
  expect(steer).toContain("tailscale status --json");
  expect(steer).not.toMatch(/\.ts\.net/);
});

test("startPreview: returns false for an unknown session id", () => {
  const { svc, sent } = makePreviewSvc({ terminalId: "term_p", liveIds: ["term_p"] });
  expect(svc.startPreview("nope", "bun run dev")).toBe(false);
  expect(sent).toHaveLength(0);
});

test("startPreview: returns false for a dead pane (session in store but pane not live)", () => {
  const { svc, s, sent } = makePreviewSvc({ terminalId: "term_dead", liveIds: ["term_other"] });
  expect(svc.startPreview(s.id, "bun run dev")).toBe(false);
  expect(sent).toHaveLength(0);
});

// ── stopPreview ───────────────────────────────────────────────────────────────

function makeStopPreviewSvc(opts: {
  hasSession?: boolean;
  devPort?: number | null;
  stopReturn?: number;
  omitReaper?: boolean;
  omitPreview?: boolean;
}) {
  const store = new SessionStore(":memory:");
  const stopCalls: { worktreePath: string; port: number; signal: NodeJS.Signals }[] = [];
  let s: ReturnType<typeof store.create> | undefined;
  if (opts.hasSession !== false) {
    s = store.create({
      name: "stop-preview-test",
      prompt: "x",
      repoPath: "/r",
      baseBranch: "main",
      branch: "shepherd/stop-preview-test",
      worktreePath: "/wt/stop-preview-test",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "term_sp",
    });
  }
  const reaper = opts.omitReaper
    ? undefined
    : {
        detect: () => [],
        reap: () => {},
        stopListenersOnPort: (worktreePath: string, port: number, signal: NodeJS.Signals) => {
          stopCalls.push({ worktreePath, port, signal });
          return opts.stopReturn ?? 1;
        },
      };
  const preview = opts.omitPreview
    ? undefined
    : {
        devPortFor: (): number | null => opts.devPort ?? null,
      };
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {}, send: () => {} } as any,
    reaper: reaper as any,
    preview: preview as any,
  });
  return { svc, store, s, stopCalls };
}

test("stopPreview: not_found when session id is unknown", () => {
  const { svc, stopCalls } = makeStopPreviewSvc({ devPort: 3000 });
  const result = svc.stopPreview("no-such-id");
  expect(result).toEqual({ result: "not_found", killed: 0 });
  expect(stopCalls).toHaveLength(0);
});

test("stopPreview: not_found when reaper dep is absent", () => {
  const { svc, s, stopCalls } = makeStopPreviewSvc({ devPort: 3000, omitReaper: true });
  const result = svc.stopPreview(s!.id);
  expect(result).toEqual({ result: "not_found", killed: 0 });
  expect(stopCalls).toHaveLength(0);
});

test("stopPreview: not_found when preview dep is absent", () => {
  const { svc, s, stopCalls } = makeStopPreviewSvc({ devPort: 3000, omitPreview: true });
  const result = svc.stopPreview(s!.id);
  expect(result).toEqual({ result: "not_found", killed: 0 });
  expect(stopCalls).toHaveLength(0);
});

test("stopPreview: not_bound when devPortFor returns null", () => {
  const { svc, s, stopCalls } = makeStopPreviewSvc({ devPort: null });
  const result = svc.stopPreview(s!.id);
  expect(result).toEqual({ result: "not_bound", killed: 0 });
  expect(stopCalls).toHaveLength(0);
});

test("stopPreview: stopped happy path — calls stopListenersOnPort with default SIGTERM", () => {
  const { svc, s, stopCalls } = makeStopPreviewSvc({ devPort: 3000, stopReturn: 1 });
  const result = svc.stopPreview(s!.id);
  expect(result).toEqual({ result: "stopped", killed: 1 });
  expect(stopCalls).toEqual([
    { worktreePath: "/wt/stop-preview-test", port: 3000, signal: "SIGTERM" },
  ]);
});

test("stopPreview: stopped with explicit SIGKILL", () => {
  const { svc, s, stopCalls } = makeStopPreviewSvc({ devPort: 4321, stopReturn: 2 });
  const result = svc.stopPreview(s!.id, "SIGKILL");
  expect(result).toEqual({ result: "stopped", killed: 2 });
  expect(stopCalls).toEqual([
    { worktreePath: "/wt/stop-preview-test", port: 4321, signal: "SIGKILL" },
  ]);
});

test("stopPreview: honest zero — stopListenersOnPort returning 0 yields stopped/0, not downgraded", () => {
  const { svc, s, stopCalls } = makeStopPreviewSvc({ devPort: 3000, stopReturn: 0 });
  const result = svc.stopPreview(s!.id);
  expect(result).toEqual({ result: "stopped", killed: 0 });
  expect(stopCalls).toHaveLength(1);
});

test("stopPreview: does NOT call any release method on the preview dep", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "stop-preview-release",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/stop-preview-release",
    worktreePath: "/wt/stop-preview-release",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_spr",
  });
  const previewCalls: string[] = [];
  // fake preview exposes only devPortFor — any extra method calls would be a type error
  const preview = {
    devPortFor: (): number | null => {
      previewCalls.push("devPortFor");
      return 3000;
    },
  };
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {}, send: () => {} } as any,
    reaper: {
      detect: () => [],
      reap: () => {},
      stopListenersOnPort: () => 1,
    } as any,
    preview,
  });
  svc.stopPreview(s.id);
  // only devPortFor was called — no release/unbind/etc.
  expect(previewCalls).toEqual(["devPortFor"]);
});

// ── context trim for auto spawns (issue #499) ─────────────────────────────────

test("parseTrimAutoContext: default on; false/0/off (case-insensitive) turn it off", () => {
  expect(parseTrimAutoContext(undefined)).toBe(true); // unset → on
  expect(parseTrimAutoContext("1")).toBe(true);
  expect(parseTrimAutoContext("true")).toBe(true);
  expect(parseTrimAutoContext("false")).toBe(false);
  expect(parseTrimAutoContext("FALSE")).toBe(false);
  expect(parseTrimAutoContext("0")).toBe(false);
  expect(parseTrimAutoContext("off")).toBe(false);
  expect(parseTrimAutoContext("Off")).toBe(false);
});

test("spawnSettingsOverlay: disablePlugins ids map to false; absent/empty omits the key", () => {
  const withIds = JSON.parse(spawnSettingsOverlay({ disablePlugins: ["a@repo", "b@repo"] }));
  expect(withIds.enabledPlugins).toEqual({ "a@repo": false, "b@repo": false });
  // absent / empty → byte-identical to the no-opts overlay (key omitted entirely)
  expect(spawnSettingsOverlay({})).toBe(spawnSettingsOverlay());
  expect(spawnSettingsOverlay({ disablePlugins: [] })).toBe(spawnSettingsOverlay());
  expect(spawnSettingsOverlay()).not.toContain("enabledPlugins");
});

test("readInstalledPluginIds: enabledPlugins keys; [] on no key; null on read/parse error", async () => {
  const ids = await readInstalledPluginIds(async () =>
    JSON.stringify({ enabledPlugins: { "x@r": true, "y@r": false } }),
  );
  expect(ids).toEqual(["x@r", "y@r"]); // every key, regardless of value
  expect(
    await readInstalledPluginIds(async () => {
      throw new Error("ENOENT");
    }),
  ).toBeNull();
  expect(await readInstalledPluginIds(async () => "{not json")).toBeNull();
  expect(await readInstalledPluginIds(async () => "{}")).toEqual([]);
  expect(await readInstalledPluginIds(async () => '{"enabledPlugins":null}')).toEqual([]);
});

test("installedPluginIds: errors resolve [] but are NOT cached; successes are", async () => {
  // Order matters: the success case below populates the module-level cache for good.
  let throws = 0;
  const throwing = async () => {
    throws++;
    throw new Error("EIO");
  };
  expect(await installedPluginIds(throwing)).toEqual([]); // caller still proceeds
  expect(await installedPluginIds(throwing)).toEqual([]); // retried, not poisoned
  expect(throws).toBe(2);
  let reads = 0;
  const ok = async () => {
    reads++;
    return '{"enabledPlugins":{"x@r":true}}';
  };
  expect(await installedPluginIds(ok)).toEqual(["x@r"]);
  expect(await installedPluginIds(ok)).toEqual(["x@r"]);
  expect(reads).toBe(1); // success memoized for the process lifetime
});

/** injectDeps + an injected pluginIds seam, counting how often it's consulted. */
function trimDeps(store: SessionStore, captured: { argv?: string[] }, pluginIds: string[]) {
  let pluginIdReads = 0;
  const deps = {
    ...injectDeps(store, captured),
    pluginIds: async () => {
      pluginIdReads++;
      return pluginIds;
    },
  };
  return { deps, pluginIdReads: () => pluginIdReads };
}

/** The parsed JSON of the argv's --settings payload. */
function settingsOverlay(argv: string[]): any {
  return JSON.parse(argv[argv.indexOf("--settings") + 1]!);
}

test("auto spawn (trim on): --disable-slash-commands + plugin-off overlay + trim notice", async () => {
  const prev = config.trimAutoContext;
  try {
    config.trimAutoContext = true;
    const store = new SessionStore(":memory:");
    const captured: { argv?: string[] } = {};
    const { deps } = trimDeps(store, captured, ["superpowers@sp", "context7@c7"]);
    const svc = new SessionService(deps as any);
    await svc.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "drain it",
      model: null,
      images: [],
      auto: true,
    });
    const argv = captured.argv!;
    expect(argv).toContain("--disable-slash-commands");
    expect(argv.at(-1)).toBe("drain it"); // prompt stays the final positional
    // every injected plugin id is force-disabled in the per-spawn settings overlay
    expect(settingsOverlay(argv).enabledPlugins).toEqual({
      "superpowers@sp": false,
      "context7@c7": false,
    });
    const sp = sysPrompt(argv);
    expect(sp).toContain("<context-trim-notice>");
    expect(sp).toContain("The Skill tool and slash commands are unavailable");
  } finally {
    config.trimAutoContext = prev;
  }
});

test("interactive spawn (trim on): untouched — no flag, no enabledPlugins, no notice", async () => {
  const prev = config.trimAutoContext;
  try {
    config.trimAutoContext = true;
    const store = new SessionStore(":memory:");
    const captured: { argv?: string[] } = {};
    const { deps, pluginIdReads } = trimDeps(store, captured, ["superpowers@sp"]);
    const svc = new SessionService(deps as any);
    await svc.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "do the thing",
      model: null,
      images: [],
    });
    const argv = captured.argv!;
    // byte-identical to the pre-trim interactive shape
    expect(argv).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--session-id",
      argv[3]!,
      "--settings",
      spawnSettingsOverlay(),
      "--append-system-prompt",
      composeSystemPrompt(null, false, { previewHint: true }),
      "do the thing",
    ]);
    expect(pluginIdReads()).toBe(0); // settings file never consulted for interactive spawns
  } finally {
    config.trimAutoContext = prev;
  }
});

test("auto spawn with trimAutoContext off: identical to the untrimmed shape", async () => {
  const prev = config.trimAutoContext;
  try {
    config.trimAutoContext = false;
    const store = new SessionStore(":memory:");
    const captured: { argv?: string[] } = {};
    const { deps, pluginIdReads } = trimDeps(store, captured, ["superpowers@sp"]);
    const svc = new SessionService(deps as any);
    await svc.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "drain it",
      model: null,
      images: [],
      auto: true,
    });
    const argv = captured.argv!;
    expect(argv).not.toContain("--disable-slash-commands");
    expect(argv[argv.indexOf("--settings") + 1]).toBe(spawnSettingsOverlay());
    expect(sysPrompt(argv)).not.toContain("<context-trim-notice>");
    expect(pluginIdReads()).toBe(0);
  } finally {
    config.trimAutoContext = prev;
  }
});

test("resume of an auto session re-applies the trim: flag + plugin-off overlay", async () => {
  const prev = config.trimAutoContext;
  try {
    config.trimAutoContext = true;
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
        list: () => [], // old agent gone → respawn
        stop: () => {},
        send: () => {},
      } as any,
      pluginIds: async () => ["superpowers@sp"],
    });
    const s = resumable(store, { auto: true });
    await svc.resume(s.id);
    const argv: string[] = calls.argv;
    expect(argv).toContain("--disable-slash-commands");
    expect(settingsOverlay(argv).enabledPlugins).toEqual({ "superpowers@sp": false });
  } finally {
    config.trimAutoContext = prev;
  }
});

// ── relaunch ───────────────────────────────────────────────────────────────

/** A relaunch-service harness: real store, mocked worktree/herdr/reaper.
 *  `create` makes a worktree at /wt/<name>; `archive` removes it + stops the agent.
 *  Returns the service plus a record of started/stopped/removed for assertions. */
function relaunchHarness(store: SessionStore) {
  const calls: {
    started: { name: string; cwd: string; argv: string[] }[];
    stopped: string[];
    removed: string[];
  } = { started: [], stopped: [], removed: [] };
  let n = 0;
  // Make the post-create override step throw (called only after seeding the original).
  const breakOverride = () => {
    store.setAutopilotState = () => {
      throw new Error("override write failed");
    };
  };
  const service = new SessionService({
    store,
    namer: async () => "relaunched",
    worktree: {
      create: (_repo: string, _base: string, name: string) => {
        const wp = `/wt/${name}-${++n}`;
        return { worktreePath: wp, branch: `shepherd/${name}`, isolated: true };
      },
      remove: (wp: string) => calls.removed.push(wp),
    } as any,
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        calls.started.push({ name, cwd, argv });
        return { terminalId: `term_${n}`, agentStatus: "working" } as any;
      },
      list: () => [],
      stop: (id: string) => calls.stopped.push(id),
    } as any,
    moveUploads: (images: string[], worktreePath: string) =>
      images.map((i) => `${worktreePath}/.shepherd-uploads/${i.split("/").pop()}`),
  });
  return { service, calls, breakOverride };
}

/** Seed a non-archived "original" session with the per-task settings to be copied. */
function originalSession(
  store: SessionStore,
  over: Partial<Parameters<SessionStore["create"]>[0]> = {},
) {
  const s = store.create({
    name: "orig",
    prompt: "do the thing",
    repoPath: "/repo",
    baseBranch: "develop",
    branch: "shepherd/orig",
    worktreePath: "/wt/orig",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_orig",
    model: "opus",
    planGateEnabled: true,
    ...over,
  });
  store.setAutopilotState(s.id, { enabled: true });
  store.setAutoMergeState(s.id, { enabled: true });
  return store.get(s.id)!;
}

test("relaunch copies prompt + all per-task settings onto the refetched new session", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = relaunchHarness(store);
  const orig = originalSession(store);

  const fresh = await service.relaunch(orig.id);

  expect(fresh.id).not.toBe(orig.id);
  expect(fresh.prompt).toBe("do the thing");
  expect(fresh.repoPath).toBe("/repo");
  expect(fresh.baseBranch).toBe("develop");
  expect(fresh.model).toBe("opus");
  expect(fresh.planGateEnabled).toBe(true);
  // overrides copied + reflected in the refetched session
  expect(fresh.autopilotEnabled).toBe(true);
  expect(fresh.autoMergeEnabled).toBe(true);
  // a fresh spawn always auto:false, regardless of the original
  expect(fresh.auto).toBe(false);
  // the new agent really started
  expect(calls.started).toHaveLength(1);
});

test("relaunch passes a supplied issueRef through to create", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = relaunchHarness(store);
  const orig = originalSession(store);

  const fresh = await service.relaunch(orig.id, {
    number: 42,
    url: "https://example/42",
    title: "Bug",
    body: "details here",
  });

  expect(fresh.issueNumber).toBe(42);
  // issue body rides the prompt argv out-of-band
  const argv = calls.started[0]!.argv;
  const promptArg = argv[argv.length - 1];
  expect(promptArg).toContain("GitHub Issue #42: Bug");
  expect(promptArg).toContain("details here");
});

test("relaunch carries images over (staged copies created, originals untouched)", async () => {
  const store = new SessionStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "relaunch-root-"));
  const wt = mkdtempSync(join(tmpdir(), "relaunch-wt-"));
  const uploads = join(wt, ".shepherd-uploads");
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, "a.png"), "PNGDATA");
  writeFileSync(join(uploads, "b.jpg"), "JPGDATA");

  const prevRoot = config.repoRoot;
  config.repoRoot = root;
  try {
    const { service, calls } = relaunchHarness(store);
    const orig = originalSession(store, { worktreePath: wt });

    await service.relaunch(orig.id);

    // originals untouched
    expect(readdirSync(uploads).sort()).toEqual(["a.png", "b.jpg"]);
    // fresh staged copies landed (extensions preserved) and were passed to create
    const staged = readdirSync(join(root, ".shepherd-uploads-staging"));
    expect(staged).toHaveLength(2);
    expect(staged.filter((f) => f.endsWith(".png"))).toHaveLength(1);
    expect(staged.filter((f) => f.endsWith(".jpg"))).toHaveLength(1);
    // both images flowed into the spawn argv (via moveUploads mock)
    const argv = calls.started[0]!.argv;
    expect(argv[argv.length - 1]).toContain("Attached images:");
  } finally {
    config.repoRoot = prevRoot;
  }
});

test("relaunch throws on a missing original", async () => {
  const store = new SessionStore(":memory:");
  const { service } = relaunchHarness(store);
  await expect(service.relaunch("nope")).rejects.toThrow();
});

test("relaunch throws on an archived original", async () => {
  const store = new SessionStore(":memory:");
  const { service } = relaunchHarness(store);
  const orig = originalSession(store);
  store.archive(orig.id);
  await expect(service.relaunch(orig.id)).rejects.toThrow();
});

test("relaunch does NOT archive the original", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls } = relaunchHarness(store);
  const orig = originalSession(store);

  await service.relaunch(orig.id);

  expect(store.get(orig.id)?.status).not.toBe("archived");
  expect(calls.stopped).not.toContain("term_orig"); // original agent left running
  expect(calls.removed).not.toContain("/wt/orig"); // original worktree left in place
});

test("relaunch tears down the just-created session if a post-create step throws (no orphan)", async () => {
  const store = new SessionStore(":memory:");
  const { service, calls, breakOverride } = relaunchHarness(store);
  const orig = originalSession(store);
  const before = store.list().length;
  breakOverride();

  await expect(service.relaunch(orig.id)).rejects.toThrow("override write failed");

  // no orphaned new session left active in the store (only the original remains)
  const active = store.list().filter((s) => s.status !== "archived");
  expect(active.map((s) => s.id)).toEqual([orig.id]);
  expect(store.list().length).toBe(before + 1); // the new row exists but is archived
  // the new agent was stopped during teardown
  expect(calls.stopped).toHaveLength(1);
  expect(calls.stopped[0]).not.toBe("term_orig");
});

test("relaunch overrides apply repo/baseBranch/prompt/model/planGateEnabled over the original", async () => {
  const store = new SessionStore(":memory:");
  const { service } = relaunchHarness(store);
  const orig = originalSession(store); // repo /repo, develop, opus, planGate true

  const fresh = await service.relaunch(orig.id, undefined, {
    repoPath: "/other-repo",
    baseBranch: "release",
    prompt: "do something else",
    model: "sonnet",
    planGateEnabled: false,
  });

  expect(fresh.repoPath).toBe("/other-repo");
  expect(fresh.baseBranch).toBe("release");
  expect(fresh.prompt).toBe("do something else");
  expect(fresh.model).toBe("sonnet");
  expect(fresh.planGateEnabled).toBe(false);
});

test("relaunch overrides treat an absent field as keep-original (explicit null replaces)", async () => {
  const store = new SessionStore(":memory:");
  const { service } = relaunchHarness(store);
  const orig = originalSession(store); // model opus, planGate true

  // Empty override bag → every field keeps the original's value.
  const kept = await service.relaunch(orig.id, undefined, {});
  expect(kept.model).toBe("opus");
  expect(kept.planGateEnabled).toBe(true);

  // Explicit null is a PRESENT value → replaces (clears) the original's.
  const cleared = await service.relaunch(orig.id, undefined, {
    model: null,
    planGateEnabled: null,
  });
  expect(cleared.model).toBe(null);
  expect(cleared.planGateEnabled).toBe(null);
});

test("relaunch images override appends to the carried-over originals", async () => {
  const store = new SessionStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "relaunch-imgroot-"));
  const wt = mkdtempSync(join(tmpdir(), "relaunch-imgwt-"));
  const uploads = join(wt, ".shepherd-uploads");
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, "orig.png"), "PNGDATA");

  const prevRoot = config.repoRoot;
  config.repoRoot = root;
  try {
    const { service, calls } = relaunchHarness(store);
    const orig = originalSession(store, { worktreePath: wt });

    await service.relaunch(orig.id, undefined, { images: ["/stage/supplied.jpg"] });

    // The new session's spawn argv carries BOTH the copied original and the supplied one.
    const argv = calls.started[0]!.argv;
    const promptArg = argv[argv.length - 1]!;
    expect(promptArg).toContain("Attached images:");
    // moveUploads mock maps each staged path to <wt>/.shepherd-uploads/<basename>
    expect(promptArg).toMatch(/\.shepherd-uploads\/.+\.png/); // copied original
    expect(promptArg).toContain("supplied.jpg"); // supplied override appended
  } finally {
    config.repoRoot = prevRoot;
  }
});

test("relaunch caps the merged image list at MAX_IMAGES, carried-over originals first", async () => {
  const store = new SessionStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "relaunch-caproot-"));
  const wt = mkdtempSync(join(tmpdir(), "relaunch-capwt-"));
  const uploads = join(wt, ".shepherd-uploads");
  mkdirSync(uploads, { recursive: true });
  // 8 carried-over originals + 5 supplied overrides = 13 → must cap to 10.
  for (let i = 0; i < 8; i++) writeFileSync(join(uploads, `orig${i}.png`), "PNGDATA");

  const prevRoot = config.repoRoot;
  config.repoRoot = root;
  try {
    const { service, calls } = relaunchHarness(store);
    const orig = originalSession(store, { worktreePath: wt });

    await service.relaunch(orig.id, undefined, {
      images: ["/stage/a.jpg", "/stage/b.jpg", "/stage/c.jpg", "/stage/d.jpg", "/stage/e.jpg"],
    });

    const argv = calls.started[0]!.argv;
    const promptArg = argv[argv.length - 1]!;
    const moved = promptArg.split("Attached images:\n")[1]!.trim().split("\n");
    expect(moved).toHaveLength(10); // capped from 13
    // Originals come first and all 8 fit, so only 2 of the 5 supplied survive the cap.
    const survivingSupplied = moved.filter((p) => /\/[a-e]\.jpg$/.test(p));
    expect(survivingSupplied).toHaveLength(2);
  } finally {
    config.repoRoot = prevRoot;
  }
});

test("resume of a non-auto session stays untrimmed even with trim on", async () => {
  const prev = config.trimAutoContext;
  try {
    config.trimAutoContext = true;
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
      pluginIds: async () => ["superpowers@sp"],
    });
    const s = resumable(store); // auto defaults to false
    await svc.resume(s.id);
    expect(calls.argv).toEqual([
      "claude",
      "--dangerously-skip-permissions",
      "--resume",
      "abc-123",
      "--settings",
      spawnSettingsOverlay(),
    ]);
  } finally {
    config.trimAutoContext = prev;
  }
});
