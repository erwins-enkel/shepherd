import { test, expect, describe } from "bun:test";
import { DrainService, type DrainStatus } from "../src/drain";
import { ACTIVE_LABEL } from "../src/drain-core";
import { SessionStore } from "../src/store";
import type { GitForge, GitState, Issue, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { StandardCreateInput, ReviewDecision, Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { Epic } from "../src/epic-core";

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
  listIssuesCalls: number;
  added: { number: number; label: string }[];
  /** ensureBranch calls: [branch, fromRef]. */
  ensured: { branch: string; fromRef: string }[];
  /** #1757: claim-label removals (a failed spawn must release the claim). */
  removed: { number: number; label: string }[];
}

function fakeForge(
  issues: Issue[],
  rec: ForgeRec,
  opts: {
    listIssues?: () => Promise<Issue[]>;
    getIssue?: (n: number) => Promise<Issue | null>;
    listSubIssues?: (parentNumber: number) => Promise<SubIssueRef[]>;
    listBlockedBy?: (issueNumber: number) => Promise<number[]>;
    ensureBranch?: (branch: string, fromRef: string) => Promise<void>;
    /** Omit the ensureBranch method entirely (e.g. a gitea forge that can't create refs). */
    noEnsureBranch?: boolean;
    /** #2069: expose the stacked-PR surface (GitHub). Reads report "unstacked". */
    stacks?: boolean;
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
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    addIssueLabel: async (number: number, label: string) => {
      rec.added.push({ number, label });
    },
    removeIssueLabel: async (number: number, label: string) => {
      rec.removed.push({ number, label });
    },
    getIssue: async (number: number) => {
      if (opts.getIssue) return opts.getIssue(number);
      return issues.find((i) => i.number === number) ?? null;
    },
    listSubIssues: opts.listSubIssues,
    listBlockedBy: opts.listBlockedBy,
    ensureBranch: opts.noEnsureBranch
      ? undefined
      : async (branch: string, fromRef: string) => {
          rec.ensured.push({ branch, fromRef });
          if (opts.ensureBranch) await opts.ensureBranch(branch, fromRef);
        },
    ...(opts.stacks
      ? {
          stackForPr: async () => null,
          createStack: async (prNumbers: number[]) => ({
            number: 7,
            baseRef: "epic/327-efi-cluster",
            prNumbers,
          }),
          addToStack: async () => {},
        }
      : {}),
  };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  forgeRec: ForgeRec;
  creates: StandardCreateInput[];
  statuses: DrainStatus[];
  epics: Epic[];
  prCache: Record<string, GitState>;
}

function makeHarness(
  opts: {
    issues?: Issue[];
    listIssuesImpl?: () => Promise<Issue[]>;
    getIssueImpl?: (n: number) => Promise<Issue | null>;
    listSubIssuesImpl?: (parentNumber: number) => Promise<SubIssueRef[]>;
    listBlockedByImpl?: (issueNumber: number) => Promise<number[]>;
    noEnsureBranch?: boolean;
    authMode?: "chatgpt" | "apikey" | "unknown";
    /** #1757: make the forge's ensureBranch THROW (a rate-limit / 5xx / race). */
    ensureBranchImpl?: (branch: string, fromRef: string) => Promise<void>;
    /** #1757: injectable clock, so a test can advance past SPAWN_FAIL_COOLDOWN_MS. */
    now?: () => number;
    /** #2069: per-repo opt-in for stacking epic children. */
    epicStacksEnabled?: boolean;
    /** #2069: give the forge the stacked-PR surface. */
    stacks?: boolean;
  } = {},
): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
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
    epicStacksEnabled: opts.epicStacksEnabled ?? false,
    hidden: false,
  });

  const forgeRec: ForgeRec = { listIssuesCalls: 0, added: [], ensured: [], removed: [] };
  const forge = fakeForge(opts.issues ?? [], forgeRec, {
    listIssues: opts.listIssuesImpl,
    getIssue: opts.getIssueImpl,
    listSubIssues: opts.listSubIssuesImpl,
    listBlockedBy: opts.listBlockedByImpl,
    noEnsureBranch: opts.noEnsureBranch,
    ensureBranch: opts.ensureBranchImpl,
    stacks: opts.stacks,
  });

  const prCache: Record<string, GitState> = {};
  const reviews: Record<string, { decision: ReviewDecision; headSha: string }> = {};
  const creates: StandardCreateInput[] = [];
  const statuses: DrainStatus[] = [];
  const epics: Epic[] = [];

  const service = {
    create: async (input: StandardCreateInput): Promise<Session> => {
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
  };

  const usage = { limits: (): UsageLimitsType => NO_USAGE };

  store.getReview = ((id: string) =>
    reviews[id]
      ? { decision: reviews[id].decision, headSha: reviews[id].headSha }
      : null) as typeof store.getReview;

  const drain = new DrainService({
    store,
    service,
    ...(opts.now ? { now: opts.now } : {}),
    resolveForge: () => forge,
    prCache: { snapshot: () => prCache },
    usage,
    repos: () => [REPO],
    emitStatus: (s) => statuses.push(s),
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: (epic) => epics.push(epic),
    readCodexAuthMode: () => opts.authMode ?? "unknown",
    rebaseCap: 5,
  });

  return { store, drain, forgeRec, creates, statuses, epics, prCache };
}

