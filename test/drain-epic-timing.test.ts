import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import type { Epic } from "../src/epic-core";
import type { GitForge, PrStatus, SubIssueRef } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { UsageLimits } from "../src/usage-limits";

const REPO = "/repo";
const PARENT = 327;
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const at = (min: number) => setSystemTime(new Date(T0 + min * MIN));

afterEach(() => setSystemTime());

const NO_USAGE: UsageLimits = {
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

function harness(subIssues: SubIssueRef[]) {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, { ...store.getRepoConfig(REPO), autoDrainEnabled: true });
  const forge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    getIssue: async () => ({
      number: PARENT,
      title: "EFI cluster",
      body: "",
      url: "",
      labels: [],
      createdAt: 0,
      assignees: [],
    }),
    listSubIssues: async () => subIssues,
    listBlockedBy: async () => [],
  } as unknown as GitForge;
  const emitted: Epic[] = [];
  const drain = new DrainService({
    store,
    service: { create: async () => Promise.reject(new Error("unused")), archive: async () => 1 },
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: () => NO_USAGE },
    repos: () => [REPO],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: (e) => emitted.push(e),
    now: () => Date.now(),
    rebaseCap: 5,
  });
  return { store, drain, emitted };
}

function childSession(store: SessionStore, issueNumber: number) {
  return store.create({
    name: "t",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "epic/327-efi-cluster",
    branch: `shepherd/t-${issueNumber}`,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "term_1",
    auto: true,
    issueNumber,
    epicParent: PARENT,
  } as never);
}

describe("buildEpic attaches the epic clock and per-child timing", () => {
  test("an integrated child keeps its end after its session is archived", async () => {
    const h = harness([sub(320, false), sub(321, false)]);
    at(0);
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
    at(5);
    const s = childSession(h.store, 320);
    at(30);
    h.store.recordEpicIntegrated(REPO, PARENT, 320);
    at(31);
    h.store.archive(s.id, "merged");
    at(60);

    const epic = (await h.drain.buildEpic(REPO, h.store.getEpicRun(REPO)!))!;
    const byNum = new Map(epic.children.map((c) => [c.number, c]));
    expect(byNum.get(320)).toMatchObject({
      state: "merged",
      startedAt: T0 + 5 * MIN,
      endedAt: T0 + 30 * MIN,
    });
    expect(byNum.get(321)).toMatchObject({ startedAt: null, endedAt: null });
    expect(epic.timing).toEqual({
      startedAt: T0,
      pausedAt: null,
      pausedMs: 0,
      landingStartedAt: null,
      landedAt: null,
      agentMs: 26 * MIN,
      idleMs: 34 * MIN,
    });
  });

  test("an epic that never ran reports no clock", async () => {
    const h = harness([sub(320, false)]);
    const epic = await h.drain.buildEpic(REPO, {
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "idle",
    });
    expect(epic!.timing).toMatchObject({ startedAt: null, pausedAt: null, idleMs: 0 });
    // No delivery facts and no measured child: nothing to forecast from.
    expect(epic!.forecast).toBeNull();
  });

  test("the completion emit carries the stopped clock and the landing start", async () => {
    const h = harness([sub(320, true), sub(321, true)]);
    at(0);
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
    at(45);
    await h.drain.pump(REPO);

    expect(h.store.getEpicRun(REPO)!.status).toBe("idle");
    const last = h.emitted.at(-1)!;
    expect(last.run.status).toBe("idle");
    expect(last.timing).toMatchObject({
      startedAt: T0,
      pausedAt: T0 + 45 * MIN,
      landingStartedAt: T0 + 45 * MIN,
    });
  });
});

describe("buildEpic attaches the forecast", () => {
  test("priced from the repo's lead time and this epic's merges; the drift anchor persists once", async () => {
    const h = harness([sub(320, false), sub(321, false), sub(322, false)]);
    // An earlier task in the repo took 60 min.
    h.store.upsertDeliveryFact({
      sessionId: "earlier",
      repoPath: REPO,
      desig: "",
      issueNumber: 900,
      createdAt: T0 - 120 * MIN,
      mergedAt: T0 - 60 * MIN,
      now: T0,
    });
    at(0);
    h.store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
    });
    const build = async () => (await h.drain.buildEpic(REPO, h.store.getEpicRun(REPO)!))!;

    at(2);
    expect((await build()).forecast).toMatchObject({ confidence: "very-low", firstFinishAt: null });
    expect(h.store.getEpicClock(REPO, PARENT)!.firstFinishAt).toBeNull();

    at(5);
    const s = childSession(h.store, 320);
    at(30);
    h.store.recordEpicIntegrated(REPO, PARENT, 320);
    at(31);
    h.store.archive(s.id, "merged"); // a 26-min delivery fact: repo median (60 + 26) / 2 = 43
    at(60);
    const first = (await build()).forecast!;
    // Step = mean(43, 43, 25); #321 and #322 through the one default slot; 20-min landing.
    expect(first).toMatchObject({
      stepMs: 37 * MIN,
      epicSamples: 1,
      repoSamples: 2,
      confidence: "low",
      finishAt: T0 + (60 + 2 * 37 + 20) * MIN,
      firstFinishAt: T0 + (60 + 2 * 37 + 20) * MIN,
    });
    expect(h.store.getEpicClock(REPO, PARENT)!.firstFinishAt).toBe(first.finishAt);

    at(70);
    const later = (await build()).forecast!;
    expect(later.finishAt).toBe(T0 + (70 + 2 * 37 + 20) * MIN);
    expect(later.firstFinishAt).toBe(first.finishAt);
    expect(h.store.getEpicClock(REPO, PARENT)!.firstFinishAt).toBe(first.finishAt);
  });
});
