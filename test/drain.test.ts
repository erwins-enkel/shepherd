import { test, expect } from "bun:test";
import { DrainService, type DrainStatus } from "../src/drain";
import { ACTIVE_LABEL } from "../src/drain-core";
import { SessionStore } from "../src/store";
import type { GitForge, GitState, Issue, MergeMethod, PrStatus } from "../src/forge/types";
import type { CreateSessionInput, ReviewDecision, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

const REPO = "/repo";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    url: `https://x/${number}`,
    labels: ["shepherd:auto"],
    createdAt: number,
    ...over,
  };
}

const NO_USAGE: UsageLimitsType = { session5h: null, week: null, stale: false, calibratedAt: null };

interface ForgeRec {
  merges: { prNumber: number; method: MergeMethod; deleteBranch: boolean }[];
  links: { prNumber: number; issueNumber: number }[];
  listIssuesCalls: number;
  closedIssues: number[];
  added: { number: number; label: string }[];
  removed: { number: number; label: string }[];
}

function fakeForge(
  issues: Issue[],
  rec: ForgeRec,
  opts: {
    merge?: () => Promise<void>;
    listIssues?: () => Promise<Issue[]>;
    closeIssue?: (n: number) => Promise<void>;
    ensureIssueLink?: (prNumber: number, issueNumber: number) => Promise<void>;
    addIssueLabel?: (n: number, label: string) => Promise<void>;
    omitCloseIssue?: boolean;
  } = {},
): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => {
      rec.listIssuesCalls++;
      if (opts.listIssues) return opts.listIssues();
      return issues;
    },
    listPullRequests: async () => [],
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async (prNumber, o) => {
      rec.merges.push({ prNumber, method: o.method, deleteBranch: o.deleteBranch });
      if (opts.merge) await opts.merge();
    },
    redeploy: async () => {},
    postReview: async () => ({}),
    // omitCloseIssue models a forge that doesn't implement the optional method.
    closeIssue: opts.omitCloseIssue
      ? undefined
      : async (issueNumber: number) => {
          rec.closedIssues.push(issueNumber);
          if (opts.closeIssue) await opts.closeIssue(issueNumber);
        },
    ensureIssueLink: async (prNumber: number, issueNumber: number) => {
      rec.links.push({ prNumber, issueNumber });
      if (opts.ensureIssueLink) await opts.ensureIssueLink(prNumber, issueNumber);
    },
    addIssueLabel: async (number: number, label: string) => {
      if (opts.addIssueLabel) await opts.addIssueLabel(number, label);
      rec.added.push({ number, label });
    },
    removeIssueLabel: async (number: number, label: string) => {
      rec.removed.push({ number, label });
    },
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  forgeRec: ForgeRec;
  creates: CreateSessionInput[];
  statuses: DrainStatus[];
  archived: string[];
  dropped: string[];
  prCache: Record<string, GitState>;
  setReview: (id: string, decision: ReviewDecision, headSha?: string) => void;
}

