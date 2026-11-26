import { test, expect, describe, setSystemTime, afterEach } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import { GithubForge, type GhRunner } from "../src/forge/github";
import { graphRateLimit } from "../src/forge/rate-limit";
import { setIssuesFreshness } from "../src/forge/repo-freshness";
import type { GitState, OpenPrSnapshot } from "../src/forge/types";
import type { Session } from "../src/types";
import type { UsageLimits as UsageLimitsType } from "../src/usage-limits";

// #2807: a running epic's structure used to be re-read every ~10 s at N + 2 GitHub calls — one
// REST blocked_by per child. These drive DrainService.buildEpic against a real GithubForge and
// count the `gh` calls it makes.

const REPO = "/repo";
const PARENT = 28;
/** The calendar epic's shape: 38 children, #29–#66, each blocked by the one before. */
const CHILDREN = Array.from({ length: 38 }, (_, i) => 29 + i);
const START = Date.parse("2026-10-05T13:00:00Z");

const NO_USAGE: UsageLimitsType = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

function structureJson(closed: Set<number>): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number: PARENT,
          title: "Calendar",
          state: "OPEN",
          body: "",
          url: `u${PARENT}`,
          subIssues: {
            nodes: CHILDREN.map((n) => ({
              number: n,
              title: `child ${n}`,
              url: `u${n}`,
              body: "",
              state: closed.has(n) ? "CLOSED" : "OPEN",
              labels: { nodes: [] },
              blockedBy: { nodes: n === CHILDREN[0] ? [] : [{ number: n - 1 }] },
            })),
          },
        },
      },
    },
  });
}

/** A recording `gh`: answers the one-query read, the REST parts, and the branch scan. */
function ghRunner(closed: Set<number>) {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === "graphql") return structureJson(closed);
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (path === `repos/o/r/issues/${PARENT}`) {
      return JSON.stringify({ number: PARENT, title: "Calendar", body: "", html_url: "u" });
    }
    if (path.endsWith("/sub_issues")) {
      return JSON.stringify(
        CHILDREN.map((n) => ({
          number: n,
          title: `child ${n}`,
          html_url: `u${n}`,
          state: closed.has(n) ? "closed" : "open",
        })),
      );
    }
    const blocked = path.match(/issues\/(\d+)\/dependencies\/blocked_by$/);
    if (blocked) {
      const n = Number(blocked[1]);
      return JSON.stringify(n === CHILDREN[0] ? [] : [{ number: n - 1 }]);
    }
    return "[]"; // matching-refs: no stray epic branches
  };
  return {
    run,
    structureQueries: () => calls.filter((c) => c[1] === "graphql").length,
    blockedByRest: () => calls.filter((c) => c.some((a) => a.endsWith("/blocked_by"))).length,
  };
}

function makeDrain(
  run: GhRunner,
  openPrSnapshot?: ConstructorParameters<typeof DrainService>[0]["openPrSnapshot"],
) {
  const store = new SessionStore(":memory:");
  store.setEpicRun({ repoPath: REPO, parentIssueNumber: PARENT, mode: "auto", status: "running" });
  const forge = new GithubForge("o/r", {} as never, run);
  const target = new GithubForge("o/target", {} as never, run);
  const drain = new DrainService({
    openPrSnapshot,
    store,
    service: {
      create: async (): Promise<Session> => {
        throw new Error("not spawning in this test");
      },
      archive: async (): Promise<number> => 0,
    },
    resolveForge: (repoPath) => (repoPath === REPO ? forge : target),
    prCache: { snapshot: () => ({}) as Record<string, GitState> },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    now: () => Date.now(),
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    rebaseCap: 5,
  });
  return { drain, store, run: store.getEpicRun(REPO)! };
}

/** Assemble the epic every 10 s (the old cache window) for `minutes`, starting at `from`. */
async function buildEvery10s(build: () => Promise<unknown>, from: number, minutes: number) {
  for (let s = 0; s <= minutes * 60; s += 10) {
    setSystemTime(new Date(from + s * 1_000));
    await build();
  }
}

afterEach(() => {
  setIssuesFreshness(null);
  setSystemTime();
});

