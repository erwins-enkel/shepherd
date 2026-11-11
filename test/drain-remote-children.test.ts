import { test, expect, describe, spyOn } from "bun:test";
import { DrainService, type DrainMachinePort, type DrainStatus } from "../src/drain";
import { ACTIVE_LABEL } from "../src/drain-core";
import type { RemoteWork } from "../src/drain-remote";
import type { Epic } from "../src/epic-core";
import { SessionStore } from "../src/store";
import type {
  GitForge,
  Issue,
  IssuePullRequestReference,
  PrStatus,
  SubIssueRef,
} from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import { GithubForge } from "../src/forge/github";
import { graphqlSyntaxCheckedRunner, referenceTimelinePage } from "./helpers/github-graphql-runner";
import type { StandardCreateInput, Session, ReviewDecision } from "../src/types";
import type { UsageLimits } from "../src/usage-limits";
import type { SessionHost } from "../src/remote-instances/sessions";
import type { BranchBehindResult, LandingRebaseResult } from "../src/landing-rebase";
import type { Capability } from "../src/remote-instances/capabilities";
import type { Placement, PlacementDecision } from "../src/remote-instances/placement";
import type { RemoteOutcome } from "../src/remote-instances/dispatch";

// Epic children (and backlog issues) that belong on another machine (src/drain-placement.ts):
// `requires-macos` sends them to the Mac, the epic's `machine` names one, and what cannot go there
// now holds the drain instead of starting here.

const REPO = "/repo";
const PARENT = 3739;
const SELF = "b1111111-1111-4111-8111-111111111111";
const MAC = "a2222222-2222-4222-8222-222222222222";
const macHost = { instanceId: MAC, name: "macbook", platform: "macos" };
const selfHost = { instanceId: SELF, name: "moes-tavern", platform: "linux" };

const NO_USAGE: UsageLimits = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

function sub(number: number, labels: string[] = []): SubIssueRef {
  return {
    number,
    title: `child ${number}`,
    url: `https://x/${number}`,
    body: "",
    closed: false,
    labels,
  };
}

function placed(target: Placement["target"], requirements: Capability[] = ["xcode"]): Placement {
  return {
    mode: "auto",
    target,
    requirements,
    basis: "requirements",
    preferred: null,
    by: { instanceId: SELF, name: "moes-tavern" },
    decidedAt: 1,
  };
}

interface FakePort extends DrainMachinePort {
  decided: { requirements: Capability[]; override: string | null }[];
  submitted: { issue: number; body: Record<string, unknown>; placement: Placement }[];
  remote: Map<number, RemoteWork>;
  /** Issues whose newest drain dispatch started on another machine, mirrored or not. */
  dispatched: Map<number, SessionHost>;
}

function fakePort(opts: {
  active?: boolean;
  decision?: (requirements: Capability[], override: string | null) => PlacementDecision;
  outcome?: RemoteOutcome;
}): FakePort {
  const port: FakePort = {
    decided: [],
    submitted: [],
    remote: new Map(),
    dispatched: new Map(),
    active: () => opts.active ?? true,
    selfId: () => SELF,
    decide: async (_repo, requirements, override) => {
      port.decided.push({ requirements, override });
      return opts.decision
        ? opts.decision(requirements, override)
        : { ok: true, placement: placed(override === SELF ? selfHost : macHost, requirements) };
    },
    submit: async ({ issue, body, placement }) => {
      port.submitted.push({ issue, body, placement });
      const outcome = opts.outcome ?? {
        kind: "started",
        session: { id: `mac-${issue}`, host: macHost },
      };
      if (outcome.kind === "started") {
        port.remote.set(issue, {
          host: macHost,
          sessionId: `mac-${issue}`,
          desig: "TASK-1",
          prNumber: null,
        });
      }
      return outcome;
    },
    work: () => port.remote,
    dispatchedElsewhere: () => port.dispatched,
  };
  return port;
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  creates: StandardCreateInput[];
  statuses: DrainStatus[];
  /** Every `epic:update` the drain emitted, oldest first. */
  epics: Epic[];
  added: number[];
  removed: number[];
}