describe("epic-child spawns base on the integration branch", () => {
  const PARENT = 327;
  const CHILD = 320;
  const EPIC_BRANCH = "epic/327-efi-cluster";

  test("running epic: ensureBranch(epic/327-efi-cluster, main) + spawn bases on it", async () => {
    const subIssues: SubIssueRef[] = [
      { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "EFI cluster",
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

    expect(h.forgeRec.ensured).toEqual([{ branch: EPIC_BRANCH, fromRef: "main" }]);
    expect(h.creates).toHaveLength(1);
    const created = h.creates[0]!;
    expect(created.baseBranch).toBe(EPIC_BRANCH);
    expect(created.issueRef?.number).toBe(CHILD);
    expect(created.agentProvider).toBeUndefined();
    // The spawn prompt carries the epic base directive so the agent opens its own PR
    // against the integration branch, not the default branch.
    expect(created.prompt).toContain(`--base ${EPIC_BRANCH}`);
    expect(created.prompt).toContain(EPIC_BRANCH);
  });

  test("running epic with explicit provider settings spawns the child with those settings", async () => {
    const subIssues: SubIssueRef[] = [
      { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "EFI cluster",
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
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
      issueRef: { number: CHILD },
    });
  });

  test("ChatGPT auth clamps a blocked Codex epic model before child create", async () => {
    const subIssues: SubIssueRef[] = [
      { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    ];
    const h = makeHarness({
      authMode: "chatgpt",
      listIssuesImpl: async () => [],
      getIssueImpl: async (n) =>
        n === PARENT
          ? ({
              number: PARENT,
              title: "EFI cluster",
              body: "epic body",
              url: "u327",
              labels: [],
              createdAt: 0,
              assignees: [],
            } as Issue)
          : null,
      listSubIssuesImpl: async () => subIssues,
      listBlockedByImpl: async () => [],
    });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
      agentProvider: "codex",
      model: "gpt-5.3-codex",
      effort: "high",
    });

    await h.drain.pump(REPO);

    expect(h.creates[0]).toMatchObject({ agentProvider: "codex", model: null });
  });

  test("running epic on a forge WITHOUT ensureBranch: falls back to main, never the epic branch", async () => {
    const subIssues: SubIssueRef[] = [
      { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    ];
    const parentIssue: Issue = {
      number: PARENT,
      title: "EFI cluster",
      body: "epic body",
      url: `https://x/${PARENT}`,
      labels: [],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({
      noEnsureBranch: true,
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

    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.baseBranch).toBe("main"); // fallback, NOT the epic branch
    expect(h.creates[0]!.issueRef?.number).toBe(CHILD);
    expect(h.forgeRec.ensured).toHaveLength(0);
    // Fell back to main → did NOT use the integration branch, so no epic directive.
    expect(h.creates[0]!.prompt).not.toContain("--base");
    expect(h.creates[0]!.prompt).not.toContain("part of an epic");
  });

  test("regular label-drain spawn: bases on main, never ensures a branch", async () => {
    const h = makeHarness({ issues: [issue(1)] });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.baseBranch).toBe("main");
    expect(h.creates[0]!.agentProvider).toBeUndefined();
    expect(h.forgeRec.ensured).toHaveLength(0);
    expect(h.forgeRec.added).toEqual([{ number: 1, label: ACTIVE_LABEL }]);
    // Regular spawn → prompt is just the title, no --base directive.
    expect(h.creates[0]!.prompt).not.toContain("--base");
  });
});

// ── #1757: the two epic-base failure modes are NOT the same ─────────────────────────────────────
//
// A child degraded onto the default branch is NOT stuck: the base-mismatch gate needs the session
// to read as an epic child (`isEpicChild`), which a degraded child fails — it carries no epicParent
// stamp and its base is the default branch — so it retires
// normally, the merge train lands it on main (isFullAuto uses the same predicate), its issue closes,
// and epic done-ness (`integrationMerged || issueClosed`) counts it. The epic PROGRESSES.
// So the two causes get opposite treatment:
//   - forge LACKS ensureBranch (gitea/local): degrade — holding would turn a progressing epic into
//     permanent zero progress. Surface it as an epic WARNING instead. (Asserted above + below.)
//   - ensureBranch THROWS (GitHub, transient): FAIL CLOSED — degrading would mix bases mid-epic and
//     the merge train would silently land this one child on main.

describe("#1757 epic base failures", () => {
  const PARENT = 327;
  const CHILD = 320;
  const EPIC_BRANCH = "epic/327-efi-cluster";
  const COOLDOWN_MS = 5 * 60_000;

  const subIssues: SubIssueRef[] = [
    { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
  ];
  const parentIssue: Issue = {
    number: PARENT,
    title: "EFI cluster",
    body: "epic body",
    url: `https://x/${PARENT}`,
    labels: [],
    createdAt: 0,
    assignees: [],
  };
  const epicOpts = {
    listIssuesImpl: async () => [],
    getIssueImpl: async (n: number) => (n === PARENT ? parentIssue : null),
    listSubIssuesImpl: async (n: number) => (n === PARENT ? subIssues : []),
    listBlockedByImpl: async () => [],
  };
  const runEpic = (h: Harness) =>
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });

  test("ensureBranch THROWS → fail closed: no child spawned on main, claim released", async () => {
    const h = makeHarness({
      ...epicOpts,
      ensureBranchImpl: async () => {
        throw new Error("403 rate limited");
      },
    });
    runEpic(h);

    await h.drain.pump(REPO);

    // The critical assertion: NO session was created. Before #1757 the child was silently based on
    // main, opened its PR against main, and the merge train would land it mid-epic.
    expect(h.creates).toHaveLength(0);
    // The claim label was stamped then RELEASED, so the issue returns to the pool for a retry.
    expect(h.forgeRec.added).toEqual([{ number: CHILD, label: ACTIVE_LABEL }]);
    expect(h.forgeRec.removed).toEqual([{ number: CHILD, label: ACTIVE_LABEL }]);
  });

  test("ensureBranch THROWS → drain reports epic_base_unavailable, naming the branch", async () => {
    const h = makeHarness({
      ...epicOpts,
      ensureBranchImpl: async () => {
        throw new Error("500");
      },
    });
    runEpic(h);

    await h.drain.pump(REPO); // fails the spawn, records the typed failure
    await h.drain.pump(REPO); // next tick: the hold is derived from it

    const last = h.statuses.at(-1)!;
    expect(last.reason).toBe("epic_base_unavailable");
    expect(last.detail).toBe(EPIC_BRANCH);
    expect(last.paused).toBe(true); // amber operator banner, not a quiet idle state
  });

  test("the hold CLEARS once the cooldown lapses (it must not latch)", async () => {
    // Regression guard for a deadlock: spawnFailures entries are only dropped on a successful spawn
    // or by a LAZY expiry delete inside doSpawn — which the hold prevents from running. A
    // membership-only derivation would therefore hold the epic FOREVER. buildState applies the
    // freshness test itself; this asserts that.
    let now = 1_000_000;
    let fail = true;
    const h = makeHarness({
      ...epicOpts,
      now: () => now,
      ensureBranchImpl: async () => {
        if (fail) throw new Error("transient");
      },
    });
    runEpic(h);

    await h.drain.pump(REPO);
    await h.drain.pump(REPO);
    expect(h.statuses.at(-1)!.reason).toBe("epic_base_unavailable");

    // ...the forge recovers and the cooldown lapses → the hold must lapse with it and the spawn retry.
    fail = false;
    now += COOLDOWN_MS + 1;
    await h.drain.pump(REPO);

    expect(h.statuses.at(-1)!.reason).not.toBe("epic_base_unavailable");
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.baseBranch).toBe(EPIC_BRANCH); // and it lands on the epic branch, as intended
  });

  test("an ORDINARY spawn failure raises NO epic_base_unavailable hold (typed error only)", async () => {
    // doSpawn's catch also wraps service.create(), so an untyped marker would turn ANY epic-child
    // spawn failure (sandbox hold, provider error, transient create error) into a mislabeled,
    // epic-wide hold — a far broader pause than the per-issue cooldown, with the wrong copy.
    const h = makeHarness(epicOpts);
    runEpic(h);
    h.drain["deps"].service.create = async () => {
      throw new Error("worktree isolation aborted");
    };

    await h.drain.pump(REPO);
    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(0);
    expect(h.statuses.at(-1)!.reason).not.toBe("epic_base_unavailable");
  });

  test("forge WITHOUT ensureBranch: epic still progresses, and the degrade is surfaced as a warning", async () => {
    // The static case. It must NOT hold (that would convert a degraded-but-progressing epic into
    // permanent zero progress) — it degrades, exactly as before, and now says so out loud.
    const h = makeHarness({ ...epicOpts, noEnsureBranch: true });
    runEpic(h);

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(1); // still spawns — no regression
    expect(h.creates[0]!.baseBranch).toBe("main");
    expect(h.statuses.at(-1)!.reason).not.toBe("epic_base_unavailable"); // and NO hold
    // ...but the operator can now SEE that this epic has no integration branch.
    expect(h.epics.at(-1)!.warnings.join("\n")).toContain("WITHOUT an integration branch");
  });
});

// ── #2067: epic-child identity is a stamped session fact, not a base-branch name ────────────────
//
// The stamp is what keeps the merge train off a child (isFullAuto) and routes its retire into the
// integration branch (doRetire) once children no longer base on `epic/*`. It is written ONLY when
// the child really got the integration branch — a degraded child behaves like an ordinary session,
// and stamping it would silently reroute every gitea/local epic through the epic retire path.

describe("#2067 epic-child identity stamped at spawn", () => {
  const PARENT = 327;
  const CHILD = 320;
  const subIssues: SubIssueRef[] = [
    { number: CHILD, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
  ];
  const parentIssue: Issue = {
    number: PARENT,
    title: "EFI cluster",
    body: "epic body",
    url: `https://x/${PARENT}`,
    labels: [],
    createdAt: 0,
    assignees: [],
  };
  const epicOpts = {
    listIssuesImpl: async () => [],
    getIssueImpl: async (n: number) => (n === PARENT ? parentIssue : null),
    listSubIssuesImpl: async (n: number) => (n === PARENT ? subIssues : []),
    listBlockedByImpl: async () => [],
  };

  test("child based on the integration branch is stamped with the epic parent", async () => {
    const h = makeHarness(epicOpts);
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.epicParent).toBe(PARENT);
  });

  test("child DEGRADED onto main (forge without ensureBranch) is NOT stamped", async () => {
    const h = makeHarness({ ...epicOpts, noEnsureBranch: true });
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.baseBranch).toBe("main");
    expect(h.creates[0]!.epicParent ?? null).toBeNull();
  });

  test("label-drain spawn carries no stamp", async () => {
    const h = makeHarness({ issues: [issue(1)] });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.epicParent ?? null).toBeNull();
  });
});

