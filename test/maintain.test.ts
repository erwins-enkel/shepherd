import { describe, expect, it } from "bun:test";
import { SessionStore } from "../src/store";
import {
  MAINTAIN_ISSUE_LABEL,
  MaintainService,
  reportFromFailedExit,
  type MaintainDeps,
} from "../src/maintain";
import { DEAD_CODE_COMMIT_MSG, DEFAULT_COOLDOWN_MS } from "../src/maintain-core";
import { UNTRUSTED_CONTENT_DIRECTIVE } from "../src/untrusted";
import { EmptyDiffError, type GitForge, type Issue } from "../src/forge/types";
import type { DeliveryRepoRow, DeliveryStats } from "../src/types";

const SELF = "/repos/shepherd";
/** 2027-01-15T10:00 local — past any sane sweep hour, so the hour gate never masks a test. */
const NOW = new Date(2027, 0, 15, 10, 0, 0).getTime();

function repoRow(repoPath: string, value: number | null, n: number): DeliveryRepoRow {
  const nil = { value: null, n: 0 };
  const stats: DeliveryStats = {
    mergedTasks: n,
    firstPassRate: { value, n },
    unreviewed: 0,
    reworkCyclesMedian: nil,
    reworkCyclesMean: nil,
    criticErrors: 0,
    planRoundsMedian: nil,
    planReworkRate: nil,
    planDriftRate: nil,
    planDriftMajor: 0,
    timeToFirstReviewMs: nil,
    leadTimeMs: nil,
    firstPushGreenRate: nil,
  };
  return { ...stats, repoPath, repo: repoPath.split("/").pop()! };
}

interface Harness {
  svc: MaintainService;
  store: SessionStore;
  spawns: { agentName: string; worktreePath: string; cwdPrompt: string[] }[];
  created: { title: string; body: string }[];
  labelled: { issueNumber: number; label: string }[];
  removed: string[];
  stopped: string[];
  logs: string[];
  openIssues: number[];
  /** Mutated by tests to steer the fake agent's deliverable. */
  draft: { current: string | null };
  clock: { now: number };
  forgeAvailable: { current: boolean };
  labelFails: { current: boolean };
  gitSha: { current: string };
  /** Whether the fake diagnosis pane still looks alive to isSpawnAlive. */
  agentAlive: { current: boolean };
  /** Tabs herdr reports, and the ids reapTransientByLabel closed. */
  tabs: { label: string; tabId: string }[];
  closedTabs: string[];
  /** Ordered trace of teardown calls, for the close-before-remove guarantee. */
  order: string[];
  detached: { repoPath: string; branch: string; sha: string }[];
  // ── tier 3 (#2171) ──────────────────────────────────────────────────────────
  /** Branch worktrees `worktree.create` handed out. */
  createdWorktrees: { baseBranch: string; name: string; worktreePath: string; branch: string }[];
  /** Every git invocation, so a test can assert what was (and was not) committed or pushed. */
  gitCalls: { cwd: string; args: string[] }[];
  openedPrs: { head: string; base: string; title: string; body: string }[];
  openPrNumbers: number[];
  /** What `git status --porcelain` reports after the fake `fallow fix`. */
  statusOut: { current: string };
  /** Dead-code reports: `live` answers the sweep's measurement of the live checkout, `worktree`
   *  is consumed in order by the fix run's before/after measurements. */
  deadCode: { live: string | null; worktree: (string | null)[] };
  /** Which fix subprocess, if any, should reject. */
  fixFails: { install: boolean; fix: boolean; typecheck: boolean };
  /** Set to throw from openPr. */
  openPrError: { current: Error | null };
}

/** A shape-faithful `fallow dead-code --format json` payload: `fixable` auto-fixable unused
 *  exports plus `files` unused files fallow refuses to touch. */
function report(fixable: number, files = 0): string {
  return JSON.stringify({
    kind: "dead-code",
    total_issues: fixable + files,
    unused_exports: Array.from({ length: fixable }, (_, i) => ({
      path: "src/usage.ts",
      export_name: `gone${i}`,
      actions: [{ type: "remove-export", auto_fixable: true, description: "Remove" }],
    })),
    unused_files: Array.from({ length: files }, (_, i) => ({
      path: `ui/src/lib/Gone${i}.svelte`,
      actions: [{ type: "delete-file", auto_fixable: false, description: "Delete" }],
    })),
  });
}

const CLEAN_REPORT = report(0);