function makeHarness(opts: {
  children: SubIssueRef[];
  parentLabels?: string[];
  port?: DrainMachinePort;
  maxAuto?: number;
  landing?: "integration" | "incremental";
  machine?: string;
  epic?: boolean;
  backlog?: Issue[];
  issuePrs?: Record<number, IssuePullRequestReference[]>;
  /** Replaces the `issuePrs` lookup (e.g. a real forge read, or an unknown `null`). */
  references?: NonNullable<GitForge["issuePullRequestReferences"]>;
  prBase?: Record<number, string>;
  /** The repo's open PRs, as the open-PR snapshot reads them (absent: no snapshot). */
  openPrs?: () => PrStatus[];
  merge?: GitForge["merge"];
  critic?: boolean;
  blockedBy?: Record<number, number[]>;
  now?: () => number;
  branchBehindDefault?: () => Promise<BranchBehindResult>;
  rebaseLandingBranch?: () => Promise<LandingRebaseResult>;
}): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: opts.critic ?? false,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: opts.maxAuto ?? 2,
    autoLabel: "shepherd:auto",
    priorityLabels: [],
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    defaultExecutionEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    mergeWithoutCi: false,
    epicStacksEnabled: false,
    sharedBrowserEnabled: false,
    claudeAiConnectorsEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
    pinned: false,
  });
  if (opts.epic !== false) {
    store.setEpicRun({
      repoPath: REPO,
      parentIssueNumber: PARENT,
      mode: "auto",
      status: "running",
      landing: opts.landing ?? "incremental",
      ...(opts.machine && { machine: opts.machine }),
    });
  }
  const labels = new Map<number, string[]>(opts.children.map((c) => [c.number, [...c.labels]]));
  const added: number[] = [];
  const removed: number[] = [];
  const creates: StandardCreateInput[] = [];
  const statuses: DrainStatus[] = [];
  const epics: Epic[] = [];
  const parent: Issue = {
    number: PARENT,
    title: "Epic: iOS parity",
    body: "",
    url: `https://x/${PARENT}`,
    labels: opts.parentLabels ?? [],
    createdAt: 0,
    assignees: [],
  };
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => opts.backlog ?? [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: opts.merge ?? (async () => {}),
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    ensureBranch: async () => {},
    addIssueLabel: async (n: number, label: string) => {
      if (label !== ACTIVE_LABEL) return;
      added.push(n);
      labels.set(n, [...(labels.get(n) ?? []), label]);
    },
    removeIssueLabel: async (n: number, label: string) => {
      if (label !== ACTIVE_LABEL) return;
      removed.push(n);
      labels.set(
        n,
        (labels.get(n) ?? []).filter((l) => l !== label),
      );
    },
    getIssue: async (n: number) => {
      if (n === PARENT) return parent;
      const backlog = opts.backlog?.find((i) => i.number === n);
      if (backlog) return { ...backlog, labels: labels.get(n) ?? backlog.labels };
      const c = opts.children.find((x) => x.number === n);
      return c
        ? {
            number: n,
            title: c.title,
            body: c.body,
            url: c.url,
            labels: labels.get(n) ?? [],
            createdAt: 0,
            assignees: [],
          }
        : null;
    },
    listSubIssues: async () =>
      opts.children.map((c) => ({ ...c, labels: labels.get(c.number) ?? [] })),
    listBlockedBy: async (n: number) => opts.blockedBy?.[n] ?? [],
    ...((opts.issuePrs || opts.references) && {
      issuePullRequestReferences: opts.references ?? (async (n: number) => opts.issuePrs![n] ?? []),
      prReviewMeta: async (pr: number) => ({ baseRefName: opts.prBase?.[pr] ?? "main" }) as never,
    }),
  };
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
  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: () => NO_USAGE },
    repos: () => [REPO],
    emitStatus: (s) => statuses.push(s),
    emitArchived: () => {},
    dropPrCache: () => {},
    emitEpic: (e) => epics.push(e),
    rebaseCap: 5,
    ...(opts.port && { machines: opts.port }),
    ...(opts.openPrs && {
      openPrSnapshot: {
        peekCurrent: () => null,
        get: async () => ({
          prs: [],
          statuses: new Map(opts.openPrs!().map((pr) => [`head-${pr.number}`, pr])),
          capped: false,
        }),
      },
    }),
    ...(opts.now && { now: opts.now }),
    // No git here: an integration epic's base probe answers "current" unless a test says otherwise.
    branchBehindDefault:
      opts.branchBehindDefault ?? (async () => ({ kind: "current", defaultSha: "main-sha" })),
    ...(opts.rebaseLandingBranch && { rebaseLandingBranch: opts.rebaseLandingBranch }),
  });
  return { store, drain, creates, statuses, epics, added, removed };
}