function makeHarness(
  opts: {
    issues?: Issue[];
    maxAuto?: number;
    autoDrainEnabled?: boolean;
    usagePct?: number;
    usageCeilingPct?: number;
    mergeImpl?: () => Promise<void>;
    listIssuesImpl?: () => Promise<Issue[]>;
    archiveImpl?: (id: string) => number;
    onArchived?: (h: Harness, id: string) => void;
    addIssueLabelImpl?: (n: number, label: string) => Promise<void>;
    closeIssueImpl?: (n: number) => Promise<void>;
    omitCloseIssue?: boolean;
    createImpl?: () => Promise<void>;
  } = {},
): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: opts.autoDrainEnabled ?? true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    maxAuto: opts.maxAuto ?? 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: opts.usageCeilingPct ?? 80,
  });

  const forgeRec: ForgeRec = {
    merges: [],
    links: [],
    listIssuesCalls: 0,
    closedIssues: [],
    added: [],
    removed: [],
  };
  const forge = fakeForge(opts.issues ?? [], forgeRec, {
    merge: opts.mergeImpl,
    listIssues: opts.listIssuesImpl,
    addIssueLabel: opts.addIssueLabelImpl,
    closeIssue: opts.closeIssueImpl,
    omitCloseIssue: opts.omitCloseIssue,
  });

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, { decision: ReviewDecision; headSha: string }> = {};
  const creates: CreateSessionInput[] = [];
  const statuses: Harness["statuses"] = [];
  const archived: string[] = [];
  const dropped: string[] = [];

  // fake service: create inserts an auto session into the real store so it shows up
  const service = {
    create: async (input: CreateSessionInput): Promise<Session> => {
      creates.push(input);
      if (opts.createImpl) await opts.createImpl();
      return store.create({
        name: "auto",
        prompt: input.prompt,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: `shepherd/auto-${input.issueRef?.number ?? "x"}`,
        worktreePath: "/wt",
        isolated: true,
        herdrSession: "default",
        herdrAgentId: "t",
        auto: input.auto ?? false,
        issueNumber: input.issueRef?.number ?? null,
      });
    },
    archive: (id: string): number => {
      if (opts.archiveImpl) return opts.archiveImpl(id);
      store.archive(id);
      return 1;
    },
  };

  const usage = {
    limits: (): UsageLimitsType => {
      const pct = opts.usagePct ?? 0;
      return pct > 0 ? { ...NO_USAGE, session5h: { pct, resetAt: 0 } } : NO_USAGE;
    },
  };

  const harness: Harness = {
    store,
    drain: null as unknown as DrainService,
    forgeRec,
    creates,
    statuses,
    archived,
    dropped,
    prCache,
    setReview: (id, decision, headSha = "") => {
      reviews[id] = { decision, headSha };
    },
  };

  // patch store.getReview to read from our local map (so we don't need a real review row)
  store.getReview = ((id: string) =>
    reviews[id]
      ? { decision: reviews[id].decision, headSha: reviews[id].headSha }
      : null) as typeof store.getReview;

  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => prCache },
    usage,
    repos: () => [REPO],
    emitStatus: (s) => statuses.push(s),
    emitArchived: (id) => {
      harness.archived.push(id);
      opts.onArchived?.(harness, id);
    },
    dropPrCache: (id) => dropped.push(id),
  });
  harness.drain = drain;
  return harness;
}

function openGreen(number: number, mergeable = true): GitState {
  return {
    kind: "github",
    state: "open",
    number,
    checks: "success",
    mergeable,
    headSha: `sha-${number}`,
    deployConfigured: false,
  };
}

test("disabled repo: emits {enabled:false}, spawns nothing, never lists issues or creates", async () => {
  const h = makeHarness({ autoDrainEnabled: false, issues: [issue(1)] });
  await h.drain.pump(REPO);
  expect(h.creates).toHaveLength(0);
  expect(h.forgeRec.listIssuesCalls).toBe(0);
  expect(h.statuses.at(-1)?.enabled).toBe(false);
});

test("spawn fills to cap: 3 labeled issues, maxAuto 2 → creates exactly 2 auto sessions then holds", async () => {
  const h = makeHarness({ maxAuto: 2, issues: [issue(1), issue(2), issue(3)] });
  await h.drain.pump(REPO);
  expect(h.creates).toHaveLength(2);
  expect(h.creates[0]!.issueRef?.number).toBe(1);
  expect(h.creates[1]!.issueRef?.number).toBe(2);
  for (const c of h.creates) {
    expect(c.auto).toBe(true);
    expect(c.baseBranch).toBe("main");
    expect(c.repoPath).toBe(REPO);
  }
  // last status holds on cap
  expect(h.statuses.at(-1)?.inFlight).toBe(2);
});

test("dedupe: an existing session mapped to #1 → spawns #2 next, not #1", async () => {
  const h = makeHarness({ maxAuto: 2, issues: [issue(1), issue(2)] });
  // seed a manual session already attached to issue #1
  h.store.create({
    name: "manual",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/manual",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: false,
    issueNumber: 1,
  });
  await h.drain.pump(REPO);
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]!.issueRef?.number).toBe(2);
});

test("retire gate: ready session → retired once; forge.merge never called; ensureIssueLink + archive + emitArchived fire", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7);
  // critic enabled (repo default) → seed a clean verdict for the current head so the gate opens
  h.setReview(s.id, "commented", "sha-7");
  await h.drain.pump(REPO);
  // drain never merges
  expect(h.forgeRec.merges).toHaveLength(0);
  // issue link ensured
  expect(h.forgeRec.links).toEqual([{ prNumber: 7, issueNumber: 7 }]);
  // session archived
  expect(h.store.get(s.id)?.status).toBe("archived");
  // emitArchived and dropPrCache fired
  expect(h.archived).toEqual([s.id]);
  expect(h.dropped).toEqual([s.id]);
  // second pump: session archived → no longer in autoSessions → no retire
  await h.drain.pump(REPO);
  expect(h.forgeRec.links).toHaveLength(1); // not called again
  expect(h.archived).toHaveLength(1); // not emitted again
});

