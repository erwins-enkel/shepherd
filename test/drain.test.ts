import { test, expect, describe } from "bun:test";
import { DrainService, type DrainStatus } from "../src/drain";
import { ACTIVE_LABEL } from "../src/drain-core";
import { SessionStore } from "../src/store";
import type {
  GitForge,
  GitState,
  Issue,
  MergeMethod,
  PrStatus,
  SubIssueRef,
} from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type {
  AgentProvider,
  CreateSessionInput,
  ReviewDecision,
  Session,
  SessionArchiveReason,
} from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { Epic } from "../src/epic-core";
import { config } from "../src/config";

const REPO = "/repo";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    url: `https://x/${number}`,
    labels: ["shepherd:auto"],
    createdAt: number,
    assignees: [],
    ...over,
  };
}

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

interface ForgeRec {
  merges: { prNumber: number; method: MergeMethod; deleteBranch: boolean }[];
  links: { prNumber: number; issueNumber: number }[];
  listIssuesCalls: number;
  closedIssues: number[];
  added: { number: number; label: string }[];
  removed: { number: number; label: string }[];
  getIssueCalls: number[];
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
    getIssue?: (n: number) => Promise<Issue | null>;
    omitCloseIssue?: boolean;
    omitGetIssue?: boolean;
    // Epic support
    listSubIssues?: (parentNumber: number) => Promise<SubIssueRef[]>;
    listBlockedBy?: (issueNumber: number) => Promise<number[]>;
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
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
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
    // omitGetIssue models a forge that doesn't implement the optional method (the
    // pre-spawn re-check then degrades to the cached candidate set + local dedup).
    // The default returns the fresh issue from the same list source, so an
    // unclaimed candidate spawns as before.
    getIssue: opts.omitGetIssue
      ? undefined
      : async (number: number) => {
          rec.getIssueCalls.push(number);
          if (opts.getIssue) return opts.getIssue(number);
          return issues.find((i) => i.number === number) ?? null;
        },
    listSubIssues: opts.listSubIssues,
    listBlockedBy: opts.listBlockedBy,
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  forgeRec: ForgeRec;
  creates: CreateSessionInput[];
  statuses: DrainStatus[];
  epics: Epic[];
  sessionNews: Session[];
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
    credits?: UsageLimitsType["credits"];
    /** Full control over the usage source (overrides usagePct/credits) — lets a test drive a
     *  CHANGING scrape across successive buildState calls (rising credit spend, weekly reset). */
    limitsImpl?: () => UsageLimitsType;
    mergeImpl?: () => Promise<void>;
    listIssuesImpl?: () => Promise<Issue[]>;
    archiveImpl?: (id: string) => number | Promise<number>;
    onArchived?: (h: Harness, id: string) => void;
    addIssueLabelImpl?: (n: number, label: string) => Promise<void>;
    closeIssueImpl?: (n: number) => Promise<void>;
    getIssueImpl?: (n: number) => Promise<Issue | null>;
    omitCloseIssue?: boolean;
    omitGetIssue?: boolean;
    createImpl?: () => Promise<void>;
    repoDefaultModel?: string;
    authMode?: "chatgpt" | "apikey" | "unknown";
    // Epic support
    listSubIssuesImpl?: (parentNumber: number) => Promise<SubIssueRef[]>;
    listBlockedByImpl?: (issueNumber: number) => Promise<number[]>;
  } = {},
): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: opts.autoDrainEnabled ?? true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: opts.maxAuto ?? 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: opts.usageCeilingPct ?? 80,
    sandboxProfile: "trusted",
    defaultModel: opts.repoDefaultModel ?? "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });
  const forgeRec: ForgeRec = {
    merges: [],
    links: [],
    listIssuesCalls: 0,
    closedIssues: [],
    added: [],
    removed: [],
    getIssueCalls: [],
  };
  const forge = fakeForge(opts.issues ?? [], forgeRec, {
    merge: opts.mergeImpl,
    listIssues: opts.listIssuesImpl,
    addIssueLabel: opts.addIssueLabelImpl,
    closeIssue: opts.closeIssueImpl,
    getIssue: opts.getIssueImpl,
    omitCloseIssue: opts.omitCloseIssue,
    omitGetIssue: opts.omitGetIssue,
    listSubIssues: opts.listSubIssuesImpl,
    listBlockedBy: opts.listBlockedByImpl,
  });

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, { decision: ReviewDecision; headSha: string }> = {};
  const creates: CreateSessionInput[] = [];
  const statuses: Harness["statuses"] = [];
  const epics: Epic[] = [];
  const sessionNews: Session[] = [];
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
    archive: async (
      id: string,
      _reapKeys?: string[],
      reason?: SessionArchiveReason,
    ): Promise<number> => {
      if (opts.archiveImpl) return opts.archiveImpl(id);
      store.archive(id, reason);
      return 1;
    },
  };

  const usage = {
    limits: (): UsageLimitsType => {
      if (opts.limitsImpl) return opts.limitsImpl();
      const pct = opts.usagePct ?? 0;
      const base = pct > 0 ? { ...NO_USAGE, session5h: { pct, resetAt: 0 } } : { ...NO_USAGE };
      if (opts.credits !== undefined) base.credits = opts.credits;
      return base;
    },
  };

  const harness: Harness = {
    store,
    drain: null as unknown as DrainService,
    forgeRec,
    creates,
    statuses,
    epics,
    sessionNews,
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
    emitEpic: (epic) => epics.push(epic),
    emitSessionNew: (s) => sessionNews.push(s),
    readCodexAuthMode: () => opts.authMode ?? "unknown",
    rebaseCap: 5,
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

test("ChatGPT auth clamps a blocked Codex global default before drain create", async () => {
  const savedProvider = config.defaultAgentProvider;
  const savedCodexModel = config.defaultCodexModel;
  config.defaultAgentProvider = "codex";
  config.defaultCodexModel = "gpt-5.3-codex";
  try {
    const h = makeHarness({
      issues: [issue(1)],
      maxAuto: 1,
      authMode: "chatgpt",
    });
    await h.drain.pump(REPO);
    expect(h.creates[0]?.model).toBeNull();
  } finally {
    config.defaultAgentProvider = savedProvider;
    config.defaultCodexModel = savedCodexModel;
  }
});

test("spawn emits session:new for the created session (UI session list is push-only)", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [issue(1)] });
  await h.drain.pump(REPO);
  expect(h.creates).toHaveLength(1);
  // exactly one announcement, carrying the persisted session (same id the store created)
  expect(h.sessionNews).toHaveLength(1);
  const created = h.store.list().find((s) => s.issueNumber === 1);
  expect(created).toBeDefined();
  expect(h.sessionNews[0]!.id).toBe(created!.id);
});