const lastStatus = (h: Harness) => h.statuses.at(-1)!;

describe("an epic child that needs a Mac", () => {
  test("goes to the Mac with its issue, base and prompt; nothing starts here", async () => {
    const port = fakePort({});
    const h = makeHarness({ children: [sub(3731, ["requires-macos", "ios-app"])], port });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(0);
    expect(port.decided).toEqual([{ requirements: ["xcode"], override: null }]);
    expect(port.submitted).toHaveLength(1);
    const { issue, body, placement } = port.submitted[0]!;
    expect(issue).toBe(3731);
    expect(placement.target.instanceId).toBe(MAC);
    expect(body).toMatchObject({
      repoPath: REPO,
      baseBranch: "main",
      issueRef: { number: 3731, url: "https://x/3731", title: "child 3731" },
      requirements: ["xcode"],
      images: [],
      placement,
    });
    expect(String(body.prompt)).toContain("3731");
    expect(body.agentProvider).toBeUndefined();
    expect(h.added).toEqual([3731]);
  });

  test("a label on the epic applies to every child", async () => {
    const port = fakePort({});
    const h = makeHarness({ children: [sub(3732)], parentLabels: ["requires-macos"], port });
    await h.drain.pump(REPO);
    expect(port.submitted.map((s) => s.issue)).toEqual([3732]);
    expect(h.creates).toHaveLength(0);
  });

  test("the epic's own CLI settings ride along", async () => {
    const port = fakePort({});
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])], port });
    h.store.setEpicRun({
      ...h.store.getEpicRun(REPO)!,
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    await h.drain.pump(REPO);
    expect(port.submitted[0]!.body).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
  });

  test("an integration epic sends it based on the integration branch", async () => {
    const port = fakePort({});
    const h = makeHarness({
      children: [sub(3731, ["requires-macos"])],
      port,
      landing: "integration",
    });
    await h.drain.pump(REPO);
    expect(String(port.submitted[0]!.body.baseBranch)).toMatch(/^epic\/3739-/);
  });

  test("the Mac out of reach: holds, claims nothing, sends nothing", async () => {
    const port = fakePort({
      decision: () => ({
        ok: true,
        placement: placed(macHost),
        wait: { status: "unreachable", alternatives: [] },
      }),
    });
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])], port });
    await h.drain.pump(REPO);
    expect(port.submitted).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
    expect(h.added).toEqual([]);
    expect(lastStatus(h)).toMatchObject({ reason: "machine_offline", detail: "macbook" });
  });

  test("no machine has Xcode: holds with the requirement", async () => {
    const port = fakePort({
      decision: () => ({
        ok: false,
        refusal: { code: "no_suitable_machine", missing: ["xcode"], together: false },
      }),
    });
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])], port });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(0);
    expect(lastStatus(h)).toMatchObject({ reason: "no_suitable_machine", detail: "xcode" });
  });

  test("a refusal there releases the claim and backs off", async () => {
    const port = fakePort({
      outcome: {
        kind: "rejected",
        host: macHost,
        reason: "model not available",
        remoteStatus: 400,
        remoteCode: null,
      },
    });
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])], port });
    await h.drain.pump(REPO);
    expect(h.added).toEqual([3731]);
    expect(h.removed).toEqual([3731]);
    await h.drain.pump(REPO);
    expect(port.submitted).toHaveLength(1);
    expect(h.creates).toHaveLength(0);
  });
});

