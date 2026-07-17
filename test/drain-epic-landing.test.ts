import { test, expect, describe } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import { EmptyDiffError, EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { GitForge, Issue, OpenPrInput, PrStatus, SubIssueRef } from "../src/forge/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";
import type { CompletedEpic } from "../src/completed-epic";
import { epicIntegrationBranch } from "../src/epic-branch";

const REPO = "/repo";
const PARENT = 327;
const PARENT_TITLE = "EFI cluster";
const INTEGRATION_BRANCH = epicIntegrationBranch(PARENT, PARENT_TITLE); // epic/327-efi-cluster

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

function sub(number: number, closed: boolean): SubIssueRef {
  return {
    number,
    title: `child ${number}`,
    url: `https://x/${number}`,
    body: "",
    closed,
    labels: [],
  };
}

/** Records the forge calls a test cares about, with per-test overrides for prStatus/openPr. */
interface ForgeSpy {
  forge: GitForge;
  openPrCalls: OpenPrInput[];
  prStatusCalls: string[];
  editPrCalls: { number: number; o: { title?: string; body?: string } }[];
  markReadyCalls: number[];
}

function fakeForge(opts: {
  subIssues: SubIssueRef[];
  prStatus?: (head: string) => Promise<PrStatus>;
  openPr?: (o: OpenPrInput) => Promise<PrStatus>;
  /** When provided, the forge exposes prChangedPaths (GitHub-like); omit to model a host
   *  without it (Gitea) — detection then degrades to off. */
  prChangedPaths?: (prNumber: number) => Promise<string[]>;
  /** Present ⇒ forge exposes editPr; the fn may throw to model a refresh failure. */
  editPr?: (prNumber: number, o: { title?: string; body?: string }) => Promise<void>;
  /** Present ⇒ forge exposes markReady; the fn may throw to model a promote failure.
   *  Omit while `hasMarkReady` is true to get a recording no-op spy. */
  markReady?: (prNumber: number) => Promise<void>;
  /** Force-omit editPr/markReady from the forge object (model a host that can't finalize). */
  noEditPr?: boolean;
  noMarkReady?: boolean;
}): ForgeSpy {
  const openPrCalls: OpenPrInput[] = [];
  const prStatusCalls: string[] = [];
  const editPrCalls: { number: number; o: { title?: string; body?: string } }[] = [];
  const markReadyCalls: number[] = [];
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (head: string) => {
      prStatusCalls.push(head);
      return (
        (await opts.prStatus?.(head)) ??
        ({ state: "none", checks: "none", deployConfigured: false } as PrStatus)
      );
    },
    openPr: async (o: OpenPrInput) => {
      openPrCalls.push(o);
      return (
        (await opts.openPr?.(o)) ??
        ({ state: "open", checks: "none", deployConfigured: false } as PrStatus)
      );
    },
    defaultBranch: async () => "main",
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    getIssue: async (n: number): Promise<Issue | null> =>
      n === PARENT
        ? {
            number: PARENT,
            title: PARENT_TITLE,
            body: "epic body",
            url: `https://x/${PARENT}`,
            labels: [],
            createdAt: 0,
            assignees: [],
          }
        : null,
    listSubIssues: async () => opts.subIssues,
    listBlockedBy: async () => [],
    ...(opts.prChangedPaths ? { prChangedPaths: opts.prChangedPaths } : {}),
    ...(opts.noEditPr
      ? {}
      : {
          editPr: async (prNumber: number, o: { title?: string; body?: string }) => {
            editPrCalls.push({ number: prNumber, o });
            await opts.editPr?.(prNumber, o);
          },
        }),
    ...(opts.noMarkReady
      ? {}
      : {
          markReady: async (prNumber: number) => {
            markReadyCalls.push(prNumber);
            await opts.markReady?.(prNumber);
          },
        }),
  };
  return { forge, openPrCalls, prStatusCalls, editPrCalls, markReadyCalls };
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  completedEmits: CompletedEpic[];
  spy: ForgeSpy;
}