test("retire: archive failure is isolated — warns and defers, does not drop pr-cache / emit archived", async () => {
  let throwOnArchive = true;
  const h = makeHarness({
    maxAuto: 1,
    issues: [],
    archiveImpl: (id) => {
      if (throwOnArchive) throw new Error("worktree.remove failed");
      h.store.archive(id);
      return 1;
    },
  });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7);
  h.setReview(s.id, "commented", "sha-7");
  // archive throws → pump must not bubble it (defer to next tick)
  await h.drain.pump(REPO);
  // link was attempted, but teardown was NOT completed on a non-archived session
  expect(h.forgeRec.links).toEqual([{ prNumber: 7, issueNumber: 7 }]);
  expect(h.store.get(s.id)?.status).not.toBe("archived");
  expect(h.dropped).toHaveLength(0);
  expect(h.archived).toHaveLength(0);
  // next tick: archive now succeeds → retire completes
  throwOnArchive = false;
  await h.drain.pump(REPO);
  expect(h.store.get(s.id)?.status).toBe("archived");
  expect(h.dropped).toEqual([s.id]);
  expect(h.archived).toEqual([s.id]);
});

test("critic enabled + no verdict yet → holds, does not retire (gate not bypassed)", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7);
  // no verdict seeded → critic-on gate holds
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toHaveLength(0);
  expect(h.forgeRec.links).toHaveLength(0);
  expect(h.archived).toHaveLength(0);
  expect(h.store.get(s.id)?.status).not.toBe("archived");
});

test("onReview triggers a pump: a clean verdict landing causes retire (archive + ensureIssueLink)", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7);
  // verdict lands now (matching head) → onReview pumps → retire fires
  h.setReview(s.id, "commented", "sha-7");
  await h.drain.onReview(s.id);
  expect(h.forgeRec.merges).toHaveLength(0);
  expect(h.forgeRec.links).toEqual([{ prNumber: 7, issueNumber: 7 }]);
  expect(h.store.get(s.id)?.status).toBe("archived");
  expect(h.archived).toEqual([s.id]);
});

test("re-spawn guard: a merged+archived auto session for #N keeps #N out of candidates", async () => {
  const h = makeHarness({ maxAuto: 2, issues: [issue(7)] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  // simulate the retired → archived lifecycle: its issueNumber must stay mapped
  h.store.archive(s.id);
  await h.drain.pump(REPO);
  // issue #7 still open+labeled, but already drained → not re-spawned
  expect(h.creates).toHaveLength(0);
});

test("drain-disabled repo: a manual archive does not pump / emit drain:status", async () => {
  const h = makeHarness({ autoDrainEnabled: false, issues: [issue(1)] });
  const s = h.store.create({
    name: "manual",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/manual",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: false,
    issueNumber: 1,
  });
  h.store.archive(s.id);
  await h.drain.onArchived(s.id);
  expect(h.statuses).toHaveLength(0);
  expect(h.creates).toHaveLength(0);
  // a status change in the disabled repo is equally silent
  await h.drain.onStatus(s.id);
  expect(h.statuses).toHaveLength(0);
});

test("no retire when review decision is changes_requested (status paused)", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7);
  h.setReview(s.id, "changes_requested");
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toHaveLength(0);
  expect(h.forgeRec.links).toHaveLength(0);
  expect(h.archived).toHaveLength(0);
  const last = h.statuses.at(-1)!;
  expect(last.paused).toBe(true);
  expect(last.reason).toBe("changes_requested");
});

test("no retire when mergeable !== true", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7, false);
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toHaveLength(0);
  expect(h.forgeRec.links).toHaveLength(0);
  expect(h.archived).toHaveLength(0);
});

test("usage ceiling hold → status paused (usage banner reachable)", async () => {
  const h = makeHarness({ maxAuto: 2, usagePct: 92, usageCeilingPct: 80, issues: [issue(1)] });
  await h.drain.pump(REPO);
  const last = h.statuses.at(-1)!;
  expect(last.reason).toBe("usage");
  expect(last.paused).toBe(true);
  expect(last.detail).toBe("92");
});

