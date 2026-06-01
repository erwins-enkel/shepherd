/**
 * Unit tests for BacklogPoller (src/backlog-poller.ts).
 *
 * The poller keeps CountsService's cache warm so GET /api/backlog serves from
 * memory. It only warms forge-backed repos (resolveForge non-null) and must
 * never throw, even if a warm call rejects — backlog freshness is best-effort.
 */
import { test, expect } from "bun:test";
import { BacklogPoller } from "../src/backlog-poller";

test("warms only forge-backed repos", async () => {
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/a" }, { path: "/b" }, { path: "/no-forge" }],
    (p) => (p === "/no-forge" ? null : { kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      return { openIssues: 1, openPRs: 0 };
    },
  );

  await poller.tick();

  expect(warmed.sort()).toEqual(["/a", "/b"]);
});

test("a rejecting warm does not sink the tick or sibling repos", async () => {
  const warmed: string[] = [];
  const poller = new BacklogPoller(
    () => [{ path: "/bad" }, { path: "/good" }],
    () => ({ kind: "github", slug: "o/r" }),
    async (p) => {
      warmed.push(p);
      if (p === "/bad") throw new Error("gh down");
      return { openIssues: 2, openPRs: 1 };
    },
  );

  await poller.tick(); // must resolve, not reject
  expect(warmed.sort()).toEqual(["/bad", "/good"]);
});

test("empty repo list is a no-op", async () => {
  let calls = 0;
  const poller = new BacklogPoller(
    () => [],
    () => ({ kind: "github", slug: "o/r" }),
    async () => {
      calls++;
      return { openIssues: 0, openPRs: 0 };
    },
  );
  await poller.tick();
  expect(calls).toBe(0);
});

test("start/stop manage the interval timer without throwing", () => {
  const poller = new BacklogPoller(
    () => [],
    () => null,
    async () => ({ openIssues: null, openPRs: null }),
    60_000,
  );
  poller.start();
  poller.stop();
  expect(true).toBe(true);
});