describe("children on another machine hold a slot until their PR opens", () => {
  test("with one slot, the next child waits while the first runs on the Mac", async () => {
    const port = fakePort({});
    const h = makeHarness({
      children: [sub(3731, ["requires-macos"]), sub(3732, ["requires-macos"])],
      port,
      maxAuto: 1,
    });
    await h.drain.pump(REPO);
    expect(port.submitted.map((s) => s.issue)).toEqual([3731]);
    const status = lastStatus(h);
    expect(status.reason).toBe("cap");
    expect(status.runSummary?.slots.used).toBe(1);
    expect(status.runSummary?.slots.holders[0]).toMatchObject({
      issueNumber: 3731,
      sessionId: "mac-3731",
      host: macHost,
    });
  });

  test("once its PR is open there, the slot is free again", async () => {
    const port = fakePort({});
    port.remote.set(3731, { host: macHost, sessionId: "mac-3731", desig: "TASK-1", prNumber: 77 });
    const h = makeHarness({
      children: [sub(3731, ["requires-macos", ACTIVE_LABEL]), sub(3732, ["requires-macos"])],
      port,
      maxAuto: 1,
    });
    await h.drain.pump(REPO);
    expect(port.submitted.map((s) => s.issue)).toEqual([3732]);
  });

  test("the confirmed start re-emits the epic with the session there", async () => {
    // Sent, start not yet confirmed: no session id there yet.
    const port = fakePort({});
    port.remote.set(3731, { host: macHost, sessionId: null, desig: null, prNumber: null });
    const h = makeHarness({ children: [sub(3731, ["requires-macos", ACTIVE_LABEL])], port });
    await h.drain.pump(REPO);
    const sentTo = (e: Epic | undefined) =>
      e?.children.find((c) => c.number === 3731)?.elsewhere ?? null;
    expect(sentTo(h.epics.at(-1))).toMatchObject({ host: macHost, sessionId: null });
    const before = h.epics.length;

    // The machine confirms the start: same child state ("running"), but the UI needs the id
    // to place the mirrored session in its epic group.
    port.remote.set(3731, {
      host: macHost,
      sessionId: "mac-3731",
      desig: "TASK-1",
      prNumber: null,
    });
    await h.drain.pump(REPO);
    expect(h.epics.length).toBe(before + 1);
    expect(sentTo(h.epics.at(-1))).toMatchObject({ host: macHost, sessionId: "mac-3731" });

    // Nothing changed: still de-duplicated.
    await h.drain.pump(REPO);
    expect(h.epics.length).toBe(before + 1);
  });

  test("a child sent there is never sent twice, even before its claim is visible", async () => {
    const port = fakePort({});
    port.remote.set(3731, { host: macHost, sessionId: null, desig: null, prNumber: null });
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])], port });
    await h.drain.pump(REPO);
    expect(port.submitted).toHaveLength(0);
  });
});

describe("unchanged without a reason to leave this machine", () => {
  test("no requirements and no named machine: runs here, nothing asked", async () => {
    const port = fakePort({});
    const h = makeHarness({ children: [sub(3731, ["ios-app"])], port });
    await h.drain.pump(REPO);
    expect(h.creates.map((c) => c.issueRef?.number)).toEqual([3731]);
    expect(port.decided).toEqual([]);
  });

  test("no other machine registered: requires-macos runs here as before", async () => {
    const port = fakePort({ active: false });
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])], port });
    await h.drain.pump(REPO);
    expect(h.creates.map((c) => c.issueRef?.number)).toEqual([3731]);
    expect(port.decided).toEqual([]);
  });

  test("without the port at all: runs here", async () => {
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])] });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
  });
});

describe("the epic names a machine", () => {
  test("another machine: every child goes there, labels or not", async () => {
    const port = fakePort({});
    const h = makeHarness({ children: [sub(3731)], port, machine: MAC });
    await h.drain.pump(REPO);
    expect(port.decided).toEqual([{ requirements: [], override: MAC }]);
    expect(port.submitted.map((s) => s.issue)).toEqual([3731]);
    expect(h.creates).toHaveLength(0);
  });

  test("this machine: runs here without asking", async () => {
    const port = fakePort({});
    const h = makeHarness({ children: [sub(3731)], port, machine: SELF });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(1);
    expect(port.decided).toEqual([]);
  });

  test("this machine for a child that needs a Mac: holds as unfit", async () => {
    const port = fakePort({
      decision: () => ({
        ok: false,
        refusal: {
          code: "missing_capabilities",
          host: selfHost,
          missing: [{ capability: "xcode", reason: "other_platform" }],
        },
      }),
    });
    const h = makeHarness({ children: [sub(3731, ["requires-macos"])], port, machine: SELF });
    await h.drain.pump(REPO);
    expect(h.creates).toHaveLength(0);
    expect(lastStatus(h)).toMatchObject({ reason: "machine_unfit", detail: "moes-tavern" });
  });
});

describe("label mode", () => {
  test("a backlog issue labelled requires-macos goes to the Mac", async () => {
    const port = fakePort({});
    const backlog: Issue = {
      number: 50,
      title: "xcode thing",
      body: "",
      url: "https://x/50",
      labels: ["shepherd:auto", "requires-macos"],
      createdAt: 0,
      assignees: [],
    };
    const h = makeHarness({ children: [], port, epic: false, backlog: [backlog] });
    await h.drain.pump(REPO);
    expect(port.submitted.map((s) => s.issue)).toEqual([50]);
    expect(h.creates).toHaveLength(0);
  });
});