test("merged → archive → advance chain: onGit(merged) closes issue, archives, drops, emits, and onArchived spawns #2", async () => {
  const advances: Promise<void>[] = [];
  const h = makeHarness({
    maxAuto: 1,
    issues: [issue(2)],
    onArchived: (hh, id) => advances.push(hh.drain.onArchived(id)),
  });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-1",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 1,
  });
  h.prCache[s.id] = openGreen(11);
  await h.drain.onGit(s.id, { ...openGreen(11), state: "merged" });
  await Promise.all(advances); // the chained onArchived pump
  expect(h.store.get(s.id)?.status).toBe("archived");
  expect(h.dropped).toEqual([s.id]);
  expect(h.archived).toEqual([s.id]);
  // closeIssue called in onGit's merged branch
  expect(h.forgeRec.closedIssues).toEqual([1]);
  // onArchived pumped → a slot freed → issue #2 spawned
  expect(h.creates).toHaveLength(1);
  expect(h.creates[0]!.issueRef?.number).toBe(2);
});

test("pumping lock: an in-flight pump makes a concurrent pump return immediately (single spawn for the slot)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = makeHarness({
    maxAuto: 1,
    issues: [issue(1)],
    // first listIssues blocks until we release; holds the pumping lock open
    listIssuesImpl: async () => {
      await gate;
      return [issue(1)];
    },
  });
  const p1 = h.drain.pump(REPO);
  const p2 = h.drain.pump(REPO); // should bail immediately (lock held)
  await p2; // returns without waiting on the gate
  expect(h.creates).toHaveLength(0); // p1 still blocked
  release();
  await p1;
  expect(h.creates).toHaveLength(1); // exactly one spawn for the single slot
});

test("ensureIssueLink failure is best-effort: retire still archives and emits even if link throws", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  // override ensureIssueLink to throw
  const store = h.store;
  const forgeRec = h.forgeRec;
  const s = store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7);
  h.setReview(s.id, "commented", "sha-7");

  // Build a drain that uses a forge where ensureIssueLink throws
  const throwingForge = fakeForge([], forgeRec, {
    ensureIssueLink: async () => {
      throw new Error("link failed");
    },
  });
  const drain2 = new DrainService({
    store,
    service: {
      create: async () => {
        throw new Error("should not spawn");
      },
      archive: (id: string): number => {
        store.archive(id);
        return 1;
      },
    },
    resolveForge: () => throwingForge,
    prCache: { snapshot: () => h.prCache },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: (id) => h.archived.push(id),
    dropPrCache: (id) => h.dropped.push(id),
  });
  await drain2.pump(REPO);
  // Link failed but teardown still ran
  expect(store.get(s.id)?.status).toBe("archived");
  expect(h.archived).toEqual([s.id]);
  expect(h.dropped).toEqual([s.id]);
});

test("tick + snapshot over repos: only drain-enabled repo is acted on and reported", async () => {
  const REPO2 = "/repo2";
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  store.setRepoConfig(REPO2, {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });

  const forgeRec: ForgeRec = {
    merges: [],
    links: [],
    listIssuesCalls: 0,
    closedIssues: [],
    added: [],
    removed: [],
  };
  const forge = fakeForge([issue(1)], forgeRec);
  const creates: CreateSessionInput[] = [];
  const statuses: DrainStatus[] = [];

  const drain = new DrainService({
    store,
    service: {
      create: async (input: CreateSessionInput): Promise<Session> => {
        creates.push(input);
        return store.create({
          name: "auto",
          prompt: input.prompt,
          repoPath: input.repoPath,
          baseBranch: input.baseBranch,
          branch: `shepherd/auto-${input.issueRef?.number ?? "x"}`,
          worktreePath: "/wt",
          isolated: true,
          herdrSession: "default",
          herdrAgentId: "t",
          auto: input.auto ?? false,
          issueNumber: input.issueRef?.number ?? null,
        });
      },
      archive: (id: string): number => {
        store.archive(id);
        return 1;
      },
    },
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO, REPO2],
    emitStatus: (s) => statuses.push(s),
    emitArchived: () => {},
    dropPrCache: () => {},
  });

  // tick should only pump the enabled repo (REPO), not REPO2
  await drain.tick();
  expect(creates.length).toBeGreaterThan(0);
  for (const c of creates) expect(c.repoPath).toBe(REPO);
  // forge.listIssues only called for enabled repo
  expect(forgeRec.listIssuesCalls).toBeGreaterThan(0);

  // snapshot: only returns entry for enabled REPO
  const snap = await drain.snapshot();
  expect(snap).toHaveLength(1);
  expect(snap[0]!.repoPath).toBe(REPO);
  expect(snap[0]!.enabled).toBe(true);
  expect(typeof snap[0]!.inFlight).toBe("number");
  expect(typeof snap[0]!.queued).toBe("number");
  expect(typeof snap[0]!.max).toBe("number");
  // snapshot must not trigger additional spawns (no side-effects beyond what tick did)
  const createsAfterSnapshot = creates.length;
  expect(creates.length).toBe(createsAfterSnapshot);
});

