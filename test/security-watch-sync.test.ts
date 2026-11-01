// security-watch lifecycle sync.
import { test, expect } from "bun:test";
import { MAX_SYNC, RESOLVED_COMMENT } from "../src/plugins/bundled/security-watch/sync";
import type { PluginSessionSnapshot } from "../src/plugins/types";
import { cs, dep, HOUR, REPO, world } from "./security-watch-fixture";

test("all filed alerts gone closes an unclaimed issue with a generic comment", async () => {
  const { w, poller } = world();
  w.setCs([cs(1), cs(2)]);
  await poller.poll();
  w.setCs([cs(2)]);
  await poller.poll();
  expect(w.closed).toHaveLength(0);
  w.setCs([]);
  await poller.poll();
  expect(w.closed).toEqual([{ number: 41, comment: RESOLVED_COMMENT }]);
  expect(w.group().filing?.sync).toBe("closed");
  expect(w.status()["sync-closed-resolved"]).toBe(1);
});

test("the close comment names no rule, path, package or severity", () => {
  for (const s of ["js/", "src/", "lodash", "high", "critical"]) {
    expect(RESOLVED_COMMENT).not.toContain(s);
  }
});

test("a claimed issue is never closed: session or claim label", async () => {
  const session = world();
  session.w.setCs([cs(1)]);
  await session.poller.poll();
  session.w.sessions.push({ repoPath: REPO, issueNumber: 41 } as PluginSessionSnapshot);
  session.w.setCs([]);
  await session.poller.poll();
  expect(session.w.closed).toHaveLength(0);
  expect(session.w.status()["sync-claimed"]).toBe(1);

  const label = world();
  label.w.setCs([cs(1)]);
  await label.poller.poll();
  const issue = label.w.issues.get(41)!;
  label.w.issues.set(41, { ...issue, labels: [...issue.labels, "shepherd:active"] });
  label.w.setCs([]);
  await label.poller.poll();
  expect(label.w.closed).toHaveLength(0);
});

test("an unavailable, failed or truncated read never closes an issue", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  w.codeScanning = { status: "unavailable", reason: "disabled" };
  await poller.poll();
  w.codeScanning = new Error("HTTP 500");
  await poller.poll();
  w.setCs([], true);
  await poller.poll();
  expect(w.closed).toHaveLength(0);
});

test("an unticked source never closes an issue", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  w.setConfig({ codeScanning: false });
  w.setCs([]);
  await poller.poll();
  expect(w.closed).toHaveLength(0);
});

test("closed on GitHub stops syncing", async () => {
  const { w, poller } = world();
  w.setDep([dep(1)]);
  await poller.poll();
  w.closeIssue(41);
  await poller.poll();
  expect(w.group("npm/lodash").filing?.sync).toBe("closed");
  expect(w.status()["sync-gh-closed"]).toBe(1);
  await poller.poll();
  expect(w.status()["sync-gh-closed"]).toBeUndefined();
});

test("syncs at most MAX_SYNC per poll, oldest sync first", async () => {
  const { w, poller } = world();
  w.state.set("meta:daily", { day: "x", counts: {} });
  for (let day = 0; day < 4; day++) {
    w.setCs(Array.from({ length: 12 }, (_, i) => cs(i + 1, { path: `f${i}.ts` })));
    await poller.poll();
    w.clock += 24 * HOUR;
  }
  expect(w.created.length).toBe(12);
  await poller.poll();
  const sum = Object.entries(w.status())
    .filter(([k]) => k.startsWith("sync-"))
    .reduce((n, [, v]) => n + v, 0);
  expect(sum).toBe(MAX_SYNC);
});
