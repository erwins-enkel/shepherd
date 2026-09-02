import { describe, expect, it } from "bun:test";
import { SessionStore } from "../src/store";
import { MAINTAIN_ISSUE_LABEL, MaintainService, type MaintainDeps } from "../src/maintain";
import { DEFAULT_COOLDOWN_MS } from "../src/maintain-core";
import { UNTRUSTED_CONTENT_DIRECTIVE } from "../src/untrusted";
import type { GitForge, Issue } from "../src/forge/types";
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
}

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
  let nextIssue = 100;

  const forge = {
    isLightweight: false,
    defaultBranch: async () => "main",
    listIssues: async () => openIssues.map((number) => ({ number }) as Issue),
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
    git: async () => `${gitSha.current}\n`,
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