describe("epic structure reads (#2807)", () => {
  test("a quiet 38-child epic makes one structure query per 5 min and no blocked_by calls", async () => {
    const closed = new Set<number>();
    const gh = ghRunner(closed);
    const { drain, run } = makeDrain(gh.run);
    let gen = 1;
    setIssuesFreshness(() => String(gen));

    await buildEvery10s(() => drain.buildEpic(REPO, run), START, 10);
    // The first read, then the covered 5-min refreshes at 5 and 10 min (#4266).
    expect(gh.structureQueries()).toBe(3);
    expect(gh.blockedByRest()).toBe(0);

    // A blocker closes on GitHub; the next fingerprint moves the issue generation.
    closed.add(29);
    gen++;
    setSystemTime(new Date(START + 11 * 60_000));
    const epic = await drain.buildEpic(REPO, run);
    expect(gh.structureQueries()).toBe(4);
    expect(epic!.children.find((c) => c.number === 30)!.state).toBe("ready");
    expect(epic!.children.find((c) => c.number === 31)!.state).toBe("blocked");
  });

  test("with GraphQL in backoff the REST fallback runs once per cache window", async () => {
    const gh = ghRunner(new Set());
    const { drain, run } = makeDrain(gh.run);
    setIssuesFreshness(() => "key-1");
    setSystemTime(new Date(START));
    graphRateLimit.noteLimitError(3_600);
    try {
      await buildEvery10s(() => drain.buildEpic(REPO, run), START, 10);
      expect(gh.structureQueries()).toBe(0);
      expect(gh.blockedByRest()).toBe(CHILDREN.length); // one read per child, once
    } finally {
      graphRateLimit.noteSuccess();
    }
  });
});

describe("archived epic child reviews", () => {
  function snapshot(slug: string, ...numbers: number[]): OpenPrSnapshot {
    return {
      prs: numbers.map((number) => ({
        number,
        url: `https://github.com/${slug}/pull/${number}`,
        author: "me",
        kind: "regular",
        title: "PR",
        createdAt: 0,
        isDraft: false,
        mergeable: null,
        checks: "none",
        jobs: [],
      })),
      statuses: new Map(),
      capped: false,
    };
  }

  function seed(
    store: SessionStore,
    issue: number,
    pr: number | null,
    repoPath = REPO,
    routed = false,
  ) {
    const s = store.create({
      name: "work",
      prompt: "",
      repoPath,
      baseBranch: "main",
      branch: "topic",
      worktreePath: "/wt",
      isolated: true,
      herdrSession: "s",
      herdrAgentId: "t",
      issueNumber: routed ? null : issue,
      homeIssueNumber: routed ? issue : null,
      homeIssueRepoPath: routed ? REPO : null,
    });
    store.upsertDeliveryFact({
      sessionId: s.id,
      repoPath,
      desig: s.desig,
      createdAt: s.createdAt,
      issueNumber: s.issueNumber,
      prNumber: pr,
      now: START,
    });
    return s;
  }

  test("confirms manual archives in their own PR repository and skips merged, closed and superseded work", async () => {
    const reads: string[] = [];
    const snapshots = new Map([
      ["o/r", snapshot("o/r", 10, 11, 12)],
      ["o/target", snapshot("o/target", 13)],
    ]);
    const { drain, run, store } = makeDrain(ghRunner(new Set()).run, {
      peekCurrent: (forge) => ({ at: START, value: snapshots.get(forge.slug!)! }),
      get: async (forge) => {
        reads.push(forge.slug!);
        return snapshots.get(forge.slug!)!;
      },
    });
    store.archive(seed(store, 29, 10).id);
    store.archive(seed(store, 30, 11).id, "merged");
    store.archive(seed(store, 31, 55).id);
    store.archive(seed(store, 32, 12).id);
    seed(store, 32, 99); // live manual successor
    store.archive(seed(store, 33, 13, "/target", true).id);
    store.archive(seed(store, 34, 10, "/target", true).id); // only open in the home repo
    store.archive(seed(store, 35, 13, "/target").id); // target's own issue #35
    store.archive(seed(store, 36, 12).id);
    store.archive(seed(store, 36, null).id); // newer archived attempt with no PR

    const epic = await drain.buildEpic(REPO, run);
    expect(
      epic!.children.filter((c) => c.archivedReview).map((c) => [c.number, c.archivedReview]),
    ).toEqual([
      [29, { number: 10, url: "https://github.com/o/r/pull/10" }],
      [33, { number: 13, url: "https://github.com/o/target/pull/13" }],
    ]);
    expect(reads.sort()).toEqual(["o/r", "o/target"]);
  });

  test("an unreadable, stale or capped snapshot leaves the epic available", async () => {
    const value = snapshot("o/r", 10);
    let mode: "failure" | "stale" | "capped" = "failure";
    const { drain, run, store } = makeDrain(ghRunner(new Set()).run, {
      peekCurrent: () =>
        mode === "capped" ? { at: START, value: { ...value, capped: true } } : null,
      get: async () => {
        if (mode === "failure") throw new Error("offline");
        return value;
      },
    });
    store.archive(seed(store, 29, 10).id);
    for (mode of ["failure", "stale", "capped"] as const) {
      const epic = await drain.buildEpic(REPO, run);
      expect(epic!.children[0]!.archivedReview).toBeUndefined();
    }
  });
});
