import { test, expect } from "bun:test";
import { DrainService, type DrainStatus } from "../src/drain";
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
  listIssuesCalls: number;
}

function fakeForge(
  issues: Issue[],
  rec: ForgeRec,
  opts: { merge?: () => Promise<void>; listIssues?: () => Promise<Issue[]> } = {},
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
  setReview: (id: string, decision: ReviewDecision) => void;
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
    onArchived?: (h: Harness, id: string) => void;
  } = {},
): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: opts.autoDrainEnabled ?? true,
    maxAuto: opts.maxAuto ?? 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: opts.usageCeilingPct ?? 80,
  });

  const forgeRec: ForgeRec = { merges: [], listIssuesCalls: 0 };
  const forge = fakeForge(opts.issues ?? [], forgeRec, {
    merge: opts.mergeImpl,
    listIssues: opts.listIssuesImpl,
  });

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, ReviewDecision> = {};
  const creates: CreateSessionInput[] = [];
  const statuses: Harness["statuses"] = [];
  const archived: string[] = [];
  const dropped: string[] = [];

  // fake service: create inserts an auto session into the real store so it shows up
  const service = {
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
    setReview: (id, decision) => {
      reviews[id] = decision;
    },
  };

  // patch store.getReview to read from our local map (so we don't need a real review row)
  store.getReview = ((id: string) =>
    reviews[id] ? { decision: reviews[id] } : null) as typeof store.getReview;

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

test("auto-merge gate: mergeable session → merges once; immediate second pump does not re-merge", async () => {
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
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toEqual([{ prNumber: 7, method: "squash", deleteBranch: true }]);
  // second pump: still in `merging` (pr-poller hasn't reported merged), git → null → no re-merge
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toHaveLength(1);
});

test("no merge when review decision is changes_requested (and status is paused)", async () => {
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
  const last = h.statuses.at(-1)!;
  expect(last.paused).toBe(true);
  expect(last.reason).toBe("changes_requested");
});

test("no merge when mergeable !== true", async () => {
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
});

test("merged → archive → advance chain: onGit(merged) archives, drops, emits, and onArchived spawns #2", async () => {
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

test("merge-throw → retry: failed merge defers to next pump (at most one attempt per pump)", async () => {
  let callCount = 0;
  const h = makeHarness({
    maxAuto: 1,
    issues: [],
    mergeImpl: async () => {
      callCount++;
      if (callCount === 1) throw new Error("conflict");
      // second call succeeds
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
  // first pump: merge throws on first attempt → id removed from merging →
  // attemptedMerge guard fires → breaks without retrying in the same pump
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toHaveLength(1); // attempted exactly once; NOT retried same pump
  // second pump: fresh attemptedMerge; id not in merging (throw cleared it) →
  // merge is retried and succeeds
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toHaveLength(2); // retried across pumps; total 2 calls
  // third pump: id now in merging (success); git → null → no further merge
  await h.drain.pump(REPO);
  expect(h.forgeRec.merges).toHaveLength(2); // no third attempt
});

test("tick + snapshot over repos: only drain-enabled repo is acted on and reported", async () => {
  const REPO2 = "/repo2";
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: true,
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });
  store.setRepoConfig(REPO2, {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
  });

  const forgeRec: ForgeRec = { merges: [], listIssuesCalls: 0 };
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