function harness(over: Partial<MaintainDeps> = {}): Harness {
  const store = new SessionStore(":memory:");
  const spawns: Harness["spawns"] = [];
  const created: Harness["created"] = [];
  const labelled: Harness["labelled"] = [];
  const removed: string[] = [];
  const stopped: string[] = [];
  const logs: string[] = [];
  const openIssues: number[] = [];
  const detached: Harness["detached"] = [];
  const draft = { current: null as string | null };
  const clock = { now: NOW };
  const forgeAvailable = { current: true };
  const labelFails = { current: false };
  const gitSha = { current: "deadbeefcafe1234" };
  const agentAlive = { current: true };
  const tabs: Harness["tabs"] = [];
  const closedTabs: string[] = [];
  const order: string[] = [];
  const createdWorktrees: Harness["createdWorktrees"] = [];
  const gitCalls: Harness["gitCalls"] = [];
  const openedPrs: Harness["openedPrs"] = [];
  const openPrNumbers: number[] = [];
  const statusOut = { current: " M src/usage.ts\n" };
  const deadCode = { live: CLEAN_REPORT as string | null, worktree: [] as (string | null)[] };
  const fixFails = { install: false, fix: false, typecheck: false };
  const openPrError = { current: null as Error | null };
  let nextIssue = 100;
  let nextPr = 500;

  const forge = {
    isLightweight: false,
    defaultBranch: async () => "main",
    listIssues: async () => openIssues.map((number) => ({ number }) as Issue),
    listPullRequests: async () => openPrNumbers.map((number) => ({ number })),
    openPr: async (o: { head: string; base: string; title: string; body: string }) => {
      if (openPrError.current) throw openPrError.current;
      openedPrs.push(o);
      const number = nextPr++;
      openPrNumbers.push(number);
      return { state: "open", number, url: `https://example.test/pull/${number}`, checks: "none" };
    },
    createIssue: async (o: { title: string; body: string }) => {
      created.push(o);
      const number = nextIssue++;
      openIssues.push(number);
      return { number, url: `https://example.test/issues/${number}` };
    },
    addIssueLabel: async (issueNumber: number, label: string) => {
      if (labelFails.current) throw new Error("label write forbidden");
      labelled.push({ issueNumber, label });
    },
  } as unknown as GitForge;

  const svc = new MaintainService({
    herdr: {
      start: async (agentName: string, worktreePath: string, argv: string[]) => {
        spawns.push({ agentName, worktreePath, cwdPrompt: argv });
        return { terminalId: `term_${spawns.length}` };
      },
      stop: async (id: string) => {
        stopped.push(id);
      },
      // isSpawnAlive reads these: an agent absent from list() is dead; one present and "idle" is
      // resolved by its foreground procs (shell-only = husk = dead).
      list: () =>
        spawns.map((sp, i) => ({
          cwd: sp.worktreePath,
          paneId: `pane_${i + 1}`,
          agentStatus: "idle",
        })),
      paneForegroundProcs: async () => (agentAlive.current ? ["claude"] : ["zsh"]),
      tabsAsync: async () => tabs,
      closeTab: async (tabId: string) => {
        closedTabs.push(tabId);
        order.push(`closeTab:${tabId}`);
      },
    } as unknown as MaintainDeps["herdr"],
    worktree: {
      createDetached: async (repoPath: string, branch: string, sha: string, slug?: string) => {
        detached.push({ repoPath, branch, sha });
        return {
          worktreePath: `/wt/shepherd-review-${slug}-abcdef12`,
          branch: null,
          isolated: true,
        };
      },
      remove: (p: string) => {
        removed.push(p);
        order.push(`remove:${p}`);
      },
      create: (_repoPath: string, baseBranch: string, name: string) => {
        const worktreePath = `/wt/shepherd-${name}`;
        const branch = `shepherd/${name}`;
        createdWorktrees.push({ baseBranch, name, worktreePath, branch });
        return { worktreePath, branch, isolated: true };
      },
      ensureBaseRef: async () => ({ baseRef: "deadbeefcafe" }),
      gitCommonDir: () => "/repos/shepherd/.git",
    } as unknown as MaintainDeps["worktree"],
    store,
    selfRepoPath: SELF,
    resolveForge: () => (forgeAvailable.current ? forge : null),
    repoDelivery: () => [],
    // Membrane seams: no host state, no bwrap.
    detectBackend: () => null,
    membraneEnv: () => ({
      claudeDir: "/tmp/claude",
      home: "/tmp/home",
      nodeBinReal: "/usr/bin/node",
      extraEnv: {},
      projectsDir: "/tmp/claude/projects",
    }),
    now: () => clock.now,
    git: async (cwd: string, args: string[]) => {
      gitCalls.push({ cwd, args });
      if (args[0] === "rev-parse") return `${gitSha.current}\n`;
      if (args[0] === "status") return statusOut.current;
      return "";
    },
    fixRunner: {
      install: async () => {
        if (fixFails.install) throw new Error("frozen lockfile mismatch");
      },
      // The sweep measures the LIVE checkout; the fix run measures its own worktree, twice.
      deadCode: async (cwd: string) =>
        cwd === SELF
          ? deadCode.live
          : deadCode.worktree.length > 0
            ? deadCode.worktree.shift()!
            : CLEAN_REPORT,
      fix: async () => {
        if (fixFails.fix) throw new Error("fallow fix exploded");
      },
      typecheck: async () => {
        if (fixFails.typecheck) throw new Error("TS2322");
      },
    },
    readDraft: () => draft.current,
    readUsage: async () => null,
    log: (m: string) => logs.push(m),
    ...over,
  });

  return {
    svc,
    store,
    spawns,
    created,
    labelled,
    removed,
    stopped,
    logs,
    openIssues,
    draft,
    clock,
    forgeAvailable,
    labelFails,
    gitSha,
    detached,
    agentAlive,
    tabs,
    closedTabs,
    order,
    createdWorktrees,
    gitCalls,
    openedPrs,
    openPrNumbers,
    statusOut,
    deadCode,
    fixFails,
    openPrError,
  };
}

/** A repo delivery row deep in tier-2 collapse — the simplest way to force one Tier-2 breach. */
function collapsing(): DeliveryRepoRow[] {
  return [repoRow(SELF, 0.1, 20)];
}