test("out-of-band merge: onGit(merged) without prior retire closes issue and archives", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-42",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 42,
  });
  // No pump / doRetire — simulate a human or GitHub auto-merge observed by the poller
  await h.drain.onGit(s.id, { ...openGreen(42), state: "merged" });
  expect(h.forgeRec.merges).toHaveLength(0); // drain never called forge.merge
  expect(h.forgeRec.closedIssues).toEqual([42]); // issue closed
  expect(h.store.get(s.id)?.status).toBe("archived");
  expect(h.archived).toEqual([s.id]);
  expect(h.dropped).toEqual([s.id]);
});

test("closeIssue not called when session has issueNumber === null (onGit merged path)", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-no-issue",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: null,
  });
  await h.drain.onGit(s.id, { ...openGreen(99), state: "merged" });
  expect(h.forgeRec.closedIssues).toHaveLength(0);
  expect(h.store.get(s.id)?.status).toBe("archived");
});

test("ensureIssueLink not called when session has issueNumber === null", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-no-issue",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: null,
  });
  h.prCache[s.id] = openGreen(99);
  h.setReview(s.id, "commented", "sha-99");
  await h.drain.pump(REPO);
  // session archived but no link attempted
  expect(h.forgeRec.links).toHaveLength(0);
  expect(h.store.get(s.id)?.status).toBe("archived");
});

// ── queue(): the actual backlog issues behind DrainStatus.queued ──────────────

test("queue: returns candidates in drain order (priority-first) as {number,title,url}", async () => {
  const h = makeHarness({
    maxAuto: 0, // cap 0 → nothing spawns, all candidates stay queued
    // #3 carries the priority label → jumps the head; the rest by number asc.
    issues: [issue(2), issue(1), issue(3, { labels: ["shepherd:auto", "shepherd:priority"] })],
  });
  const q = await h.drain.queue(REPO);
  expect(q.map((i) => i.number)).toEqual([3, 1, 2]);
  expect(q[0]).toEqual({ number: 3, title: "issue 3", url: "https://x/3" });
});

test("queue: excludes issues already mapped to a session", async () => {
  const h = makeHarness({ maxAuto: 0, issues: [issue(1), issue(2)] });
  h.store.create({
    name: "manual",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/manual",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: false,
    issueNumber: 1,
  });
  const q = await h.drain.queue(REPO);
  expect(q.map((i) => i.number)).toEqual([2]);
});

test("queue: [] when drain disabled, never hits the forge", async () => {
  const h = makeHarness({ autoDrainEnabled: false, issues: [issue(1)] });
  const q = await h.drain.queue(REPO);
  expect(q).toEqual([]);
  expect(h.forgeRec.listIssuesCalls).toBe(0);
});

// ── claim-label coordination (multi-instance) ───────────────────────────────────

test("spawn claims the issue: stamps ACTIVE_LABEL on the host", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [issue(1)] });
  await h.drain.pump(REPO);
  expect(h.creates).toHaveLength(1);
  expect(h.forgeRec.added).toEqual([{ number: 1, label: ACTIVE_LABEL }]);
});

