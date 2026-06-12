import { test, expect } from "bun:test";
import { StandalonePrCriticService } from "../src/standalone-critic";
import { CRITIC_REVIEW_MARKER } from "../src/forge/types";
import type { GitForge, PrReviewMeta, PullRequest } from "../src/forge/types";
import type { PrReview } from "../src/types";

// ── fixtures ────────────────────────────────────────────────────────────────

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "Add a feature",
    url: "u",
    author: "alice",
    kind: "regular",
    createdAt: 0,
    isDraft: false,
    mergeable: true,
    checks: "success",
    jobs: [],
    headSha: "abc123",
    headRefName: "feat/x",
    ...over,
  };
}

const OPEN_META: PrReviewMeta = {
  body: "does the thing",
  baseRefName: "main",
  isCrossRepository: false,
  state: "open",
};

interface Spies {
  posted: { n: number; event: string; body: string }[];
  comments: { n: number; body: string }[];
  started: { name: string; cwd: string; argv: string[] }[];
  stopped: string[];
  removed: string[];
  created: { branch: string; sha: string; slug?: string; pullRef?: string }[];
  bumped: { repoPath: string; prNumber: number; headSha: string }[];
  puts: PrReview[];
  recordedSpawns: any[];
  completedSpawns: any[];
  logs: string[];
}

function makeForge(
  spies: Spies,
  opts: {
    prs?: PullRequest[];
    meta?: (n: number) => Promise<PrReviewMeta | null>;
    noComment?: boolean;
    noMeta?: boolean;
  } = {},
): GitForge {
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => opts.prs ?? [pr()],
    prStatus: async () => ({ state: "open", checks: "success", deployConfigured: false }),
    openPr: async () => ({ state: "open", checks: "success", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    defaultBranch: async () => "main",
    postReview: async (n, o) => {
      spies.posted.push({ n, event: o.event, body: o.body });
      return { url: "ru" };
    },
  };
  if (!opts.noMeta) forge.prReviewMeta = opts.meta ?? (async () => OPEN_META);
  if (!opts.noComment)
    forge.comment = async (n, body) => {
      spies.comments.push({ n, body });
    };
  return forge;
}

function makeDeps(
  over: Partial<any> = {},
  opts: {
    repos?: string[];
    criticAllPrs?: boolean | ((r: string) => boolean);
    criticEnabled?: boolean;
    managed?: (r: string) => Set<string>;
    forge?: (r: string) => GitForge | null;
    priorReviews?: Record<string, PrReview>; // keyed `${repo}#${n}`
    concurrency?: number;
  } = {},
) {
  const spies: Spies = {
    posted: [],
    comments: [],
    started: [],
    stopped: [],
    removed: [],
    created: [],
    bumped: [],
    puts: [],
    recordedSpawns: [],
    completedSpawns: [],
    logs: [],
  };
  const reviews: Record<string, PrReview> = { ...(opts.priorReviews ?? {}) };
  const rk = (repoPath: string, n: number) => `${repoPath}#${n}`;
  const deps = {
    store: {
      getRepoConfig: (r: string) => ({
        criticAllPrs:
          typeof opts.criticAllPrs === "function"
            ? opts.criticAllPrs(r)
            : (opts.criticAllPrs ?? true),
        criticEnabled: opts.criticEnabled ?? true,
      }),
      getPrReview: (repoPath: string, n: number) => reviews[rk(repoPath, n)] ?? null,
      putPrReview: (v: PrReview) => {
        spies.puts.push(v);
        reviews[rk(v.repoPath, v.prNumber)] = v;
      },
      bumpPrReviewHead: (repoPath: string, prNumber: number, headSha: string, now: number) => {
        spies.bumped.push({ repoPath, prNumber, headSha });
        const r = reviews[rk(repoPath, prNumber)];
        if (r) reviews[rk(repoPath, prNumber)] = { ...r, headSha, updatedAt: now };
      },
      recordReviewerSpawn: (r: any) => spies.recordedSpawns.push(r),
      completeReviewerSpawn: (id: string, u: any, at: number) =>
        spies.completedSpawns.push({ id, u, at }),
    },
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        spies.started.push({ name, cwd, argv });
        return { terminalId: "rt" } as any;
      },
      stop: (t: string) => spies.stopped.push(t),
    },
    worktree: {
      createDetached: async (
        _repo: string,
        branch: string,
        sha: string,
        slug?: string,
        pullRef?: string,
      ) => {
        spies.created.push({ branch, sha, slug, pullRef });
        return { worktreePath: "/review-wt", branch: null, isolated: true };
      },
      remove: (p: string) => spies.removed.push(p),
    },
    resolveForge: opts.forge ?? (() => makeForge(spies)),
    repos: () => opts.repos ?? ["/r"],
    managedBranches: opts.managed ?? (() => new Set<string>()),
    concurrency: opts.concurrency,
    now: () => 1000,
    log: (msg: string) => spies.logs.push(msg),
    // default: a request-changes verdict with one finding
    readVerdict: () => ({
      decision: "request-changes",
      summary: "1 issue",
      body: "## findings",
      findings: ["feat/x: a bug"],
    }),
    // no real git: keep base unknown so the scope backstop is skipped (findings pass through)
    computePatchId: async () => ({ patchId: "p1", baseSha: null, files: [] }),
    readUsage: async () => null,
    ...over,
  };
  return { deps, spies, reviews };
}