const GOOD_DRAFT = JSON.stringify({
  title: "First-pass rate collapsed on shepherd",
  anomaly: "Only 10% of merged tasks passed review first time.",
  evidence: "src/critic-core.ts builds an over-strict prompt.",
  subsystem: "ReviewService",
  openQuestions: ["Did the prompt change land recently?"],
});

describe("sweep gating", () => {
  it("persists a reading for every band, breached or not", async () => {
    const h = harness({ repoDelivery: () => [repoRow(SELF, 1, 20), repoRow("/repos/b", 1, 20)] });
    await h.svc.sweep();
    const keys = h.store.listMaintainReadings().map((r) => r.key);
    expect(keys).toContain("critic_error_rate");
    expect(keys).toContain("first_pass_collapse:/repos/shepherd");
    expect(keys).toContain("first_pass_collapse:/repos/b");
  });

  it("evaluates once per local day", async () => {
    const h = harness({ repoDelivery: collapsing });
    await h.svc.sweep();
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(1);
  });

  it("evaluates again the next day", async () => {
    const h = harness({ repoDelivery: collapsing, cooldownMs: 0 });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick(); // settle the first run so it stops holding the in-flight lock
    h.clock.now += 25 * 60 * 60 * 1000;
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(2);
  });

  it("waits for the sweep hour", async () => {
    const h = harness({
      repoDelivery: collapsing,
      sweepHour: 23,
      now: () => new Date(2027, 0, 15, 4, 0, 0).getTime(),
    });
    await h.svc.sweep();
    expect(h.store.listMaintainReadings()).toHaveLength(0);
  });

  it("waits for operator presence", async () => {
    const h = harness({ repoDelivery: collapsing, isPresent: () => false });
    await h.svc.sweep();
    expect(h.store.listMaintainReadings()).toHaveLength(0);
  });

  it("force skips the cadence gates but not suppression", async () => {
    const h = harness({ repoDelivery: collapsing, isPresent: () => false });
    await h.svc.sweep({ force: true });
    expect(h.spawns).toHaveLength(1);
    await h.svc.sweep({ force: true });
    expect(h.spawns).toHaveLength(1);
  });
});

describe("suppression", () => {
  it("does not spawn while a run for the band is still in flight", async () => {
    const h = harness({ repoDelivery: collapsing });
    await h.svc.sweep();
    await h.svc.sweep({ force: true });
    expect(h.spawns).toHaveLength(1);
    expect(h.logs.join("\n")).toContain("already in flight");
  });

  it("holds the cooldown in OBSERVE mode, where no issue is ever filed", async () => {
    // The regression this whole anchor exists for: act off ⇒ nothing filed ⇒ an issue-anchored
    // cooldown would have re-spawned every single sweep.
    const h = harness({ repoDelivery: collapsing, act: false });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.created).toHaveLength(0);

    for (let day = 1; day <= 13; day++) {
      h.clock.now += 24 * 60 * 60 * 1000;
      await h.svc.sweep();
    }
    expect(h.spawns).toHaveLength(1);
    expect(h.logs.join("\n")).toContain("cooling down");
  });

  it("spawns again once the cooldown expires", async () => {
    const h = harness({ repoDelivery: collapsing, act: false });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    h.clock.now += DEFAULT_COOLDOWN_MS + 1000;
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(2);
  });

  it("keeps suppressing past the cooldown while the filed issue is still open", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.created).toHaveLength(1);

    h.clock.now += DEFAULT_COOLDOWN_MS + 1000;
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(1);
    expect(h.logs.join("\n")).toContain("is still open");
  });

  it("releases once the filed issue closes and the cooldown has passed", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();

    h.openIssues.length = 0; // the operator closed it
    h.clock.now += DEFAULT_COOLDOWN_MS + 1000;
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(2);
  });

  it("anchors on a run that ERRORED, so a failing band cannot burn a spawn a day", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.clock.now += 16 * 60_000; // past the timeout, still no draft
    await h.svc.tick();
    expect(h.store.listMaintainRuns(5)[0]!.outcome).toBe("error");

    h.clock.now += 24 * 60 * 60 * 1000;
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(1);
  });
});

describe("spend cap", () => {
  it("spawns at most one diagnosis per sweep, most severe first", async () => {
    const h = harness({
      // Two independent tier-2 breaches in one sweep.
      repoDelivery: () => [repoRow("/repos/a", 0.1, 20), repoRow("/repos/b", 0.1, 20)],
    });
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(1);
    expect(h.store.listMaintainRuns(5)).toHaveLength(1);
  });

  it("never spawns for a tier-1 breach", async () => {
    const h = harness({ repoDelivery: () => [repoRow(SELF, 0.55, 20)] });
    await h.svc.sweep();
    expect(
      h.store.listMaintainReadings().find((r) => r.bandId === "first_pass_collapse")?.tier,
    ).toBe(1);
    expect(h.spawns).toHaveLength(0);
  });
});

describe("self-amplification guard", () => {
  it("a full sweep + finalize writes no signal rows", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    // Seed a signal so the band has evidence to read — the count must not GROW.
    h.store.addSignal({ repoPath: SELF, sessionId: null, kind: "stall", payload: "tail" });
    const before = h.store.countSignalsByKind(0);
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.store.countSignalsByKind(0)).toEqual(before);
  });
});