function makeHarness(opts: {
  subIssues: SubIssueRef[];
  prStatus?: (head: string) => Promise<PrStatus>;
  openPr?: (o: OpenPrInput) => Promise<PrStatus>;
  prChangedPaths?: (prNumber: number) => Promise<string[]>;
  editPr?: (prNumber: number, o: { title?: string; body?: string }) => Promise<void>;
  markReady?: (prNumber: number) => Promise<void>;
  noEditPr?: boolean;
  noMarkReady?: boolean;
  preWarm?: boolean;
  /** Skip recording the running epic_run row (e.g. testing tick() in isolation). */
  noEpicRun?: boolean;
  autoDrainEnabled?: boolean;
}): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: opts.autoDrainEnabled ?? true,
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
    preWarmEpicLandingCi: opts.preWarm ?? false,
    hidden: false,
  });
  if (!opts.noEpicRun) {
    store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
  }

  const spy = fakeForge(opts);
  const completedEmits: CompletedEpic[] = [];

  const service = {
    create: async () => {
      throw new Error("not used in these tests");
    },
    archive: () => 1,
  };

  const drain = new DrainService({
    store,
    service: service as never,
    resolveForge: () => spy.forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: () => {},
    emitEpicCompleted: (e) => completedEmits.push(e),
    rebaseCap: 5,
  });

  return { store, drain, completedEmits, spy };
}

/** Seed a recorded, integration-merged epic_completed row WITHOUT driving the completion
 *  edge — for exercising ensureLandingPr directly via tick()/ensureLandingPrsForRepo. */
function seedCompleted(h: Harness, children: number[] = [320]): void {
  for (const c of children) {
    h.store.recordEpicIntegrated(REPO, PARENT, c, {
      number: 9000 + c,
      url: `https://github.com/o/r/pull/${9000 + c}`,
    });
  }
  const rollup = children.map((c) => ({
    number: c,
    title: `child ${c}`,
    url: `https://x/${c}`,
    prNumber: 9000 + c,
    prUrl: `https://github.com/o/r/pull/${9000 + c}`,
    mergedAt: 1,
    integrated: true,
  }));
  h.store.recordEpicCompleted({
    repoPath: REPO,
    parentIssueNumber: PARENT,
    parentTitle: PARENT_TITLE,
    completedAt: 1,
    childrenJson: JSON.stringify(rollup),
  });
}

