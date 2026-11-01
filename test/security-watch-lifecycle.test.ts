// security-watch end to end over fakes, across polls: what re-files and what must not.
import { test, expect } from "bun:test";
import { cs, dep, HOUR, world } from "./security-watch-fixture";

const DAY = 24 * HOUR;

/** Filed once, then closed by a person, with the alert still open. */
async function closedWithOpenAlert(cfg = {}) {
  const x = world(cfg);
  x.w.setCs([cs(1)]);
  x.w.setDep([]);
  await x.poller.poll();
  expect(x.w.created).toHaveLength(1);
  x.w.closeIssue(41);
  await x.poller.poll();
  return x;
}

test("closed issue + same open alerts: no re-file over repeated polls", async () => {
  const { w, poller, triage } = await closedWithOpenAlert();
  for (let i = 0; i < 4; i++) {
    w.clock += DAY;
    await poller.poll();
  }
  expect(w.created).toHaveLength(1);
  expect(w.status()["closed-still-open"]).toBe(1);
  expect(triage.closedStillOpen()).toHaveLength(1);
});

test("resolved, then reopened with the same number: re-files, linking the earlier issue", async () => {
  const { w, poller } = await closedWithOpenAlert();
  w.clock += HOUR;
  w.setCs([]);
  await poller.poll();
  expect(w.group().observedResolvedAt).toBe(w.clock);
  w.clock += HOUR;
  w.setCs([cs(1)]);
  await poller.poll();
  expect(w.created).toHaveLength(2);
  expect(w.created[1]?.body).toContain("https://gh/issues/41");
});

test("a new alert number re-files after the close", async () => {
  const { w, poller } = await closedWithOpenAlert();
  w.clock += HOUR;
  w.setCs([cs(1), cs(2)]);
  await poller.poll();
  expect(w.created).toHaveLength(2);
});

test("third filing goes to a human: no drain label", async () => {
  const { w, poller } = world({ autoDrain: true });
  w.setCs([cs(1)]);
  for (let n = 1; n <= 3; n++) {
    await poller.poll();
    expect(w.created).toHaveLength(n);
    w.closeIssue(40 + n);
    w.clock += DAY;
    w.setCs([]);
    await poller.poll();
    w.clock += DAY;
    w.setCs([cs(1)]);
  }
  expect(w.created.map((c) => c.labels)).toEqual([
    ["security-alert", "shepherd:auto"],
    ["security-alert", "shepherd:auto"],
    ["security-alert"],
  ]);
  expect(w.created[2]?.body).toContain("needs a human");
});

test("filter change: raising severity closes nothing and sets no resolution", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  w.setConfig({ minSeverity: "critical" });
  w.clock += HOUR;
  await poller.poll();
  expect(w.closed).toHaveLength(0);
  expect(w.group().observedResolvedAt).toBeUndefined();
  expect(w.group().filing?.sync).toBe("open");
});

test("filter change: restoring it does not make a closed group eligible or spend an attempt", async () => {
  const { w, poller } = await closedWithOpenAlert();
  w.setConfig({ minSeverity: "critical" });
  w.clock += HOUR;
  await poller.poll();
  w.setConfig({ minSeverity: "high" });
  w.clock += HOUR;
  await poller.poll();
  expect(w.created).toHaveLength(1);
  expect(w.group().filing?.attempts).toBe(1);
  expect(w.group().observedResolvedAt).toBeUndefined();
});

test("filter change: unticking include-non-production closes nothing", async () => {
  const { w, poller } = world({ includeNonProduction: true });
  w.setCs([cs(1, { classifications: ["test"] })]);
  await poller.poll();
  w.setConfig({ includeNonProduction: false });
  w.clock += HOUR;
  await poller.poll();
  expect(w.closed).toHaveLength(0);
  expect(w.group().observedResolvedAt).toBeUndefined();
});

test("an alert open at filing but filter-hidden does not re-file when the filter is relaxed", async () => {
  const { w, poller } = world();
  w.setCs([cs(1), cs(2, { securitySeverity: "low" })]);
  await poller.poll();
  expect(w.group().filing).toMatchObject({ filedAlerts: [1], coveredAlerts: [1, 2] });
  w.closeIssue(41);
  await poller.poll();
  w.setConfig({ minSeverity: "low" });
  w.clock += HOUR;
  await poller.poll();
  expect(w.created).toHaveLength(1);
  expect(w.status()["closed-still-open"]).toBe(1);
});

test("Dependabot: an alert first seen in its grace period BEFORE filing re-files once it ends", async () => {
  const { w, poller } = world();
  w.setDep([dep(1), dep(2, { createdAt: w.clock - HOUR })]);
  await poller.poll();
  expect(w.group("npm/lodash").filing).toMatchObject({ filedAlerts: [1], coveredAlerts: [1] });
  w.closeIssue(41);
  await poller.poll();
  expect(w.created).toHaveLength(1);
  w.clock += DAY;
  await poller.poll();
  expect(w.created).toHaveLength(2);
});

test("Dependabot: an alert first seen in its grace period AFTER filing re-files once it ends", async () => {
  const { w, poller } = world();
  w.setDep([dep(1)]);
  await poller.poll();
  w.closeIssue(41);
  await poller.poll();
  w.clock += HOUR;
  w.setDep([dep(1), dep(2, { createdAt: w.clock })]);
  await poller.poll();
  expect(w.created).toHaveLength(1);
  w.clock += DAY;
  await poller.poll();
  expect(w.created).toHaveLength(2);
});

test("Dependabot: an alert with no patch at filing re-files once a patch appears", async () => {
  const { w, poller } = world();
  w.setDep([dep(1), dep(2, { patchedVersion: null })]);
  await poller.poll();
  w.closeIssue(41);
  w.clock += HOUR;
  await poller.poll();
  expect(w.created).toHaveLength(1);
  w.setDep([dep(1), dep(2)]);
  w.clock += HOUR;
  await poller.poll();
  expect(w.created).toHaveLength(2);
});

test("an alert first seen while the filing was open re-files after the close", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  w.setCs([cs(1), cs(2)]);
  await poller.poll();
  expect(w.created).toHaveLength(1);
  w.closeIssue(41);
  await poller.poll(); // this poll's sync notices the close; the next one can file
  await poller.poll();
  expect(w.created).toHaveLength(2);
});

test("an alert held back by the per-poll limit re-files on a later poll", async () => {
  const { w, poller } = world();
  const others = [2, 3, 4].map((n) => cs(n, { path: `o${n}.ts`, securitySeverity: "critical" }));
  const target = cs(1);
  w.verdict = { fixable: false, confidence: "low", hypothesis: "", files: [], reason: "no" };
  w.setCs([target, ...others]);
  await poller.poll();
  expect(w.status().throttled).toBe(1);
  w.verdict = { fixable: true, confidence: "high", hypothesis: "", files: [], reason: "r" };
  w.clock += HOUR;
  await poller.poll();
  expect(w.created).toHaveLength(1);
  expect(w.created[0]?.title).toContain("src/a.ts");
});

test("an alert held back by the daily cap re-files on a later poll", async () => {
  const { w, poller } = await closedWithOpenAlert();
  w.state.set("meta:daily", {
    day: new Date(w.clock).toISOString().slice(0, 10),
    counts: { "/r/web": 3 },
  });
  w.setCs([cs(1), cs(2)]);
  await poller.poll();
  expect(w.status().cap).toBe(1);
  expect(w.created).toHaveLength(1);
  w.clock += DAY;
  await poller.poll();
  expect(w.created).toHaveLength(2);
});