describe("act gate", () => {
  it("logs the issue it WOULD file and calls createIssue never", async () => {
    const h = harness({ repoDelivery: collapsing, act: false });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.created).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("would file issue");
    expect(h.store.listMaintainRuns(5)[0]!.outcome).toBe("skipped");
  });

  it("files a labelled issue and records its number when act is on", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.created[0]!.title).toBe("First-pass rate collapsed on shepherd");
    expect(h.created[0]!.body).toContain("## Anomaly");
    expect(h.created[0]!.body).toContain("first_pass_collapse:/repos/shepherd");
    expect(h.labelled).toEqual([{ issueNumber: 100, label: MAINTAIN_ISSUE_LABEL }]);
    const run = h.store.listMaintainRuns(5)[0]!;
    expect(run.outcome).toBe("filed");
    expect(run.issueNumber).toBe(100);
  });

  it("still files when labelling fails — the label is a filter, the issue is the deliverable", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    // A repo whose labels the token cannot write: addIssueLabel throws, createIssue does not.
    h.labelFails.current = true;
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.created).toHaveLength(1);
    expect(h.store.listMaintainRuns(5)[0]!.outcome).toBe("filed");
    expect(h.logs.join("\n")).toContain("labelling");
  });

  it("rejects an unparseable draft rather than filing an empty issue", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = "not json at all {{{";
    // While the agent is alive the file may still be mid-write, so the read waits...
    await h.svc.tick();
    expect(h.store.listMaintainRuns(5)[0]!.outcome).toBeNull();
    // ...and fails fast once the pane is gone, without waiting out the whole timeout.
    h.agentAlive.current = false;
    await h.svc.tick();
    expect(h.created).toHaveLength(0);
    expect(h.store.listMaintainRuns(5)[0]!.outcome).toBe("error");
  });
});

describe("worktree protection", () => {
  it("reports the checkout as in-flight between spawn and finalize", async () => {
    const h = harness({ repoDelivery: collapsing, act: false });
    expect(h.svc.inflightWorktrees()).toEqual([]);
    await h.svc.sweep();
    // This is what keeps sweepStaleReviewWorktrees off a live run: the path is `-review-`-shaped.
    expect(h.svc.inflightWorktrees()).toHaveLength(1);
    expect(h.svc.inflightWorktrees()[0]).toContain("-review-");
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.svc.inflightWorktrees()).toEqual([]);
  });

  it("tears down the worktree and the pane on every finalize path", async () => {
    const h = harness({ repoDelivery: collapsing, act: false });
    await h.svc.sweep();
    h.clock.now += 16 * 60_000;
    await h.svc.tick();
    expect(h.removed).toHaveLength(1);
    expect(h.stopped).toHaveLength(1);
  });
});

describe("fail-closed paths", () => {
  it("skips tier 2 when the self repo has no forge, but still records readings", async () => {
    const h = harness({ repoDelivery: collapsing });
    h.forgeAvailable.current = false;
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(0);
    expect(h.store.listMaintainReadings().length).toBeGreaterThan(0);
    expect(h.logs.join("\n")).toContain("no forge");
  });

  it("settles an orphaned run at boot and reclaims its worktree", async () => {
    const h = harness({ repoDelivery: collapsing });
    await h.svc.sweep();
    // A fresh process: the durable row survives, the in-memory ownership does not.
    const fresh = harness({ repoDelivery: collapsing });
    const inflightRow = h.store.listInflightMaintainRuns()[0]!;
    fresh.store.insertMaintainRun(inflightRow);
    await fresh.svc.reapOrphans();
    expect(fresh.store.listInflightMaintainRuns()).toHaveLength(0);
    expect(fresh.store.listMaintainRuns(5)[0]!.outcome).toBe("error");
    expect(fresh.removed).toContain(inflightRow.worktreePath);
  });
});

describe("snapshot", () => {
  it("exposes readings + recent runs for the lens", async () => {
    const h = harness({ repoDelivery: collapsing, act: false });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    const snap = h.svc.snapshot();
    expect(snap.readings.length).toBeGreaterThan(0);
    expect(snap.recentRuns).toHaveLength(1);
  });
});

describe("diagnosis evidence", () => {
  /** 25 stall signals across 5 sessions in a repo that is NOT the self repo — enough to put
   *  `incident_spike:stall` in tier 2. */
  function seedStalls(store: SessionStore, repoPath: string): void {
    for (let i = 0; i < 25; i++) {
      store.addSignal({
        repoPath,
        sessionId: `sess-${i % 5}`,
        kind: "stall",
        payload: `stalled waiting on thing-${i}`,
      });
    }
  }

  /** The transient argv's trailing positional is the prompt. */
  const promptOf = (h: Harness) => h.spawns[0]!.cwdPrompt.at(-1)!;

  /** `addSignal` stamps its own `Date.now()`, so the service must read a real clock for the
   *  in-window filter to see the seeded rows. `force` then skips the hour gate. */
  const liveHarness = () => harness({ now: () => Date.now() });

  it("reads signal evidence across EVERY repo, matching how the band is scored", async () => {
    const h = liveHarness();
    // The band is scored globally (countSignalsByKind has no repo dimension), so evidence scoped to
    // the self repo would leave this breach with nothing to explain it.
    seedStalls(h.store, "/repos/elsewhere");
    await h.svc.sweep({ force: true });
    expect(h.spawns).toHaveLength(1);
    const prompt = promptOf(h);
    expect(prompt).toContain("stalled waiting on thing-");
    // Each line names its own repo, so the agent can see whether the class is spread or local.
    expect(prompt).toContain("repo=elsewhere");
  });

  it("fences the evidence and states the untrusted-content contract once", async () => {
    const h = liveHarness();
    seedStalls(h.store, "/repos/elsewhere");
    await h.svc.sweep({ force: true });
    const prompt = promptOf(h);
    expect(prompt).toContain("⟦UNTRUSTED:signal 1:");
    expect(prompt.split(UNTRUSTED_CONTENT_DIRECTIVE).length - 1).toBe(1);
  });
});