describe("ensureLandingPr — open + track the epic→default landing PR (#635)", () => {
  test("opens once: pending row + prStatus none → openPr exactly once, row open with returned facts", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: async () => ({
        state: "open",
        number: 555,
        url: "https://github.com/o/r/pull/555",
        checks: "none",
        deployConfigured: false,
      }),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(1);
    expect(h.spy.openPrCalls[0]!.head).toBe(INTEGRATION_BRANCH);
    expect(h.spy.openPrCalls[0]!.base).toBe("main");

    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(555);
    expect(row.landingPrUrl).toBe("https://github.com/o/r/pull/555");

    const emit = h.completedEmits.at(-1)!;
    expect(emit.landingState).toBe("open");
    expect(emit.landingPrNumber).toBe(555);
    expect(emit.landingPrUrl).toBe("https://github.com/o/r/pull/555");
  });

  test("idempotent reuse: prStatus open (#99) → openPr NOT called, row open #99", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      prStatus: async () => ({
        state: "open",
        number: 99,
        url: "https://github.com/o/r/pull/99",
        checks: "none",
        deployConfigured: false,
      }),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0);
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(99);
  });

  test("merged PR recorded as merged (no second PR), row merged", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      prStatus: async () => ({
        state: "merged",
        number: 77,
        url: "https://github.com/o/r/pull/77",
        checks: "none",
        deployConfigured: false,
      }),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0);
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("merged");
    expect(row.landingPrNumber).toBe(77);
  });

  test("closed PR not re-opened → row none", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      prStatus: async () => ({ state: "closed", checks: "none", deployConfigured: false }),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.store.listEpicCompleted(REPO)[0]!.landingState).toBe("none");
  });

  test("no integrated children → row none, openPr NOT called", async () => {
    const h = makeHarness({ subIssues: [], noEpicRun: true });
    // record a completed row with NO epic_integrated rows
    h.store.recordEpicCompleted({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      parentTitle: PARENT_TITLE,
      completedAt: 1,
      childrenJson: JSON.stringify([]),
    });

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0); // short-circuited before the forge
    expect(h.store.listEpicCompleted(REPO)[0]!.landingState).toBe("none");
  });

  test("EmptyDiffError → row none, no error state", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: async () => {
        throw new EmptyDiffError(INTEGRATION_BRANCH, "main");
      },
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(1);
    expect(h.store.listEpicCompleted(REPO)[0]!.landingState).toBe("none");
  });

  test("generic error → error + attempts++; retries to success; parks at the cap", async () => {
    // console.warn "[drain] ensureLandingPr openPr failed…" is expected on each failure.
    let calls = 0;
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: async () => {
        calls++;
        throw new Error("network");
      },
    });
    seedCompleted(h);

    // 1st failure → error, attempts 1
    await h.drain.tick();
    let row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error");
    expect(row.landingAttempts).toBe(1);
    expect(calls).toBe(1);

    // Make the next attempt succeed → open
    h.spy.forge.openPr = async (o) => {
      h.spy.openPrCalls.push(o);
      return {
        state: "open",
        number: 600,
        url: "u",
        checks: "none",
        deployConfigured: false,
      } as PrStatus;
    };
    await h.drain.tick();
    row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(600);
  });

  test("parks at MAX_LANDING_ATTEMPTS: no further forge call once capped", async () => {
    // console.warn expected on each of the 5 failures.
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: async () => {
        throw new Error("network");
      },
    });
    seedCompleted(h);

    // Drive 5 failing ticks → attempts climbs to 5, row parked.
    for (let i = 0; i < 5; i++) await h.drain.tick();
    let row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error");
    expect(row.landingAttempts).toBe(5);
    const openCallsAtCap = h.spy.openPrCalls.length;
    const prStatusAtCap = h.spy.prStatusCalls.length;
    expect(openCallsAtCap).toBe(5);

    // 6th tick: row is at the cap → retry set excludes it → ZERO new forge calls.
    await h.drain.tick();
    expect(h.spy.openPrCalls.length).toBe(openCallsAtCap);
    expect(h.spy.prStatusCalls.length).toBe(prStatusAtCap);
    row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingAttempts).toBe(5); // unchanged
  });

  test("terminal short-circuit: a row already open → no forge calls", async () => {
    const h = makeHarness({ subIssues: [], noEpicRun: true });
    seedCompleted(h);
    h.store.setEpicLandingPr(REPO, PARENT, {
      state: "open",
      prNumber: 42,
      prUrl: "u",
      attempts: 0,
    });

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
    expect(h.store.listEpicCompleted(REPO)[0]!.landingPrNumber).toBe(42);
  });

  test("terminal short-circuit: a row already merged → no forge calls", async () => {
    const h = makeHarness({ subIssues: [], noEpicRun: true });
    seedCompleted(h);
    h.store.setEpicLandingPr(REPO, PARENT, {
      state: "merged",
      prNumber: 77,
      prUrl: "u",
      attempts: 0,
    });

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.spy.prStatusCalls).toHaveLength(0);
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("merged");
    expect(row.landingPrNumber).toBe(77);
  });

  test("completion not wedged: openPr throws at the edge → run still idle, row error", async () => {
    // console.warn expected (landing failure). Drives the real completion edge via pump().
    const h = makeHarness({
      subIssues: [sub(320, false), sub(321, true)],
      openPr: async () => {
        throw new Error("network");
      },
    });
    // 320 integration-merged (so listEpicIntegratedDetails is non-empty → openPr is attempted).
    h.store.recordEpicIntegrated(REPO, PARENT, 320, {
      number: 9001,
      url: "https://github.com/o/r/pull/9001",
    });

    await h.drain.pump(REPO);

    // The idle flip happened DESPITE the landing failure (decoupled — drain not frozen).
    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error");
    expect(row.landingAttempts).toBe(1);
    expect(h.spy.openPrCalls).toHaveLength(1);
  });

  test("completion edge opens the landing PR when openPr succeeds", async () => {
    const h = makeHarness({
      subIssues: [sub(320, false), sub(321, true)],
      openPr: async () => ({
        state: "open",
        number: 700,
        url: "https://github.com/o/r/pull/700",
        checks: "none",
        deployConfigured: false,
      }),
    });
    h.store.recordEpicIntegrated(REPO, PARENT, 320, {
      number: 9001,
      url: "https://github.com/o/r/pull/9001",
    });

    await h.drain.pump(REPO);

    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(700);
    // openPr targeted the integration branch → default.
    expect(h.spy.openPrCalls[0]!.head).toBe(INTEGRATION_BRANCH);
    expect(h.spy.openPrCalls[0]!.base).toBe("main");
    // Body closes the parent + the integrated child.
    expect(h.spy.openPrCalls[0]!.body).toContain(`Closes #${PARENT}`);
    expect(h.spy.openPrCalls[0]!.body).toContain("Closes #320");
  });

  test("prStatus itself throws → row error, attempts 1, openPr NOT called (throw caught, not escaped)", async () => {
    // console.warn expected (landing failure).
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      prStatus: async () => {
        throw new Error("forge down");
      },
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0); // never reached openPr — the throw was caught
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error");
    expect(row.landingAttempts).toBe(1);
  });

  test("in-flight guard: two concurrent ensureLandingPr → openPr called exactly once", async () => {
    // A deferred we resolve manually to hold openPr open across both invocations.
    let releaseOpenPr: (s: PrStatus) => void;
    const openPrGate = new Promise<PrStatus>((resolve) => {
      releaseOpenPr = resolve;
    });
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: () => openPrGate, // blocks until released
    });
    seedCompleted(h);

    // Invoke twice concurrently — the second must no-op (first is mid-flight).
    const ensure = (
      h.drain as unknown as {
        ensureLandingPr: (r: string, p: number, t: string) => Promise<void>;
      }
    ).ensureLandingPr.bind(h.drain);
    const first = ensure(REPO, PARENT, PARENT_TITLE);
    const second = ensure(REPO, PARENT, PARENT_TITLE);
    await second; // returns immediately (guard no-op) while first is still gated
    // Let `first` advance through prStatus → defaultBranch up to the gated openPr.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(h.spy.openPrCalls).toHaveLength(1); // exactly one openPr, no double-open
    expect(h.spy.prStatusCalls).toHaveLength(1); // and no double prStatus

    releaseOpenPr!({
      state: "open",
      number: 808,
      url: "https://github.com/o/r/pull/808",
      checks: "none",
      deployConfigured: false,
    });
    await first;

    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(808);
    expect(h.spy.openPrCalls).toHaveLength(1); // still exactly one
  });
});

