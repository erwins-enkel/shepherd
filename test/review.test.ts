import { test, expect, beforeEach, afterEach } from "bun:test";
import { ReviewService, reviewPrompt, scopeFindings } from "../src/review";
import { PluginSpawnAborted } from "../src/plugins/types";
import type { VerdictRead } from "../src/json-tolerant";
import type { RawVerdict } from "../src/critic-core";

/** Wrap a legacy `() => RawVerdict | null` reader into the 3-way VerdictRead the service now expects.
 *  A returned object → strict parse (finalize now); null → absent (wait until timeout). Preserves the
 *  behavior every pre-existing test relied on. */
const adaptLegacyVerdict = (fn: () => RawVerdict | null) => (): VerdictRead<RawVerdict> => {
  const v = fn();
  return v == null ? { status: "absent" } : { status: "parsed", value: v, repaired: false };
};
import {
  CRITIC_REVIEW_MARKER,
  AUTHOR_RESPONSE_MARKER,
  EMPTY_BACKLOG_COUNTS,
} from "../src/forge/types";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

async function withAuth<T>(
  mode: typeof config.authMode,
  helper: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  config.authMode = mode;
  config.authApiKeyHelperPath = helper;
  try {
    return await fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}
import type { GitForge, GitState, PrComment, PrStatus } from "../src/forge/types";
import type { Session, ReviewVerdict } from "../src/types";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "x",
    prompt: "do the thing",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t",
    claudeSessionId: "c",
    model: null,
    effort: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    completionRepromptCount: 0,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    landingRepair: false,
    status: "running",
    lastState: "idle",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    spawnTerminalId: null,
    spawnAccountDir: null,
    ...over,
  };
}
const OPEN_GREEN: GitState = {
  kind: "github",
  state: "open",
  number: 7,
  checks: "success",
  headSha: "abc",
  deployConfigured: false,
};

function fakeForge(
  rec: { event?: string; body?: string },
  comments: PrComment[],
  commentCalls: number[],
  prStatus: () => Promise<PrStatus> = async () => OPEN_GREEN as PrStatus,
  postedComments?: { n: number; body: string }[], // when provided, forge exposes a comment() spy
): GitForge {
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus,
    openPr: async () => OPEN_GREEN as PrStatus,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async (_n, o) => {
      rec.event = o.event;
      rec.body = o.body;
      return { url: "ru" };
    },
    listPrComments: async (n) => {
      commentCalls.push(n);
      return comments;
    },
    defaultBranch: async () => "main",
  };
  if (postedComments) {
    forge.comment = async (n, body) => {
      postedComments.push({ n, body });
    };
  }
  return forge;
}

function makeDeps(
  over: any,
  opts: {
    autoAddressEnabled?: boolean;
    autoAddressReturns?: boolean;
    comments?: PrComment[];
    prStatus?: () => Promise<PrStatus>;
    noCommentApi?: boolean; // when true the fake forge omits comment() (non-GitHub host)
    /** Inject a raw 3-way verdict read directly (for the #822 repaired/unparseable gate tests). */
    verdictRead?: VerdictRead<RawVerdict>;
    /** agentStatus reported by herdr.list() for the critic at /review-wt (default "idle" = finished). */
    criticAgentStatus?: string;
    /**
     * Foreground processes returned by herdr.paneForegroundProcs for the critic pane.
     * Default ['zsh'] (shell-only husk → isSpawnAlive returns false for non-working agents).
     * Pass non-shell procs to simulate a live-but-idle critic.
     */
    criticProcs?: string[];
    /**
     * Raw readVerdict function override — bypasses adaptLegacyVerdict. Use when you need
     * stateful behavior (e.g. throw on first call, succeed on second). Takes precedence over
     * both `verdictRead` and `over.readVerdict`.
     */
    readVerdictFn?: () => VerdictRead<RawVerdict>;
  } = {},
) {
  const reviews: Record<string, ReviewVerdict> = {};
  const started: { name: string; cwd: string; argv: string[]; env?: Record<string, string> }[] = [];
  const stopped: string[] = [];
  const removed: string[] = [];
  const bumped: { id: string; headSha: string }[] = []; // bumpReviewHead calls (rebase-skip)
  const steers: { id: string; text: string }[] = [];
  const signals: { kind: string; payload: string }[] = [];
  const commentCalls: number[] = []; // prNumbers passed to listPrComments
  const postedComments: { n: number; body: string }[] = []; // forge.comment() calls (post-merge critic)
  const recordedSpawns: any[] = []; // recordReviewerSpawn calls
  const completedSpawns: any[] = []; // completeReviewerSpawn calls
  const rec: { event?: string; body?: string } = {};
  const base = {
    store: {
      getRepoConfig: () => ({
        criticEnabled: true,
        autoAddressEnabled: opts.autoAddressEnabled ?? false,
      }),
      getReview: (id: string) => reviews[id] ?? null,
      putReview: (v: ReviewVerdict) => {
        reviews[v.sessionId] = v;
      },
      bumpReviewHead: (id: string, headSha: string, updatedAt: number) => {
        bumped.push({ id, headSha });
        const r = reviews[id];
        if (r) reviews[id] = { ...r, headSha, updatedAt };
      },
      dropReview: (id: string) => {
        delete reviews[id];
      },
      snapshotReviews: () => reviews,
      addSignal: (s: { kind: string; payload: string }) => signals.push(s),
      recordReviewerSpawn: (r: any) => recordedSpawns.push(r),
      completeReviewerSpawn: (id: string, u: any, at: number) =>
        completedSpawns.push({ id, u, at }),
    },
    herdr: new (class {
      readonly recorded = stopped; // this-dependent: unbound call loses this.recorded
      async start(name: string, cwd: string, argv: string[], env?: Record<string, string>) {
        started.push({ name, cwd, argv, env });
        return { terminalId: "rt" } as any;
      }
      async stop(t: string) {
        this.recorded.push(t); // this.recorded → throws TypeError if called unbound
      }
      // tick() consults agentStatus + paneForegroundProcs via isSpawnAlive to gate verdicts.
      list() {
        return [
          {
            cwd: "/review-wt",
            terminalId: "rt",
            paneId: "p1",
            agentStatus: opts.criticAgentStatus ?? "idle",
          },
        ] as any;
      }
      async paneForegroundProcs(): Promise<string[]> {
        // Default: shell-only (husk) so non-working agents are treated as dead by isSpawnAlive.
        // Tests that need a live-but-idle critic pass criticProcs with non-shell entries.
        return opts.criticProcs ?? ["zsh"];
      }
      async closeTab() {
        /* forward-compat; used by other tests via the existing path */
      }
    })(),
    worktree: new (class {
      readonly recorded = removed; // this-dependent: unbound call loses this.recorded
      createDetached = async () => ({ worktreePath: "/review-wt", branch: null, isolated: true });
      remove(p: string) {
        this.recorded.push(p); // this.recorded → throws TypeError if called unbound
      }
      gitCommonDir = () => "/fake-git-common";
    })(),
    // no bwrap on test hosts: degrade to passthrough so existing argv assertions hold
    detectBackend: () => null,
    resolveForge: () =>
      fakeForge(
        rec,
        opts.comments ?? [],
        commentCalls,
        opts.prStatus,
        opts.noCommentApi ? undefined : postedComments,
      ),
    onChange: () => {},
    autoAddress: (id: string, text: string) => {
      steers.push({ id, text });
      return opts.autoAddressReturns ?? true;
    },
    now: () => 1000,
    ...over,
    // Adapt the legacy `() => RawVerdict | null` reader (default or `over.readVerdict`) into the
    // 3-way VerdictRead the service now consumes — placed AFTER `...over` so the wrap always wins.
    // Priority: readVerdictFn (raw stateful) > verdictRead (raw static) > adapted legacy reader.
    readVerdict: opts.readVerdictFn
      ? opts.readVerdictFn
      : opts.verdictRead
        ? () => opts.verdictRead!
        : adaptLegacyVerdict(
            over.readVerdict ??
              (() => ({ decision: "request-changes", summary: "2 issues", body: "## findings" })),
          ),
  };
  return {
    deps: base,
    reviews,
    started,
    stopped,
    removed,
    bumped,
    steers,
    signals,
    commentCalls,
    postedComments,
    recordedSpawns,
    completedSpawns,
    rec,
  };
}

function verdict(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    sessionId: "s1",
    headSha: "abc",
    patchId: "p",
    decision: "changes_requested",
    summary: "s",
    body: "b",
    findings: ["f"],
    addressRound: 3,
    addressCap: 3,
    streakReviews: 1,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: true,
    finalRoundTimeoutMs: 900_000,
    seenNoteIds: [],
    updatedAt: 1000,
    ...over,
  };
}

test("clearStallState marks the verdict dismissed, keeps changes_requested", () => {
  const { deps: d, reviews } = makeDeps({});
  reviews["s1"] = verdict();
  new ReviewService(d as any).clearStallState(session());
  expect(reviews["s1"]!.dismissed).toBe(true);
  expect(reviews["s1"]!.decision).toBe("changes_requested");
  expect(reviews["s1"]!.addressRound).toBe(0);
});

test("forceReview pre-reset clears a prior dismissed flag", async () => {
  const { deps: d, reviews } = makeDeps({});
  reviews["s1"] = verdict({ dismissed: true });
  await new ReviewService(d as any).forceReview(session(), OPEN_GREEN);
  // forceReview writes the hygiene reset row (dismissed:false) before spawning the re-review.
  expect(reviews["s1"]!.dismissed).toBeFalsy();
});

test("reviewPrompt embeds base + task and asks for the verdict file", () => {
  const p = reviewPrompt("main", "do the thing");
  expect(p).toContain("git diff main...HEAD");
  expect(p).toContain("do the thing");
  expect(p).toContain(".shepherd-review.json");
  expect(p).toContain("Never approve");
});

test("consider → tick: posts request-changes, persists, reaps", async () => {
  const { deps: d, reviews, started, stopped, removed, rec } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(started).toHaveLength(1);
  expect(started[0]!.name).toBe("review TASK-01");
  await svc.tick();
  expect(rec.event).toBe("REQUEST_CHANGES");
  expect(reviews["s1"]?.decision).toBe("changes_requested");
  expect(reviews["s1"]?.url).toBe("ru");
  expect(stopped).toEqual(["rt"]);
  expect(removed).toEqual(["/review-wt"]);
  // critic-posted body must carry the marker; stored verdict must stay clean
  expect(rec.body).toContain("## findings");
  expect(rec.body).toContain(CRITIC_REVIEW_MARKER);
  expect(reviews["s1"]?.body).toBe("## findings");
});