describe("concurrency", () => {
  it("two overlapping forced sweeps spawn the band once", async () => {
    // suppressionFor awaits, so without a synchronous claim both calls would pass the in-flight
    // check and spawn the same band twice.
    const h = harness({ repoDelivery: collapsing });
    await Promise.all([h.svc.sweep({ force: true }), h.svc.sweep({ force: true })]);
    expect(h.spawns).toHaveLength(1);
    expect(h.store.listMaintainRuns(5)).toHaveLength(1);
  });
});

describe("finalize robustness", () => {
  it("settles the run row even when the filing path throws", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    // A store failure mid-finalize must not strand the row as in-flight — that would leave the
    // band un-anchored until the next boot reconcile.
    h.store.listMaintainReadings = () => {
      throw new Error("db gone");
    };
    await h.svc.tick();
    expect(h.store.listInflightMaintainRuns()).toHaveLength(0);
    expect(h.store.listMaintainRuns(5)[0]!.outcome).toBe("error");
    // Teardown still happened.
    expect(h.removed).toHaveLength(1);
    expect(h.stopped).toHaveLength(1);
  });
});

describe("worktree base resolution", () => {
  it("checks out a real sha for origin/<base>, not ensureBaseRef's ref", async () => {
    // ensureBaseRef falls back to the BRANCH NAME for a diverged or upstream-less base, and
    // createDetached hard-rejects anything that is not 7-40 hex chars.
    const h = harness({ repoDelivery: collapsing });
    await h.svc.sweep();
    expect(h.detached).toHaveLength(1);
    expect(h.detached[0]!.sha).toBe("deadbeefcafe1234");
    expect(h.detached[0]!.repoPath).toBe(SELF);
  });

  it("skips the diagnosis when origin/<base> cannot be resolved", async () => {
    const h = harness({
      repoDelivery: collapsing,
      git: async () => {
        throw new Error("no such ref");
      },
    });
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(0);
    expect(h.detached).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("cannot resolve origin/main");
    // No dangling run row for a diagnosis that never started.
    expect(h.store.listMaintainRuns(5)).toHaveLength(0);
  });
});

describe("partial-write protection", () => {
  /** A draft caught halfway through being written. jsonrepair closes it into a shape-valid object,
   *  so nothing but the `repaired` flag distinguishes it from a finished diagnosis. */
  const TRUNCATED = '{"title":"First pass collapsed on shepherd","anomaly":"Only 10% of merged ta';

  it("does not finalize a repaired draft while the agent is still alive", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = TRUNCATED;
    await h.svc.tick();
    // Nothing filed, nothing torn down — the run is still in flight, so the pane keeps writing.
    expect(h.created).toHaveLength(0);
    expect(h.removed).toHaveLength(0);
    expect(h.stopped).toHaveLength(0);
    expect(h.svc.inflightWorktrees()).toHaveLength(1);
    expect(h.store.listInflightMaintainRuns()).toHaveLength(1);
  });

  it("finalizes the COMPLETED draft once the agent finishes writing it", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = TRUNCATED;
    await h.svc.tick();
    expect(h.created).toHaveLength(0);
    // The agent finishes the file; the strict parse then finalizes on the very next tick.
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.body).toContain("Only 10% of merged tasks passed review first time.");
  });

  it("accepts a repaired draft once the pane is dead — it will never improve", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    // Unescaped inner quotes: recoverable, and the agent is gone, so waiting buys nothing.
    h.draft.current = '{"title":"Reviewer says "no verdict"","anomaly":"It errored."}';
    h.agentAlive.current = false;
    await h.svc.tick();
    expect(h.created).toHaveLength(1);
    expect(h.store.listMaintainRuns(5)[0]!.outcome).toBe("filed");
  });

  it("still finalizes a strict parse immediately, without waiting on the pane", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = GOOD_DRAFT;
    expect(h.agentAlive.current).toBe(true);
    await h.svc.tick();
    expect(h.created).toHaveLength(1);
  });

  it("times out a repaired draft the agent never completes", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = TRUNCATED;
    await h.svc.tick();
    expect(h.created).toHaveLength(0);
    // The hard timeout is the backstop when the pane stays alive forever.
    h.clock.now += 16 * 60_000;
    await h.svc.tick();
    expect(h.created).toHaveLength(1);
    expect(h.store.listInflightMaintainRuns()).toHaveLength(0);
  });

  it("releases the finalizing claim on a wait, so the next tick retries", async () => {
    const h = harness({ repoDelivery: collapsing, act: true });
    await h.svc.sweep();
    h.draft.current = TRUNCATED;
    await h.svc.tick();
    await h.svc.tick();
    h.draft.current = GOOD_DRAFT;
    await h.svc.tick();
    expect(h.created).toHaveLength(1);
  });
});

describe("diagnosis prompt window", () => {
  it("quotes the band's OWN measurement window, not a fixed 7 days", async () => {
    const h = harness({ repoDelivery: collapsing });
    await h.svc.sweep();
    // first_pass_collapse is scored over the 30d delivery range; telling the agent 7 would put a
    // wrong window into the filed issue as its reasoning.
    expect(h.spawns[0]!.cwdPrompt.at(-1)!).toContain("the last 30 days");
  });
});

