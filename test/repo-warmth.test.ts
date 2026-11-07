import { describe, expect, test } from "bun:test";
import {
  RepoWarmthService,
  clampWarmRepoDays,
  inLiveColdRead,
  liveColdRead,
  type RepoWarmthDeps,
} from "../src/repo-warmth";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function make(over: Partial<RepoWarmthDeps> = {}) {
  let now = NOW;
  const opened = new Map<string, number>();
  const deps: RepoWarmthDeps = {
    windowDays: () => 3,
    listRepos: () => [
      { path: "/root/a", realPath: "/real/a" },
      { path: "/root/b", realPath: "/real/b" },
      { path: "/root/b-clone", realPath: "/real/b-clone" },
      { path: "/root/c", realPath: "/real/c" },
    ],
    slugOf: (p) =>
      p.includes("b-clone") || p.endsWith("/b") ? "o/b" : p.endsWith("/a") ? "o/a" : "o/c",
    canonical: (p) => p.replace("/root/", "/real/"),
    lastActivityByRepo: () => ({}),
    repoOpenedSince: (since) => new Set([...opened].filter(([, t]) => t >= since).map(([p]) => p)),
    markRepoOpened: (p, at) => opened.set(p, at),
    automationRepos: () => [],
    activeEpicRepos: () => [],
    epicCompletedRepos: () => [],
    openPrRepos: () => [],
    now: () => now,
    ...over,
  };
  return { svc: new RepoWarmthService(deps), advance: (ms: number) => (now += ms), opened };
}

describe("RepoWarmthService", () => {
  test("session activity inside the window warms; outside is cold", () => {
    const { svc } = make({
      lastActivityByRepo: () => ({ "/real/a": NOW - 2 * DAY, "/real/c": NOW - 4 * DAY }),
    });
    expect(svc.isWarmPath("/root/a")).toBe(true);
    expect(svc.isWarmPath("/real/a")).toBe(true);
    expect(svc.isWarmSlug("o/a")).toBe(true);
    expect(svc.isWarmPath("/root/c")).toBe(false);
    expect(svc.isWarmSlug("o/c")).toBe(false);
  });

  test("raw-path store keys match too", () => {
    const { svc } = make({ lastActivityByRepo: () => ({ "/root/a": NOW }) });
    expect(svc.isWarmPath("/real/a")).toBe(true);
  });

  test.each([
    ["automationRepos"],
    ["activeEpicRepos"],
    ["epicCompletedRepos"],
    ["openPrRepos"],
  ] as const)("%s keeps a repo warm at any age", (dep) => {
    const { svc } = make({ [dep]: () => ["/real/c"] });
    expect(svc.isWarmPath("/root/c")).toBe(true);
    expect(svc.isWarmSlug("o/c")).toBe(true);
  });

  test("a slug is warm when any of its local paths is", () => {
    const { svc } = make({ lastActivityByRepo: () => ({ "/real/b-clone": NOW }) });
    expect(svc.isWarmSlug("o/b")).toBe(true);
    expect(svc.isWarmPath("/root/b")).toBe(true);
  });

  test("touch promotes, persists canonically and invalidates the memo", () => {
    const { svc, opened } = make();
    expect(svc.isWarmPath("/root/c")).toBe(false);
    expect(svc.touch("/root/c")).toBe(true);
    expect(opened.get("/real/c")).toBe(NOW);
    expect(svc.isWarmPath("/root/c")).toBe(true);
    expect(svc.touch("/root/c")).toBe(false);
  });

  test("demotes once the window passes", () => {
    const { svc, advance } = make();
    svc.touch("/root/c");
    advance(3 * DAY - 20_000);
    expect(svc.isWarmPath("/root/c")).toBe(true);
    advance(40_000);
    expect(svc.isWarmPath("/root/c")).toBe(false);
  });

  test("window 0 turns gating off", () => {
    const { svc } = make({ windowDays: () => 0 });
    expect(svc.gatingOff()).toBe(true);
    expect(svc.isWarmPath("/root/c")).toBe(true);
    expect(svc.isWarmSlug("o/c")).toBe(true);
  });

  test("memoizes the set for 15s", () => {
    let reads = 0;
    const { svc, advance } = make({
      lastActivityByRepo: () => {
        reads++;
        return {};
      },
    });
    svc.isWarmPath("/root/a");
    svc.isWarmSlug("o/a");
    expect(reads).toBe(1);
    advance(16_000);
    svc.isWarmPath("/root/a");
    expect(reads).toBe(2);
  });
});

test("clampWarmRepoDays", () => {
  expect(clampWarmRepoDays(3)).toBe(3);
  expect(clampWarmRepoDays("7")).toBe(7);
  expect(clampWarmRepoDays(-1)).toBe(0);
  expect(clampWarmRepoDays(99)).toBe(30);
  expect(clampWarmRepoDays("x")).toBe(3);
  expect(clampWarmRepoDays(2.6)).toBe(3);
});

test("liveColdRead scopes across awaits", async () => {
  expect(inLiveColdRead()).toBe(false);
  const inside = await liveColdRead(async () => {
    await Promise.resolve();
    return inLiveColdRead();
  });
  expect(inside).toBe(true);
  expect(inLiveColdRead()).toBe(false);
});