// ── #2069: a stacked child spawns on its predecessor's PR head branch ────────────────────────────
//
// With `epicStacksEnabled`, a child whose ONLY outstanding blocker is its chain predecessor spawns
// as soon as that predecessor's PR is OPEN — based on the predecessor's branch rather than the epic
// integration branch, and a whole CI + critic + merge cycle earlier than the wait-for-merge path.

describe("#2069 stacked epic-child spawn base", () => {
  const PARENT = 327;
  const LOWER = 320;
  const UPPER = 321;
  const EPIC_BRANCH = "epic/327-efi-cluster";
  const LOWER_BRANCH = "shepherd/auto-320";

  const subIssues: SubIssueRef[] = [
    { number: LOWER, title: "EFI", url: "u320", body: "spec 320", closed: false, labels: [] },
    { number: UPPER, title: "boot", url: "u321", body: "spec 321", closed: false, labels: [] },
  ];
  const parentIssue: Issue = {
    number: PARENT,
    title: "EFI cluster",
    body: "epic body",
    url: `https://x/${PARENT}`,
    labels: [],
    createdAt: 0,
    assignees: [],
  };
  const epicOpts = {
    listIssuesImpl: async () => [],
    getIssueImpl: async (n: number) => (n === PARENT ? parentIssue : null),
    listSubIssuesImpl: async (n: number) => (n === PARENT ? subIssues : []),
    listBlockedByImpl: async (n: number) => (n === UPPER ? [LOWER] : []),
  };

  /** The predecessor as the drain sees it mid-flight: a live auto session with an OPEN PR. */
  function seedLowerWithOpenPr(h: Harness): void {
    const s = h.store.create({
      name: "auto",
      prompt: "p",
      repoPath: REPO,
      baseBranch: EPIC_BRANCH,
      branch: LOWER_BRANCH,
      worktreePath: "/wt",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "t",
      auto: true,
      issueNumber: LOWER,
      epicParent: PARENT,
    });
    h.prCache[s.id] = {
      kind: "github",
      state: "open",
      number: 900,
      checks: "none",
      deployConfigured: false,
    };
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
  }

  test("spawns the successor on the predecessor's branch — no ensureBranch, epicParent stamped", async () => {
    const h = makeHarness({ ...epicOpts, epicStacksEnabled: true, stacks: true });
    seedLowerWithOpenPr(h);

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(1);
    const created = h.creates[0]!;
    expect(created.issueRef?.number).toBe(UPPER);
    expect(created.baseBranch).toBe(LOWER_BRANCH);
    // The predecessor's head is a LIVE branch; ensuring it would create it at the default
    // branch's tip if it had been deleted, silently basing the child on nothing.
    expect(h.forgeRec.ensured).toHaveLength(0);
    // Still an epic child: stamped, so it stays off the merge train and retires into the epic.
    expect(created.epicParent).toBe(PARENT);
    // The directive names the sibling branch as the PR base and the epic branch as the stack's
    // destination, so the agent doesn't "correct" the base to the one its siblings use.
    expect(created.prompt).toContain(`--base ${LOWER_BRANCH}`);
    expect(created.prompt).toContain(EPIC_BRANCH);
  });

  test("flag OFF: the successor waits for its blocker to merge (today's behaviour)", async () => {
    const h = makeHarness({ ...epicOpts, epicStacksEnabled: false, stacks: true });
    seedLowerWithOpenPr(h);

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(0);
  });

  test("forge without the stack surface never stacks, even with the flag on", async () => {
    const h = makeHarness({ ...epicOpts, epicStacksEnabled: true, stacks: false });
    seedLowerWithOpenPr(h);

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(0);
  });

  test("predecessor with no PR yet is not stack-ready", async () => {
    const h = makeHarness({ ...epicOpts, epicStacksEnabled: true, stacks: true });
    seedLowerWithOpenPr(h);
    for (const id of Object.keys(h.prCache)) delete h.prCache[id];

    await h.drain.pump(REPO);

    expect(h.creates).toHaveLength(0);
  });
});
