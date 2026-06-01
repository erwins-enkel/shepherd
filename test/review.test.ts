import { test, expect } from "bun:test";
import { ReviewService, reviewPrompt } from "../src/review";
import type { GitForge, GitState, PrStatus } from "../src/forge/types";
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

function fakeForge(rec: { event?: string; body?: string }): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    prStatus: async () => OPEN_GREEN as PrStatus,
    openPr: async () => OPEN_GREEN as PrStatus,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async (_n, o) => {
      rec.event = o.event;
      rec.body = o.body;
      return { url: "ru" };
    },
  };
}

function makeDeps(over: any) {
  const reviews: Record<string, ReviewVerdict> = {};
  const started: { name: string; cwd: string; argv: string[] }[] = [];
  const stopped: string[] = [];
  const removed: string[] = [];
  const rec: { event?: string; body?: string } = {};
  const base = {
    store: {
      getRepoConfig: () => ({ criticEnabled: true }),
      getReview: (id: string) => reviews[id] ?? null,
      putReview: (v: ReviewVerdict) => {
        reviews[v.sessionId] = v;
      },
      dropReview: (id: string) => {
        delete reviews[id];
      },
      snapshotReviews: () => reviews,
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
    resolveForge: () => fakeForge(rec),
    onChange: () => {},
    now: () => 1000,
    readVerdict: () => ({ decision: "request-changes", summary: "2 issues", body: "## findings" }),
    ...over,
  };
  return { deps: base, reviews, started, stopped, removed, rec };
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
    decision: "commented",
    summary: "",
    body: "",
    updatedAt: 1,
  };
  svc.forget("s1");
  expect(stopped).toEqual(["rt"]); // critic terminal reaped
  expect(removed).toEqual(["/review-wt"]); // worktree removed
  expect(reviews["s1"]).toBeUndefined(); // stored verdict dropped
});
