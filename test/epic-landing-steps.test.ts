import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import {
  collectLandingManualSteps,
  landingStepsRecordId,
  materializeLandingManualSteps,
} from "../src/epic-landing-steps";
import { buildLandingPrBody } from "../src/epic-landing";
import type { GitForge } from "../src/forge/types";

const REPO = "/r";
const fence = (lines: string) => "Prose.\n\n```shepherd:manual-steps\n" + lines + "\n```\n";

/** Fake forge whose prReviewMeta serves PR bodies by number; a missing number throws. */
function forgeWith(
  bodies: Record<number, string>,
  calls: number[] = [],
): Pick<GitForge, "prReviewMeta"> {
  return {
    prReviewMeta: async (n: number) => {
      calls.push(n);
      if (!(n in bodies)) throw new Error(`gh: pr ${n} unavailable`);
      return {
        body: bodies[n]!,
        baseRefName: "epic/55-x",
        isCrossRepository: false,
        state: "merged",
      };
    },
  };
}

function newSession(store: SessionStore, issueNumber: number) {
  return store.create({
    name: "n",
    prompt: "p",
    repoPath: REPO,
    baseBranch: "epic/55-x",
    branch: `shepherd/c${issueNumber}`,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
    issueNumber,
  });
}

/** A child's own Owed record (an out-of-band child merge materialized it). */
function childRecord(
  store: SessionStore,
  prNumber: number,
  steps: { text: string; done: boolean }[],
) {
  const s = newSession(store, prNumber - 10);
  store.materializePostMergeSteps({
    sessionId: s.id,
    desig: s.desig,
    repoPath: REPO,
    prNumber,
    prTitle: "child",
    steps: steps.map((x, i) => ({
      id: `ms${i + 1}`,
      text: x.text,
      postMerge: false,
      doneAt: x.done ? 1 : null,
    })),
  });
  return s.id;
}

const CHILDREN = [
  { number: 60, prNumber: 70 },
  { number: 61, prNumber: 71 },
  { number: 62, prNumber: null },
];

describe("collectLandingManualSteps (#3103)", () => {
  test("aggregates ≥2 children, dedupes, keeps origin + child [x]", async () => {
    const store = new SessionStore(":memory:");
    const steps = await collectLandingManualSteps({
      forge: forgeWith({
        70: fence("- [ ] Set VERCEL_TOKEN\n- [x] Rotate Blob key"),
        71: fence("- [ ] set  vercel_token\n- [ ] POST-MERGE: Trello webhook"),
      }),
      store,
      repoPath: REPO,
      children: CHILDREN,
    });
    expect(steps).toEqual([
      { text: "Set VERCEL_TOKEN", postMerge: false, done: false, fromPrs: [70, 71] },
      { text: "Rotate Blob key", postMerge: false, done: true, fromPrs: [70] },
      { text: "Trello webhook", postMerge: true, done: false, fromPrs: [71] },
    ]);
  });

  test("a step ticked in the child's Owed record or the prior landing body stays done", async () => {
    const store = new SessionStore(":memory:");
    childRecord(store, 70, [{ text: "set vercel_token", done: true }]);
    const prior = buildLandingPrBody({
      parentNumber: 55,
      parentTitle: "E",
      integrationBranch: "epic/55-x",
      defaultBranch: "main",
      children: [],
      manualSteps: [{ text: "Trello webhook", postMerge: true, done: true, fromPrs: [71] }],
    });
    const steps = await collectLandingManualSteps({
      forge: forgeWith({
        70: fence("- [ ] Set VERCEL_TOKEN"),
        71: fence("- [ ] POST-MERGE: Trello webhook\n- [ ] Screenshot branches"),
      }),
      store,
      repoPath: REPO,
      children: CHILDREN,
      priorLandingBody: prior,
    });
    expect(steps.map((s) => [s.text, s.done])).toEqual([
      ["Set VERCEL_TOKEN", true],
      ["Trello webhook", true],
      ["Screenshot branches", false],
    ]);
  });

  test("child PR fetch failure falls back to the child's stored session steps", async () => {
    const store = new SessionStore(":memory:");
    const s = newSession(store, 61);
    store.setSessionManualSteps(s.id, [{ id: "ms1", text: "From session", postMerge: true }]);
    const steps = await collectLandingManualSteps({
      forge: forgeWith({ 70: fence("- [ ] A") }),
      store,
      repoPath: REPO,
      children: CHILDREN,
    });
    expect(steps).toEqual([
      { text: "A", postMerge: false, done: false, fromPrs: [70] },
      { text: "From session", postMerge: true, done: false, fromPrs: [71] },
    ]);
  });
});

