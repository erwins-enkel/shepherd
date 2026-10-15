// Bootstrap task kind (#3109): pins from the resolver only, plan gate + autopilot off,
// autonomous downgraded, resume/relaunch keep the directive.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService, composeSystemPrompt } from "../src/service";
import { bootstrapDirective } from "../src/bootstrap-directive";
import { HouseStackUnresolvedError, type HouseStackResolution } from "../src/house-stack";

const RESOLVED: HouseStackResolution = {
  ok: true,
  resolvedAt: "2026-10-15T08:00:00.000Z",
  npm: [
    { name: "svelte", version: "9.4.2" },
    { name: "bun", version: "7.1.3" },
  ],
  crates: [],
  rustToolchain: "1.99.0",
};

function deps(
  store: SessionStore,
  captured: { argv?: string[]; worktrees: number },
  resolution: HouseStackResolution = RESOLVED,
) {
  return {
    store,
    namer: async () => "boot",
    houseStackResolver: { resolve: async () => resolution },
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => {
        captured.worktrees++;
        return { worktreePath: "/wt/boot", branch: "shepherd/boot", isolated: true };
      },
      remove: () => {},
      gitCommonDir: () => "/wt/boot/.git",
    } as any,
    herdr: {
      start: async (_n: string, _c: string, argv: string[]) => {
        captured.argv = argv;
        return { terminalId: "t1" };
      },
      list: () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    detectBackend: () => "bwrap" as const,
    detectEgressBackend: () => "slirp4netns" as const,
  };
}

function sysPrompt(argv: string[]): string {
  return argv[argv.indexOf("--append-system-prompt") + 1]!;
}

const input = {
  repoPath: "/repo",
  baseBranch: "main",
  prompt: "bootstrap the app",
  model: null,
  images: [],
  bootstrap: true,
};

function repoWith(store: SessionStore, over: Record<string, unknown>) {
  store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), ...over });
}

test("bootstrap spawn: directive carries the resolved pins, no plan gate/autopilot, keeps single-PR", async () => {
  const store = new SessionStore(":memory:");
  repoWith(store, { planGateEnabled: true, autopilotEnabled: true });
  const captured = { worktrees: 0 } as { argv?: string[]; worktrees: number };
  const svc = new SessionService(deps(store, captured) as any);
  const s = await svc.create({ ...input, autopilotEnabled: true });
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain("<bootstrap-directive>");
  expect(sp).toContain("`svelte@9`");
  expect(sp).toContain('"packageManager": "bun@7.1.3"');
  expect(sp).toContain('channel = "1.99.0"');
  expect(sp).not.toContain("<plan-gate-directive>");
  expect(sp).not.toContain("<autopilot-directive>");
  expect(s.planPhase).toBeNull();
  const row = store.get(s.id)!;
  expect(row.bootstrap).toBe(true);
  expect(row.autopilotEnabled).toBe(false);
  expect(store.getBootstrapStack(s.id)).toEqual(RESOLVED as any);
});

test("bootstrap spawn: an unresolved House Stack refuses the start before any worktree", async () => {
  const store = new SessionStore(":memory:");
  const captured = { worktrees: 0 } as { argv?: string[]; worktrees: number };
  const svc = new SessionService(
    deps(store, captured, {
      ok: false,
      errors: [{ ecosystem: "npm", name: "svelte", reason: "timed out" }],
    }) as any,
  );
  await expect(svc.create(input)).rejects.toBeInstanceOf(HouseStackUnresolvedError);
  expect(captured.worktrees).toBe(0);
  expect(captured.argv).toBeUndefined();
  expect(store.list()).toHaveLength(0);
});

test("bootstrap under an autonomous repo default is downgraded to standard", async () => {
  const store = new SessionStore(":memory:");
  repoWith(store, { sandboxProfile: "autonomous" });
  const captured = { worktrees: 0 } as { argv?: string[]; worktrees: number };
  const svc = new SessionService(deps(store, captured) as any);
  const s = await svc.create(input);
  expect(s.sandboxApplied).toBe("standard");
});