describe("restart reconcile", () => {
  it("closes the orphaned diagnosis tab, not just the worktree", async () => {
    const prior = harness({ repoDelivery: collapsing });
    await prior.svc.sweep();
    const row = prior.store.listInflightMaintainRuns()[0]!;

    const fresh = harness({ repoDelivery: collapsing });
    fresh.store.insertMaintainRun(row);
    // The prior lifetime's tab survives the restart; nothing in this process owns it.
    fresh.tabs.push({ label: row.agentName, tabId: "tab-orphan" });
    fresh.tabs.push({ label: "my-feature", tabId: "tab-user" });

    await fresh.svc.reapOrphans();
    // Without this the agent keeps running in a tab nothing ever closes.
    expect(fresh.closedTabs).toEqual(["tab-orphan"]);
    expect(fresh.removed).toContain(row.worktreePath);
    expect(fresh.store.listInflightMaintainRuns()).toHaveLength(0);
  });

  it("closes the pane BEFORE deleting the worktree it is running in", async () => {
    const prior = harness({ repoDelivery: collapsing });
    await prior.svc.sweep();
    const row = prior.store.listInflightMaintainRuns()[0]!;

    const fresh = harness({ repoDelivery: collapsing });
    fresh.store.insertMaintainRun(row);
    fresh.tabs.push({ label: row.agentName, tabId: "tab-orphan" });

    await fresh.svc.reapOrphans();
    // Removing first would leave a live agent with its cwd deleted underneath it.
    expect(fresh.order).toEqual(["closeTab:tab-orphan", `remove:${row.worktreePath}`]);
  });

  it("spares an ordinary user session tab", async () => {
    const h = harness({ repoDelivery: collapsing });
    h.tabs.push({ label: "maintain-the-thing", tabId: "tab-user" });
    await h.svc.reapOrphans();
    expect(h.closedTabs).toEqual([]);
  });

  it("survives herdr being unavailable at boot", async () => {
    const prior = harness({ repoDelivery: collapsing });
    await prior.svc.sweep();
    const row = prior.store.listInflightMaintainRuns()[0]!;

    const fresh = harness({
      repoDelivery: collapsing,
      herdr: {
        tabsAsync: async () => {
          throw new Error("herdr down");
        },
      } as unknown as MaintainDeps["herdr"],
    });
    fresh.store.insertMaintainRun(row);
    // The tab reap is best-effort; the row must still settle so the band is not stuck in flight.
    await fresh.svc.reapOrphans();
    expect(fresh.store.listInflightMaintainRuns()).toHaveLength(0);
  });
});

// ── tier 3: the dead-code fix (#2171) ────────────────────────────────────────

/** Enough auto-fixable dead code in the live checkout to put `dead_code_drift` over its tier-2
 *  threshold — which, because the band declares a fix class, reads as tier 3. */
function drifting(over: Partial<MaintainDeps> = {}) {
  const h = harness({ pr: true, ...over });
  h.deadCode.live = report(4, 2);
  // The fix worktree sees the same drift, then a clean tree once fallow has fixed it.
  h.deadCode.worktree = [report(4, 2), CLEAN_REPORT];
  return h;
}

describe("tier 3 — routing", () => {
  it("promotes the band and takes the fix path, not the diagnosis path", async () => {
    const h = drifting();
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(0); // no agent — the whole point of a pre-approved class
    expect(h.created).toHaveLength(0); // and no issue
    expect(h.openedPrs).toHaveLength(1);
    const run = h.store.listMaintainRuns(10).find((r) => r.bandKey === "dead_code_drift")!;
    expect(run.tier).toBe(3);
    expect(run.outcome).toBe("opened");
    expect(run.issueNumber).toBe(500);
    expect(run.issueUrl).toBe("https://example.test/pull/500");
    // No spawn happened, so nothing may be charged to the cost ledger.
    expect(run.spawnSessionId).toBe("");
    expect(run.agentName).toBe("");
  });

  it("still diagnoses a tier-2 band that declares no fix class", async () => {
    const h = harness({ repoDelivery: collapsing });
    await h.svc.sweep();
    expect(h.spawns).toHaveLength(1);
    expect(h.openedPrs).toHaveLength(0);
  });

  it("spends the per-sweep action cap on the more severe band", async () => {
    // Tier 3 sorts above tier 2, so the fix runs and the diagnosis waits for tomorrow.
    const h = drifting({ repoDelivery: collapsing });
    await h.svc.sweep();
    expect(h.openedPrs).toHaveLength(1);
    expect(h.spawns).toHaveLength(0);
  });

  it("commits, pushes and opens the PR against the default branch", async () => {
    const h = drifting();
    await h.svc.sweep();
    const wt = h.createdWorktrees[0]!;
    const args = h.gitCalls.filter((c) => c.cwd === wt.worktreePath).map((c) => c.args);
    expect(args).toContainEqual(["add", "-A"]);
    expect(args).toContainEqual(["commit", "--no-verify", "-m", DEAD_CODE_COMMIT_MSG]);
    expect(args).toContainEqual(["push", "-u", "origin", wt.branch]);
    expect(h.openedPrs[0]!.head).toBe(wt.branch);
    expect(h.openedPrs[0]!.base).toBe("main");
    expect(h.openedPrs[0]!.title).toBe(DEAD_CODE_COMMIT_MSG);
    // The body has to tell the operator what was left behind, or the two unused FILES look fixed.
    expect(h.openedPrs[0]!.body).toContain("4 unused exports");
    expect(h.openedPrs[0]!.body).toContain("2 finding(s) are not auto-fixable");
  });

  it("cleans up the worktree and the local branch on the way out", async () => {
    const h = drifting();
    await h.svc.sweep();
    const wt = h.createdWorktrees[0]!;
    expect(h.removed).toContain(wt.worktreePath);
    expect(h.gitCalls.map((c) => c.args)).toContainEqual(["branch", "-D", wt.branch]);
  });
});