// ── 1. filter ────────────────────────────────────────────────────────────────

test("reviews a fresh open green regular session-less PR", async () => {
  const { deps, spies } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(1);
  expect(spies.started[0]!.name).toBe("pr-critic /r#7");
  expect(spies.recordedSpawns).toHaveLength(1);
  expect(spies.recordedSpawns[0]!.taskSessionId).toBe("pr:/r#7");
});

test("skips draft / non-green / bot PRs", async () => {
  for (const bad of [
    pr({ number: 1, isDraft: true }),
    pr({ number: 2, checks: "pending" }),
    pr({ number: 3, checks: "failure" }),
    pr({ number: 4, kind: "dependabot" }),
    pr({ number: 5, kind: "release" }),
  ]) {
    const local = makeDeps({}, { forge: undefined });
    local.deps.resolveForge = () => makeForge(local.spies, { prs: [bad] });
    const svc = new StandalonePrCriticService(local.deps as any);
    await svc.sweep();
    expect(local.spies.started).toHaveLength(0);
  }
});

// tiny helper for tests that re-wire the forge with throwaway spies
function spies0(): Spies {
  return {
    posted: [],
    comments: [],
    started: [],
    stopped: [],
    removed: [],
    created: [],
    bumped: [],
    puts: [],
    recordedSpawns: [],
    completedSpawns: [],
    logs: [],
  };
}

test("skips a PR already reviewed at this exact head", async () => {
  const { deps, spies } = makeDeps(
    {},
    {
      priorReviews: {
        "/r#7": {
          repoPath: "/r",
          prNumber: 7,
          headSha: "abc123", // same as pr().headSha → already reviewed
          patchId: "old",
          decision: "commented",
          reviewedPatchIds: [],
          updatedAt: 0,
        },
      },
    },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
});

test("skips a PR missing headSha/headRefName (logged)", async () => {
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () => makeForge(local.spies, { prs: [pr({ headSha: undefined })] });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(0);
  expect(local.spies.logs.some((l) => l.includes("missing headSha"))).toBe(true);
});

// ── 2. session-managed exclusion + criticEnabled coverage hole ───────────────

test("skips a session-managed branch when criticEnabled is ON", async () => {
  const { deps, spies } = makeDeps({}, { criticEnabled: true, managed: () => new Set(["feat/x"]) });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
});

test("REVIEWS a session-managed branch when criticEnabled is OFF (coverage hole)", async () => {
  const { deps, spies } = makeDeps(
    {},
    { criticEnabled: false, managed: () => new Set(["feat/x"]) },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(1);
});

test("does nothing for a repo whose criticAllPrs is OFF", async () => {
  const { deps, spies } = makeDeps({}, { criticAllPrs: false });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
});

// ── 3. in-flight exclusion across sweeps ─────────────────────────────────────

test("does not double-spawn an in-flight PR across two sweeps", async () => {
  const { deps, spies } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.sweep(); // no tick() between → still in flight
  expect(spies.started).toHaveLength(1);
  expect(spies.created).toHaveLength(1);
});

// ── 4. patch-id skip ─────────────────────────────────────────────────────────

test("patch-id match: no spawn, head bumped, worktree reaped, skip logged", async () => {
  const { deps, spies } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "p1", baseSha: null, files: [] }),
    },
    {
      priorReviews: {
        "/r#7": {
          repoPath: "/r",
          prNumber: 7,
          headSha: "OLDHEAD", // different head → passes the head-dedup, reaches patch-id skip
          patchId: "p1", // same patch-id → pure rebase, skip
          decision: "commented",
          reviewedPatchIds: [],
          updatedAt: 0,
        },
      },
    },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
  expect(spies.bumped).toEqual([{ repoPath: "/r", prNumber: 7, headSha: "abc123" }]);
  expect(spies.removed).toEqual(["/review-wt"]);
  expect(spies.logs.some((l) => l.includes("unchanged diff"))).toBe(true);
});

// ── 5. concurrency cap ───────────────────────────────────────────────────────