test("non-bootstrap spawn never consults the resolver", async () => {
  const store = new SessionStore(":memory:");
  const captured = { worktrees: 0 } as { argv?: string[]; worktrees: number };
  let calls = 0;
  const d = deps(store, captured);
  d.houseStackResolver = {
    resolve: async () => {
      calls++;
      return RESOLVED;
    },
  };
  const svc = new SessionService(d as any);
  const s = await svc.create({ ...input, bootstrap: false });
  expect(calls).toBe(0);
  expect(store.get(s.id)?.bootstrap).toBe(false);
  expect(sysPrompt(captured.argv!)).not.toContain("<bootstrap-directive>");
});

test("resume of a bootstrap session re-renders the persisted pins", async () => {
  const store = new SessionStore(":memory:");
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
    bootstrapStack: RESOLVED as Extract<HouseStackResolution, { ok: true }>,
  });
  store.update(s.id, { status: "done", lastState: "done" });
  const captured = { worktrees: 0 } as { argv?: string[]; worktrees: number };
  const svc = new SessionService({ ...deps(store, captured), transcriptExists: () => true } as any);
  await svc.resume(s.id);
  expect(captured.argv).toContain("--resume");
  const sp = sysPrompt(captured.argv!);
  expect(sp).toContain("<bootstrap-directive>");
  expect(sp).toContain("`svelte@9`");
});

test("relaunch keeps the bootstrap flag and re-resolves", async () => {
  const store = new SessionStore(":memory:");
  const captured = { worktrees: 0 } as { argv?: string[]; worktrees: number };
  let calls = 0;
  const d = deps(store, captured);
  d.houseStackResolver = {
    resolve: async () => {
      calls++;
      return RESOLVED;
    },
  };
  const svc = new SessionService(d as any);
  const s = await svc.create(input);
  const again = await svc.relaunch(s.id);
  expect(calls).toBe(2);
  expect(store.get(again.id)?.bootstrap).toBe(true);
});

test("composeSystemPrompt: bootstrap outranks plan gate + autopilot but keeps the PR blocks", () => {
  const sp = composeSystemPrompt(null, true, {
    bootstrap: "BOOT",
    planGate: "interactive",
    toolGuard: false,
    agentSkills: false,
  });
  expect(sp).toContain("<bootstrap-directive>\nBOOT\n</bootstrap-directive>");
  expect(sp).not.toContain("<plan-gate-directive>");
  expect(sp).not.toContain("<autopilot-directive>");
  expect(sp).toContain("<single-pr-invariant>");
});

test("bootstrapDirective: every version comes from the resolution", () => {
  const text = bootstrapDirective({
    stack: RESOLVED as Extract<HouseStackResolution, { ok: true }>,
    agentProvider: "claude",
  });
  // Only the resolved versions (and their pinned majors) appear — nothing from memory.
  const versions = text.match(/\b\d+\.\d+\.\d+\b/g) ?? [];
  expect(new Set(versions)).toEqual(new Set(["9.4.2", "7.1.3", "1.99.0"]));
  expect(text).toContain("AskUserQuestion");
  expect(text).toContain("$ bun add -d husky");
  expect(text).toContain("rustup component add clippy");
  expect(text).toContain("## What the guardrails can't catch");
  expect(text).toContain("docs/decisions/0001-foundation.md");
});

test("bootstrapDirective: codex asks in chat; a missing stack fails closed", () => {
  const codex = bootstrapDirective({
    stack: RESOLVED as Extract<HouseStackResolution, { ok: true }>,
    agentProvider: "codex",
  });
  expect(codex).not.toContain("AskUserQuestion");
  const none = bootstrapDirective({ stack: null, agentProvider: "claude" });
  expect(none).toContain("relaunch the task");
  expect(none).not.toMatch(/\d+\.\d+\.\d+/);
});

test("relaunch rejects a merged kind conflict, allows an explicit switch", async () => {
  const store = new SessionStore(":memory:");
  const captured = { worktrees: 0 } as { argv?: string[]; worktrees: number };
  const svc = new SessionService(deps(store, captured) as any);
  const boot = await svc.create(input);
  await expect(svc.relaunch(boot.id, undefined, { plain: true })).rejects.toThrow(
    /bootstrap cannot be combined/,
  );
  const research = await svc.create({ ...input, bootstrap: false, research: true });
  await expect(svc.relaunch(research.id, undefined, { bootstrap: true })).rejects.toThrow(
    /bootstrap cannot be combined/,
  );
  const switched = await svc.relaunch(research.id, undefined, { bootstrap: true, research: false });
  expect(store.get(switched.id)?.bootstrap).toBe(true);
  expect(store.get(switched.id)?.research).toBe(false);
});