test("spawn failure releases the claim so the issue returns to the pool", async () => {
  const h = makeHarness({
    maxAuto: 1,
    issues: [issue(1)],
    createImpl: async () => {
      throw new Error("create boom");
    },
  });
  await h.drain.pump(REPO);
  // claimed, then released on the create throw; no session persisted
  expect(h.forgeRec.added.some((a) => a.number === 1 && a.label === ACTIVE_LABEL)).toBe(true);
  expect(h.forgeRec.removed.some((r) => r.number === 1 && r.label === ACTIVE_LABEL)).toBe(true);
  expect(h.store.list().filter((s) => s.status !== "archived")).toHaveLength(0);
});

test("retire KEEPS the claim: a ready PR is left open, so the issue stays claimed until a human merges", async () => {
  const advances: Promise<void>[] = [];
  const h = makeHarness({
    maxAuto: 1,
    issues: [],
    onArchived: (hh, id) => advances.push(hh.drain.onArchived(id)),
  });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  h.prCache[s.id] = openGreen(7);
  h.setReview(s.id, "commented", "sha-7");
  await h.drain.pump(REPO);
  await Promise.all(advances);
  // retired (archived + link ensured), but the claim is NOT released — the open PR's
  // issue must stay claimed so no instance re-spawns it before the human merges.
  expect(h.store.get(s.id)?.status).toBe("archived");
  expect(h.forgeRec.links).toEqual([{ prNumber: 7, issueNumber: 7 }]);
  expect(h.forgeRec.removed).toHaveLength(0);
});

test("abandon (manual archive of an auto session) releases the claim → re-queue", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-5",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 5,
  });
  h.store.archive(s.id);
  await h.drain.onArchived(s.id);
  expect(h.forgeRec.removed).toEqual([{ number: 5, label: ACTIVE_LABEL }]);
});

test("out-of-band clean merge: closes the issue and drops the now-moot claim (so a reopen isn't skipped)", async () => {
  const advances: Promise<void>[] = [];
  const h = makeHarness({
    maxAuto: 1,
    issues: [],
    onArchived: (hh, id) => advances.push(hh.drain.onArchived(id)),
  });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  await h.drain.onGit(s.id, { ...openGreen(7), state: "merged" });
  await Promise.all(advances);
  expect(h.forgeRec.closedIssues).toEqual([7]); // merged → closed
  expect(h.forgeRec.removed).toEqual([{ number: 7, label: ACTIVE_LABEL }]); // claim cleaned up
});

test("merge with a FAILED close retains the claim — a still-open merged issue can't be re-spawned", async () => {
  const advances: Promise<void>[] = [];
  const h = makeHarness({
    maxAuto: 1,
    issues: [],
    closeIssueImpl: async () => {
      throw new Error("close boom");
    },
    onArchived: (hh, id) => advances.push(hh.drain.onArchived(id)),
  });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  await h.drain.onGit(s.id, { ...openGreen(7), state: "merged" });
  await Promise.all(advances);
  expect(h.forgeRec.removed).toHaveLength(0); // claim kept: close failed, issue still open
});

test("merge on a forge WITHOUT closeIssue retains the claim — the issue stays open", async () => {
  const advances: Promise<void>[] = [];
  const h = makeHarness({
    maxAuto: 1,
    issues: [],
    omitCloseIssue: true, // forge omits the optional closeIssue method
    onArchived: (hh, id) => advances.push(hh.drain.onArchived(id)),
  });
  const s = h.store.create({
    name: "auto",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "shepherd/auto-7",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: true,
    issueNumber: 7,
  });
  await h.drain.onGit(s.id, { ...openGreen(7), state: "merged" });
  await Promise.all(advances);
  expect(h.forgeRec.closedIssues).toHaveLength(0); // never closed (no method)
  expect(h.forgeRec.removed).toHaveLength(0); // claim kept: issue is still open
});

test("archiving a manually-linked (non-auto) session releases its claim", async () => {
  // A human linking an issue at task creation stamps the claim (via the create
  // route), so archiving that manual session must ALSO release it.
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "manual",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "feature/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: false,
    issueNumber: 5,
  });
  h.store.archive(s.id);
  await h.drain.onArchived(s.id);
  expect(h.forgeRec.removed).toEqual([{ number: 5, label: ACTIVE_LABEL }]);
});

test("archiving a non-auto session WITHOUT an issue never touches labels", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [] });
  const s = h.store.create({
    name: "manual",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "main",
    branch: "feature/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    auto: false,
    issueNumber: null,
  });
  h.store.archive(s.id);
  await h.drain.onArchived(s.id);
  expect(h.forgeRec.removed).toHaveLength(0);
});