test("concurrency=1: only one of two eligible PRs spawns, the other is deferred", async () => {
  const local = makeDeps({}, { concurrency: 1, forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, { prs: [pr({ number: 7 }), pr({ number: 8, headRefName: "feat/y" })] });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(1);
  expect(local.spies.logs.some((l) => l.includes("deferred"))).toBe(true);
});

// ── 6. finalize publish ──────────────────────────────────────────────────────

test("open PR: finalize posts a COMMENT (never REQUEST_CHANGES) even on a request-changes verdict", async () => {
  const { deps, spies } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick();
  expect(spies.posted).toHaveLength(1);
  expect(spies.posted[0]!.event).toBe("COMMENT");
  expect(spies.posted[0]!.body).toContain(CRITIC_REVIEW_MARKER);
  expect(spies.stopped).toEqual(["rt"]);
  expect(spies.removed).toEqual(["/review-wt"]);
  // dedup row persisted
  expect(spies.puts).toHaveLength(1);
  expect(spies.puts[0]!.decision).toBe("changes_requested");
});

test("merged PR with findings: post-merge comment, no review posted", async () => {
  let calls = 0;
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, {
      meta: async () => {
        // open at begin(), merged at finalize
        calls++;
        return calls === 1 ? OPEN_META : { ...OPEN_META, state: "merged" };
      },
    });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  await svc.tick();
  expect(local.spies.posted).toHaveLength(0); // no review on a merged PR
  expect(local.spies.comments).toHaveLength(1);
  expect(local.spies.comments[0]!.body).toContain("after this PR merged");
});

test("closed PR: silent (no review, no comment)", async () => {
  let calls = 0;
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, {
      meta: async () => {
        calls++;
        return calls === 1 ? OPEN_META : { ...OPEN_META, state: "closed" };
      },
    });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  await svc.tick();
  expect(local.spies.posted).toHaveLength(0);
  expect(local.spies.comments).toHaveLength(0);
  // dedup row still written
  expect(local.spies.puts).toHaveLength(1);
});

// ── 7. fork ──────────────────────────────────────────────────────────────────

test("cross-repository PR: createDetached is called with the pull ref", async () => {
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, { meta: async () => ({ ...OPEN_META, isCrossRepository: true }) });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.created).toHaveLength(1);
  expect(local.spies.created[0]!.pullRef).toBe("refs/pull/7/head");
});

// ── 8. dedup persistence ─────────────────────────────────────────────────────

test("findings verdict appends the patch-id to reviewedPatchIds", async () => {
  const { deps, spies } = makeDeps({
    computePatchId: async () => ({ patchId: "pNEW", baseSha: null, files: [] }),
  });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick();
  expect(spies.puts[0]!.reviewedPatchIds).toEqual(["pNEW"]);
});

test("clean verdict resets reviewedPatchIds to []", async () => {
  const { deps, spies } = makeDeps(
    {
      readVerdict: () => ({ decision: "comment", summary: "ok", body: "lgtm", findings: [] }),
      computePatchId: async () => ({ patchId: "pNEW", baseSha: null, files: [] }),
    },
    {
      priorReviews: {
        "/r#7": {
          repoPath: "/r",
          prNumber: 7,
          headSha: "OLDHEAD",
          patchId: "pOLD",
          decision: "changes_requested",
          reviewedPatchIds: ["pOLD"],
          updatedAt: 0,
        },
      },
    },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick();
  expect(spies.puts[0]!.reviewedPatchIds).toEqual([]);
  expect(spies.puts[0]!.decision).toBe("commented");
});

// ── 9. round-robin fairness ──────────────────────────────────────────────────

test("two enabled repos: the round-robin offset rotates which repo is considered first", async () => {
  // Fairness is about ORDER of consideration, not who ultimately spawns (the cap can block the
  // later repo). Record the repo each sweep enumerates FIRST via the listPullRequests call order,
  // and assert it alternates /a, /b, /a, … so one busy repo can't perpetually preempt the other.
  const considered: string[] = [];
  const base = makeDeps({}, { repos: ["/a", "/b"], concurrency: 5, forge: undefined });
  base.deps.resolveForge = (r: string) => {
    const f = makeForge(spies0(), {});
    f.listPullRequests = async () => {
      considered.push(r);
      return []; // empty so nothing spawns and the cap never fills — isolates the ordering
    };
    return f;
  };
  const svc = new StandalonePrCriticService(base.deps as any);
  await svc.sweep(); // offset 0 → /a, /b
  await svc.sweep(); // offset 1 → /b, /a
  await svc.sweep(); // offset 0 → /a, /b
  expect(considered).toEqual(["/a", "/b", "/b", "/a", "/a", "/b"]);
});
