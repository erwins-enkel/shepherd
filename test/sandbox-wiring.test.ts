import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { DrainService } from "../src/drain";
import type { SandboxBackend } from "../src/sandbox";
import type { EgressBackend } from "../src/egress";
import { egressTmpDir } from "../src/egress";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CreateSessionInput, Session } from "../src/types";
import type { GitForge, Issue, PrStatus } from "../src/forge/types";
import type { UsageLimits } from "../src/usage-limits";
import type { EgressWatcher } from "../src/egress-watch";

// A herdr stub that records the argv it was started with (the assertion target).
function herdrStub(record: { argv?: string[] }) {
  return {
    start: async (_name: string, cwd: string, argv: string[]) => {
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
    stop: async () => {},
    send: () => {},
    relabel: async () => {},
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
    ensureBaseRef: async () => {},
    branchExists: () => false,
  } as any;
}

function makeService(opts: {
  store: SessionStore;
  record: { argv?: string[] };
  detectBackend: () => SandboxBackend;
  detectEgressBackend?: () => EgressBackend;
  egressProbed?: { called: boolean };
}) {
  return new SessionService({
    store: opts.store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub(opts.record),
    detectBackend: opts.detectBackend,
    // Default the egress seam to null so an autonomous test never falls through to the real
    // (slow, host-dependent) self-test. Tests that want egress ON inject "slirp4netns".
    detectEgressBackend: () => {
      if (opts.egressProbed) opts.egressProbed.called = true;
      return opts.detectEgressBackend ? opts.detectEgressBackend() : null;
    },
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

test("create + auto + autonomous + FS backend + egress backend → egress-runner wraps, files written", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
  });
  const s = await service.create(baseInput({ auto: true }));
  try {
    // argv: egress-runner.sh --tmp <dir> -- bwrap …override-flags… -- <inner>
    expect(record.argv?.[0]).toMatch(/egress-runner\.sh$/);
    expect(record.argv?.[1]).toBe("--tmp");
    const tmp = egressTmpDir(s.id);
    expect(record.argv?.[2]).toBe(tmp);
    expect(record.argv?.[3]).toBe("--");
    expect(record.argv?.[4]).toBe("bwrap");
    // the egress override binds (nsswitch/resolv overrides) sit between the membrane flags
    // and the inner `--`; the inner argv (claude) follows the LAST `--`.
    const lastSep = record.argv!.lastIndexOf("--");
    expect(record.argv!.slice(0, lastSep)).toContain(`${tmp}/nsswitch.conf`);
    expect(record.argv!.slice(0, lastSep)).toContain(`${tmp}/resolv.conf`);
    expect(record.argv![lastSep + 1]).toBe("claude");
    expect(s.sandboxApplied).toBe("autonomous");
    expect(s.sandboxDegraded).toBe(false);
    expect(s.egressApplied).toBe(true);
    expect(s.egressDegraded).toBe(false);
    // config artefacts materialized in the per-session temp dir.
    for (const f of ["egress.nft", "dnsmasq.argv", "resolv.conf", "nsswitch.conf"]) {
      expect(existsSync(join(tmp, f))).toBe(true);
    }
    expect(readFileSync(join(tmp, "resolv.conf"), "utf8")).toContain("nameserver 127.0.0.1");
  } finally {
    rmSync(egressTmpDir(s.id), { recursive: true, force: true });
  }
});

test("create + auto + autonomous + FS backend + egress NULL → refused (EGRESS_UNAVAILABLE), no spawn", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null,
  });
  await expect(service.create(baseInput({ auto: true }))).rejects.toThrow(
    /egress backend unavailable/i,
  );
  expect(record.argv).toBeUndefined(); // never spawned
});

test("create + INTERACTIVE autonomous + FS backend + egress NULL → FS-membrane (plain bwrap), egressDegraded", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null,
  });
  const s = await service.create(baseInput({ auto: false }));
  expect(record.argv?.[0]).toBe("bwrap"); // plain FS membrane, NOT the egress-runner
  expect(record.argv).not.toContain("--tmp");
  expect(s.sandboxApplied).toBe("autonomous");
  expect(s.egressApplied).toBe(false);
  expect(s.egressDegraded).toBe(true);
});

test("create + trusted → egress NEVER probed, egress fields false", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const egressProbed = { called: false };
  const service = makeService({ store, record, detectBackend: () => "bwrap", egressProbed });
  const s = await service.create(baseInput());
  expect(egressProbed.called).toBe(false); // trusted: backend skipped, so egress never probed
  expect(s.egressApplied).toBe(false);
  expect(s.egressDegraded).toBe(false);
});