describe("migration-awareness checkpoint at landing-open (#645)", () => {
  const openWith = (number: number) => async () => ({
    state: "open" as const,
    number,
    url: `https://github.com/o/r/pull/${number}`,
    checks: "none" as const,
    deployConfigured: false,
  });

  test("landing PR with migration files → paths persisted on the row + emitted", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: openWith(555),
      prChangedPaths: async () => [
        "src/foo.ts",
        "server/migrations/001_init.sql",
        "drizzle/0001.sql",
        "README.md",
      ],
    });
    seedCompleted(h);

    await h.drain.tick();

    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.migrationPaths).toEqual(["server/migrations/001_init.sql", "drizzle/0001.sql"]);
    expect(row.migrationsAckedAt).toBe(null);
    // the latest emit carries the detected paths so the chip appears live
    expect(h.completedEmits.at(-1)!.migrationPaths).toEqual([
      "server/migrations/001_init.sql",
      "drizzle/0001.sql",
    ]);
  });

  test("landing PR with NO migration files → no paths persisted", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: openWith(556),
      prChangedPaths: async () => ["src/foo.ts", "ui/src/lib/api.ts", "README.md"],
    });
    seedCompleted(h);

    await h.drain.tick();

    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.migrationPaths).toEqual([]);
  });

  test("forge WITHOUT prChangedPaths (Gitea) → no paths, landing unaffected", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: openWith(557),
      // no prChangedPaths → detection degrades to off
    });
    seedCompleted(h);

    await h.drain.tick();

    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(557);
    expect(row.migrationPaths).toEqual([]);
  });

  test("prChangedPaths THROWS → landing still succeeds (fail-safe), no paths", async () => {
    // console.warn "[drain] migration detection skipped…" is expected.
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      openPr: openWith(558),
      prChangedPaths: async () => {
        throw new Error("gh files down");
      },
    });
    seedCompleted(h);

    await h.drain.tick();

    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open"); // landing unaffected by the detection failure
    expect(row.landingPrNumber).toBe(558);
    expect(row.migrationPaths).toEqual([]);
  });

  test("completion flip is INDEPENDENT of migrations: run goes idle even with migration files", async () => {
    const h = makeHarness({
      subIssues: [sub(320, false), sub(321, true)],
      openPr: openWith(700),
      prChangedPaths: async () => ["server/migrations/001.sql"],
    });
    h.store.recordEpicIntegrated(REPO, PARENT, 320, {
      number: 9001,
      url: "https://github.com/o/r/pull/9001",
    });

    await h.drain.pump(REPO);

    // The autonomous running→idle flip happened regardless of the (unacknowledged) migrations.
    expect(h.store.getEpicRun(REPO)?.status).toBe("idle");
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.migrationPaths).toEqual(["server/migrations/001.sql"]);
    expect(row.migrationsAckedAt).toBe(null); // detected but NOT acknowledged — yet idle anyway
  });
});

