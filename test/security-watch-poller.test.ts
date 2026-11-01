// security-watch poll: backlog order, throttling, and what counts as resolved.
import { test, expect } from "bun:test";
import { DAILY_CAP } from "../src/plugins/bundled/security-watch/rules";
import { cs, dep, HOUR, world } from "./security-watch-fixture";

const backlog = (n: number) =>
  Array.from({ length: n }, (_, i) => cs(i + 1, { path: `f${i + 1}.ts`, createdAt: 1000 + i }));

test("master switch off: no reads, no triage", async () => {
  const { w, poller } = world();
  w.state.set("settings", { enabled: false, pollMinutes: 30, locale: "en" });
  w.codeScanning = new Error("must not read");
  expect(await poller.poll()).toBe("disabled");
  await poller.tick();
  expect(w.triaged).toHaveLength(0);
});

test("tick honours the interval", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.tick();
  expect(w.created).toHaveLength(1);
  w.setCs([cs(1), cs(2, { path: "b.ts" })]);
  w.clock += 10 * 60_000;
  await poller.tick();
  expect(w.created).toHaveLength(1);
  w.clock += 30 * 60_000;
  await poller.tick();
  expect(w.created).toHaveLength(2);
});

test("backlog on first poll: worst first, at most 3 triages per poll", async () => {
  const { w, poller } = world();
  w.verdict = { fixable: false, confidence: "low", hypothesis: "", files: [], reason: "no" };
  w.setCs([
    cs(1, { path: "a.ts", createdAt: 1 }),
    cs(2, { path: "b.ts", createdAt: 2, securitySeverity: "critical" }),
    cs(3, { path: "c.ts", createdAt: 3 }),
    cs(4, { path: "d.ts", createdAt: 0 }),
    cs(5, { path: "e.ts", createdAt: 4 }),
  ]);
  await poller.poll();
  expect(w.triaged.map((t) => /MESSAGE-(\d+)/.exec(t.content)?.[1])).toEqual(["2", "4", "1"]);
  expect(w.status().throttled).toBe(2);
  w.clock += HOUR;
  await poller.poll();
  expect(w.triaged).toHaveLength(5);
});

test("daily cap: at most 3 filed per repo per day; the rest wait for tomorrow", async () => {
  const { w, poller } = world();
  w.setCs(backlog(5));
  await poller.poll();
  await poller.poll();
  expect(w.created).toHaveLength(DAILY_CAP);
  expect(w.triaged).toHaveLength(DAILY_CAP);
  expect(w.status().cap).toBe(2);
  w.clock += 24 * HOUR;
  await poller.poll();
  expect(w.created).toHaveLength(5);
});

test("filters and holds trigger no triage and each has a status count", async () => {
  const { w, poller } = world();
  w.setCs([
    cs(1, { path: "a.ts", securitySeverity: "low" }),
    cs(2, { path: "b.ts", securitySeverity: null }),
    cs(3, { path: "c.ts", classifications: ["test"] }),
  ]);
  w.setDep([
    dep(4, { package: "a", scope: "development" }),
    dep(5, { package: "b", patchedVersion: null }),
    dep(6, { package: "c", createdAt: w.clock - HOUR }),
  ]);
  await poller.poll();
  expect(w.triaged).toHaveLength(0);
  expect(w.status()).toMatchObject({
    "skip-below-severity": 1,
    "skip-no-severity": 1,
    "skip-non-production": 2,
    "skip-no-patch": 1,
    "skip-grace": 1,
  });
});

test("opt-in gate: non-private repos produce no triage until acknowledged; private never needs it", async () => {
  for (const visibility of ["public", "internal", "unknown"] as const) {
    const { w, poller } = world();
    w.visibility = visibility;
    w.setCs([cs(1)]);
    await poller.poll();
    expect(w.triaged).toHaveLength(0);
    expect(w.created).toHaveLength(0);
    expect(w.status()["needs-ack"]).toBe(1);
    w.setConfig({ publicRiskAck: true });
    await poller.poll();
    expect(w.created).toHaveLength(1);
  }
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  expect(w.created).toHaveLength(1);
});

test("a read failure is local: the other source still runs, status records it", async () => {
  const { w, poller } = world();
  w.codeScanning = new Error("HTTP 500");
  w.setDep([dep(1)]);
  await poller.poll();
  expect(w.created).toHaveLength(1);
  const status = w.state.get<{ lastError: string }>("meta:status")!;
  expect(status.lastError).toBe("HTTP 500");
  expect(w.state.get("avail:/r/web")).toEqual({ cs: "error", dep: "ok" });
});

test("an unavailable source is reported and files nothing", async () => {
  const { w, poller } = world();
  w.codeScanning = { status: "unavailable", reason: "disabled" };
  await poller.poll();
  expect(w.status()["unavailable-disabled"]).toBe(1);
  expect(w.state.get("avail:/r/web")).toEqual({ cs: "disabled", dep: "ok" });
});

test("an unticked source is not read", async () => {
  const { w, poller } = world({ codeScanning: false });
  w.codeScanning = new Error("must not read");
  await poller.poll();
  expect(w.state.get<{ lastError: string | null }>("meta:status")?.lastError).toBeNull();
});

test("a group with no open alerts and no filing is dropped", async () => {
  const { w, poller } = world();
  w.verdict = { fixable: false, confidence: "low", hypothesis: "", files: [], reason: "no" };
  w.setCs([cs(1)]);
  await poller.poll();
  expect(w.groups()).toHaveLength(1);
  w.setCs([]);
  await poller.poll();
  expect(w.groups()).toHaveLength(0);
});

test("truncated reads add to what is known and never resolve a filing", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  w.setCs([cs(2)], true);
  await poller.poll();
  expect(w.group().openAlerts.map((a) => a.number)).toEqual([1, 2]);
  expect(w.group().observedResolvedAt).toBeUndefined();
  w.setCs([], true);
  await poller.poll();
  expect(w.group().observedResolvedAt).toBeUndefined();
  expect(w.closed).toHaveLength(0);
});

test("an unavailable read or a failed read never sets observedResolvedAt", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  w.codeScanning = { status: "unavailable", reason: "forbidden" };
  await poller.poll();
  w.codeScanning = new Error("HTTP 500");
  await poller.poll();
  expect(w.group().observedResolvedAt).toBeUndefined();
  expect(w.closed).toHaveLength(0);
});