test("create + standard → egress NEVER probed, egress fields false", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const egressProbed = { called: false };
  const service = makeService({ store, record, detectBackend: () => "bwrap", egressProbed });
  const s = await service.create(baseInput());
  expect(egressProbed.called).toBe(false); // standard is not egress-confined
  expect(record.argv).not.toContain("--tmp");
  expect(s.egressApplied).toBe(false);
  expect(s.egressDegraded).toBe(false);
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
    egressApplied: false,
    egressDegraded: false,
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
    archive: async () => 1,
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
    rebaseCap: 5,
  });
  await drain.pump("/repo");
  expect(createCalls).toBe(0);
});

test("resume + autonomous + FS + egress backend → egress-runner re-wraps, egress fields persisted", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
  });
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
    claudeSessionId: "44444444-4444-4444-4444-444444444444",
    auto: false,
    sandboxApplied: "autonomous",
  });
  const out = await service.resume(s.id, { force: true });
  try {
    expect(out).not.toBeNull();
    expect(record.argv?.[0]).toMatch(/egress-runner\.sh$/);
    expect(out!.egressApplied).toBe(true);
    expect(out!.egressDegraded).toBe(false);
  } finally {
    rmSync(egressTmpDir(s.id), { recursive: true, force: true });
  }
});

test("resume + auto autonomous + egress NULL → refused (returns null, husk preserved)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null,
  });
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
    claudeSessionId: "55555555-5555-5555-5555-555555555555",
    auto: true,
    sandboxApplied: "autonomous",
  });
  const out = await service.resume(s.id, { force: true });
  expect(out).toBeNull();
  expect(record.argv).toBeUndefined();
});

test("drain + autonomous repo + egress NULL → held, service.create NOT called", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
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
    archive: async () => 1,
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
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null, // egress unavailable → autonomous drain refused
    rebaseCap: 5,
  });
  await drain.pump("/repo");
  expect(createCalls).toBe(0);
});

// ── egressWatcher wiring tests ────────────────────────────────────────────────

function makeWatcherStub(): Pick<EgressWatcher, "start" | "stop"> & {
  starts: Array<{ sessionId: string; opts: Parameters<EgressWatcher["start"]>[1] }>;
  stops: string[];
} {
  const starts: Array<{ sessionId: string; opts: Parameters<EgressWatcher["start"]>[1] }> = [];
  const stops: string[] = [];
  return {
    starts,
    stops,
    start: (sessionId, opts) => starts.push({ sessionId, opts }),
    stop: async (sessionId) => stops.push(sessionId),
  };
}

test("egressWatcher.start called on autonomous egress spawn", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const watcher = makeWatcherStub();
  const service = new SessionService({
    store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub(record),
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    egressWatcher: watcher,
  });

  const s = await service.create(baseInput({ auto: true }));
  try {
    expect(watcher.starts).toHaveLength(1);
    expect(watcher.starts[0]!.sessionId).toBe(s.id);
    expect(watcher.starts[0]!.opts.repoPath).toBe("/repo");
    expect(watcher.starts[0]!.opts.dnsLogPath).toContain("dns.log");
    expect(watcher.starts[0]!.opts.allowlist.length).toBeGreaterThan(0);
  } finally {
    rmSync(egressTmpDir(s.id), { recursive: true, force: true });
  }
});

test("egressWatcher.stop called on archive (before removeEgressTmp)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const watcher = makeWatcherStub();
  const service = new SessionService({
    store,
    namer: async () => "s",
    worktree: {
      ...worktreeStub(),
      remove: () => {},
    },
    herdr: herdrStub(record),
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    egressWatcher: watcher,
  });

  const s = await service.create(baseInput({ auto: true }));
  try {
    await service.archive(s.id);
    expect(watcher.stops).toContain(s.id);
  } finally {
    // egressTmpDir already removed by archive; ignore if already gone.
    try {
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    } catch {
      /* already removed */
    }
  }
});

test("egressWatcher NOT called for trusted spawn (no egress)", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const watcher = makeWatcherStub();
  const service = new SessionService({
    store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub(record),
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    egressWatcher: watcher,
  });

  await service.create(baseInput()); // trusted profile → no egress
  expect(watcher.starts).toHaveLength(0);
});

// ── local helpers ─────────────────────────────────────────────────────────────

const NO_USAGE: UsageLimits = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

function defaultRepoConfig() {
  return {
    criticEnabled: false,
    criticAllPrs: false,
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
    defaultModel: "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask" as const,
    egressExtraHosts: [] as string[],
    repoMode: "forge" as const,
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
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
    assignees: [],
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
