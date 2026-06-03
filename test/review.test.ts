import { test, expect } from "bun:test";
import { ReviewService, reviewPrompt } from "../src/review";
import { CRITIC_REVIEW_MARKER, AUTHOR_RESPONSE_MARKER } from "../src/forge/types";
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
    readyToMerge: false,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotQuestion: null,
    status: "running",
    lastState: "idle",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
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
): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
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
}

function makeDeps(
  over: any,
  opts: {
    autoAddressEnabled?: boolean;
    autoAddressReturns?: boolean;
    comments?: PrComment[];
    prStatus?: () => Promise<PrStatus>;
  } = {},
) {
  const reviews: Record<string, ReviewVerdict> = {};
  const started: { name: string; cwd: string; argv: string[] }[] = [];
  const stopped: string[] = [];
  const removed: string[] = [];
  const bumped: { id: string; headSha: string }[] = []; // bumpReviewHead calls (rebase-skip)
  const steers: { id: string; text: string }[] = [];
  const signals: { kind: string; payload: string }[] = [];
  const commentCalls: number[] = []; // prNumbers passed to listPrComments
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
    },
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        started.push({ name, cwd, argv });
        return { terminalId: "rt" } as any;
      },
      stop: (t: string) => stopped.push(t),
    },
    worktree: {
      createDetached: () => ({ worktreePath: "/review-wt", branch: null, isolated: true }),
      remove: (p: string) => removed.push(p),
    },
    resolveForge: () => fakeForge(rec, opts.comments ?? [], commentCalls, opts.prStatus),
    onChange: () => {},
    autoAddress: (id: string, text: string) => {
      steers.push({ id, text });
      return opts.autoAddressReturns ?? true;
    },
    now: () => 1000,
    readVerdict: () => ({ decision: "request-changes", summary: "2 issues", body: "## findings" }),
    ...over,
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
    rec,
  };
}

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
  svc.consider(session(), OPEN_GREEN);
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

test("onReviewing fires true on spawn and false on finalize", async () => {
  const events: { id: string; reviewing: boolean }[] = [];
  const { deps: d } = makeDeps({
    onReviewing: (id: string, reviewing: boolean) => events.push({ id, reviewing }),
  });
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN);
  expect(events).toEqual([{ id: "s1", reviewing: true }]);
  await svc.tick();
  expect(events).toEqual([
    { id: "s1", reviewing: true },
    { id: "s1", reviewing: false },
  ]);
});

test("onReviewing fires false when an in-flight critic is forgotten", () => {
  const events: { id: string; reviewing: boolean }[] = [];
  const { deps: d } = makeDeps({
    onReviewing: (id: string, reviewing: boolean) => events.push({ id, reviewing }),
  });
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN);
  svc.forget("s1");
  expect(events).toEqual([
    { id: "s1", reviewing: true },
    { id: "s1", reviewing: false },
  ]);
});