describe("materializeLandingManualSteps (#3103)", () => {
  const landingBody = buildLandingPrBody({
    parentNumber: 55,
    parentTitle: "E",
    integrationBranch: "epic/55-x",
    defaultBranch: "main",
    children: [],
    manualSteps: [
      { text: "Set VERCEL_TOKEN", postMerge: false, done: false, fromPrs: [70, 71] },
      { text: "Rotate Blob key", postMerge: true, done: true, fromPrs: [70] },
    ],
  });

  const run = (store: SessionStore, forge: Pick<GitForge, "prReviewMeta">, onChange = () => {}) =>
    materializeLandingManualSteps({
      forge,
      store,
      repoPath: REPO,
      parentIssueNumber: 55,
      landingPrNumber: 75,
      landingPrTitle: "feat: e (epic #55)",
      children: CHILDREN,
      emitChange: onChange,
    });

  test("writes one epic Owed record (done pre-ticked), dismisses covered child records, replay no-ops", async () => {
    const store = new SessionStore(":memory:");
    const covered = childRecord(store, 70, [{ text: "Set VERCEL_TOKEN", done: false }]);
    const uncovered = childRecord(store, 71, [{ text: "Unrelated thing", done: false }]);
    let changes = 0;
    const calls: number[] = [];
    await run(store, forgeWith({ 75: landingBody }, calls), () => changes++);

    const rec = store.getPostMergeSteps(landingStepsRecordId(REPO, 55))!;
    expect(rec.desig).toBe("EPIC-55");
    expect(rec.prNumber).toBe(75);
    expect(rec.steps.map((s) => [s.text, s.postMerge, s.doneAt != null])).toEqual([
      ["Set VERCEL_TOKEN (from #70, #71)", false, false],
      ["Rotate Blob key (from #70)", true, true],
    ]);
    expect(store.getPostMergeSteps(covered)!.clearedAt).not.toBeNull();
    expect(store.getPostMergeSteps(uncovered)!.clearedAt).toBeNull();
    expect(changes).toBe(1);

    await run(store, forgeWith({ 75: landingBody }, calls), () => changes++);
    expect(changes).toBe(1);
    expect(calls).toEqual([75]); // replay short-circuits before any forge call
  });

  test("landing body fetch failure → persisted aggregate", async () => {
    const store = new SessionStore(":memory:");
    store.recordEpicCompleted({
      repoPath: REPO,
      parentIssueNumber: 55,
      parentTitle: "E",
      completedAt: 1,
      childrenJson: "[]",
    });
    store.setEpicLandingManualSteps(REPO, 55, [
      { text: "Persisted step", postMerge: false, done: false, fromPrs: [70] },
    ]);
    await run(store, forgeWith({}));
    expect(
      store.getPostMergeSteps(landingStepsRecordId(REPO, 55))!.steps.map((s) => s.text),
    ).toEqual(["Persisted step (from #70)"]);
  });

  test("no record when nothing is owed", async () => {
    const store = new SessionStore(":memory:");
    await run(store, forgeWith({ 75: "no steps here" }));
    expect(store.getPostMergeSteps(landingStepsRecordId(REPO, 55))).toBeNull();
  });

  test("record id is URL-safe and per-repo", () => {
    expect(landingStepsRecordId("/a/b c", 55)).toMatch(/^epic-landing-55-[0-9a-f]{8}$/);
    expect(landingStepsRecordId("/x", 55)).not.toBe(landingStepsRecordId("/y", 55));
  });
});