describe("tier 3 — observe mode", () => {
  it("does all the work and opens nothing when SHEPHERD_MAINTAIN_PR is off", async () => {
    const h = drifting({ pr: false });
    await h.svc.sweep();
    expect(h.openedPrs).toHaveLength(0);
    const wtArgs = h.gitCalls.map((c) => c.args.join(" "));
    expect(wtArgs.some((a) => a.startsWith("commit"))).toBe(false);
    expect(wtArgs.some((a) => a.startsWith("push"))).toBe(false);
    // The log must name the real diff, not a guess — that is why observe still installs and fixes.
    expect(h.logs.join("\n")).toContain("would open a PR removing 4 unused exports");
    const run = h.store.listMaintainRuns(10).find((r) => r.bandKey === "dead_code_drift")!;
    expect(run.outcome).toBe("skipped");
  });

  it("is not armed by SHEPHERD_MAINTAIN_ACT", async () => {
    // The whole reason tier 3 has its own flag: arming issue-filing must not arm PR-opening.
    const h = drifting({ pr: false, act: true });
    await h.svc.sweep();
    expect(h.openedPrs).toHaveLength(0);
  });
});

describe("tier 3 — fail-closed gates", () => {
  const runWith = async (h: ReturnType<typeof drifting>) => {
    await h.svc.sweep();
    return h.store.listMaintainRuns(10).find((r) => r.bandKey === "dead_code_drift")!;
  };

  it("opens nothing when the install fails", async () => {
    const h = drifting();
    h.fixFails.install = true;
    expect((await runWith(h)).outcome).toBe("error");
    expect(h.openedPrs).toHaveLength(0);
  });

  it("opens nothing when typecheck goes red on the result", async () => {
    const h = drifting();
    h.fixFails.typecheck = true;
    expect((await runWith(h)).outcome).toBe("error");
    expect(h.openedPrs).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("typecheck failed");
  });

  it("opens nothing when auto-fixable findings survive the fix", async () => {
    const h = drifting();
    h.deadCode.worktree = [report(4, 2), report(2, 2)]; // fallow only got half of them
    expect((await runWith(h)).outcome).toBe("error");
    expect(h.openedPrs).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("2 auto-fixable finding(s) survived");
  });

  it("refuses to commit a manifest change without a lockfile regen", async () => {
    // `fallow fix` also removes unused DEPENDENCIES; committing that would land the PR CI-red.
    const h = drifting();
    h.statusOut.current = " M src/usage.ts\n M package.json\n";
    expect((await runWith(h)).outcome).toBe("error");
    expect(h.openedPrs).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("package.json");
  });

  it("catches a lockfile too, in any package", async () => {
    const h = drifting();
    h.statusOut.current = " M ui/bun.lock\n";
    expect((await runWith(h)).outcome).toBe("error");
    expect(h.openedPrs).toHaveLength(0);
  });

  it("treats an unreadable post-fix measurement as a failure, never as a clean tree", async () => {
    const h = drifting();
    h.deadCode.worktree = [report(4, 2), null];
    expect((await runWith(h)).outcome).toBe("error");
    expect(h.openedPrs).toHaveLength(0);
  });

  it("stands down when the pristine base branch has nothing to fix", async () => {
    // The sweep measured the LIVE checkout, which can carry uncommitted edits. The clean checkout
    // of origin/main is what the fix is accountable to.
    const h = drifting();
    h.deadCode.worktree = [CLEAN_REPORT];
    const run = await runWith(h);
    expect(run.outcome).toBe("skipped");
    expect(h.openedPrs).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("nothing auto-fixable on the base branch");
  });

  it("stands down when fallow fix changes nothing", async () => {
    const h = drifting();
    h.statusOut.current = "";
    const run = await runWith(h);
    expect(run.outcome).toBe("skipped");
    expect(h.openedPrs).toHaveLength(0);
  });
});

describe("tier 3 — openPr failure", () => {
  it("takes the pushed branch back down rather than orphaning it on the remote", async () => {
    const h = drifting();
    h.openPrError.current = new Error("forge is down");
    await h.svc.sweep();
    const wt = h.createdWorktrees[0]!;
    expect(h.gitCalls.map((c) => c.args)).toContainEqual(["push", "origin", "--delete", wt.branch]);
    const run = h.store.listMaintainRuns(10).find((r) => r.bandKey === "dead_code_drift")!;
    expect(run.outcome).toBe("error");
  });

  it("treats an empty diff as nothing to open, not as an error", async () => {
    const h = drifting();
    h.openPrError.current = new EmptyDiffError("shepherd/maintain-fix-aaaaaaaa", "main");
    await h.svc.sweep();
    const run = h.store.listMaintainRuns(10).find((r) => r.bandKey === "dead_code_drift")!;
    expect(run.outcome).toBe("skipped");
  });
});

