// security-watch rules: grouping, filters, holds and eligibility.
import { test, expect } from "bun:test";
import {
  alertFilter,
  alertHold,
  candidatesOf,
  coveredAlerts,
  evaluateGroup,
  groupCodeScanning,
  groupDependabot,
  needsAck,
  urgency,
  compareUrgency,
} from "../src/plugins/bundled/security-watch/rules";
import { DEFAULT_REPO, type GroupRecord } from "../src/plugins/bundled/security-watch/state";
import { cs, dep, HOUR, REPO, T0 } from "./security-watch-fixture";

const one = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};

test("3 alerts of one rule across 2 files yield 2 groups", () => {
  const groups = groupCodeScanning(REPO, [
    cs(1, { path: "a.ts" }),
    cs(2, { path: "a.ts" }),
    cs(3, { path: "b.ts" }),
  ]);
  expect(groups.map((g) => g.openAlerts.map((a) => a.number))).toEqual([[1, 2], [3]]);
});

test("advisories on one package + manifest yield 1 group; another manifest its own", () => {
  const groups = groupDependabot(REPO, [dep(1), dep(2), dep(3, { manifest: "ui/package.json" })]);
  expect(groups.map((g) => g.openAlerts.length)).toEqual([2, 1]);
});

test("operator filters: severity, no severity, non-production", () => {
  const group = (a: Parameters<typeof cs>[1]) =>
    one(one(groupCodeScanning(REPO, [cs(1, a)])).openAlerts);
  const cfg = DEFAULT_REPO;
  expect(alertFilter(group({}), cfg)).toBeNull();
  expect(alertFilter(group({ securitySeverity: "critical" }), cfg)).toBeNull();
  expect(alertFilter(group({ securitySeverity: "medium" }), cfg)).toBe("below-severity");
  expect(alertFilter(group({ securitySeverity: null }), cfg)).toBe("no-severity");
  expect(alertFilter(group({ classifications: ["test"] }), cfg)).toBe("non-production");
  expect(
    alertFilter(group({ classifications: ["test"] }), { ...cfg, includeNonProduction: true }),
  ).toBeNull();
  const devDep = one(one(groupDependabot(REPO, [dep(1, { scope: "development" })])).openAlerts);
  expect(alertFilter(devDep, cfg)).toBe("non-production");
});

test("holds: Dependabot grace and no patch; code scanning has none", () => {
  const alert = (o: Parameters<typeof dep>[1]) =>
    one(one(groupDependabot(REPO, [dep(1, o)])).openAlerts);
  expect(alertHold("dep", alert({}), T0)).toBeNull();
  expect(alertHold("dep", alert({ createdAt: T0 - HOUR }), T0)).toBe("grace");
  expect(alertHold("dep", alert({ patchedVersion: null }), T0)).toBe("no-patch");
  expect(alertHold("cs", alert({ createdAt: T0, patchedVersion: null }), T0)).toBeNull();
});

test("coveredAlerts: filter-hidden alerts count; hold-only alerts do not", () => {
  const g = one(
    groupDependabot(REPO, [
      dep(1),
      dep(2, { severity: "low" }),
      dep(3, { createdAt: T0 - HOUR }),
      dep(4, { patchedVersion: null }),
      dep(5, { severity: "low", createdAt: T0 - HOUR }),
    ]),
  );
  expect(candidatesOf(g, DEFAULT_REPO, T0).map((a) => a.number)).toEqual([1]);
  expect(coveredAlerts(g, DEFAULT_REPO, T0)).toEqual([1, 2, 5]);
});

test("needsAck: everything but private, until acknowledged", () => {
  for (const v of ["public", "internal", "unknown"] as const) {
    expect(needsAck(v, DEFAULT_REPO)).toBe(true);
    expect(needsAck(v, { ...DEFAULT_REPO, publicRiskAck: true })).toBe(false);
  }
  expect(needsAck("private", DEFAULT_REPO)).toBe(false);
});

function record(over: Partial<GroupRecord> = {}): GroupRecord {
  return { ...one(groupCodeScanning(REPO, [cs(1), cs(2)])), ...over };
}

test("evaluateGroup: open filing, pending triage, triaged set, cap", () => {
  const g = record();
  const c = { filedToday: 0 };
  expect(evaluateGroup(g, g.openAlerts, c)).toBeNull();
  expect(evaluateGroup(g, g.openAlerts, { filedToday: 3 })).toBe("cap");
  const filing = {
    number: 1,
    url: "u",
    filedAt: T0,
    filedAlerts: [1],
    coveredAlerts: [1, 2],
    attempts: 1,
  };
  expect(evaluateGroup({ ...g, filing: { ...filing, sync: "open" } }, g.openAlerts, c)).toBe(
    "filed",
  );
  const triage = { alerts: [1, 2], verdict: null, reason: "", overridden: false, updatedAt: T0 };
  expect(evaluateGroup({ ...g, triage: { ...triage, outcome: "pending" } }, g.openAlerts, c)).toBe(
    "triage-pending",
  );
  expect(evaluateGroup({ ...g, triage: { ...triage, outcome: "rejected" } }, g.openAlerts, c)).toBe(
    "triaged",
  );
});

test("urgency: worst severity first, then oldest", () => {
  const u = (o: Parameters<typeof cs>[1]) =>
    urgency(one(groupCodeScanning(REPO, [cs(1, o)])).openAlerts);
  const list = [u({ securitySeverity: "high" }), u({ securitySeverity: "critical" })];
  expect(list.sort(compareUrgency)[0]).toEqual(u({ securitySeverity: "critical" }));
  const older = u({ createdAt: 1 });
  expect([u({ createdAt: 2 }), older].sort(compareUrgency)[0]).toEqual(older);
});