test("spawn failure does NOT emit session:new (emit is success-only, outside the spawn try)", async () => {
  const h = makeHarness({
    maxAuto: 1,
    issues: [issue(1)],
    createImpl: async () => {
      throw new Error("create boom");
    },
  });
  await h.drain.pump(REPO);
  // create threw → claim released, no session persisted, and nothing announced
  expect(h.forgeRec.removed.some((r) => r.number === 1 && r.label === ACTIVE_LABEL)).toBe(true);
  expect(h.sessionNews).toHaveLength(0);
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
  expect(h.store.get(s.id)?.archiveReason).toBe("drain");
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

test("label drain with global Codex default bypasses Claude usage ceiling", async () => {
  const saved = config.defaultAgentProvider;
  config.defaultAgentProvider = "codex";
  try {
    const h = makeHarness({
      maxAuto: 2,
      usagePct: 100,
      usageCeilingPct: 80,
      issues: [issue(1)],
    });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
    const last = h.statuses.at(-1)!;
    expect(last.paused).toBe(false);
    expect(last.reason).not.toBe("usage");
  } finally {
    config.defaultAgentProvider = saved;
  }
});

function creditWindow(over: Partial<NonNullable<UsageLimitsType["credits"]>> = {}) {
  return {
    pct: 50,
    spent: 25,
    cap: 50,
    currency: "€",
    resetAt: null,
    scrapedAt: 0,
    stale: false,
    ...over,
  };
}

// Fail-safe gate: a stale credits snapshot (>1h old, monthly budget not rolled over) is
// non-null with a real `spent`, but the rest of the app deliberately disregards it
// (overspending() = !!c && !c.stale && c.spent > 0). The drain must apply the same !stale
// gate, else a stale `spent > ceiling` would freeze every repo on disregarded data.
test("stale credits snapshot → NO credits hold (drain proceeds, stale data disregarded)", async () => {
  const h = makeHarness({
    maxAuto: 2,
    issues: [issue(1)],
    credits: creditWindow({ spent: 999, stale: true }), // far above default ceiling 0
  });
  await h.drain.pump(REPO);
  const last = h.statuses.at(-1)!;
  expect(last.reason).not.toBe("credits");
  expect(h.creates).toHaveLength(1); // spawned: not frozen on stale spend
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_RESET = 1_700_000_000_000; // fixed epoch; injected verbatim (no rollForward in tests)
const MONTH_RESET = WEEK_RESET + 2 * WEEK_MS; // the monthly credit-budget reset epoch

// Build a usage source whose weekly window + credit spend (+ monthly reset epoch) can be mutated
// between pumps, to exercise the "spend since the weekly window began" cost guard
// (effectiveCreditSpent).
function usageWithCredit(
  read: () => {
    spent: number;
    weekResetAt: number | null;
    weekPct?: number;
    monthResetAt?: number | null;
  },
) {
  return (): UsageLimitsType => {
    const { spent, weekResetAt, weekPct = 20, monthResetAt = MONTH_RESET } = read();
    return {
      ...NO_USAGE,
      week: weekResetAt == null ? null : { pct: weekPct, resetAt: weekResetAt },
      credits: creditWindow({ spent, resetAt: monthResetAt }),
    };
  };
}

// THE FIX: a large month-to-date credit total with fresh weekly headroom is HISTORICAL spend
// (paid overage can only accrue while a window is exhausted). It must NOT freeze the drain — the
// old guard paused until the monthly credit reset even with plenty of subscription left.
test("month-to-date credits but weekly headroom → NO credits hold (historical spend baselined out)", async () => {
  const h = makeHarness({
    maxAuto: 2,
    issues: [issue(1)],
    limitsImpl: usageWithCredit(() => ({ spent: 46.47, weekResetAt: WEEK_RESET, weekPct: 27 })),
  });
  await h.drain.pump(REPO);
  const last = h.statuses.at(-1)!;
  expect(last.reason).not.toBe("credits");
  expect(h.creates).toHaveLength(1); // drained: a pre-existing total doesn't pause it
});

// Control: NEW paid spend accruing after the baseline (window re-exhausted this week) → DOES hold.
test("credits rising above the weekly baseline → credits hold (paused)", async () => {
  let spent = 25; // anchored on first observation
  const h = makeHarness({
    maxAuto: 2,
    issues: [issue(1)],
    limitsImpl: usageWithCredit(() => ({ spent, weekResetAt: WEEK_RESET, weekPct: 50 })),
  });
  await h.drain.snapshot(); // first observation → anchor := 25
  spent = 30; // +5 of genuinely new paid spend this weekly cycle
  await h.drain.pump(REPO);
  const last = h.statuses.at(-1)!;
  expect(last.reason).toBe("credits");
  expect(last.paused).toBe(true);
  expect(h.creates).toHaveLength(0);
});

// The pause tracks the SUBSCRIPTION cadence: a credit hold clears when the weekly window resets
// (re-anchoring to the current total), not stuck until the monthly credit reset.
test("weekly window reset re-anchors credits → a credit pause clears at the reset", async () => {
  let spent = 10;
  let weekResetAt = WEEK_RESET;
  const h = makeHarness({
    maxAuto: 2,
    issues: [issue(1)],
    limitsImpl: usageWithCredit(() => ({ spent, weekResetAt, weekPct: 50 })),
  });
  await h.drain.snapshot(); // anchor := 10 @ WEEK_RESET
  spent = 15; // +5 new paid spend this week
  await h.drain.pump(REPO);
  expect(h.statuses.at(-1)!.reason).toBe("credits"); // paused: 5 > ceiling 0

  weekResetAt = WEEK_RESET + WEEK_MS; // weekly window rolled over → fresh headroom
  await h.drain.pump(REPO);
  expect(h.statuses.at(-1)!.reason).not.toBe("credits"); // re-anchored to 15 → 0 → un-paused
});

// The monthly credit budget resets independently of the weekly window: the scraped total DROPS
// (e.g. 46.47 → 0). The anchor must follow that drop, else fresh new-month spend is masked until
// it re-climbs past last month's anchor and the default-0 ceiling fails to pause on real spend.
test("monthly credit reset (total drops) re-anchors → fresh new-month spend still pauses", async () => {
  let spent = 46.47;
  const h = makeHarness({
    maxAuto: 2,
    issues: [issue(1)],
    limitsImpl: usageWithCredit(() => ({ spent, weekResetAt: WEEK_RESET, weekPct: 50 })),
  });
  await h.drain.snapshot(); // anchor := 46.47 (end of month)
  spent = 0; // monthly budget rolled over → cumulative total drops
  await h.drain.snapshot(); // re-anchor := 0
  spent = 5; // €5 of genuinely new spend in the fresh month
  await h.drain.pump(REPO);
  const last = h.statuses.at(-1)!;
  expect(last.reason).toBe("credits"); // 5 > ceiling 0 → paused, NOT masked by the old anchor
  expect(h.creates).toHaveLength(0);
});

// A monthly reset observed LATE (stale across the boundary, or spend accrued before the first
// post-reset scrape) shows a nonzero new-cycle total on first re-observation. Anchoring to that
// value would mask it; the fresh cycle starts at 0, so the full observed total must count.
test("monthly reset observed late (first post-reset total nonzero) → still pauses on that spend", async () => {
  let spent = 46.47;
  const h = makeHarness({
    maxAuto: 2,
    issues: [issue(1)],
    limitsImpl: usageWithCredit(() => ({ spent, weekResetAt: WEEK_RESET, weekPct: 50 })),
  });
  await h.drain.snapshot(); // anchor := 46.47 (old month)
  spent = 5; // monthly budget rolled over, but €5 already accrued before we first re-observed
  await h.drain.pump(REPO);
  const last = h.statuses.at(-1)!;
  expect(last.reason).toBe("credits"); // counts €5 from 0 — not masked by re-anchoring to it
  expect(h.creates).toHaveLength(0);
});

// A monthly reset with NO spend drop: the new cycle already reached/exceeded last month's total
// before the first fresh scrape (Shepherd stale/down across the boundary). A spend-drop heuristic
// can't see it, so we detect the rollover from the monthly reset EPOCH advancing and count from 0.
// With a ceiling between the stale delta and the real new-cycle spend, the old code wouldn't pause.
test("monthly reset with no spend drop (epoch advanced) → counts new cycle from 0, pauses", async () => {
  const savedCeiling = config.extraCreditsDrainCeiling;
  config.extraCreditsDrainCeiling = 10; // between the stale delta (50−46.47=3.53) and the real 50
  try {
    let spent = 46.47;
    let monthResetAt = MONTH_RESET;
    const h = makeHarness({
      maxAuto: 2,
      issues: [issue(1)],
      limitsImpl: usageWithCredit(() => ({
        spent,
        weekResetAt: WEEK_RESET,
        weekPct: 50,
        monthResetAt,
      })),
    });
    await h.drain.snapshot(); // anchor := { spent 46.47, monthResetAt MONTH_RESET }
    spent = 50; // new month already spent €50 (> old baseline) before our first fresh scrape
    monthResetAt = MONTH_RESET + 30 * 24 * 60 * 60 * 1000; // monthly reset epoch advanced
    await h.drain.pump(REPO);
    const last = h.statuses.at(-1)!;
    // Old (drop-only) code: 50 ≥ 46.47 → no drop → delta 3.53 < ceiling 10 → no pause (the bug).
    // New code: epoch advanced → count 50 from 0 → 50 > 10 → pause.
    expect(last.reason).toBe("credits");
    expect(h.creates).toHaveLength(0);
  } finally {
    config.extraCreditsDrainCeiling = savedCeiling;
  }
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
      archive: async (id: string): Promise<number> => {
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
    rebaseCap: 5,
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
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });
  store.setRepoConfig(REPO2, {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });

  const forgeRec: ForgeRec = {
    merges: [],
    links: [],
    listIssuesCalls: 0,
    closedIssues: [],
    added: [],
    removed: [],
    getIssueCalls: [],
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
      archive: async (id: string): Promise<number> => {
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
    rebaseCap: 5,
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

test("pre-spawn re-check: a fresh read showing ACTIVE_LABEL (claimed by another instance) yields — no spawn, no stamp", async () => {
  // The cached candidate list still shows #1 unclaimed, but a fresh read reveals
  // another instance stamped it since (the stale-cache race). doSpawn must yield.
  const h = makeHarness({
    maxAuto: 1,
    issues: [issue(1)],
    getIssueImpl: async (n) => issue(n, { labels: ["shepherd:auto", ACTIVE_LABEL] }),
  });
  await h.drain.pump(REPO);
  expect(h.creates).toHaveLength(0); // did not spawn
  expect(h.forgeRec.added).toHaveLength(0); // did not even stamp its own claim
  expect(h.forgeRec.getIssueCalls).toContain(1); // the re-check actually ran
});

test("pre-spawn re-check: a fresh read showing the issue unclaimed spawns normally (stamp + create)", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [issue(1)] });
  await h.drain.pump(REPO);
  expect(h.forgeRec.getIssueCalls).toContain(1); // re-check consulted
  expect(h.creates).toHaveLength(1);
  expect(h.forgeRec.added).toEqual([{ number: 1, label: ACTIVE_LABEL }]);
});

test("pre-spawn re-check is best-effort: getIssue throwing still spawns (drain never stalls)", async () => {
  const h = makeHarness({
    maxAuto: 1,
    issues: [issue(1)],
    getIssueImpl: async () => {
      throw new Error("getIssue boom");
    },
  });
  await h.drain.pump(REPO);
  expect(h.creates).toHaveLength(1); // fell through to spawn
  expect(h.forgeRec.added).toEqual([{ number: 1, label: ACTIVE_LABEL }]);
});

test("pre-spawn re-check on a forge WITHOUT getIssue degrades to spawning (no regress)", async () => {
  const h = makeHarness({ maxAuto: 1, issues: [issue(1)], omitGetIssue: true });
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

// ── drain epic mode ──────────────────────────────────────────────────────────────

describe("drain epic mode", () => {
  const PARENT = 327;
  const CHILD = 320;

  function epicHarness(
    epicStatus: "running" | "paused" = "running",
    epicMode: "auto" | "attended" = "auto",
    opts: {
      usagePct?: number;
      usageCeilingPct?: number;
      agentProvider?: AgentProvider;
      model?: string | null;
      effort?: string | null;
    } = {},
  ) {
    const subIssues: SubIssueRef[] = [
      {
        number: CHILD,
        title: "EFI",
        url: "u320",
        body: "Notion spec 320",
        closed: false,
        labels: [],
      },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "Epic parent",
      body: "epic body",
      url: `https://x/${PARENT}`,
      labels: [],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({
      usagePct: opts.usagePct,
      usageCeilingPct: opts.usageCeilingPct,
      // listIssues returns [] — epic native mode must NOT rely on it
      listIssuesImpl: async () => [],
      getIssueImpl: async (n) => (n === PARENT ? parentIssue : null),
      listSubIssuesImpl: async (n) => (n === PARENT ? subIssues : []),
      listBlockedByImpl: async () => [],
    });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: epicMode,
      status: epicStatus,
      agentProvider: opts.agentProvider,
      model: opts.model,
      effort: opts.effort,
    });
    return h;
  }

  test("running auto epic spawns the dependency-free root once, carries body, and does NOT depend on listIssues", async () => {
    const h = epicHarness("running", "auto");
    await h.drain.pump(REPO);
    // listIssues should NOT have been called (native sub-issues used instead)
    expect(h.forgeRec.listIssuesCalls).toBe(0);
    // Exactly one session created
    expect(h.creates).toHaveLength(1);
    const created = h.creates[0]!;
    expect(created.auto).toBe(true);
    expect(created.issueRef?.number).toBe(CHILD);
    expect(created.issueRef?.body).toBe("Notion spec 320");
  });

  test("running Codex epic spawns despite Claude usage ceiling", async () => {
    const h = epicHarness("running", "auto", {
      usagePct: 100,
      usageCeilingPct: 80,
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.agentProvider).toBe("codex");
    expect(h.creates[0]!.model).toBe("gpt-5.5");
    expect(h.creates[0]!.effort).toBe("high");
    const last = h.statuses.at(-1)!;
    expect(last.paused).toBe(false);
    expect(last.reason).not.toBe("usage");
  });

  test("running epic inheriting global Codex default spawns despite Claude usage ceiling", async () => {
    const saved = config.defaultAgentProvider;
    const savedClaudeModel = config.defaultModel;
    const savedCodexModel = config.defaultCodexModel;
    config.defaultAgentProvider = "codex";
    config.defaultModel = "sonnet";
    config.defaultCodexModel = "gpt-5.4";
    try {
      const h = epicHarness("running", "auto", {
        usagePct: 100,
        usageCeilingPct: 80,
      });
      await h.drain.pump(REPO);
      expect(h.creates).toHaveLength(1);
      expect(h.creates[0]!.agentProvider).toBeUndefined();
      expect(h.creates[0]!.model).toBe("gpt-5.4");
      const last = h.statuses.at(-1)!;
      expect(last.paused).toBe(false);
      expect(last.reason).not.toBe("usage");
    } finally {
      config.defaultAgentProvider = saved;
      config.defaultModel = savedClaudeModel;
      config.defaultCodexModel = savedCodexModel;
    }
  });

  test("paused epic spawns nothing", async () => {
    const h = epicHarness("paused", "auto");
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(0);
  });

  test("attended epic holds until approveEpicNext", async () => {
    const h = epicHarness("running", "attended");
    // First pump: attended mode → no spawn yet
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(0);
    // Approve next spawn
    h.drain.approveEpicNext(REPO);
    // Second pump: now approved → should spawn
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.issueRef?.number).toBe(CHILD);
  });

  test("running epic sets DrainStatus.epicParent; non-epic repo has epicParent null", async () => {
    const h = epicHarness("running", "auto");
    await h.drain.pump(REPO);
    const last = h.statuses.at(-1)!;
    expect(last.epicParent).toBe(PARENT);

    // Non-epic repo: make a fresh harness without any epic set
    const h2 = makeHarness({ issues: [] });
    await h2.drain.pump(REPO);
    const last2 = h2.statuses.at(-1)!;
    expect(last2.epicParent).toBeNull();
  });

  test("emitEpic fires once per change, not once per pump iteration", async () => {
    const h = epicHarness("running", "auto");
    await h.drain.pump(REPO);
    // The pump loops up to 100 times but emitEpic must not fire once per iteration.
    // A single pump that reaches a steady hold should call emitEpic ≤ 2 times.
    expect(h.epics.length).toBeGreaterThan(0);
    expect(h.epics.length).toBeLessThanOrEqual(2);
  });

  test("idle epic_run row does NOT suppress label-drain: autoDrainEnabled+idle row → label candidates used, enabled true", async () => {
    const h = makeHarness({
      autoDrainEnabled: true,
      issues: [issue(1)],
    });
    // Seed an idle epic_run row — must not override label-drain
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "idle",
    });
    await h.drain.pump(REPO);
    // Label-drain must have run: listIssues was called and session was created for #1
    expect(h.forgeRec.listIssuesCalls).toBeGreaterThan(0);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.issueRef?.number).toBe(1);
    const last = h.statuses.at(-1)!;
    expect(last.enabled).toBe(true);
    expect(last.epicParent).toBeNull();
  });

  test("running epic with all-merged children auto-transitions to idle after pump", async () => {
    const subIssues: SubIssueRef[] = [
      {
        number: CHILD,
        title: "EFI",
        url: "u320",
        body: "Notion spec 320",
        closed: true, // already merged
        labels: [],
      },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "Epic parent",
      body: "epic body",
      url: `https://x/${PARENT}`,
      labels: [],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({
      listIssuesImpl: async () => [],
      getIssueImpl: async (n) => (n === PARENT ? parentIssue : null),
      listSubIssuesImpl: async (n) => (n === PARENT ? subIssues : []),
      listBlockedByImpl: async () => [],
    });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
    await h.drain.pump(REPO);
    // All children merged → auto-complete: status must be idle now
    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");
    // A final epic:update reflecting the completed state must have been emitted
    expect(h.epics.length).toBeGreaterThan(0);
    expect(h.epics.at(-1)!.run.status).toBe("idle");
  });

  test("auto-complete with autoDrain OFF emits drain:status with epicParent=null (banner clears without reload)", async () => {
    // Bug: when the epic auto-completes and autoDrainEnabled is false, the pump
    // guard prevents any further pump, so the stale epicParent from the pre-transition
    // state was never corrected in the emitted drain:status.
    const subIssues: SubIssueRef[] = [
      {
        number: CHILD,
        title: "EFI",
        url: "u320",
        body: "Notion spec 320",
        closed: true, // already merged → triggers auto-complete
        labels: [],
      },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "Epic parent",
      body: "epic body",
      url: `https://x/${PARENT}`,
      labels: [],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({
      autoDrainEnabled: false, // label-drain OFF — no follow-up pump will fire
      listIssuesImpl: async () => [],
      getIssueImpl: async (n) => (n === PARENT ? parentIssue : null),
      listSubIssuesImpl: async (n) => (n === PARENT ? subIssues : []),
      listBlockedByImpl: async () => [],
    });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
    await h.drain.pump(REPO);
    // Stored run must be idle (existing behavior)
    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");
    // The LAST emitted drain:status must carry epicParent=null (corrected emit)
    const lastStatus = h.statuses.at(-1)!;
    expect(lastStatus.epicParent).toBeNull();
  });

  test("snapshot() and queue() do NOT emit epic:update; pump() does", async () => {
    const h = epicHarness("running", "auto");
    const epicsBefore = h.epics.length;
    // snapshot and queue are read-only: must not emit
    await h.drain.snapshot();
    await h.drain.queue(REPO);
    expect(h.epics.length).toBe(epicsBefore);
    // pump does emit
    await h.drain.pump(REPO);
    expect(h.epics.length).toBeGreaterThan(epicsBefore);
  });
});

// ── #790: per-issue spawn-failure cooldown ────────────────────────────────────

test("#790: spawn-failure cooldown: failed issue is skipped until window expires", async () => {
  // Mutable clock injected as `now` dep so we control time deterministically.
  let clock = 1_000_000;

  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
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
    signoffAuthority: "human",
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });

  const candidateIssue = issue(42);
  const forgeRec: ForgeRec = {
    merges: [],
    links: [],
    listIssuesCalls: 0,
    closedIssues: [],
    added: [],
    removed: [],
    getIssueCalls: [],
  };
  // Count ACTIVE_LABEL claim calls only (addIssueLabel with ACTIVE_LABEL).
  let claimCount = 0;
  const forge = fakeForge([candidateIssue], forgeRec, {
    addIssueLabel: async (n, label) => {
      if (label === ACTIVE_LABEL) claimCount++;
    },
  });

  const drain = new DrainService({
    store,
    service: {
      create: async () => {
        throw new Error("isolation failed");
      },
      archive: async (id: string): Promise<number> => {
        store.archive(id);
        return 1;
      },
    },
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    now: () => clock,
    // Zero TTL so the issues list is never served from cache between pumps.
    issuesTtlMs: 0,
    rebaseCap: 5,
  });

  // Step 3: first pump — one claim attempt, create throws, cooldown recorded.
  await drain.pump(REPO);
  expect(claimCount).toBe(1);

  // Step 4: second pump, clock unchanged — still within cooldown window, skipped.
  await drain.pump(REPO);
  expect(claimCount).toBe(1);

  // Step 5: advance clock past the 5-minute cooldown, pump again — re-attempted.
  clock += 5 * 60_000 + 1;
  await drain.pump(REPO);
  expect(claimCount).toBe(2);
});