describe("tier 3 — suppression", () => {
  it("will not open a second PR while the first is still open", async () => {
    const h = drifting({ cooldownMs: 0 });
    await h.svc.sweep();
    expect(h.openedPrs).toHaveLength(1);
    h.deadCode.worktree = [report(4, 2), CLEAN_REPORT];
    h.clock.now += 25 * 60 * 60 * 1000;
    await h.svc.sweep();
    expect(h.openedPrs).toHaveLength(1);
    expect(h.logs.join("\n")).toContain("PR #500 is still open");
  });

  it("opens another once the first PR is gone", async () => {
    const h = drifting({ cooldownMs: 0 });
    await h.svc.sweep();
    h.openPrNumbers.length = 0; // merged or closed
    h.deadCode.worktree = [report(4, 2), CLEAN_REPORT];
    h.clock.now += 25 * 60 * 60 * 1000;
    await h.svc.sweep();
    expect(h.openedPrs).toHaveLength(2);
  });

  it("holds the band for the cooldown even when the run published nothing", async () => {
    const h = drifting({ pr: false });
    await h.svc.sweep();
    h.deadCode.worktree = [report(4, 2), CLEAN_REPORT];
    h.clock.now += 25 * 60 * 60 * 1000;
    await h.svc.sweep();
    expect(h.logs.join("\n")).toContain("cooling down");
  });
});

describe("tier 3 — restart reconcile", () => {
  it("settles an interrupted fix run and force-deletes its branch", async () => {
    const h = harness();
    h.store.insertMaintainRun({
      id: "run-1",
      bandKey: "dead_code_drift",
      bandId: "dead_code_drift",
      tier: 3,
      value: 4,
      worktreePath: "/wt/shepherd-maintain-fix-abcdef12",
      agentName: "",
      spawnSessionId: "",
      spawnedAt: NOW - 60_000,
      completedAt: null,
      outcome: null,
      issueNumber: null,
      issueUrl: null,
    });
    await h.svc.reapOrphans();
    expect(h.removed).toContain("/wt/shepherd-maintain-fix-abcdef12");
    expect(h.gitCalls.map((c) => c.args)).toContainEqual([
      "branch",
      "-D",
      "shepherd/maintain-fix-abcdef12",
    ]);
    expect(h.store.listInflightMaintainRuns()).toHaveLength(0);
  });

  it("does not go looking for a branch behind a tier-2 diagnosis worktree", async () => {
    const h = harness();
    h.store.insertMaintainRun({
      id: "run-2",
      bandKey: "critic_error_rate",
      bandId: "critic_error_rate",
      tier: 2,
      value: 0.5,
      worktreePath: "/wt/shepherd-review-sess-abcdef12",
      agentName: "__maintain__abcdef12",
      spawnSessionId: "sess",
      spawnedAt: NOW - 60_000,
      completedAt: null,
      outcome: null,
      issueNumber: null,
      issueUrl: null,
    });
    await h.svc.reapOrphans();
    expect(h.gitCalls.some((c) => c.args[0] === "branch")).toBe(false);
  });
});

describe("tier 3 — worktree protection", () => {
  it("protects the fix checkout while the run owns it, and releases it after", async () => {
    // A stale-worktree sweeper reads inflightWorktrees(); if the fix path is missing from it, a
    // long run has its checkout deleted underneath it.
    const seen: string[][] = [];
    // Referenced from the runner closures below, which only run once `drifting` has returned.
    const h: ReturnType<typeof drifting> = drifting({
      fixRunner: {
        install: async () => {
          seen.push(h.svc.inflightWorktrees());
        },
        deadCode: async (cwd: string) =>
          cwd === SELF ? h.deadCode.live : (h.deadCode.worktree.shift() ?? CLEAN_REPORT),
        fix: async () => {},
        typecheck: async () => {
          seen.push(h.svc.inflightWorktrees());
        },
      },
    });
    await h.svc.sweep();
    const wt = h.createdWorktrees[0]!.worktreePath;
    expect(seen).toHaveLength(2);
    for (const snapshot of seen) expect(snapshot).toContain(wt);
    expect(h.svc.inflightWorktrees()).toHaveLength(0);
  });
});

describe("reportFromFailedExit", () => {
  it("keeps the report from a non-zero exit — fallow exits 1 whenever it finds anything", () => {
    // Verified against fallow 2.100.0: `dead-code` exits 1 both before AND after a fix while
    // non-auto-fixable findings remain. Discarding that output would leave the band permanently
    // reading "no data" and tier 3 permanently unreachable.
    expect(reportFromFailedExit({ code: 1, stdout: '{"kind":"dead-code"}' })).toBe(
      '{"kind":"dead-code"}',
    );
  });

  it("discards output from a KILLED process — it is truncated mid-document", () => {
    // A timeout or maxBuffer overflow leaves half a JSON document that jsonrepair would happily
    // close into a shape-valid report with a smaller finding count, which the verify gate could
    // read as a clean tree.
    expect(reportFromFailedExit({ killed: true, stdout: '{"kind":"dead-code","unu' })).toBeNull();
  });

  it("is null when there is no output at all", () => {
    expect(reportFromFailedExit(new Error("bunx: command not found"))).toBeNull();
    expect(reportFromFailedExit({ code: 127, stdout: "" })).toBeNull();
  });
});