test("criticArgv threads env.effort into the spawn argv (issue #1418)", async () => {
  const { deps: d, started } = makeDeps({
    env: () => ({ provider: "claude" as const, model: null, effort: "high" }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(started[0]!.argv).toContain("--effort");
  expect(started[0]!.argv[started[0]!.argv.indexOf("--effort") + 1]).toBe("high");
});

test("criticArgv emits no --effort when env.effort is null/default (issue #1418)", async () => {
  const { deps: d, started } = makeDeps({
    env: () => ({ provider: "claude" as const, model: null, effort: null }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(started[0]!.argv).not.toContain("--effort");
});

test("records the reviewer spawn on begin (issue #502)", async () => {
  const { deps: d, recordedSpawns } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(recordedSpawns).toHaveLength(1);
  const r = recordedSpawns[0]!;
  expect(r.kind).toBe("review");
  expect(r.taskSessionId).toBe("s1");
  expect(r.reviewerSessionId).toBeTruthy();
  expect(r.worktreePath).toBe("/review-wt");
});

test("completes the spawn's token total on finalize (issue #502)", async () => {
  const {
    deps: d,
    recordedSpawns,
    completedSpawns,
  } = makeDeps({
    readUsage: async () => ({
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 2,
      total: 117,
      messageCount: 1,
      lastActivity: 0,
      byModel: {},
    }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(completedSpawns).toHaveLength(1);
  expect(completedSpawns[0]!.u.total).toBe(117);
  expect(completedSpawns[0]!.id).toBe(recordedSpawns[0]!.reviewerSessionId);
});

test("onReviewing fires true on spawn and false on finalize", async () => {
  const events: { id: string; reviewing: boolean }[] = [];
  const { deps: d } = makeDeps({
    onReviewing: (id: string, reviewing: boolean) => events.push({ id, reviewing }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(events).toEqual([{ id: "s1", reviewing: true }]);
  await svc.tick();
  expect(events).toEqual([
    { id: "s1", reviewing: true },
    { id: "s1", reviewing: false },
  ]);
});

test("onReviewing start + inflight snapshot carry the critic's exact reviewer env", async () => {
  const events: unknown[][] = [];
  const env = { provider: "codex" as const, model: "gpt-5.5", effort: "high" };
  const { deps: d } = makeDeps({
    env: () => env,
    onReviewing: (id: string, reviewing: boolean, reviewerEnv?: unknown) =>
      events.push([id, reviewing, reviewerEnv]),
  });
  const svc = new ReviewService(d as any);

  await svc.consider(session(), OPEN_GREEN);

  expect(events).toContainEqual(["s1", true, env]);
  expect(svc.reviewingInflight()).toEqual([{ id: "s1", ...env }]);
  await svc.tick();
  expect(svc.reviewingInflight()).toEqual([]);
  expect(events.at(-1)).toEqual(["s1", false, undefined]);
});

test("onReviewing fires false when an in-flight critic is forgotten", async () => {
  const events: { id: string; reviewing: boolean }[] = [];
  const { deps: d } = makeDeps({
    onReviewing: (id: string, reviewing: boolean) => events.push({ id, reviewing }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  svc.forget("s1");
  expect(events).toEqual([
    { id: "s1", reviewing: true },
    { id: "s1", reviewing: false },
  ]);
});

test("onActivity surfaces the running critic's latest tool-use while no verdict yet", async () => {
  const acts: { id: string; summary: string }[] = [];
  const { deps: d } = makeDeps({
    readVerdict: () => null, // still running — no verdict file yet
    readActivity: () => "$ git diff main...HEAD",
    onActivity: (id: string, summary: string) => acts.push({ id, summary }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(acts).toEqual([{ id: "s1", summary: "$ git diff main...HEAD" }]);
});

test("onActivity stays silent when the critic has no parseable activity yet", async () => {
  const acts: unknown[] = [];
  const { deps: d } = makeDeps({
    readVerdict: () => null,
    readActivity: () => null, // transcript missing / nothing parseable
    onActivity: (id: string, summary: string) => acts.push({ id, summary }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(acts).toEqual([]);
});

test("onActivity does not fire on the tick that finalizes the verdict", async () => {
  const acts: unknown[] = [];
  const { deps: d } = makeDeps({
    // verdict present → this tick finalizes rather than reporting activity
    readActivity: () => "$ git diff",
    onActivity: (id: string, summary: string) => acts.push({ id, summary }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(acts).toEqual([]);
});

test("critic spawns read-only: no skip-permissions, dontAsk + scoped allowlist", async () => {
  const { deps: d, started } = makeDeps({});
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  const argv = started[0]!.argv;
  // an untrusted PR diff must not be able to escalate to command execution
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  expect(argv).toContain("Read");
  // bare `Write`: path-scoped Write rules are silently denied under dontAsk, so
  // the verdict file could never be written with a scoped rule. Safety still
  // holds — disposable worktree, no exec/commit/network (asserted below).
  expect(argv).toContain("Write");
  expect(argv).not.toContain("Edit");
  expect(argv).not.toContain("Bash"); // only subcommand-scoped Bash(git ...) entries
  // clean context: the critic must not inherit the user's hooks/plugins/skills
  // (e.g. superpowers' SessionStart "invoke a skill" preamble → Skill denied →
  // thrash). NOT --bare (it would break subscription-OAuth auth).
  expect(argv).not.toContain("--bare");
  expect(argv).toContain("--disable-slash-commands");
  const settingsRaw = argv[argv.indexOf("--settings") + 1];
  expect(settingsRaw).toBeDefined();
  // The thinking-budget env channel was retired (issue #1419): the critic's reasoning headroom
  // for the #597 cross-file verification now rides on --effort, so its --settings carries NO env key.
  expect(JSON.parse(settingsRaw!)).toEqual({
    disableAllHooks: true,
    enableAllProjectMcpServers: true,
  });
  expect(argv).toContain("--safe-mode");
});

test("critic: subscription mode — no apiKeyHelper, no env 4th arg", async () => {
  await withAuth("subscription", "/ignored.sh", async () => {
    const { deps: d, started } = makeDeps({});
    await new ReviewService(d as any).consider(session(), OPEN_GREEN);
    const argv = started[0]!.argv;
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!).apiKeyHelper).toBeUndefined();
    expect(started[0]!.env).toBeUndefined();
  });
});

test("critic: api-key mode (passthrough host) — apiKeyHelper + CLAUDE_CONFIG_DIR env", async () => {
  // detectBackend()→null on the test host → no membrane → passthrough env carries the mirror dir.
  await withAuth("api-key", "/helper.sh", async () => {
    const { deps: d, started } = makeDeps({});
    await new ReviewService(d as any).consider(session(), OPEN_GREEN);
    const argv = started[0]!.argv;
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!).apiKeyHelper).toBe("/helper.sh");
    expect(Object.keys(started[0]!.env!)).toEqual(["CLAUDE_CONFIG_DIR"]);
  });
});

test("critic: api-key without a configured key fails closed (no spawn, worktree reaped)", async () => {
  await withAuth("api-key", null, async () => {
    const { deps: d, started, removed } = makeDeps({});
    await new ReviewService(d as any).consider(session(), OPEN_GREEN);
    expect(started).toHaveLength(0);
    expect(removed).toEqual(["/review-wt"]);
  });
});

test("task prompt survives the variadic allowlist (not swallowed → no task → timeout)", async () => {
  const { deps: d, started } = makeDeps({});
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  const argv = started[0]!.argv;
  // `--allowedTools <tools...>` is variadic: it greedily eats every following
  // token until the next flag. The task prompt is the trailing positional, so a
  // single-value flag MUST sit between the allowlist and the prompt — otherwise
  // the real `claude` CLI folds the prompt into the allowlist and the critic
  // launches with no task, hanging until the 10-min timeout (every review).
  //
  // FRAGILE COUPLING: this stays green only because makeDeps({}) injects no computePatchId,
  // so the real defaultComputePatchId runs against the nonexistent "/review-wt" path, git
  // fails, baseSha → null, diffBase falls back to session.baseBranch ("main"), and the
  // assertion is self-referential (reviewPrompt("main", …) on both sides). It would BREAK if
  // rev-parse ever resolved a SHA on that path (diffBase would become that SHA, not "main").
  expect(argv.at(-1)).toBe(reviewPrompt("main", "do the thing"));
  expect(argv.at(-3)).toBe("--permission-mode");
  expect(argv.at(-2)).toBe("dontAsk");
  // nothing between the allowlist and the prompt may be a bare allowlist entry:
  // a flag must terminate the variadic first.
  const afterAllow = argv.slice(argv.indexOf("--allowedTools") + 1, argv.length - 1);
  const firstFlag = afterAllow.findIndex((a) => a.startsWith("--"));
  expect(firstFlag).toBeGreaterThanOrEqual(0);
});

test("does not review the same head twice", async () => {
  const { deps: d, started } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  await svc.consider(session(), OPEN_GREEN); // same headSha already reviewed
  expect(started).toHaveLength(1);
});

test("skips when repo critic disabled", () => {
  const { deps: d, started } = makeDeps({
    store: {
      getRepoConfig: () => ({ criticEnabled: false }),
      getReview: () => null,
      putReview: () => {},
      dropReview: () => {},
      snapshotReviews: () => ({}),
      addSignal: () => {},
    },
  });
  new ReviewService(d as any).consider(session(), OPEN_GREEN);
  expect(started).toHaveLength(0);
});

test("skips when CI not green / PR not open", () => {
  const { deps: d, started } = makeDeps({});
  const svc = new ReviewService(d as any);
  svc.consider(session(), { ...OPEN_GREEN, checks: "pending" });
  svc.consider(session(), { ...OPEN_GREEN, state: "merged" });
  expect(started).toHaveLength(0);
});

test("no-CI repo (noCi + checks:none) → reviews", async () => {
  const { deps: d, started } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, checks: "none", noCi: true });
  expect(started).toHaveLength(1);
});

test("checks:none WITHOUT noCi → skipped (CI repo pre-green)", async () => {
  const { deps: d, started } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, checks: "none", noCi: false });
  await svc.consider(session(), { ...OPEN_GREEN, checks: "none" }); // noCi absent ⇒ false
  expect(started).toHaveLength(0);
});

test("timeout with no verdict → error verdict, still reaps", async () => {
  let t = 1000;
  const {
    deps: d,
    reviews,
    stopped,
    removed,
  } = makeDeps({
    now: () => t,
    readVerdict: () => null,
    timeoutMs: 5000,
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  t = 1000 + 6000;
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error");
  expect(stopped).toEqual(["rt"]);
  expect(removed).toEqual(["/review-wt"]);
});

// ── #822 gate (merge-gating critic path) ─────────────────────────────────────
// A present-but-unparseable verdict whose critic spawn has FINISHED finalizes the transient `error`
// verdict immediately, instead of waiting out the full timeout (mirrors recap's fail-fast).
test("#822 review fail-fast: unparseable + finished critic → error well before timeout", async () => {
  let t = 1000;
  const {
    deps: d,
    reviews,
    stopped,
    removed,
  } = makeDeps(
    { now: () => t, timeoutMs: 300_000 },
    { verdictRead: { status: "unparseable" }, criticAgentStatus: "idle" }, // idle = finished
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  t = 1000 + 5000; // only 5s elapsed — nowhere near timeoutMs
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error"); // failed fast, not after the timeout
  expect(stopped).toEqual(["rt"]);
  expect(removed).toEqual(["/review-wt"]);
});

// A REPAIRED verdict while the critic is still WORKING must not be trusted (could be a truncated
// partial write closed up by jsonrepair → would silently drop findings / flip the decision).
test("#822 review gate: repaired + still-working critic → not finalized (no drop/flip)", async () => {
  let t = 1000;
  const {
    deps: d,
    reviews,
    stopped,
    removed,
  } = makeDeps(
    { now: () => t, timeoutMs: 300_000 },
    {
      verdictRead: {
        status: "parsed",
        repaired: true,
        value: { decision: "request-changes", summary: "1 issue", body: "## findings" },
      },
      criticAgentStatus: "working",
    },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  t = 1000 + 5000; // not timed out
  await svc.tick();
  expect(reviews["s1"]).toBeUndefined(); // gated: still in-flight, no verdict persisted
  expect(stopped).toEqual([]); // critic not reaped
  expect(removed).toEqual([]);
});

// `absent` is the out-of-scope "critic wrote nothing" class: even with a finished spawn it must not
// fail-fast — only the hard timeout finalizes it.
test("#822 review gate: absent + finished critic (not timed out) → not finalized", async () => {
  let t = 1000;
  const {
    deps: d,
    reviews,
    removed,
  } = makeDeps(
    { now: () => t, timeoutMs: 300_000 },
    { verdictRead: { status: "absent" }, criticAgentStatus: "done" },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  t = 1000 + 5000; // not timed out
  await svc.tick();
  expect(reviews["s1"]).toBeUndefined(); // not fail-fasted
  expect(removed).toEqual([]);
});

// ── TASK-1021 process-liveness regressions ────────────────────────────────────
// A live-but-idle critic (agentStatus "idle" between API turns, but claude/node still running)
// past the 60s startup grace must NOT be finalized-null and reaped — the root cause of
// TASK-1021's three successive review failures (62s, 69s, 73s runs, all reaped while working).

test("[TASK-1021] live-but-idle critic past grace: stays inflight, NOT finalized-null", async () => {
  let t = 1000; // consider() sets startedAt=1000
  const {
    deps: d,
    reviews,
    stopped,
    removed,
  } = makeDeps(
    { now: () => t, timeoutMs: 300_000 },
    {
      verdictRead: { status: "absent" },
      criticAgentStatus: "idle",
      criticProcs: ["claude", "node-MainThread"], // live critic mid-turn
    },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  t = 1000 + 90_000; // advance past STARTUP_GRACE_MS (60s); elapsed=90s
  await svc.tick();
  expect(reviews["s1"]).toBeUndefined(); // not finalized
  expect(stopped).toEqual([]); // not reaped
  expect(removed).toEqual([]);
});

test("husk critic (shell-only) past grace: finalize-null error (fast-fail preserved)", async () => {
  let t = 1000; // consider() sets startedAt=1000
  const {
    deps: d,
    reviews,
    stopped,
    removed,
  } = makeDeps(
    { now: () => t, timeoutMs: 300_000 },
    {
      verdictRead: { status: "absent" },
      criticAgentStatus: "idle",
      criticProcs: ["zsh"], // shell-only husk — genuinely dead
    },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  t = 1000 + 90_000; // advance past STARTUP_GRACE_MS (60s); elapsed=90s
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error"); // finalize-null: fast-fail preserved
  expect(stopped).not.toEqual([]); // reaped
  expect(removed).not.toEqual([]);
});

// Overlapping-ticks regression: the second concurrent tick must skip an entry whose
// finalizing flag was claimed by the first tick before the first async yield.
test("overlapping ticks: second tick skips entry already claimed by first tick", async () => {
  const {
    deps: d,
    stopped,
    removed,
  } = makeDeps(
    { now: () => 1000, timeoutMs: 300_000 },
    {
      // strict parse → finalize-value regardless of spawnFinished, so tick will finalize
      // criticProcs is default ['zsh'] (dead) — doesn't matter for strict parse
    },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  // Fire two ticks concurrently — tick1 claims finalizing before its first await;
  // tick2 sees finalizing=true and skips the entry entirely.
  const tick1 = svc.tick();
  const tick2 = svc.tick();
  await Promise.all([tick1, tick2]);
  // Exactly one finalize: exactly one stop + one remove
  expect(stopped.length).toBe(1);
  expect(removed.length).toBe(1);
});

// Throw-after-claim regression: if something throws after finalizing is claimed (but before
// finalize()), the flag must be released so the next tick can retry (no wedge/leak).
test("throw-after-claim: finalizing flag released on readVerdict throw → next tick succeeds", async () => {
  let callCount = 0;
  const { deps: d, reviews } = makeDeps(
    { now: () => 1000, timeoutMs: 300_000 },
    {
      // Raw fn (bypasses adaptLegacyVerdict) so the VerdictRead shapes are returned correctly.
      // First call throws (simulates readVerdict failing after flag is claimed);
      // second call returns a valid verdict so the subsequent tick can finalize.
      readVerdictFn: (): VerdictRead<RawVerdict> => {
        callCount++;
        if (callCount === 1) throw new Error("transient read error");
        return {
          status: "parsed",
          value: { decision: "request-changes", summary: "issue", body: "## findings" },
          repaired: false,
        };
      },
    },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  // First tick: readVerdict throws → flag released, entry stays inflight
  await svc.tick();
  expect(reviews["s1"]).toBeUndefined(); // not finalized yet (throw caused retry)
  // Second tick: readVerdict succeeds → finalizes normally
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("changes_requested"); // finalized on retry
});

test("comment decision maps to COMMENT and never approves", async () => {
  const { deps: d, rec } = makeDeps({
    readVerdict: () => ({ decision: "comment", summary: "ok", body: "lgtm-ish" }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(rec.event).toBe("COMMENT");
});

test("forget reaps an in-flight critic and drops the stored review", async () => {
  const { deps: d, reviews, stopped, removed } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // now in-flight
  reviews["s1"] = {
    sessionId: "s1",
    headSha: "abc",
    patchId: "pid-abc",
    decision: "commented",
    summary: "",
    body: "",
    findings: [],
    addressRound: 0,
    addressCap: 3,
    streakReviews: 0,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 15 * 60_000,
    seenNoteIds: [],
    updatedAt: 1,
  };
  svc.forget("s1");
  expect(stopped).toEqual(["rt"]); // critic terminal reaped
  expect(removed).toEqual(["/review-wt"]); // worktree removed
  expect(reviews["s1"]).toBeUndefined(); // stored verdict dropped
});

// ── rebase-skip (content-fingerprint dedup) ───────────────────────────────────

test("rebase with identical diff: skips the critic, re-points head, preserves the verdict", async () => {
  const {
    deps: d,
    reviews,
    started,
    removed,
    bumped,
  } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-same", baseSha: "base-pid-same", files: ["f"] }),
  });
  // prior verdict was for head "old"; the branch is force-pushed/rebased to "newsha"
  // but its diff is identical → same patch-id.
  reviews["s1"] = priorReview({ patchId: "pid-same", headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(0); // no critic spawned
  expect(removed).toEqual(["/review-wt"]); // the probe worktree is reaped
  expect(bumped).toEqual([{ id: "s1", headSha: "newsha" }]); // head re-pointed
  // verdict otherwise intact: outstanding findings + patch-id survive (not re-posted)
  expect(reviews["s1"]?.findings).toEqual(["fix the race in worker.ts"]);
  expect(reviews["s1"]?.patchId).toBe("pid-same");
});

test("new commit (different diff): reviews and records the new fingerprint", async () => {
  const {
    deps: d,
    reviews,
    started,
    bumped,
  } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-new", baseSha: "base-pid-new", files: ["f"] }),
  });
  reviews["s1"] = priorReview({ patchId: "pid-old", headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(bumped).toHaveLength(0); // not a skip
  expect(started).toHaveLength(1); // critic spawned
  await svc.tick();
  expect(reviews["s1"]?.patchId).toBe("pid-new"); // fingerprint persisted on the verdict
});

test("first review records the fingerprint for later rebase-skip", async () => {
  const {
    deps: d,
    reviews,
    started,
  } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-first", baseSha: "base-pid-first", files: ["f"] }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // no prior
  expect(started).toHaveLength(1);
  await svc.tick();
  expect(reviews["s1"]?.patchId).toBe("pid-first");
});

test("unresolvable fingerprint never skips: reviews even with a prior verdict", async () => {
  const {
    deps: d,
    reviews,
    started,
    bumped,
  } = makeDeps({ computePatchId: async () => ({ patchId: null, baseSha: null, files: [] }) });
  // prior has a real patch-id, but this run can't fingerprint (git failed / empty diff)
  reviews["s1"] = priorReview({ patchId: "pid-old", headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(bumped).toHaveLength(0); // safety default → do not skip
  expect(started).toHaveLength(1); // reviewed
});

test("prior error verdict never rebase-skips (retries the transient failure)", async () => {
  const {
    deps: d,
    reviews,
    started,
    bumped,
  } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-same", baseSha: "base-pid-same", files: ["f"] }),
  });
  // an errored prior that (legacy row / defensive) still carries a matching fingerprint
  reviews["s1"] = priorReview({ decision: "error", patchId: "pid-same", headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(bumped).toHaveLength(0); // not skipped despite identical fingerprint
  expect(started).toHaveLength(1); // re-reviewed instead of inheriting the stale error
});

test("error verdict records no fingerprint (so a later head always re-reviews)", async () => {
  const { deps: d, reviews } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-x", baseSha: "base-pid-x", files: ["f"] }),
    readVerdict: () => ({ decision: "bogus", summary: "?", body: "" }), // unparseable → error
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error");
  expect(reviews["s1"]?.patchId).toBe(""); // no fingerprint persisted on a failed run
});

test("rebase-skip short-circuits before any forge call (no author-notes fetch)", async () => {
  const {
    deps: d,
    reviews,
    started,
    commentCalls,
  } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "pid-same", baseSha: "base-pid-same", files: ["f"] }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ patchId: "pid-same", headSha: "old" }); // has findings
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(0); // skipped
  expect(commentCalls).toEqual([]); // skip happened before fetchAuthorNotes
});

// ── auto-address loop ─────────────────────────────────────────────────────────

test("reviewPrompt asks for structured findings", () => {
  const p = reviewPrompt("main", "do the thing");
  expect(p).toContain('"findings"');
});

test("reviewPrompt latent-defect lens routes by reachability", () => {
  const p = reviewPrompt("main", "do the thing");
  expect(p).toContain("LATENT-DEFECT LENS");
  expect(p).toContain("Latent / future-reachable (non-blocking):"); // dormant → informational body section
  expect(p).toContain('put it in "findings"'); // reachable-today defect stays blockable
});

test("reviewPrompt injects prior findings for verification (accountability)", () => {
  const p = reviewPrompt("main", "do the thing", ["fix the race", "rename foo"]);
  expect(p).toContain("fix the race");
  expect(p).toContain("rename foo");
  expect(p.toLowerCase()).toContain("previous"); // tells the critic these were raised before
});

test("reviewPrompt injects author notes with accept-if-justified guidance", () => {
  const p = reviewPrompt("main", "do the thing", ["fix X"], ["X is intentional per the spec"]);
  expect(p).toContain("X is intentional per the spec");
  expect(p.toLowerCase()).toContain("accept"); // honor a sound justification
  // notes are an injection surface (anyone can comment on a PR) → frame them as
  // unverified claims the critic must judge against the diff, not take on faith.
  expect(p.toLowerCase()).toContain("unverified");
});

// ── fresh-base threading (Fix A) ────────────────────────────────────────────────

test("divergence guard: critic prompt diffs the exact threaded baseSha, not the branch name", async () => {
  // Inject computePatchId returning a fresh base SHA distinct from session.baseBranch ("main").
  // The spawned critic prompt (trailing positional) must diff that exact SHA — proving the
  // resolved fresh base is threaded through, not the stale local "main" ref.
  const { deps: d, started } = makeDeps({
    computePatchId: async () => ({
      patchId: "pid-z",
      baseSha: "deadbeefcafe1234",
      files: ["x.ts"],
    }),
  });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  const prompt = started[0]!.argv.at(-1)!;
  expect(prompt).toContain("git diff deadbeefcafe1234...HEAD");
  expect(prompt).not.toContain("git diff main...HEAD");
});

test("baseSha-null fallback: prompt diffs the local base branch", async () => {
  // A total git failure (baseSha null) degrades to session.baseBranch — today's behavior.
  const { deps: d, started } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-z", baseSha: null, files: [] }),
  });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  expect(started[0]!.argv.at(-1)!).toContain("git diff main...HEAD");
});

// ── diff-scope prompt rule + precedence (Fix B1) ─────────────────────────────────

test("reviewPrompt carries the diff-scope rule, path-prefix requirement, and re-raise carve-out", () => {
  const p = reviewPrompt("base-sha", "do the thing", ["PrRow.svelte: stale nit"], ["a note"]);
  // scope block restricts findings to the diff
  expect(p).toContain("SCOPE");
  expect(p).toContain("git diff base-sha...HEAD");
  // path-prefix requirement
  expect(p).toContain('repo-relative path followed by ": "');
  // the precedence carve-out amends the re-raise directives: drop, don't re-raise, if the
  // finding's file isn't in the diff
  expect(p).toContain("UNLESS its file is not in");
  expect(p.toLowerCase()).toContain("do not re-raise");
  // out-of-scope body section + decision-consistency note
  expect(p).toContain("Out of scope (pre-existing, not in this PR):");
  expect(p).toContain('the decision is "comment", never "request-changes"');
});

// ── deterministic scope backstop helper (Fix B2, unit) ───────────────────────────

test("scopeFindings drops path-attributed out-of-diff findings, keeps in-diff + unattributed", () => {
  const files = ["in/Bar.svelte", "src/a.ts"];
  const { kept, dropped } = scopeFindings(
    [
      "outdir/Foo.svelte: out of scope",
      "in/Bar.svelte: in scope",
      "src/a.ts:42: with a line suffix",
      "Nit: a prose prefix, not a path",
      "Animation at 1.5s: too slow", // spaced prose ending in a dotted word → not a path
      "v2.0: regression", // version-like dotted token (digit-led ext) → not a path
      "no prefix at all",
    ],
    files,
  );
  expect(dropped).toEqual(["outdir/Foo.svelte: out of scope"]);
  expect(kept).toEqual([
    "in/Bar.svelte: in scope",
    "src/a.ts:42: with a line suffix",
    "Nit: a prose prefix, not a path",
    "Animation at 1.5s: too slow",
    "v2.0: regression",
    "no prefix at all",
  ]);
});

test("scopeFindings drops nothing when the file set is empty", () => {
  const { kept, dropped } = scopeFindings(["any/where.ts: x", "y"], []);
  expect(dropped).toEqual([]);
  expect(kept).toEqual(["any/where.ts: x", "y"]);
});

test("scopeFindings keeps a basename- or partial-path-prefixed in-diff finding (full-path fallback)", () => {
  const files = ["ui/src/lib/components/Viewport.svelte", "src/a.ts"];
  const { kept, dropped } = scopeFindings(
    [
      "Viewport.svelte: bare basename of an in-diff file",
      "components/Viewport.svelte:12: a trailing path slice",
      "PrRow.svelte: a basename matching NO changed file",
    ],
    files,
  );
  // basename + trailing-segment matches correspond to a changed file → kept; an unrelated
  // basename (PrRow.svelte) matches nothing in the diff → still dropped.
  expect(kept).toEqual([
    "Viewport.svelte: bare basename of an in-diff file",
    "components/Viewport.svelte:12: a trailing path slice",
  ]);
  expect(dropped).toEqual(["PrRow.svelte: a basename matching NO changed file"]);
});

// ── deterministic scope backstop in finalize (Fix B2, integration) ───────────────

test("backstop drops an out-of-diff path-attributed finding on finalize", async () => {
  const {
    deps: d,
    reviews,
    steers,
  } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "p", baseSha: "b", files: ["in/Bar.svelte"] }),
      readVerdict: () => ({
        decision: "comment",
        summary: "nit",
        body: "b",
        findings: ["outdir/Foo.svelte: pre-existing, not this PR"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.findings).toEqual([]); // out-of-diff finding dropped
  expect(steers).toHaveLength(0); // nothing in-scope → not steered
});

test("backstop keeps an in-diff path-attributed finding", async () => {
  const {
    deps: d,
    reviews,
    steers,
  } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "p", baseSha: "b", files: ["in/Bar.svelte"] }),
      readVerdict: () => ({
        decision: "comment",
        summary: "nit",
        body: "b",
        findings: ["in/Bar.svelte: fix this"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.findings).toEqual(["in/Bar.svelte: fix this"]);
  expect(steers).toHaveLength(1);
});

test("backstop keeps an unattributed (no path prefix) finding", async () => {
  const { deps: d, reviews } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "p", baseSha: "b", files: ["in/Bar.svelte"] }),
      readVerdict: () => ({
        decision: "comment",
        summary: "nit",
        body: "b",
        findings: ["does not satisfy the task"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.findings).toEqual(["does not satisfy the task"]);
});

test("backstop skipped (empty files) → all findings kept", async () => {
  const { deps: d, reviews } = makeDeps(
    {
      // baseSha resolved but no diff files → backstop can't run reliably → keep everything
      computePatchId: async () => ({ patchId: "p", baseSha: "b", files: [] }),
      readVerdict: () => ({
        decision: "comment",
        summary: "nit",
        body: "b",
        findings: ["outdir/Foo.svelte: would be dropped if the guard ran"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.findings).toEqual(["outdir/Foo.svelte: would be dropped if the guard ran"]);
});

test("request-changes emptied by the backstop flips to commented + [] (no steer)", async () => {
  const {
    deps: d,
    reviews,
    steers,
    rec,
  } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "p", baseSha: "b", files: ["in/Bar.svelte"] }),
      readVerdict: () => ({
        decision: "request-changes",
        summary: "x",
        body: "b",
        findings: ["outdir/Foo.svelte: pre-existing only"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("commented"); // flipped, never request-changes + []
  expect(reviews["s1"]?.findings).toEqual([]);
  expect(steers).toHaveLength(0); // no out-of-diff churn steered
  expect(rec.event).toBe("COMMENT"); // posts as a comment, not REQUEST_CHANGES
});

test("partial drop: request-changes keeps the in-diff finding, drops the out-of-diff one, stays changes_requested", async () => {
  const {
    deps: d,
    reviews,
    steers,
  } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "p", baseSha: "b", files: ["in/Bar.svelte"] }),
      readVerdict: () => ({
        decision: "request-changes",
        summary: "x",
        body: "b",
        findings: ["outside/Foo.svelte: pre-existing, not this PR", "in/Bar.svelte: fix this"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.findings).toEqual(["in/Bar.svelte: fix this"]); // out-of-diff dropped, in-diff kept
  expect(reviews["s1"]?.decision).toBe("changes_requested"); // findings remain → NOT flipped
  expect(steers).toHaveLength(1); // steered only for the kept finding
  expect(steers[0]!.text).toContain("in/Bar.svelte: fix this");
  expect(steers[0]!.text).not.toContain("outside/Foo.svelte");
});

test("auto-address on: feeds findings back to the agent and advances the round", async () => {
  const {
    deps: d,
    reviews,
    steers,
  } = makeDeps(
    {
      readVerdict: () => ({
        decision: "comment",
        summary: "one nit",
        body: "b",
        findings: ["nit: rename x to y"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  // even a NON-blocking comment is steered back — "shouldn't get off easily"
  expect(steers).toHaveLength(1);
  expect(steers[0]!.id).toBe("s1");
  expect(steers[0]!.text).toContain("nit: rename x to y");
  expect(reviews["s1"]?.addressRound).toBe(1);
  expect(reviews["s1"]?.findings).toEqual(["nit: rename x to y"]);
});

test("disabling auto-address mid-streak resets the round (no stale round badge)", async () => {
  const { deps: d, reviews } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }) },
    { autoAddressEnabled: false }, // user toggled the loop off while a streak was at round 2
  );
  reviews["s1"] = priorReview({ addressRound: 2 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressRound).toBe(0); // loop off → no streak; badge clears
});

test("auto-address off: never steers even with findings", async () => {
  const { deps: d, steers } = makeDeps(
    {
      readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }),
    },
    { autoAddressEnabled: false },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(steers).toHaveLength(0);
});

test("clean verdict (no findings) stops the loop and resets the round", async () => {
  const {
    deps: d,
    reviews,
    steers,
  } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "lgtm", body: "b", findings: [] }) },
    { autoAddressEnabled: true },
  );
  // a streak is already in progress (2 rounds spent on an older head)
  reviews["s1"] = {
    sessionId: "s1",
    headSha: "old",
    patchId: "pid-old",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["was broken"],
    addressRound: 2,
    addressCap: 3,
    streakReviews: 2,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 15 * 60_000,
    seenNoteIds: [],
    updatedAt: 1,
  };
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // new head "abc" (re-review → async note fetch)
  await svc.tick();
  expect(steers).toHaveLength(0); // nothing to address
  expect(reviews["s1"]?.addressRound).toBe(0); // streak reset
});

test("round cap reached: holds the round, posts the review + signal, does not steer", async () => {
  const {
    deps: d,
    reviews,
    steers,
    signals,
    rec,
  } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "still broken",
        body: "b",
        findings: ["still broken"],
      }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = {
    sessionId: "s1",
    headSha: "old",
    patchId: "pid-old",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["still broken"],
    addressRound: 3, // == cap: the agent has had its 3 tries
    addressCap: 3,
    streakReviews: 3,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 15 * 60_000,
    seenNoteIds: [],
    updatedAt: 1,
  };
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // re-review → async note fetch
  await svc.tick();
  expect(steers).toHaveLength(0); // gave up — escalates to the human
  expect(reviews["s1"]?.addressRound).toBe(3); // round preserved (not reset, not advanced)
  expect(rec.event).toBe("REQUEST_CHANGES"); // still posts to the PR
  expect(signals.some((s) => s.kind === "critic")).toBe(true); // captured for the human/learnings
});

test("PR merged before finalize (findings): post-merge comment, no review/steer/signal (#596 gap a)", async () => {
  const {
    deps: d,
    reviews,
    steers,
    signals,
    rec,
    postedComments,
  } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "x",
        body: "b",
        findings: ["fix x"],
      }),
    },
    // critic spawned while open, but the PR merged before the verdict finalized
    { autoAddressEnabled: true, prStatus: async () => ({ ...OPEN_GREEN, state: "merged" }) },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // spawn while open (no prStatus call yet)
  await svc.tick(); // finalize: live recheck sees "merged" → record findings as a comment
  // critic lost the race → findings recorded as a post-merge ISSUE COMMENT (can't request-changes)
  expect(postedComments).toHaveLength(1);
  expect(postedComments[0]!.n).toBe(7); // f.prNumber
  expect(postedComments[0]!.body).toContain("b"); // verdict body
  expect(postedComments[0]!.body).toContain(CRITIC_REVIEW_MARKER); // marked as a critic review
  expect(postedComments[0]!.body).toContain("merged"); // explains why findings arrive post-merge
  // …but nothing that gates/steers a merge that already happened
  expect(rec.event).toBeUndefined(); // no PR review posted on a merged PR
  expect(steers).toHaveLength(0); // no churn steered onto a merged branch
  expect(signals.some((s) => s.kind === "critic")).toBe(false); // and no learnings signal
  expect(reviews["s1"]?.decision).toBe("changes_requested"); // verdict still persisted (UI/dedup)
  expect(reviews["s1"]?.addressRound).toBe(0); // no steer round
});

test("PR merged before finalize (clean verdict): silent — nothing posted (#596 gap a)", async () => {
  const {
    deps: d,
    steers,
    rec,
    postedComments,
  } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "lgtm", body: "b", findings: [] }) },
    { autoAddressEnabled: true, prStatus: async () => ({ ...OPEN_GREEN, state: "merged" }) },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(postedComments).toHaveLength(0); // clean verdict → nothing to record post-merge
  expect(rec.event).toBeUndefined();
  expect(steers).toHaveLength(0);
});

test("PR merged before finalize but host lacks comment(): best-effort, no throw (#596 gap a)", async () => {
  const {
    deps: d,
    steers,
    rec,
    postedComments,
  } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "x",
        body: "b",
        findings: ["fix x"],
      }),
    },
    {
      autoAddressEnabled: true,
      prStatus: async () => ({ ...OPEN_GREEN, state: "merged" }),
      noCommentApi: true, // non-GitHub host: no comment API
    },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick(); // must NOT reject when the host can't post comments
  expect(postedComments).toHaveLength(0); // nothing posted (host has no comment API)
  expect(rec.event).toBeUndefined();
  expect(steers).toHaveLength(0);
});

test("PR-state recheck throws: fail-closed — fully inert", async () => {
  const {
    deps: d,
    reviews,
    steers,
    rec,
  } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }) },
    {
      autoAddressEnabled: true,
      prStatus: async () => {
        throw new Error("gh unavailable");
      },
    },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick(); // must NOT reject
  expect(steers).toHaveLength(0); // can't confirm open → don't steer
  expect(rec.event).toBeUndefined(); // …and don't post the review
  expect(reviews["s1"]?.addressRound).toBe(0);
});

test("PR closed (not merged) before finalize: also fully inert", async () => {
  const {
    deps: d,
    steers,
    rec,
    postedComments,
  } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }) },
    { autoAddressEnabled: true, prStatus: async () => ({ ...OPEN_GREEN, state: "closed" }) },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(steers).toHaveLength(0); // guard is state !== "open", not just merged
  expect(rec.event).toBeUndefined(); // closed PR → review not posted
  expect(postedComments).toHaveLength(0); // closed-unmerged → moot, no post-merge comment either
});

test("PR merged before finalize (error verdict): not persisted, no escalation", async () => {
  // Critic spawn and PR merge both fire on CI-green → they race. A transient critic error that
  // finalizes after the merge is observable must NOT flip the (not-yet-archived) session to
  // REVIEW ERR. Seed the error streak at the cap boundary (errorRound 2, cap 3) so the no-stall
  // assertion is discriminating: on the pre-fix code the error path bumps 2→3, crossing the cap
  // and emitting a stall signal. With the fix the verdict is suppressed, so neither happens.
  const {
    deps: d,
    reviews,
    signals,
  } = makeDeps(
    { readVerdict: () => ({ decision: "junk", summary: "boom", body: "" }) }, // unparseable → error
    { prStatus: async () => ({ ...OPEN_GREEN, state: "merged" }) },
  );
  reviews["s1"] = priorReview({ errorRound: 2, addressRound: 1 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // spawn while open (no prStatus call yet)
  await svc.tick(); // finalize: live recheck sees "merged" → moot error, suppressed
  expect(reviews["s1"]?.decision).not.toBe("error"); // not overwritten with the moot error verdict
  expect(reviews["s1"]?.errorRound).toBe(2); // NOT bumped to 3 (verdict wasn't persisted)
  expect(signals.some((s) => s.kind === "stall")).toBe(false); // and no cap-crossing escalation
});

test("PR closed before finalize (error verdict): also suppressed, no escalation", async () => {
  // Same suppression for closed-unmerged: the guard is state !== "open", not just merged.
  const {
    deps: d,
    reviews,
    signals,
  } = makeDeps(
    { readVerdict: () => ({ decision: "junk", summary: "boom", body: "" }) },
    { prStatus: async () => ({ ...OPEN_GREEN, state: "closed" }) },
  );
  reviews["s1"] = priorReview({ errorRound: 2 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.errorRound).toBe(2); // suppressed → counter untouched
  expect(signals.some((s) => s.kind === "stall")).toBe(false);
});

test("advancing into the cap marks the final round pending (not yet stalled)", async () => {
  const { deps: d, reviews } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "still broken",
        body: "b",
        findings: ["still broken"],
      }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ addressRound: 2 }); // one try left; cap is 3
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressRound).toBe(3);
  expect(reviews["s1"]?.finalRoundPending).toBe(true);
});

test("holding at the cap is a confirmed stall, not pending", async () => {
  const { deps: d, reviews } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "still broken",
        body: "b",
        findings: ["still broken"],
      }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ addressRound: 3 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressRound).toBe(3);
  expect(reviews["s1"]?.finalRoundPending).toBe(false);
});

test("clean verdict is never final-round-pending", async () => {
  const { deps: d, reviews } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "lgtm", body: "b", findings: [] }) },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ addressRound: 2 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.finalRoundPending).toBe(false);
});

test("dead agent pane: steer attempted but the round does not advance", async () => {
  const {
    deps: d,
    reviews,
    steers,
  } = makeDeps(
    {
      readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }),
    },
    { autoAddressEnabled: true, autoAddressReturns: false }, // reply() → false (pane gone)
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(steers).toHaveLength(1); // attempted
  expect(reviews["s1"]?.addressRound).toBe(0); // but no progress was made
});

function priorReview(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    sessionId: "s1",
    headSha: "old",
    patchId: "pid-old",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["fix the race in worker.ts"],
    addressRound: 1,
    addressCap: 3,
    streakReviews: 1,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 15 * 60_000,
    seenNoteIds: [],
    updatedAt: 1,
    ...over,
  };
}

test("re-review injects the prior round's findings into the critic prompt", async () => {
  const { deps: d, reviews, started } = makeDeps({}, { autoAddressEnabled: true });
  reviews["s1"] = priorReview();
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // new head → fresh critic run
  expect(started[0]!.argv.at(-1)).toContain("fix the race in worker.ts");
});

test("the steer tells the agent to post a declined finding as a PR comment", async () => {
  const { deps: d, steers } = makeDeps(
    {
      readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // first review
  await svc.tick();
  expect(steers[0]!.text).toContain("gh pr comment 7"); // PR number from OPEN_GREEN.number
  expect(steers[0]!.text).toContain(AUTHOR_RESPONSE_MARKER);
});

test("re-review fetches the author's PR notes and injects them into the prompt", async () => {
  const {
    deps: d,
    reviews,
    started,
    commentCalls,
  } = makeDeps(
    {},
    {
      autoAddressEnabled: true,
      comments: [
        { id: "c1", author: "me", body: "unrelated chatter", createdAt: 1 },
        {
          id: "c2",
          author: "me",
          body: `${AUTHOR_RESPONSE_MARKER} #2 is intentional: it mirrors the spec`,
          createdAt: 2,
        },
      ],
    },
  );
  reviews["s1"] = priorReview();
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(commentCalls).toEqual([7]); // fetched comments for PR #7
  const prompt = started[0]!.argv.at(-1)!;
  expect(prompt).toContain("#2 is intentional: it mirrors the spec"); // the marked note
  expect(prompt).not.toContain(AUTHOR_RESPONSE_MARKER); // marker stripped
  expect(prompt).not.toContain("unrelated chatter"); // unmarked comment ignored
});

test("first review does NOT fetch author notes", async () => {
  const { deps: d, commentCalls } = makeDeps({}, { autoAddressEnabled: true });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN); // no prior → first review
  expect(commentCalls).toEqual([]);
});

test("auto-address off: re-review does not fetch author notes", async () => {
  const { deps: d, reviews, commentCalls } = makeDeps({}, { autoAddressEnabled: false });
  reviews["s1"] = priorReview();
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(commentCalls).toEqual([]); // gated on autoAddressEnabled — critic-only repos unchanged
});

test("steer that throws (dead pane) is not-delivered and still finalizes + reaps", async () => {
  const {
    deps: d,
    reviews,
    stopped,
    removed,
  } = makeDeps(
    {
      // a live-in-store / dead-pane agent: reply() reaches herdr.send → execFileSync throws
      autoAddress: () => {
        throw new Error("herdr: agent send failed (dead pane)");
      },
      readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // first review
  await svc.tick(); // must NOT reject
  expect(reviews["s1"]?.decision).toBe("commented"); // verdict persisted
  expect(reviews["s1"]?.addressRound).toBe(0); // throw = not delivered → round held
  expect(stopped).toEqual(["rt"]); // terminal reaped despite the throw
  expect(removed).toEqual(["/review-wt"]); // worktree reaped — no leak
  expect(svc.reviewingIds()).toEqual([]); // in-flight entry cleared — not wedged
});

test("concurrent re-review considers spawn the critic only once (no TOCTOU double-run)", async () => {
  const { deps: d, reviews, started } = makeDeps({}, { autoAddressEnabled: true });
  reviews["s1"] = priorReview(); // re-review path → begin awaits fetchAuthorNotes
  const svc = new ReviewService(d as any);
  // two session:git events for the same head land while the first is mid-await
  await Promise.all([svc.consider(session(), OPEN_GREEN), svc.consider(session(), OPEN_GREEN)]);
  expect(started).toHaveLength(1); // the slot is claimed before the await
});

test("forget() during the re-review await aborts the spawn (no critic for an archived session)", async () => {
  const { deps: d, reviews, started } = makeDeps({}, { autoAddressEnabled: true });
  reviews["s1"] = priorReview(); // re-review path → begin suspends at fetchAuthorNotes
  const svc = new ReviewService(d as any);
  const p = svc.consider(session(), OPEN_GREEN); // suspends mid-fetch
  svc.forget("s1"); // session archived while the gh fetch is in flight
  await p;
  expect(started).toHaveLength(0); // begin saw the forget and aborted before spawning
  expect(svc.reviewingIds()).toEqual([]); // nothing left in flight
});

test("forget() during the getIssue await aborts the spawn and reaps the worktree", async () => {
  // Suspend begin() inside the issue-body getIssue fetch (first-review path → author-notes
  // doesn't suspend, so getIssue is the ONLY await between the `starting` claim and the spawn).
  // Fire forget() (session archived) while it's parked, then let the fetch resolve. begin()
  // must re-check `starting`, NOT spawn, and reap the detached worktree it already allocated.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const {
    deps: d,
    started,
    removed,
  } = makeDeps({
    resolveForge: () =>
      ({
        getIssue: async () => {
          await gate;
          return { body: "ISSUE_BODY_XYZ" };
        },
      }) as any,
  });
  const svc = new ReviewService(d as any);
  const p = svc.consider(session({ issueNumber: 99 }), OPEN_GREEN); // suspends mid getIssue
  await Promise.resolve(); // let begin() advance into the parked getIssue await
  svc.forget("s1"); // archive mid-fetch → clears the `starting` tombstone
  release();
  await p;
  expect(started).toHaveLength(0); // never spawned the critic for a gone session
  expect(removed).toEqual(["/review-wt"]); // the detached worktree was reaped
  expect(svc.reviewingIds()).toEqual([]); // nothing left in flight
});

// ── follow-up polish (#247) ─────────────────────────────────────────────────────

test("verdict surfaces the configured cap so the UI need not mirror it", async () => {
  const { deps: d, reviews } = makeDeps({ cap: 5 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressCap).toBe(5); // ReviewService({cap}) → verdict payload
});

test("a cap thunk is resolved live so a settings change applies without a restart", async () => {
  let live = 3; // stands in for config.prReviewCyclesCap
  const { deps: d, reviews } = makeDeps({ cap: () => live });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressCap).toBe(3); // first run reads the thunk's current value
  live = 7; // operator bumps the global setting mid-run
  delete reviews["s1"]; // force a fresh verdict on the next run
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressCap).toBe(7); // new cap takes effect, no reconstruction
});

test("re-review injects only author notes not already shown on an earlier round", async () => {
  const {
    deps: d,
    reviews,
    started,
  } = makeDeps(
    {},
    {
      autoAddressEnabled: true,
      comments: [
        {
          id: "c2",
          author: "me",
          body: `${AUTHOR_RESPONSE_MARKER} round-1 note (already seen)`,
          createdAt: 1,
        },
        {
          id: "c3",
          author: "me",
          body: `${AUTHOR_RESPONSE_MARKER} round-2 note (new)`,
          createdAt: 2,
        },
      ],
    },
  );
  // a streak already injected c2 on the previous round
  reviews["s1"] = priorReview({ seenNoteIds: ["c2"] });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  const prompt = started[0]!.argv.at(-1)!;
  expect(prompt).toContain("round-2 note (new)"); // the fresh note reaches the critic
  expect(prompt).not.toContain("round-1 note (already seen)"); // the stale one does not re-feed
  await svc.tick();
  expect(reviews["s1"]?.seenNoteIds).toEqual(["c2", "c3"]); // dedup set carried forward
});

test("consecutive critic errors escalate via a stall signal at the cap", async () => {
  const {
    deps: d,
    reviews,
    signals,
  } = makeDeps({ readVerdict: () => ({ decision: "junk", summary: "boom", body: "" }) });
  // two errors already on the no-progress streak; this one hits cap (3)
  reviews["s1"] = priorReview({ errorRound: 2, addressRound: 1 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error");
  expect(reviews["s1"]?.errorRound).toBe(3); // separate counter advanced
  expect(reviews["s1"]?.addressRound).toBe(1); // findings streak preserved, NOT reset to clean
  expect(signals.some((s) => s.kind === "stall")).toBe(true); // escalates to the human
});

test("errors past the cap do not re-signal (escalates once, on crossing)", async () => {
  const {
    deps: d,
    reviews,
    signals,
  } = makeDeps({ readVerdict: () => ({ decision: "junk", summary: "boom", body: "" }) });
  // already over the cap (escalated on an earlier round) — a further error must stay quiet
  reviews["s1"] = priorReview({ errorRound: 3 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.errorRound).toBe(4); // counter keeps climbing
  expect(signals.some((s) => s.kind === "stall")).toBe(false); // but the loud signal fired once, on crossing
});

test("a critic error below the cap bumps the error streak without escalating", async () => {
  const {
    deps: d,
    reviews,
    signals,
  } = makeDeps({ readVerdict: () => ({ decision: "junk", summary: "boom", body: "" }) });
  reviews["s1"] = priorReview({ errorRound: 0, addressRound: 2 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.errorRound).toBe(1);
  expect(reviews["s1"]?.addressRound).toBe(2); // preserved
  expect(signals.some((s) => s.kind === "stall")).toBe(false); // not yet at the cap
});

test("a real verdict resets the error streak", async () => {
  const { deps: d, reviews } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "ok", body: "b", findings: [] }) },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ errorRound: 2 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.errorRound).toBe(0); // any successful verdict clears the no-progress streak
});

test("an error verdict does not consume freshly-fetched author notes (re-inject next round)", async () => {
  const {
    deps: d,
    reviews,
    started,
  } = makeDeps(
    { readVerdict: () => ({ decision: "junk", summary: "boom", body: "" }) },
    {
      autoAddressEnabled: true,
      comments: [
        { id: "c9", author: "me", body: `${AUTHOR_RESPONSE_MARKER} a fresh note`, createdAt: 1 },
      ],
    },
  );
  reviews["s1"] = priorReview({ seenNoteIds: [] }); // re-review fetches + injects c9
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(started[0]!.argv.at(-1)).toContain("a fresh note"); // the note reached the (doomed) critic
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error");
  // the errored critic never produced a verdict on c9, so it must NOT be marked seen
  expect(reviews["s1"]?.seenNoteIds).toEqual([]);
});

// ── bound review spawns: per-streak spawn ceiling (#501) ─────────────────────────

test("ceiling reached: does NOT spawn (no worktree allocated, no re-signal)", async () => {
  const {
    deps: d,
    reviews,
    started,
    removed,
    signals,
  } = makeDeps(
    { computePatchId: async () => ({ patchId: "pid-new", baseSha: "base-pid-new", files: ["f"] }) },
    { autoAddressEnabled: true },
  );
  // cap default 3 → ceiling 6; a streak already AT the ceiling with outstanding findings.
  reviews["s1"] = priorReview({ streakReviews: 6, headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(0); // critic not spawned
  expect(removed).toEqual([]); // bailed BEFORE allocating the probe worktree
  // the stall signal fired on crossing (in finalize), not here on the blocked tick
  expect(signals.some((s) => s.kind === "stall")).toBe(false);
});

test("ceiling crossing emits exactly one stall signal", async () => {
  const {
    deps: d,
    reviews,
    signals,
  } = makeDeps(
    {
      computePatchId: async () => ({
        patchId: "pid-cross",
        baseSha: "base-pid-cross",
        files: ["f"],
      }),
      readVerdict: () => ({
        decision: "request-changes",
        summary: "still broken",
        body: "b",
        findings: ["still broken"],
      }),
    },
    { autoAddressEnabled: true },
  );
  // one review short of the ceiling (6); this run finalizes the 6th → crosses.
  reviews["s1"] = priorReview({ streakReviews: 5, headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  await svc.tick();
  expect(reviews["s1"]?.streakReviews).toBe(6); // reached the ceiling
  const paused = signals.filter(
    (s) => s.kind === "stall" && s.payload.includes("auto-review paused"),
  );
  expect(paused).toHaveLength(1); // exactly one, on crossing
  expect(paused[0]!.payload).toContain("6 times");
});

test("a higher live cap raises the ceiling: a streak at 6 still spawns + the signal tracks the cap", async () => {
  // The ceiling is 2*cap, derived from the LIVE cap. With cap=4 the ceiling is 8, so a streak
  // at 6 is under budget (would be at-ceiling under the default cap=3). Proves the gate +
  // crossing guard both read the live cap, not a frozen number — and the crossing guard fires
  // once exactly when the streak first reaches the live ceiling.
  const {
    deps: d,
    reviews,
    started,
    signals,
  } = makeDeps(
    {
      cap: 4, // ceiling = 8
      computePatchId: async () => ({ patchId: "pid-h", baseSha: "base-pid-h", files: ["f"] }),
      readVerdict: () => ({
        decision: "request-changes",
        summary: "still broken",
        body: "b",
        findings: ["still broken"],
      }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ streakReviews: 7, headSha: "old" }); // one short of 8
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(1); // under the raised ceiling → spawns
  await svc.tick();
  expect(reviews["s1"]?.streakReviews).toBe(8); // crosses the raised ceiling
  const paused = signals.filter((s) => s.kind === "stall" && s.payload.includes("8 times"));
  expect(paused).toHaveLength(1); // signal count tracks the live ceiling
});

test("under the ceiling still spawns normally", async () => {
  const {
    deps: d,
    reviews,
    started,
  } = makeDeps(
    { computePatchId: async () => ({ patchId: "pid-new", baseSha: "base-pid-new", files: ["f"] }) },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ streakReviews: 3, headSha: "old" }); // well under 6
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(1); // budget remains → critic spawns
});

test("ceiling is strict for findings reviews but NOT total spawns: an error verdict (findings=[]) re-reviews", async () => {
  // Documents the approximate-total bound (#501 critic note): the gate keys off
  // findings.length > 0, so an error/timeout verdict (which preserves streakReviews but
  // carries findings=[]) does NOT trip the ceiling — error churn is governed by errorRound,
  // not this gate, so a flapping critic can re-spawn past 2*cap. (In the live loop an error
  // verdict can't actually carry streakReviews >= ceiling, since reaching the ceiling needs a
  // findings verdict that then blocks the next spawn; this fixture pins the gate's literal
  // semantics so a refactor dropping the findings>0 leg fails here and forces a conscious call.)
  const {
    deps: d,
    reviews,
    started,
  } = makeDeps(
    { computePatchId: async () => ({ patchId: "pid-new", baseSha: "base-pid-new", files: ["f"] }) },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({
    decision: "error",
    findings: [], // error verdicts carry no findings
    streakReviews: 6, // at the default ceiling, yet not a findings streak
    headSha: "old",
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(1); // not blocked by the findings-review ceiling
});

test("clean verdict resets streakReviews and reviewedPatchIds (un-suppresses)", async () => {
  const { deps: d, reviews } = makeDeps(
    {
      computePatchId: async () => ({
        patchId: "pid-clean-run",
        baseSha: "base-pid-clean-run",
        files: ["f"],
      }),
      readVerdict: () => ({ decision: "comment", summary: "lgtm", body: "b", findings: [] }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({
    streakReviews: 4,
    reviewedPatchIds: ["pid-a", "pid-b"],
    headSha: "old",
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  await svc.tick();
  expect(reviews["s1"]?.streakReviews).toBe(0); // streak reset
  expect(reviews["s1"]?.reviewedPatchIds).toEqual([]); // churn set cleared
});

// ── bound review spawns: per-streak patch-id dedup (#501) ────────────────────────

test("revert to an earlier (not immediately-prior) reviewed patch-id skips", async () => {
  const {
    deps: d,
    reviews,
    started,
    bumped,
  } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-a", baseSha: "base-pid-a", files: ["f"] }), // bounced back to a diff reviewed earlier this streak
  });
  // prior verdict's own patchId is pid-c, but pid-a was reviewed earlier in the streak.
  reviews["s1"] = priorReview({
    patchId: "pid-c",
    headSha: "old",
    reviewedPatchIds: ["pid-a", "pid-b", "pid-c"],
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(0); // set-membership match → skipped
  expect(bumped).toEqual([{ id: "s1", headSha: "newsha" }]); // head re-pointed, verdict preserved
  expect(reviews["s1"]?.findings).toEqual(["fix the race in worker.ts"]); // outstanding findings held
});

test("after a clean verdict cleared the set, a pre-clean patch-id is reviewed again", async () => {
  const {
    deps: d,
    reviews,
    started,
    bumped,
  } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-a", baseSha: "base-pid-a", files: ["f"] }),
  });
  // a clean verdict reset the set to []; pid-a was reviewed pre-clean but is no longer tracked.
  reviews["s1"] = priorReview({
    decision: "commented",
    findings: [],
    patchId: "pid-clean",
    reviewedPatchIds: [],
    streakReviews: 0,
    headSha: "old",
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(bumped).toHaveLength(0); // not skipped — the set was cleared
  expect(started).toHaveLength(1); // reviewed again (a revert to a buggy earlier state)
});

test("error verdict does not poison the dedup set (same diff re-reviews)", async () => {
  const { deps: d, reviews } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-x", baseSha: "base-pid-x", files: ["f"] }),
    // first run errors on pid-x; it must NOT be added to reviewedPatchIds.
    readVerdict: () => ({ decision: "junk", summary: "boom", body: "" }),
  });
  reviews["s1"] = priorReview({ headSha: "old", reviewedPatchIds: [] });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error");
  // errored patch-id NOT added → a later head with the SAME diff re-reviews (rebaseSkip
  // also independently refuses to skip past an error decision).
  expect(reviews["s1"]?.reviewedPatchIds).toEqual([]);
});

test("reviewPrompt enforces verification discipline (grounding, not plausibility)", () => {
  const p = reviewPrompt("main", "do the thing");
  // intro rule: no asserting plausibility
  expect(p).toContain("VERIFY — do not assert plausibility");
  // citation requirement: concrete ground truth + path:line
  expect(p).toContain("cite the concrete ground truth");
  expect(p).toContain("path:line");
  // cannot-verify vs wrong distinction
  expect(p).toContain("CANNOT-VERIFY vs WRONG");
  // attribution rule for cross-tree findings
  expect(p).toContain("ATTRIBUTION when a verified problem points outside the diff");
});

test("clean prior verdict still rebase-skips on a same-patch-id force-push (OR-branch)", async () => {
  const {
    deps: d,
    reviews,
    started,
    bumped,
  } = makeDeps({
    computePatchId: async () => ({ patchId: "pid-clean", baseSha: "base-pid-clean", files: ["f"] }),
  });
  // a CLEAN verdict: reviewedPatchIds is [] but patchId is preserved. The OR-branch
  // (prior.patchId === patchId) must still fire even with an empty set.
  reviews["s1"] = priorReview({
    decision: "commented",
    findings: [],
    patchId: "pid-clean",
    reviewedPatchIds: [],
    streakReviews: 0,
    headSha: "old",
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(started).toHaveLength(0); // skipped via the patchId OR-branch
  expect(bumped).toEqual([{ id: "s1", headSha: "newsha" }]); // head re-pointed
});

// ── originating-issue body as UNTRUSTED critic context ───────────────────────────

test("critic prompt embeds the originating issue body (UNTRUSTED) when issueNumber is set", async () => {
  const { deps: d, started } = makeDeps({
    resolveForge: () => ({ getIssue: async () => ({ body: "ISSUE_BODY_XYZ" }) }) as any,
  });
  await new ReviewService(d as any).consider(session({ issueNumber: 99 }), OPEN_GREEN);
  const prompt = started[0]!.argv.at(-1)!;
  expect(prompt).toContain("ISSUE_BODY_XYZ");
  expect(prompt).toContain("ORIGINATING ISSUE");
  expect(prompt).toContain("UNTRUSTED");
});

test("no issue block when issueNumber is null", async () => {
  const { deps: d, started } = makeDeps({
    resolveForge: () => ({ getIssue: async () => ({ body: "ISSUE_BODY_XYZ" }) }) as any,
  });
  await new ReviewService(d as any).consider(session({ issueNumber: null }), OPEN_GREEN);
  const prompt = started[0]!.argv.at(-1)!;
  expect(prompt).not.toContain("ORIGINATING ISSUE");
  expect(prompt).not.toContain("ISSUE_BODY_XYZ");
});

test("degrades cleanly when getIssue is absent / returns null / throws (no block, still spawns)", async () => {
  for (const getIssue of [
    undefined,
    async () => null,
    async () => {
      throw new Error("gh boom");
    },
  ]) {
    const { deps: d, started } = makeDeps({
      resolveForge: () => ({ getIssue }) as any,
    });
    await new ReviewService(d as any).consider(session({ issueNumber: 99 }), OPEN_GREEN);
    expect(started).toHaveLength(1); // no throw → critic still spawns
    expect(started[0]!.argv.at(-1)!).not.toContain("ORIGINATING ISSUE");
  }
});

test("degrades cleanly when resolveForge returns null (no block, still spawns)", async () => {
  const { deps: d, started } = makeDeps({ resolveForge: () => null });
  await new ReviewService(d as any).consider(session({ issueNumber: 99 }), OPEN_GREEN);
  expect(started).toHaveLength(1); // no throw → critic still spawns
  expect(started[0]!.argv.at(-1)!).not.toContain("ORIGINATING ISSUE");
});

// ── FS membrane wrapping ─────────────────────────────────────────────────────────

test("critic spawn is wrapped in bwrap when backend is present", async () => {
  const { deps: d, started } = makeDeps({
    detectBackend: () => "bwrap",
    membraneEnv: () => ({
      claudeDir: "/fake/.claude",
      home: "/fake/home",
      nodeBinReal: "/fake/bin/node",
    }),
    worktree: {
      createDetached: async () => ({ worktreePath: "/review-wt", branch: null, isolated: true }),
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    },
  });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  const argv = started[0]!.argv;
  expect(argv[0]).toBe("bwrap");
  // membrane uses isolated:true → worktree + gitCommonDir binds, not whole repo
  expect(argv).toContain("/review-wt");
  expect(argv).toContain("/fake-git-common");
  // inner argv follows the "--" separator
  const sep = argv.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(argv[sep + 1]).not.toBe("bwrap"); // reviewer argv directly follows, not another bwrap
  expect(argv.at(-1)).toBe(reviewPrompt("main", "do the thing"));
});

test("critic spawn degrades to unwrapped when backend is null", async () => {
  const { deps: d, started } = makeDeps({
    detectBackend: () => null,
    worktree: {
      createDetached: async () => ({ worktreePath: "/review-wt", branch: null, isolated: true }),
      remove: () => {},
      gitCommonDir: () => "/fake-git-common",
    },
  });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  const argv = started[0]!.argv;
  expect(argv[0]).not.toBe("bwrap"); // passthrough — identical to pre-sandbox behavior
});

test("inflightWorktrees: empty before any review starts", () => {
  const { deps: d } = makeDeps({});
  const svc = new ReviewService(d as any);
  expect(svc.inflightWorktrees()).toEqual([]);
});

test("inflightWorktrees: returns worktree path after consider() spawns a review", async () => {
  const { deps: d } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(svc.inflightWorktrees()).toEqual(["/review-wt"]);
});

// ── forceReview (operator-initiated manual re-review) ───────────────────────────

test("forceReview LEVER: re-reviews an unchanged head (same patch-id) that consider() skips", async () => {
  // The regression guard for the actual re-trigger lever (§4): a non-error prior verdict whose
  // patchId equals the current head's computed patch-id. force must SPAWN — proving rebaseSkip
  // did NOT skip because force bypassed shouldSkipForPatchId. NOT reliant on streak/error resets.
  const mk = () =>
    makeDeps({ computePatchId: async () => ({ patchId: "pid-same", baseSha: "b", files: ["f"] }) });

  // control: same head + matching patch-id via the AUTO path → skipped, no spawn.
  const ctl = mk();
  ctl.reviews["s1"] = priorReview({ patchId: "pid-same", headSha: "abc" }); // OPEN_GREEN.headSha
  const ctlSvc = new ReviewService(ctl.deps as any);
  const ctlOutcome = await ctlSvc.consider(session(), OPEN_GREEN);
  expect(ctlOutcome).toBe("skipped");
  expect(ctl.started).toHaveLength(0);

  // forceReview: same setup → bypasses the patch-id skip → spawns.
  const f = mk();
  f.reviews["s1"] = priorReview({ patchId: "pid-same", headSha: "abc" });
  const svc = new ReviewService(f.deps as any);
  const outcome = await svc.forceReview(session(), OPEN_GREEN);
  expect(outcome).toBe("started");
  expect(f.started).toHaveLength(1);
  expect(svc.reviewingIds()).toEqual(["s1"]);
});

test("forceReview: aborts an in-flight run (finalizing=false), reaps it, then respawns", async () => {
  const events: { id: string; reviewing: boolean }[] = [];
  const {
    deps: d,
    started,
    stopped,
    removed,
  } = makeDeps({
    onReviewing: (id: string, reviewing: boolean) => events.push({ id, reviewing }),
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // now in-flight (terminal "rt", worktree /review-wt)
  expect(svc.reviewingIds()).toEqual(["s1"]);
  const outcome = await svc.forceReview(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(outcome).toBe("started");
  // old run reaped: its terminal stopped + worktree removed; onReviewing(false) emitted
  expect(stopped).toContain("rt");
  expect(removed).toContain("/review-wt");
  expect(events).toContainEqual({ id: "s1", reviewing: false });
  // fresh run spawned (a second herdr.start) and is in-flight again
  expect(started).toHaveLength(2);
  expect(svc.reviewingIds()).toEqual(["s1"]);
});

test("forceReview: finalizing in-flight run → skipped, does NOT reap (tick owns teardown)", async () => {
  const { deps: d, started, stopped, removed } = makeDeps({});
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  // tick()'s finalize already owns this run's teardown + verdict.
  (svc as any).inflight.get("s1").finalizing = true;
  const outcome = await svc.forceReview(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(outcome).toBe("skipped");
  expect(stopped).toEqual([]); // not reaped — finalize() owns it
  expect(removed).toEqual([]);
  expect(started).toHaveLength(1); // no respawn
});

test("forceReview: mid-spawn (starting) → skipped", async () => {
  const { deps: d, started } = makeDeps({});
  const svc = new ReviewService(d as any);
  (svc as any).starting.add("s1");
  const outcome = await svc.forceReview(session(), OPEN_GREEN);
  expect(outcome).toBe("skipped");
  expect(started).toHaveLength(0);
});

test("forceReview: preconditions still gate → skipped (CI not green)", async () => {
  const { deps: d, started } = makeDeps({});
  const svc = new ReviewService(d as any);
  expect(await svc.forceReview(session(), { ...OPEN_GREEN, checks: "pending" })).toBe("skipped");
  expect(started).toHaveLength(0);
});

test("forceReview: preconditions still gate → skipped (PR not open)", async () => {
  const { deps: d, started } = makeDeps({});
  const svc = new ReviewService(d as any);
  expect(await svc.forceReview(session(), { ...OPEN_GREEN, state: "merged" })).toBe("skipped");
  expect(started).toHaveLength(0);
});

test("forceReview: preconditions still gate → skipped (critic disabled)", async () => {
  const { deps: d, started } = makeDeps({});
  d.store.getRepoConfig = () => ({ criticEnabled: false, autoAddressEnabled: false });
  const svc = new ReviewService(d as any);
  expect(await svc.forceReview(session(), OPEN_GREEN)).toBe("skipped");
  expect(started).toHaveLength(0);
});

test("forceReview: begin() bails (spawn throws) → error, worktree cleaned up", async () => {
  const { deps: d, removed } = makeDeps({});
  d.herdr.start = () => {
    throw new Error("spawn failed");
  };
  const svc = new ReviewService(d as any);
  const outcome = await svc.forceReview(session(), OPEN_GREEN);
  expect(outcome).toBe("error");
  expect(removed).toEqual(["/review-wt"]); // probe worktree reaped on the bail
  expect(svc.reviewingIds()).toEqual([]); // nothing left in-flight
});

test("forceReview HYGIENE: resets errorRound/streak/reviewedPatchIds/addressRound on the prior verdict", async () => {
  const { deps: d, reviews } = makeDeps({});
  const svc = new ReviewService(d as any);
  reviews["s1"] = priorReview({
    headSha: "abc",
    errorRound: 2,
    streakReviews: 5,
    reviewedPatchIds: ["pid-x", "pid-y"],
    findings: ["still outstanding"],
    addressRound: 1,
    finalRoundPending: true,
  });
  await svc.forceReview(session(), OPEN_GREEN);
  // hygiene resets persisted via putReview, applied before the force re-review runs
  expect(reviews["s1"]?.errorRound).toBe(0);
  expect(reviews["s1"]?.streakReviews).toBe(0);
  expect(reviews["s1"]?.reviewedPatchIds).toEqual([]);
  // auto-address streak also reset so a forced review grants a fresh address budget
  expect(reviews["s1"]?.addressRound).toBe(0);
  expect(reviews["s1"]?.finalRoundPending).toBe(false);
  // outstanding-work state (findings + diff) the critic must re-verify is preserved
  expect(reviews["s1"]?.findings).toEqual(["still outstanding"]);
});

test("forceReview HYGIENE: addressRound at cap (rework stall) → reset clears quota block", async () => {
  const { deps: d, reviews } = makeDeps({});
  const svc = new ReviewService(d as any);
  const addressCap = 3;
  reviews["s1"] = priorReview({
    headSha: "abc",
    errorRound: 0,
    streakReviews: 2,
    reviewedPatchIds: [],
    findings: ["outstanding finding"],
    addressRound: addressCap, // stalled at cap
    addressCap,
    finalRoundPending: false,
  });
  await svc.forceReview(session(), OPEN_GREEN);
  // reset must clear the stall: addressRound back to 0
  expect(reviews["s1"]?.addressRound).toBe(0);
  expect(reviews["s1"]?.finalRoundPending).toBe(false);
  // findings preserved — the critic must still re-verify them
  expect(reviews["s1"]?.findings).toEqual(["outstanding finding"]);
});

// ── reapOrphans (boot reconcile) ────────────────────────────────────────────────

/** Build fake deps for reapOrphans tests — minimal, narrowly focused on reapOrphans. */
function makeOrphanDeps(
  rows: any[],
  opts: {
    sessions?: Record<string, any>;
    reviews?: Record<string, any>;
    agents?: any[];
    worktreeExists?: (p: string) => boolean;
    readUsage?: (wt: string, id: string) => Promise<any>;
  } = {},
) {
  const completedSpawns: { id: string; u: any; at: number }[] = [];
  const droppedReviews: string[] = [];
  const closedTabs: string[] = [];
  const removedWorktrees: string[] = [];
  const agents = opts.agents ?? [];

  const deps = {
    store: {
      listReviewerSpawns: () => rows,
      get: (id: string) => opts.sessions?.[id] ?? null,
      getReview: (id: string) => opts.reviews?.[id] ?? null,
      completeReviewerSpawn: (id: string, u: any, at: number) =>
        completedSpawns.push({ id, u, at }),
      dropReview: (id: string) => droppedReviews.push(id),
      // other store methods not needed for reapOrphans
      getRepoConfig: () => ({ criticEnabled: false, autoAddressEnabled: false }),
      putReview: () => {},
      bumpReviewHead: () => {},
      snapshotReviews: () => ({}),
      addSignal: () => {},
      recordReviewerSpawn: () => {},
    },
    herdr: {
      start: async () => ({ terminalId: "rt" }) as any,
      stop: async () => {},
      list: () => agents,
      closeTab: async (tabId: string) => closedTabs.push(tabId),
    },
    worktree: {
      createDetached: async () => ({ worktreePath: "/wt", branch: null, isolated: true }),
      remove: (p: string) => removedWorktrees.push(p),
      gitCommonDir: () => "/fake-git",
    },
    resolveForge: () => null,
    onChange: () => {},
    detectBackend: () => null,
    worktreeExists: opts.worktreeExists ?? (() => false),
    readUsage: opts.readUsage ?? (async () => null),
    now: () => 9999,
  };

  return { deps, completedSpawns, droppedReviews, closedTabs, removedWorktrees };
}

test("reapOrphans: true orphan (worktree present), error verdict — reaps, drops, returns taskId", async () => {
  const row = {
    reviewerSessionId: "rev-1",
    taskSessionId: "s1",
    kind: "review",
    worktreePath: "/orphan-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const s = session({ id: "s1", desig: "TASK-01" });
  const fakeUsage = {
    input: 10,
    output: 5,
    cacheRead: 20,
    cacheWrite: 1,
    total: 36,
    messageCount: 2,
    lastActivity: 0,
    byModel: {},
    fullRecaches: 0,
    sidechainCount: 0,
  };
  const { deps, completedSpawns, droppedReviews, closedTabs, removedWorktrees } = makeOrphanDeps(
    [row],
    {
      sessions: { s1: s },
      reviews: { s1: priorReview({ decision: "error" }) },
      agents: [
        { name: "review TASK-01", tabId: "tab-99", terminalId: "rt-99", cwd: "/other-wt" } as any,
      ],
      worktreeExists: (p) => p === "/orphan-wt",
      readUsage: async () => fakeUsage,
    },
  );
  const svc = new ReviewService(deps as any);
  const result = await svc.reapOrphans();

  // store.get was called with the taskSessionId
  // squatter found by name "review TASK-01" → closeTab called
  expect(closedTabs).toEqual(["tab-99"]);
  // worktree removed
  expect(removedWorktrees).toEqual(["/orphan-wt"]);
  // spawn row completed with real usage
  expect(completedSpawns).toHaveLength(1);
  expect(completedSpawns[0]!.id).toBe("rev-1");
  expect(completedSpawns[0]!.u.total).toBe(36);
  // error verdict → dropReview called
  expect(droppedReviews).toEqual(["s1"]);
  // taskId in re-kick set
  expect(result).toContain("s1");
});

test("reapOrphans: readUsage returns null → zeroed usage used, full reap for error-verdict orphan", async () => {
  const row = {
    reviewerSessionId: "rev-null",
    taskSessionId: "s1",
    kind: "review",
    worktreePath: "/orphan-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const s = session({ id: "s1", desig: "TASK-01" });
  const { deps, completedSpawns, droppedReviews } = makeOrphanDeps([row], {
    sessions: { s1: s },
    reviews: { s1: priorReview({ decision: "error" }) },
    agents: [],
    worktreeExists: () => true, // true orphan: worktree present, finalize never ran
    readUsage: async () => null,
  });
  const svc = new ReviewService(deps as any);
  const result = await svc.reapOrphans();

  expect(completedSpawns).toHaveLength(1);
  const u = completedSpawns[0]!.u;
  // all numeric fields zeroed
  expect(u.input).toBe(0);
  expect(u.output).toBe(0);
  expect(u.cacheRead).toBe(0);
  expect(u.cacheWrite).toBe(0);
  expect(u.total).toBe(0);
  expect(u.messageCount).toBe(0);
  expect(u.fullRecaches).toBe(0);
  expect(u.sidechainCount).toBe(0);
  // worktree-present error orphan: dropReview called and taskSessionId in re-kick set
  expect(droppedReviews).toContain("s1");
  expect(result).toContain("s1");
});

test("reapOrphans: non-error prior verdict — NOT dropped, BUT taskId IS returned and proc/worktree reaped", async () => {
  const row = {
    reviewerSessionId: "rev-2",
    taskSessionId: "s1",
    kind: "review",
    worktreePath: "/orphan-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const s = session({ id: "s1", desig: "TASK-01" });
  const { deps, completedSpawns, droppedReviews, closedTabs, removedWorktrees } = makeOrphanDeps(
    [row],
    {
      sessions: { s1: s },
      reviews: { s1: priorReview({ decision: "changes_requested" }) },
      agents: [
        { name: "review TASK-01", tabId: "tab-55", terminalId: "rt-55", cwd: "/orphan-wt" } as any,
      ],
      worktreeExists: () => true,
    },
  );
  const svc = new ReviewService(deps as any);
  const result = await svc.reapOrphans();

  // proc and worktree reaped
  expect(closedTabs).toEqual(["tab-55"]);
  expect(removedWorktrees).toEqual(["/orphan-wt"]);
  // spawn row completed
  expect(completedSpawns).toHaveLength(1);
  // NOT dropped (non-error verdict)
  expect(droppedReviews).toEqual([]);
  // but taskId IS in the re-kick set
  expect(result).toContain("s1");
});

test("reapOrphans: worktree absent (cleanly finalized, transcript miss) — completes row, no reap/drop/re-kick", async () => {
  const row = {
    reviewerSessionId: "rev-3",
    taskSessionId: "s1",
    kind: "review",
    worktreePath: "/gone-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const { deps, completedSpawns, droppedReviews, closedTabs, removedWorktrees } = makeOrphanDeps(
    [row],
    {
      sessions: { s1: session({ id: "s1", desig: "TASK-01" }) },
      reviews: {},
      agents: [],
      worktreeExists: () => false, // worktree gone → cleanly finalized
    },
  );
  const svc = new ReviewService(deps as any);
  const result = await svc.reapOrphans();

  // row completed (zeroed usage)
  expect(completedSpawns).toHaveLength(1);
  expect(completedSpawns[0]!.u.total).toBe(0);
  // no reap, no drop, no re-kick
  expect(closedTabs).toEqual([]);
  expect(removedWorktrees).toEqual([]);
  expect(droppedReviews).toEqual([]);
  expect(result).not.toContain("s1");
});

test("reapOrphans: kind=plan_gate and completedAt!=null rows are ignored entirely", async () => {
  const rows = [
    {
      reviewerSessionId: "rev-pg",
      taskSessionId: "pg1",
      kind: "plan_gate",
      worktreePath: "/pg-wt",
      completedAt: null,
      spawnedAt: 0,
    },
    {
      reviewerSessionId: "rev-done",
      taskSessionId: "s2",
      kind: "review",
      worktreePath: "/done-wt",
      completedAt: 12345, // already completed
      spawnedAt: 0,
    },
  ];
  const { deps, completedSpawns, closedTabs, removedWorktrees } = makeOrphanDeps(rows, {
    sessions: { pg1: session({ id: "pg1" }), s2: session({ id: "s2" }) },
    worktreeExists: () => true,
  });
  const svc = new ReviewService(deps as any);
  const result = await svc.reapOrphans();

  // neither row processed (no completions, no reaps, empty re-kick set)
  expect(completedSpawns).toHaveLength(0);
  expect(closedTabs).toHaveLength(0);
  expect(removedWorktrees).toHaveLength(0);
  expect(result).toEqual([]);
});

test("reapOrphans: row body throws → sweep continues to process next row", async () => {
  const throwingRow = {
    reviewerSessionId: "rev-bad",
    taskSessionId: "s-bad",
    kind: "review",
    worktreePath: "/bad-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const goodRow = {
    reviewerSessionId: "rev-good",
    taskSessionId: "s-good",
    kind: "review",
    worktreePath: "/good-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const { deps, completedSpawns } = makeOrphanDeps([throwingRow, goodRow], {
    sessions: { "s-good": session({ id: "s-good", desig: "TASK-02" }) },
    worktreeExists: (p) => p === "/good-wt",
    // readUsage throws for the bad row, returns null for the good one
    readUsage: async (_wt, id) => {
      if (id === "rev-bad") throw new Error("transcript gone");
      return null;
    },
  });
  const svc = new ReviewService(deps as any);
  // must not reject
  const result = await svc.reapOrphans();

  // good row was still processed
  expect(completedSpawns.some((c) => c.id === "rev-good")).toBe(true);
  // good row re-kick (session exists + worktree present)
  expect(result).toContain("s-good");
});

test("reapOrphans: session gone (store.get → undefined) — reaps proc/worktree (cwd fallback), no drop, not returned", async () => {
  const row = {
    reviewerSessionId: "rev-gone",
    taskSessionId: "s-gone",
    kind: "review",
    worktreePath: "/orphan-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const { deps, completedSpawns, droppedReviews, closedTabs, removedWorktrees } = makeOrphanDeps(
    [row],
    {
      sessions: {}, // session gone
      agents: [
        // no name match (session gone, label empty), but cwd matches
        { name: "", tabId: "tab-cwd", terminalId: "rt-cwd", cwd: "/orphan-wt" } as any,
      ],
      worktreeExists: () => true,
    },
  );
  const svc = new ReviewService(deps as any);
  const result = await svc.reapOrphans();

  // spawn row completed
  expect(completedSpawns).toHaveLength(1);
  // squatter found by cwd fallback → closeTab called
  expect(closedTabs).toEqual(["tab-cwd"]);
  // worktree removed
  expect(removedWorktrees).toEqual(["/orphan-wt"]);
  // NOT dropped, NOT returned
  expect(droppedReviews).toEqual([]);
  expect(result).not.toContain("s-gone");
});

test("findSquatter: empty label does NOT match an unnamed agent whose cwd differs (no wrong-agent kill)", async () => {
  // Regression guard for the empty-label correctness edge: when the session is gone the caller
  // passes label="" — a naive `a.name === label` would match any unnamed agent (name="") regardless
  // of cwd, potentially closing an unrelated agent. The fix skips the name match when label is falsy.
  const row = {
    reviewerSessionId: "rev-unrelated",
    taskSessionId: "s-unrelated",
    kind: "review",
    worktreePath: "/orphan-wt",
    completedAt: null,
    spawnedAt: 0,
  };
  const { deps, closedTabs } = makeOrphanDeps([row], {
    sessions: {}, // session gone → label will be ""
    agents: [
      // unnamed agent whose cwd does NOT match the orphan's worktree — must NOT be closed
      {
        name: "",
        tabId: "tab-unrelated",
        terminalId: "rt-unrelated",
        cwd: "/completely-different-wt",
      } as any,
    ],
    worktreeExists: () => true,
  });
  const svc = new ReviewService(deps as any);
  await svc.reapOrphans();

  // The unrelated unnamed agent must not have been killed
  expect(closedTabs).toEqual([]);
});

test("critic: onSpawn fires (kind=review, parentSessionId) and binds credentialDir through to the spawn env", async () => {
  let seen: any;
  const { deps: d, started } = makeDeps({
    // The plugin's pool dir exists on host (#1213 validate-and-skip would otherwise drop a
    // non-existent dir and fall open to the active account).
    pathExists: () => true,
    runSpawnHooks: async (desc: any) => {
      seen = desc;
      return { credentialDir: "/pool/acct-2" };
    },
  });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  expect(seen.kind).toBe("review");
  expect(seen.parentSessionId).toBe("s1"); // the reviewed session's id
  expect(seen.sessionId).not.toBe("s1"); // the critic mints its own one-shot id
  expect(started).toHaveLength(1);
  // detectBackend()→null on the test host → passthrough → the patched dir rides the herdr env,
  // winning over apiKeyPassthroughEnv. (The membrane --setenv path is covered in spawn-membrane.test.ts.)
  expect(started[0]!.env!.CLAUDE_CONFIG_DIR).toBe("/pool/acct-2");
});

test("critic: onSpawn abortSpawn → review skipped, worktree reaped, no spawn", async () => {
  const {
    deps: d,
    started,
    removed,
  } = makeDeps({
    runSpawnHooks: async () => {
      throw new PluginSpawnAborted("pool exhausted", "cswap");
    },
  });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  expect(started).toHaveLength(0);
  expect(removed).toEqual(["/review-wt"]);
});

test("critic: onSpawn abort surfaces the reason as an error verdict (not a silent failure)", async () => {
  const {
    deps: d,
    reviews,
    started,
  } = makeDeps({
    runSpawnHooks: async () => {
      throw new PluginSpawnAborted("no usable ready account available", "cswap");
    },
  });
  await new ReviewService(d as any).consider(session(), OPEN_GREEN);
  expect(started).toHaveLength(0); // never spawned
  const v = reviews["s1"];
  expect(v?.decision).toBe("error");
  expect(v?.summary).toBe("no usable ready account available");
  expect(v?.headSha).toBe("abc");
  expect(v?.findings).toEqual([]); // not findings-bearing → must not trip the spawn ceiling
  expect(v?.patchId).toBe(""); // transient: a later identical head must re-attempt, not inherit it
  expect(v?.spawnAborted).toBe(true); // marks it exempt from the same-head dedup
});

test("critic: an abort verdict does NOT block re-attempting the same head — it self-heals", async () => {
  // First pass: pool cold → abort persists a spawnAborted error verdict for head "abc".
  let cold = true;
  const { deps: d, started } = makeDeps({
    runSpawnHooks: async () => {
      if (cold) throw new PluginSpawnAborted("no usable ready account available", "cswap");
      return {}; // pool warm → empty patch, the spawn proceeds
    },
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  expect(started).toHaveLength(0); // aborted, nothing spawned

  // Pool warms; the SAME head must re-attempt (the abort row is dedup-exempt) and now spawn.
  cold = false;
  await svc.consider(session(), OPEN_GREEN);
  expect(started).toHaveLength(1); // re-attempted on the same head and spawned the critic
});

test("critic: a repeated onSpawn abort for the same head does not churn the verdict", async () => {
  let changes = 0;
  const { deps: d, removed } = makeDeps({
    runSpawnHooks: async () => {
      throw new PluginSpawnAborted("pool cold", "cswap");
    },
    onChange: () => {
      changes++;
    },
  });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.consider(session(), OPEN_GREEN);
  // begin() ran BOTH times (the abort row is dedup-exempt, so consider didn't bail at the
  // same-head guard) — proven by two worktree reaps — yet the (headSha, reason) dedup inside
  // publishSpawnAbort kept it to a single onChange.
  expect(removed).toEqual(["/review-wt", "/review-wt"]);
  expect(changes).toBe(1);
});

// ── #1757: epic-child critic context is wired only for epic children ────────────────────────────

test("#1757 epic child: the critic prompt carries the EPIC CONTEXT block + the collected delta", async () => {
  const { deps: d, started } = makeDeps({
    computePatchId: async () => ({ patchId: "p", baseSha: "deadbeefcafe1234", files: ["x.ts"] }),
    collectBaseDelta: async () => ({
      paths: ["src/base-only.ts"],
      pathsTruncated: 0,
      commits: ["abc1234 feat: sibling landed"],
      commitsTruncated: 0,
    }),
  });
  await new ReviewService(d as any).consider(
    session({ baseBranch: "epic/1757-critic" }),
    OPEN_GREEN,
  );
  const prompt = started[0]!.argv.at(-1)!;
  expect(prompt).toContain("EPIC CONTEXT");
  expect(prompt).toContain("epic/1757-critic");
  expect(prompt).toContain("OVERRIDES the VERIFY rule");
  // the server-collected delta is embedded (and fenced) so the enumeration is data, not diligence
  expect(prompt).toContain("⟦UNTRUSTED:base delta paths:");
  expect(prompt).toContain("src/base-only.ts");
});

test("#1757 non-epic session: no epic block, and the delta is never collected", async () => {
  let collected = 0;
  const { deps: d, started } = makeDeps({
    computePatchId: async () => ({ patchId: "p", baseSha: "deadbeefcafe1234", files: ["x.ts"] }),
    collectBaseDelta: async () => {
      collected++;
      return null;
    },
  });
  await new ReviewService(d as any).consider(session({ baseBranch: "main" }), OPEN_GREEN);
  expect(started[0]!.argv.at(-1)!).not.toContain("EPIC CONTEXT");
  expect(collected).toBe(0); // no wasted git in the common (non-epic) path
});

test("#1757 epic child with an unresolvable base: degraded block, no delta collection", async () => {
  // An epic integration branch usually has no local ref, so a failed fetch leaves baseSha null and
  // every base command would error. The override still ships (the grep-and-conclude rule is still
  // in force), but existence conclusions become limitations rather than findings.
  let collected = 0;
  const { deps: d, started } = makeDeps({
    computePatchId: async () => ({ patchId: "p", baseSha: null, files: ["x.ts"] }),
    collectBaseDelta: async () => {
      collected++;
      return null;
    },
  });
  await new ReviewService(d as any).consider(session({ baseBranch: "epic/9-x" }), OPEN_GREEN);
  const prompt = started[0]!.argv.at(-1)!;
  expect(prompt).toContain("EPIC CONTEXT");
  expect(prompt).toContain("OVERRIDES the VERIFY rule");
  expect(prompt).toContain("It is NOT a finding.");
  expect(prompt).not.toContain("git show");
  expect(collected).toBe(0); // nothing to collect against — never shell out
});

test("#1757 the auto-address steer points an epic child at the base its worktree lacks", async () => {
  // Epic children are deliberately never rebased, so the CHILD's own worktree is missing the merged
  // sibling work too. The critic can now ground a finding in that base code — without this note the
  // agent receiving the finding cannot SEE the code it names, and would "fix" it against a tree
  // that lacks it.
  const { deps: d, steers } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "s",
        body: "b",
        findings: ["src/child.ts: imports `helper`, which a merged sibling removed"],
      }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session({ baseBranch: "epic/1757-critic" }), OPEN_GREEN);
  await svc.tick();
  expect(steers[0]!.text).toContain("has NOT been rebased onto it");
  expect(steers[0]!.text).toContain("git fetch origin epic/1757-critic");
  expect(steers[0]!.text).toContain("git show FETCH_HEAD:<path>");
});

test("#1757 a non-epic steer is unchanged (no base note)", async () => {
  const { deps: d, steers } = makeDeps(
    {
      readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }),
    },
    { autoAddressEnabled: true },
  );
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(steers[0]!.text).not.toContain("rebased onto");
  expect(steers[0]!.text).not.toContain("FETCH_HEAD");
});