describe("an integration epic recognizes a child merged from another machine", () => {
  const PINNED = "epic/3739-ios-parity";
  const children = [sub(3731, ["requires-macos", ACTIVE_LABEL]), sub(3732, [ACTIVE_LABEL])];
  const run = async (base: string) => {
    const h = makeHarness({
      children,
      port: fakePort({ active: false }),
      landing: "integration",
      issuePrs: { 3731: [{ number: 91, url: "https://x/pull/91", state: "merged" }] },
      prBase: { 91: base },
    });
    h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, PINNED);
    await h.drain.tick();
    return h;
  };

  test("a merged PR into the pinned epic branch integrates the child", async () => {
    const h = await run(PINNED);
    expect(h.store.isEpicIntegratedChild(REPO, 3731)).toBe(true);
    expect(h.store.isEpicIntegratedChild(REPO, 3732)).toBe(false);
  });

  test("a merged PR into another branch does not", async () => {
    const h = await run("main");
    expect(h.store.isEpicIntegratedChild(REPO, 3731)).toBe(false);
  });

  test("found through the GitHub forge's own reference query, as GitHub parses it", async () => {
    const github = new GithubForge(
      "o/r",
      {} as never,
      graphqlSyntaxCheckedRunner((args) =>
        referenceTimelinePage(
          args.includes("number=3731")
            ? [{ number: 91, url: "https://x/pull/91", state: "merged" }]
            : [],
        ),
      ),
    );
    const h = makeHarness({
      children,
      port: fakePort({ active: false }),
      landing: "integration",
      references: (n) => github.issuePullRequestReferences(n),
      prBase: { 91: PINNED },
    });
    h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, PINNED);
    await h.drain.tick();
    expect(h.store.isEpicIntegratedChild(REPO, 3731)).toBe(true);
    expect(h.store.isEpicIntegratedChild(REPO, 3732)).toBe(false);
  });

  test("an unknown reference read is not taken for no PRs: it warns and records nothing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = makeHarness({
        children,
        port: fakePort({ active: false }),
        landing: "integration",
        references: async () => null,
        prBase: { 91: PINNED },
      });
      h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, PINNED);
      await h.drain.tick();
      expect(h.store.isEpicIntegratedChild(REPO, 3731)).toBe(false);
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned.some((m) => m.includes("#3731") && m.includes("unknown"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("an integration epic lands a child it sent to another machine (#3957)", () => {
  // Epic #3016's stall: the drain sent #3013 to the MacBook (TASK-145), its PR #3955 went green
  // into the epic branch, and nobody merged it — the Mac keeps epic children off its merge train
  // and does not lead the epic. The leading drain now retires it like a child of its own.
  const PINNED = "epic/3739-ios-parity";
  const CHILD = 3731;
  const NEXT = 3732;
  const PR = 3955;
  const HEAD = "8e1f408";
  const children = [sub(CHILD, ["requires-macos", ACTIVE_LABEL]), sub(NEXT, ["requires-macos"])];

  const openPr = (o: Partial<PrStatus> = {}): PrStatus => ({
    state: "open",
    number: PR,
    url: `https://x/pull/${PR}`,
    checks: "success",
    mergeable: true,
    headSha: HEAD,
    baseRefName: PINNED,
    isDraft: false,
    deployConfigured: false,
    ...o,
  });

  type Merge = { pr: number; o: Parameters<GitForge["merge"]>[1] };

  function remote(o: {
    pr?: () => PrStatus[];
    critic?: boolean;
    verdict?: { decision: ReviewDecision | ""; headSha: string };
    /** live: the mirror shows the session and its PR; noPr: the session but not its PR; missing:
     *  not the session either (only the dispatch row says it started there); manual: started there
     *  by hand, never dispatched by this drain. */
    mirror?: "live" | "noPr" | "missing" | "manual";
    issuePrs?: Record<number, IssuePullRequestReference[]>;
    references?: NonNullable<GitForge["issuePullRequestReferences"]>;
    merge?: (pr: number) => Promise<void>;
    extra?: Partial<Parameters<typeof makeHarness>[0]>;
  }) {
    const port = fakePort({});
    const mirror = o.mirror ?? "live";
    if (mirror === "live" || mirror === "noPr") {
      port.remote.set(CHILD, {
        host: macHost,
        sessionId: "mac-3731",
        desig: "TASK-145",
        prNumber: mirror === "live" ? PR : null,
      });
    }
    if (mirror !== "manual") port.dispatched.set(CHILD, macHost);
    const merges: Merge[] = [];
    const h = makeHarness({
      children,
      port,
      landing: "integration",
      blockedBy: { [NEXT]: [CHILD] },
      critic: o.critic ?? false,
      openPrs: o.pr ?? (() => [openPr()]),
      issuePrs: o.issuePrs ?? { [CHILD]: [{ number: PR, url: "u", state: "open" }] },
      ...(o.references && { references: o.references }),
      merge: async (pr, opts) => {
        await o.merge?.(pr);
        merges.push({ pr, o: opts });
      },
      ...o.extra,
    });
    h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, PINNED);
    if (o.verdict) {
      h.store.putPrReview({
        repoPath: REPO,
        prNumber: PR,
        headSha: o.verdict.headSha,
        patchId: "p",
        decision: o.verdict.decision,
        reviewedPatchIds: [],
        updatedAt: 1,
      });
    }
    return { h, port, merges };
  }

  const childState = (h: Harness, n: number) =>
    h.epics.at(-1)?.children.find((c) => c.number === n)?.state;

  test("a green, mergeable PR with the critic's clean verdict for its head is squash-merged", async () => {
    const { h, merges } = remote({
      critic: true,
      verdict: { decision: "commented", headSha: HEAD },
    });
    await h.drain.tick();
    expect(merges).toEqual([
      { pr: PR, o: { method: "squash", deleteBranch: true, expectedHeadSha: HEAD } },
    ]);
    expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(true);
    expect(h.store.listEpicIntegratedDetails(REPO, PARENT)).toEqual([
      expect.objectContaining({ childNumber: CHILD, prNumber: PR, mergedBase: PINNED }),
    ]);
    expect(childState(h, CHILD)).toBe("merged");
  });

  test("critic on without a verdict for the head: waits and asks this host's critic", async () => {
    for (const verdict of [undefined, { decision: "commented" as const, headSha: "older" }]) {
      const { h, merges } = remote({ critic: true, ...(verdict && { verdict }) });
      await h.drain.tick();
      expect(merges).toEqual([]);
      expect([...h.drain.remoteChildReviewPrs(REPO)]).toEqual([PR]);
      expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(false);
    }
  });

  test("critic off: a green, mergeable PR lands without a verdict and asks for none", async () => {
    const { h, merges } = remote({});
    await h.drain.tick();
    expect(merges.map((m) => m.pr)).toEqual([PR]);
    expect(h.drain.remoteChildReviewPrs(REPO).size).toBe(0);
  });

  test("the critic requests changes for the head: no merge, the hold names the session there", async () => {
    const { h, merges } = remote({
      critic: true,
      verdict: { decision: "changes_requested", headSha: HEAD },
    });
    await h.drain.tick();
    expect(merges).toEqual([]);
    expect(lastStatus(h)).toMatchObject({
      reason: "changes_requested",
      detail: "macbook · TASK-145",
    });
    // Asking again for the same head would only repeat the verdict.
    expect(h.drain.remoteChildReviewPrs(REPO).size).toBe(0);
  });

  test("a verdict for an older head is no trouble", async () => {
    const { h } = remote({
      critic: true,
      verdict: { decision: "changes_requested", headSha: "older" },
    });
    await h.drain.tick();
    expect(lastStatus(h).reason).not.toBe("changes_requested");
  });

  test("what is not landable is left alone", async () => {
    const variants: Partial<PrStatus>[] = [
      { baseRefName: "main" },
      { isDraft: true },
      { checks: "pending" },
      { checks: "failure" },
      { mergeable: null },
      { mergeable: false },
      { headSha: undefined },
    ];
    for (const v of variants) {
      const { h, merges } = remote({ pr: () => [openPr(v)] });
      await h.drain.tick();
      expect({ v, merges }).toEqual({ v, merges: [] });
      expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(false);
    }
  });

  test("done there is no merge: the child stays in review until its PR lands", async () => {
    const { h, merges } = remote({ pr: () => [openPr({ checks: "pending" })] });
    await h.drain.tick();
    expect(merges).toEqual([]);
    expect(childState(h, CHILD)).toBe("in-review");
    expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(false);
  });

  test("the mirror lost the PR or the session: the issue's references name the PR", async () => {
    for (const mirror of ["noPr", "missing"] as const) {
      const { h, merges } = remote({ mirror, pr: () => [openPr({ headSha: "forge-head" })] });
      await h.drain.tick();
      // The forge's head, never a mirror's stale one, is what the merge is bound to.
      expect({ mirror, merges }).toEqual({
        mirror,
        merges: [
          { pr: PR, o: { method: "squash", deleteBranch: true, expectedHeadSha: "forge-head" } },
        ],
      });
      expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(true);
    }
  });

  test("without the mirror an unknown or ambiguous reference read merges nothing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unknown = remote({ mirror: "missing", references: async () => null });
      await unknown.h.drain.tick();
      expect(unknown.merges).toEqual([]);
      const two = remote({
        mirror: "missing",
        issuePrs: {
          [CHILD]: [
            { number: PR, url: "u", state: "open" },
            { number: PR + 1, url: "u", state: "open" },
          ],
        },
        pr: () => [openPr(), openPr({ number: PR + 1 })],
      });
      await two.h.drain.tick();
      expect(two.merges).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a child started there by hand is never merged here", async () => {
    const { h, merges } = remote({ mirror: "manual" });
    await h.drain.tick();
    expect(merges).toEqual([]);
    expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(false);
  });

  test("a failed merge records nothing; the next tick tries again", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let fail = true;
      const { h, merges } = remote({
        merge: async () => {
          if (fail) throw new Error("head moved");
        },
      });
      await h.drain.tick();
      expect(merges).toEqual([]);
      expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(false);
      fail = false;
      await h.drain.tick();
      expect(merges.map((m) => m.pr)).toEqual([PR]);
      expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("once it lands, the stale epic branch is rebased and the next child goes to the Mac", async () => {
    const clock = { t: 10 * 60 * 60_000 };
    const rebased: string[] = [];
    let green = false;
    const { h, port, merges } = remote({
      pr: () => [openPr({ checks: green ? "success" : "pending" })],
      extra: {
        now: () => clock.t,
        branchBehindDefault: async () => ({ kind: "behind", defaultSha: "main-sha" }),
        rebaseLandingBranch: async () => {
          rebased.push("x");
          return { kind: "rebased", headSha: "new" } as LandingRebaseResult;
        },
      },
    });
    h.store.setEpicBaseFreshness(REPO, PARENT, { behindSince: clock.t - 5 * 60 * 60_000 });

    // The child's PR is still in review there: the branch must not be rewritten under it.
    await h.drain.tick();
    expect(merges).toEqual([]);
    expect(rebased).toEqual([]);
    expect(lastStatus(h).reason).toBe("epic_base_stale");
    expect(port.submitted).toEqual([]);

    green = true;
    clock.t += 60_000;
    await h.drain.tick();
    expect(merges.map((m) => m.pr)).toEqual([PR]);
    expect(rebased).toEqual(["x"]);
    expect(h.store.getEpicBaseFreshness(REPO, PARENT)?.behindSince ?? null).toBeNull();
    expect(port.submitted.map((s) => s.issue)).toEqual([NEXT]);
  });

  test("a merge made on the Mac is found although an archived local attempt exists", async () => {
    const port = fakePort({ active: false });
    port.remote.set(CHILD, {
      host: macHost,
      sessionId: "mac-3731",
      desig: "TASK-145",
      prNumber: 91,
    });
    const h = makeHarness({
      children,
      port,
      landing: "integration",
      issuePrs: { [CHILD]: [{ number: 91, url: "https://x/pull/91", state: "merged" }] },
      prBase: { 91: PINNED },
    });
    h.store.getOrInitEpicIntegrationBranch(REPO, PARENT, PINNED);
    const earlier = h.store.create({
      name: "earlier",
      prompt: "p",
      repoPath: REPO,
      baseBranch: PINNED,
      branch: "shepherd/earlier-3731",
      worktreePath: "/wt",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "t",
      auto: true,
      issueNumber: CHILD,
    });
    h.store.archive(earlier.id);
    await h.drain.tick();
    expect(h.store.isEpicIntegratedChild(REPO, CHILD)).toBe(true);
  });
});
