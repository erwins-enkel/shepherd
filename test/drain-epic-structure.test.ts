import { test, expect, describe, setSystemTime, afterEach } from "bun:test";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import { GithubForge, type GhRunner } from "../src/forge/github";
import { graphRateLimit } from "../src/forge/rate-limit";
import { setIssuesFreshness } from "../src/forge/repo-freshness";
import type { GitState } from "../src/forge/types";
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

function makeDrain(run: GhRunner) {
  const store = new SessionStore(":memory:");
  store.setEpicRun({ repoPath: REPO, parentIssueNumber: PARENT, mode: "auto", status: "running" });
  const forge = new GithubForge("o/r", {} as never, run);
  const drain = new DrainService({
    store,
    service: {
      create: async (): Promise<Session> => {
        throw new Error("not spawning in this test");
      },
      archive: async (): Promise<number> => 0,
    },
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) as Record<string, GitState> },
    usage: { limits: (): UsageLimitsType => NO_USAGE },
    repos: () => [REPO],
    now: () => Date.now(),
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    rebaseCap: 5,
  });
  return { drain, run: store.getEpicRun(REPO)! };
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
  test("a quiet 38-child epic makes one structure query and no blocked_by calls in 10 min", async () => {
    const closed = new Set<number>();
    const gh = ghRunner(closed);
    const { drain, run } = makeDrain(gh.run);
    let gen = 1;
    setIssuesFreshness(() => String(gen));

    await buildEvery10s(() => drain.buildEpic(REPO, run), START, 10);
    expect(gh.structureQueries()).toBe(1);
    expect(gh.blockedByRest()).toBe(0);

    // A blocker closes on GitHub; the next fingerprint moves the issue generation.
    closed.add(29);
    gen++;
    setSystemTime(new Date(START + 11 * 60_000));
    const epic = await drain.buildEpic(REPO, run);
    expect(gh.structureQueries()).toBe(2);
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
