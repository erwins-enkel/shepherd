import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { DrainService } from "../src/drain";
import type { SandboxBackend } from "../src/sandbox";
import type { CreateSessionInput, Session } from "../src/types";
import type { GitForge, Issue, PrStatus } from "../src/forge/types";
import type { UsageLimits } from "../src/usage-limits";

// A herdr stub that records the argv it was started with (the assertion target).
function herdrStub(record: { argv?: string[] }) {
  return {
    start: (_name: string, cwd: string, argv: string[]) => {
      record.argv = argv;
      return {
        terminalId: "term_x",
        cwd,
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      };
    },
    list: () => [],
    stop: () => {},
    send: () => {},
    relabel: () => {},
  } as any;
}

function worktreeStub() {
  return {
    create: () => ({
      worktreePath: "/wt/s",
      branch: "shepherd/s",
      isolated: true,
    }),
    remove: () => {},
    gitCommonDir: () => "/wt/s/.git",
  } as any;
}

function makeService(opts: {
  store: SessionStore;
  record: { argv?: string[] };
  detectBackend: () => SandboxBackend;
}) {
  return new SessionService({
    store: opts.store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub(opts.record),
    detectBackend: opts.detectBackend,
  });
}

const baseInput = (over: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
  repoPath: "/repo",
  baseBranch: "main",
  prompt: "do it",
  model: null,
  images: [],
  ...over,
});

test("create + trusted (default repo config) → passthrough argv (no bwrap)", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = await service.create(baseInput());
  expect(record.argv?.[0]).toBe("claude");
  expect(record.argv).not.toContain("bwrap");
  expect(s.sandboxApplied).toBe("trusted");
  expect(s.sandboxDegraded).toBe(false);
});

test("create + standard + backend bwrap → wraps argv, records applied=standard", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = await service.create(baseInput());
  expect(record.argv?.[0]).toBe("bwrap");
  // the original claude argv appears after a `--` separator
  const sep = record.argv!.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(record.argv![sep + 1]).toBe("claude");
  expect(s.sandboxApplied).toBe("standard");
  expect(s.sandboxDegraded).toBe(false);
});

test("create + standard + backend null → passthrough but degraded", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => null });
  const s = await service.create(baseInput());
  expect(record.argv?.[0]).toBe("claude");
  expect(record.argv).not.toContain("bwrap");
  expect(s.sandboxApplied).toBe("standard");
  expect(s.sandboxDegraded).toBe(true);
});

test("create + auto + standard → rejects (standard refuses auto)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const service = makeService({ store, record: {}, detectBackend: () => "bwrap" });
  await expect(service.create(baseInput({ auto: true }))).rejects.toThrow();
});

test("create + auto + autonomous + backend null → rejects", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const service = makeService({ store, record: {}, detectBackend: () => null });
  await expect(service.create(baseInput({ auto: true }))).rejects.toThrow();
});

test("create + auto + autonomous + backend bwrap → succeeds, applied=autonomous", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = await service.create(baseInput({ auto: true }));
  expect(record.argv?.[0]).toBe("bwrap");
  expect(s.sandboxApplied).toBe("autonomous");
  expect(s.sandboxDegraded).toBe(false);
});

test("create + auto + trusted → succeeds (legacy), passthrough", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = await service.create(baseInput({ auto: true }));
  expect(record.argv?.[0]).toBe("claude");
  expect(s.sandboxApplied).toBe("trusted");
});

test("resume + auto + standard → returns null (does not throw)", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  // create a row directly: trusted at create time, auto, with a pinned claude session id.
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "11111111-1111-1111-1111-111111111111",
    auto: true,
  });
  // Now flip the repo to standard so an auto resume is refused.
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const out = await service.resume(s.id, { force: true });
  expect(out).toBeNull();
  // The auto-gate pre-check fires BEFORE any respawn work (husk preserved): herdr.start
  // is never called, so no new argv was recorded.
  expect(record.argv).toBeUndefined();
});

test("resume + trusted → resumes normally, passthrough argv", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "22222222-2222-2222-2222-222222222222",
    auto: false,
  });
  const out = await service.resume(s.id, { force: true });
  expect(out).not.toBeNull();
  expect(record.argv?.[0]).toBe("claude");
  expect(record.argv).toContain("--resume");
  expect(out!.sandboxApplied).toBe("trusted");
});

test("resume preserves a per-spawn override stricter than the repo default (no silent unconfine)", async () => {
  const store = new SessionStore(":memory:");
  // Repo default is trusted (unset), but the session was SPAWNED with sandboxApplied=standard
  // (a per-spawn override). On resume it must stay wrapped, not fall back to trusted.
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "33333333-3333-3333-3333-333333333333",
    auto: false,
    sandboxApplied: "standard",
    sandboxDegraded: false,
  });
  const out = await service.resume(s.id, { force: true });
  expect(out).not.toBeNull();
  expect(record.argv?.[0]).toBe("bwrap"); // still confined, NOT passthrough
  expect(out!.sandboxApplied).toBe("standard"); // badge preserved, not overwritten to trusted
});

test("drain pre-check: standard profile holds → service.create NOT called", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  let createCalls = 0;
  const service = {
    create: async (input: CreateSessionInput): Promise<Session> => {
      createCalls++;
      return store.create({
        name: "auto",
        prompt: input.prompt,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: "shepherd/auto",
        worktreePath: "/wt",
        isolated: true,
        herdrSession: "default",
        herdrAgentId: "t",
        auto: true,
        issueNumber: input.issueRef?.number ?? null,
      });
    },
    archive: () => 1,
  };
  const forge = makeForge([issue(1)]);
  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimits => NO_USAGE },
    repos: () => ["/repo"],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
  });
  await drain.pump("/repo");
  expect(createCalls).toBe(0);
});

// ── local helpers ─────────────────────────────────────────────────────────────

const NO_USAGE: UsageLimits = {
  session5h: null,
  week: null,
  stale: false,
  calibratedAt: null,
};

function defaultRepoConfig() {
  return {
    criticEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human" as const,
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted" as const,
  };
}

function issue(number: number): Issue {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    url: `https://x/${number}`,
    labels: ["shepherd:auto"],
    createdAt: number,
  };
}

function makeForge(issues: Issue[]): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => issues,
    listPullRequests: async () => [],
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    getIssue: async (n: number) => issues.find((i) => i.number === n) ?? null,
  } as unknown as GitForge;
}