test("critic spawns read-only: no skip-permissions, dontAsk + scoped allowlist", () => {
  const { deps: d, started } = makeDeps({});
  new ReviewService(d as any).consider(session(), OPEN_GREEN);
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
  expect(argv[argv.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
});

test("task prompt survives the variadic allowlist (not swallowed → no task → timeout)", () => {
  const { deps: d, started } = makeDeps({});
  new ReviewService(d as any).consider(session(), OPEN_GREEN);
  const argv = started[0]!.argv;
  // `--allowedTools <tools...>` is variadic: it greedily eats every following
  // token until the next flag. The task prompt is the trailing positional, so a
  // single-value flag MUST sit between the allowlist and the prompt — otherwise
  // the real `claude` CLI folds the prompt into the allowlist and the critic
  // launches with no task, hanging until the 10-min timeout (every review).
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
  svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  svc.consider(session(), OPEN_GREEN); // same headSha already reviewed
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
  svc.consider(session(), OPEN_GREEN);
  t = 1000 + 6000;
  await svc.tick();
  expect(reviews["s1"]?.decision).toBe("error");
  expect(stopped).toEqual(["rt"]);
  expect(removed).toEqual(["/review-wt"]);
});

test("comment decision maps to COMMENT and never approves", async () => {
  const { deps: d, rec } = makeDeps({
    readVerdict: () => ({ decision: "comment", summary: "ok", body: "lgtm-ish" }),
  });
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(rec.event).toBe("COMMENT");
});

test("forget reaps an in-flight critic and drops the stored review", () => {
  const { deps: d, reviews, stopped, removed } = makeDeps({});
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN); // now in-flight
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
    computePatchId: () => "pid-same",
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
  const { deps: d, reviews, started, bumped } = makeDeps({ computePatchId: () => "pid-new" });
  reviews["s1"] = priorReview({ patchId: "pid-old", headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(bumped).toHaveLength(0); // not a skip
  expect(started).toHaveLength(1); // critic spawned
  await svc.tick();
  expect(reviews["s1"]?.patchId).toBe("pid-new"); // fingerprint persisted on the verdict
});

test("first review records the fingerprint for later rebase-skip", async () => {
  const { deps: d, reviews, started } = makeDeps({ computePatchId: () => "pid-first" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN); // no prior
  expect(started).toHaveLength(1);
  await svc.tick();
  expect(reviews["s1"]?.patchId).toBe("pid-first");
});

test("unresolvable fingerprint never skips: reviews even with a prior verdict", async () => {
  const { deps: d, reviews, started, bumped } = makeDeps({ computePatchId: () => null });
  // prior has a real patch-id, but this run can't fingerprint (git failed / empty diff)
  reviews["s1"] = priorReview({ patchId: "pid-old", headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(bumped).toHaveLength(0); // safety default → do not skip
  expect(started).toHaveLength(1); // reviewed
});

test("prior error verdict never rebase-skips (retries the transient failure)", async () => {
  const { deps: d, reviews, started, bumped } = makeDeps({ computePatchId: () => "pid-same" });
  // an errored prior that (legacy row / defensive) still carries a matching fingerprint
  reviews["s1"] = priorReview({ decision: "error", patchId: "pid-same", headSha: "old" });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), { ...OPEN_GREEN, headSha: "newsha" });
  expect(bumped).toHaveLength(0); // not skipped despite identical fingerprint
  expect(started).toHaveLength(1); // re-reviewed instead of inheriting the stale error
});

test("error verdict records no fingerprint (so a later head always re-reviews)", async () => {
  const { deps: d, reviews } = makeDeps({
    computePatchId: () => "pid-x",
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
  } = makeDeps({ computePatchId: () => "pid-same" }, { autoAddressEnabled: true });
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
  svc.consider(session(), OPEN_GREEN);
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
  svc.consider(session(), OPEN_GREEN);
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

test("PR merged before finalize: verdict is moot — no review posted, no steer, no signal", async () => {
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
        summary: "x",
        body: "b",
        findings: ["fix x"],
      }),
    },
    // critic spawned while open, but the PR merged before the verdict finalized
    { autoAddressEnabled: true, prStatus: async () => ({ ...OPEN_GREEN, state: "merged" }) },
  );
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN); // spawn while open (no prStatus call yet)
  await svc.tick(); // finalize: live recheck sees "merged" → fully inert
  expect(steers).toHaveLength(0); // no churn steered onto a merged branch
  expect(rec.event).toBeUndefined(); // moot: no review posted on a merged PR
  expect(signals.some((s) => s.kind === "critic")).toBe(false); // and no learnings signal
  expect(reviews["s1"]?.decision).toBe("changes_requested"); // verdict still persisted (UI/dedup)
  expect(reviews["s1"]?.addressRound).toBe(0); // no steer round
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
  svc.consider(session(), OPEN_GREEN);
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
  } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "nit", body: "b", findings: ["x"] }) },
    { autoAddressEnabled: true, prStatus: async () => ({ ...OPEN_GREEN, state: "closed" }) },
  );
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(steers).toHaveLength(0); // guard is state !== "open", not just merged
  expect(rec.event).toBeUndefined(); // closed PR → review not posted
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
  svc.consider(session(), OPEN_GREEN);
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
  svc.consider(session(), OPEN_GREEN); // first review (no prior) → sync spawn
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

test("first review does NOT fetch author notes", () => {
  const { deps: d, commentCalls } = makeDeps({}, { autoAddressEnabled: true });
  new ReviewService(d as any).consider(session(), OPEN_GREEN); // no prior → first review
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
  svc.consider(session(), OPEN_GREEN); // first review (no prior) → sync spawn
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

// ── follow-up polish (#247) ─────────────────────────────────────────────────────

test("verdict surfaces the configured cap so the UI need not mirror it", async () => {
  const { deps: d, reviews } = makeDeps({ cap: 5 });
  const svc = new ReviewService(d as any);
  svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressCap).toBe(5); // ReviewService({cap}) → verdict payload
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