describe("classifyLanding — adopt + finalize the pre-warm draft landing PR (#1664)", () => {
  /** prStatus returning an existing open (optionally draft) landing PR at #num. */
  const openExisting = (num: number, isDraft: boolean) => async () =>
    ({
      state: "open" as const,
      number: num,
      url: `https://github.com/o/r/pull/${num}`,
      isDraft,
      checks: "none" as const,
      deployConfigured: false,
    }) as PrStatus;

  test("adopt a DRAFT (flag on) → editPr with final body (no pre-warm marker) + markReady once → open", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: openExisting(42, true),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0); // adopted, never opened a 2nd PR
    expect(h.spy.editPrCalls).toHaveLength(1);
    expect(h.spy.editPrCalls[0]!.number).toBe(42);
    // Final rollup body — closes parent + child, NO provisional "Pre-warm draft" marker.
    expect(h.spy.editPrCalls[0]!.o.body).toContain(`Closes #${PARENT}`);
    expect(h.spy.editPrCalls[0]!.o.body).toContain("Closes #320");
    expect(h.spy.editPrCalls[0]!.o.body).not.toContain("Pre-warm draft");
    expect(h.spy.markReadyCalls).toEqual([42]);

    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(42);
    expect(row.landingPrUrl).toBe("https://github.com/o/r/pull/42");
  });

  test("manual-undraft (flag on, isDraft false) → editPr STILL called (union), markReady NOT → open", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: openExisting(43, false),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.editPrCalls).toHaveLength(1); // union via preWarm
    expect(h.spy.markReadyCalls).toHaveLength(0); // not a draft → never promoted
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(43);
  });

  test("flag flipped OFF mid-drain, still a DRAFT → editPr STILL called (union via isDraft) + markReady → open", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: false, // operator disabled the flag mid-drain…
      prStatus: openExisting(44, true), // …but the draft already exists
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.editPrCalls).toHaveLength(1); // union via existing.isDraft
    expect(h.spy.markReadyCalls).toEqual([44]);
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
  });

  test("flag OFF record-failed-gap (non-draft open) → NO editPr, NO markReady → open (success-criterion 4)", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: false,
      prStatus: openExisting(45, false),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.editPrCalls).toHaveLength(0);
    expect(h.spy.markReadyCalls).toHaveLength(0);
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(45);
  });

  test("markReady THROWS (draft, refresh ok) → error with PR ref PRESERVED + attempts++; retry succeeds → open (self-heal)", async () => {
    // console.warn "[drain] markReady failed…" expected on the first tick.
    let failMarkReady = true;
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: openExisting(46, true),
      markReady: async () => {
        if (failMarkReady) throw new Error("markReady boom");
      },
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.editPrCalls).toHaveLength(1); // body refreshed before the failed promote
    let row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error");
    expect(row.landingPrNumber).toBe(46); // PR ref PRESERVED, not nulled
    expect(row.landingPrUrl).toBe("https://github.com/o/r/pull/46");
    expect(row.landingAttempts).toBe(1);

    // Next tick: markReady now succeeds → self-heals to open.
    failMarkReady = false;
    await h.drain.tick();
    row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(46);
    expect(h.spy.markReadyCalls).toEqual([46, 46]);
  });

  test("editPr THROWS (draft) → markReady NOT called (coupled) → error with PR ref preserved", async () => {
    // console.warn "[drain] landing body refresh failed…" expected.
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: openExisting(47, true),
      editPr: async () => {
        throw new Error("editPr boom");
      },
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.markReadyCalls).toHaveLength(0); // coupled: never un-draft onto a stale body
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error");
    expect(row.landingPrNumber).toBe(47);
    expect(row.landingPrUrl).toBe("https://github.com/o/r/pull/47");
    expect(row.landingAttempts).toBe(1);
  });

  test("persistent still-draft failure parks at the attempts cap (visible error, not healthy open)", async () => {
    // console.warn expected on each of the 5 failing ticks.
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: openExisting(48, true),
      markReady: async () => {
        throw new Error("markReady down");
      },
    });
    seedCompleted(h);

    for (let i = 0; i < 5; i++) await h.drain.tick();
    let row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error");
    expect(row.landingAttempts).toBe(5);
    expect(row.landingPrNumber).toBe(48); // still carries the PR ref while parked

    // 6th tick: at the cap → no further forge touch.
    const editsAtCap = h.spy.editPrCalls.length;
    await h.drain.tick();
    expect(h.spy.editPrCalls.length).toBe(editsAtCap);
    row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingAttempts).toBe(5);
  });

  test("closed && isDraft → opens a fresh NON-draft landing PR → open", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: async () =>
        ({
          state: "closed",
          number: 49,
          url: "https://github.com/o/r/pull/49",
          isDraft: true,
          checks: "none",
          deployConfigured: false,
        }) as PrStatus,
      openPr: async () => ({
        state: "open",
        number: 500,
        url: "https://github.com/o/r/pull/500",
        checks: "none",
        deployConfigured: false,
      }),
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(1);
    expect(h.spy.openPrCalls[0]!.draft).toBeFalsy(); // fresh NON-draft landing PR
    expect(h.spy.editPrCalls).toHaveLength(0); // re-open path, not adoption
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("open");
    expect(row.landingPrNumber).toBe(500);
  });

  test("closed && NOT draft → terminal none, openPr NOT called", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: async () =>
        ({
          state: "closed",
          number: 51,
          url: "https://github.com/o/r/pull/51",
          isDraft: false,
          checks: "none",
          deployConfigured: false,
        }) as PrStatus,
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.openPrCalls).toHaveLength(0);
    expect(h.store.listEpicCompleted(REPO)[0]!.landingState).toBe("none");
  });

  test("draft but forge has NO markReady → cannot finalize → error with PR ref preserved", async () => {
    const h = makeHarness({
      subIssues: [],
      noEpicRun: true,
      preWarm: true,
      prStatus: openExisting(52, true),
      noMarkReady: true, // host can't promote a draft
    });
    seedCompleted(h);

    await h.drain.tick();

    expect(h.spy.editPrCalls).toHaveLength(1); // body still refreshed
    const row = h.store.listEpicCompleted(REPO)[0]!;
    expect(row.landingState).toBe("error"); // still a draft, never readied → visible error
    expect(row.landingPrNumber).toBe(52);
  });
});
