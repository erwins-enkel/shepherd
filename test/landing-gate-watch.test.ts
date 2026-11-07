/** #2858: LandingGateWatch pushes an open landing row only when its gate signature moves. */
import { describe, expect, test } from "bun:test";
import type { CompletedEpic } from "../src/completed-epic";
import { LandingGateWatch, landingGateSignature } from "../src/landing-gate-watch";

const REPO = "/repo";

function row(over: Partial<CompletedEpic> = {}): CompletedEpic {
  return {
    repoPath: REPO,
    parentIssueNumber: 7,
    parentTitle: "Epic",
    completedAt: 1_000,
    children: [],
    landingPrNumber: 42,
    landingPrUrl: "http://x/42",
    landingState: "open",
    migrationPaths: [],
    migrationsAckedAt: null,
    landingRebasePauseReason: null,
    landingRepairCount: 0,
    landingRepairHead: null,
    landingConflictReworkCount: 0,
    landingChecks: "pending",
    landingReady: false,
    landingStranded: false,
    landingStrandedAt: null,
    ...over,
  };
}

function watch() {
  const emitted: CompletedEpic[] = [];
  return { w: new LandingGateWatch((r) => emitted.push(r)), emitted };
}

describe("landingGateSignature", () => {
  test("ignores the time-derived booleans", () => {
    expect(
      landingGateSignature(row({ landingStranded: true, landingConflictStranded: true })),
    ).toBe(landingGateSignature(row()));
  });

  test("moves with gate fields and silent landing progress", () => {
    const base = landingGateSignature(row());
    expect(landingGateSignature(row({ landingReady: true }))).not.toBe(base);
    expect(landingGateSignature(row({ landingRebasePauseReason: "conflict" }))).not.toBe(base);
    expect(landingGateSignature(row({ landingStrandedAt: 5 }))).not.toBe(base);
  });
});

describe("LandingGateWatch", () => {
  test("first sight pushes; an unchanged row never pushes again across many observations", () => {
    const { w, emitted } = watch();
    for (let i = 0; i < 50; i++) w.observe(REPO, new Set([7]), [row()]);
    expect(emitted).toHaveLength(1);
  });

  test("a changed gate pushes the new row once", () => {
    const { w, emitted } = watch();
    w.observe(REPO, new Set([7]), [row()]);
    w.observe(REPO, new Set([7]), [row({ landingChecks: "success", landingReady: true })]);
    w.observe(REPO, new Set([7]), [row({ landingChecks: "success", landingReady: true })]);
    expect(emitted.map((r) => r.landingReady)).toEqual([false, true]);
  });

  test("an open row left unobserved keeps its signature", () => {
    const { w, emitted } = watch();
    w.observe(REPO, new Set([7]), [row()]);
    w.observe(REPO, new Set([7]), []);
    w.observe(REPO, new Set([7]), [row()]);
    expect(emitted).toHaveLength(1);
  });

  test("a row no longer open is forgotten, so a re-open pushes afresh", () => {
    const { w, emitted } = watch();
    w.observe(REPO, new Set([7]), [row()]);
    w.observe(REPO, new Set(), []);
    w.observe(REPO, new Set([7]), [row()]);
    expect(emitted).toHaveLength(2);
  });

  test("repos are tracked separately", () => {
    const { w, emitted } = watch();
    w.observe(REPO, new Set([7]), [row()]);
    w.observe("/other", new Set([7]), [row({ repoPath: "/other" })]);
    w.observe(REPO, new Set([7]), [row()]);
    expect(emitted).toHaveLength(2);
  });

  test("pushed() returns the row last pushed, and forgets it once the row is no longer open", () => {
    const { w } = watch();
    expect(w.pushed(REPO, 7)).toBeUndefined();
    w.observe(REPO, new Set([7]), [row({ landingReady: true })]);
    expect(w.pushed(REPO, 7)?.landingReady).toBe(true);
    w.observe(REPO, new Set(), []);
    expect(w.pushed(REPO, 7)).toBeUndefined();
  });
});
