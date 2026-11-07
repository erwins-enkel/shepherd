import { test, expect, describe } from "bun:test";
import { DrainService, type DrainMachinePort, type DrainStatus } from "../src/drain";
import { ACTIVE_LABEL } from "../src/drain-core";
import type { RemoteWork } from "../src/drain-remote";
import { SessionStore } from "../src/store";
import type {
  GitForge,
  Issue,
  IssuePullRequestReference,
  PrStatus,
  SubIssueRef,
} from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { StandardCreateInput, Session } from "../src/types";
import type { UsageLimits } from "../src/usage-limits";
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
  };
  return port;
}

interface Harness {
  store: SessionStore;
  drain: DrainService;
  creates: StandardCreateInput[];
  statuses: DrainStatus[];
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
  prBase?: Record<number, string>;
}): Harness {
  const store = new SessionStore(":memory:");
  store.setRepoConfig(REPO, {
    criticEnabled: false,
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
    merge: async () => {},
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
    listBlockedBy: async () => [],
    ...(opts.issuePrs && {
      issuePullRequestReferences: async (n: number) => opts.issuePrs![n] ?? [],
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
    emitEpic: () => {},
    rebaseCap: 5,
    ...(opts.port && { machines: opts.port }),
  });
  return { store, drain, creates, statuses, added, removed };
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
});
