import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { PostMergeStepsService } from "../src/post-merge-steps";
import type { GitForge } from "../src/forge/types";
import type { ManualStep } from "../src/manual-steps";

function newStore(): SessionStore {
  return new SessionStore(":memory:");
}

function newSession(
  store: SessionStore,
  over: Partial<Parameters<SessionStore["create"]>[0]> = {},
) {
  return store.create({
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
    ...over,
  });
}

const STEPS: ManualStep[] = [
  { id: "ms1", text: "Set FLAG=1 in prod", postMerge: false },
  { id: "ms2", text: "rotate the webhook secret", postMerge: true },
];

/** Minimal fake forge; only the methods the service touches are real. Spies record calls. */
function fakeForge(
  over: Partial<{
    prBody: string;
    createIssue: GitForge["createIssue"];
    comment: GitForge["comment"];
    prReviewMeta: GitForge["prReviewMeta"];
  }> = {},
): GitForge {
  const f: Partial<GitForge> = {
    createIssue:
      over.createIssue ?? (async () => ({ number: 42, url: "https://example.test/issues/42" })),
    comment: over.comment ?? (async () => {}),
    prReviewMeta:
      over.prReviewMeta ??
      (async () => ({
        body: over.prBody ?? "",
        baseRefName: "main",
        isCrossRepository: false,
        state: "merged" as const,
      })),
  };
  return f as unknown as GitForge;
}

function makeService(
  store: SessionStore,
  forge: GitForge | null,
  onChange?: () => void,
): PostMergeStepsService {
  return new PostMergeStepsService({
    store,
    resolveForge: () => forge,
    emitChange: onChange ?? (() => {}),
  });
}

test("materializes ALL declared steps on merge (POST-MERGE + non-POST-MERGE)", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);

  const svc = makeService(store, fakeForge());
  await svc.onMerged(store.get(s.id)!, 7, "Add flag");

  const list = store.listOutstandingPostMergeSteps();
  expect(list.length).toBe(1);
  expect(list[0]!.sessionId).toBe(s.id);
  expect(list[0]!.prNumber).toBe(7);
  expect(list[0]!.prTitle).toBe("Add flag");
  expect(list[0]!.steps.map((x) => x.id)).toEqual(["ms1", "ms2"]);
  expect(list[0]!.steps.every((x) => x.doneAt === null)).toBe(true);
});

test("POST-MERGE-only PR still materializes", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, [{ id: "ms1", text: "rotate secret", postMerge: true }]);

  await makeService(store, fakeForge()).onMerged(store.get(s.id)!, 1, "t");
  expect(store.listOutstandingPostMergeSteps().length).toBe(1);
});

test("re-derives steps from the PR body when stored steps are empty", async () => {
  const store = newStore();
  const s = newSession(store); // manualSteps left empty (detection hasn't run)

  const body = [
    "```shepherd:manual-steps",
    "- [ ] Set FLAG=1",
    "- [ ] POST-MERGE: rotate",
    "```",
  ].join("\n");
  await makeService(store, fakeForge({ prBody: body })).onMerged(store.get(s.id)!, 3, "t");

  const list = store.listOutstandingPostMergeSteps();
  expect(list.length).toBe(1);
  expect(list[0]!.steps.map((x) => x.text)).toEqual(["Set FLAG=1", "rotate"]);
  // re-derived steps are also persisted back onto the session (keeps the recap/chip consistent).
  expect(store.get(s.id)!.manualSteps.length).toBe(2);
});

test("no steps anywhere → no record, no outbound write", async () => {
  const store = newStore();
  const s = newSession(store);
  let issued = 0;
  const forge = fakeForge({
    prBody: "",
    createIssue: async () => {
      issued++;
      return { number: 1, url: "u" };
    },
  });
  await makeService(store, forge).onMerged(store.get(s.id)!, 1, "t");
  expect(store.listOutstandingPostMergeSteps().length).toBe(0);
  expect(issued).toBe(0);
});

test("idempotent across merged-event replay: one record, tick-state preserved", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);
  const svc = makeService(store, fakeForge());

  await svc.onMerged(store.get(s.id)!, 7, "t");
  store.setPostMergeStepDone(s.id, "ms1", true); // operator ticks one
  await svc.onMerged(store.get(s.id)!, 7, "t"); // replay (boot warm-tick)

  const list = store.listOutstandingPostMergeSteps();
  expect(list.length).toBe(1);
  expect(list[0]!.steps.find((x) => x.id === "ms1")!.doneAt).not.toBeNull(); // not clobbered
});

test("opt-in ON: opens exactly one tracking issue, links it back to the PR, idempotent on replay", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);
  store.setRepoConfig("/r", { ...store.getRepoConfig("/r"), manualStepsIssueEnabled: true });

  let issued = 0;
  const comments: Array<{ pr: number; body: string }> = [];
  const forge = fakeForge({
    createIssue: async () => {
      issued++;
      return { number: 99, url: "https://example.test/issues/99" };
    },
    comment: async (pr, body) => {
      comments.push({ pr, body });
    },
  });
  const svc = makeService(store, forge);

  await svc.onMerged(store.get(s.id)!, 7, "t");
  await svc.onMerged(store.get(s.id)!, 7, "t"); // replay must NOT open a second issue

  expect(issued).toBe(1);
  expect(store.getPostMergeSteps(s.id)!.trackingIssueUrl).toBe("https://example.test/issues/99");
  expect(comments.length).toBe(1);
  expect(comments[0]!.pr).toBe(7);
  expect(comments[0]!.body).toContain("https://example.test/issues/99");
});

test("opt-in OFF: zero outbound writes", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);
  // default repo config has manualStepsIssueEnabled === false
  let issued = 0;
  const forge = fakeForge({
    createIssue: async () => {
      issued++;
      return { number: 1, url: "u" };
    },
  });
  await makeService(store, forge).onMerged(store.get(s.id)!, 7, "t");
  expect(issued).toBe(0);
  expect(store.getPostMergeSteps(s.id)!.trackingIssueUrl).toBeNull();
});

test("createIssue failure does not throw, leaves URL null, retries + succeeds on replay", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);
  store.setRepoConfig("/r", { ...store.getRepoConfig("/r"), manualStepsIssueEnabled: true });

  let attempt = 0;
  const forge = fakeForge({
    createIssue: async () => {
      attempt++;
      if (attempt === 1) throw new Error("rate limited");
      return { number: 5, url: "https://example.test/issues/5" };
    },
  });
  const svc = makeService(store, forge);

  await svc.onMerged(store.get(s.id)!, 7, "t"); // first attempt throws internally
  expect(store.getPostMergeSteps(s.id)!.trackingIssueUrl).toBeNull(); // record intact, no URL
  await svc.onMerged(store.get(s.id)!, 7, "t"); // replay retries (URL still null)
  expect(attempt).toBe(2);
  expect(store.getPostMergeSteps(s.id)!.trackingIssueUrl).toBe("https://example.test/issues/5");
});

test("ticking every step clears the record from the outstanding list", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);
  await makeService(store, fakeForge()).onMerged(store.get(s.id)!, 7, "t");

  store.setPostMergeStepDone(s.id, "ms1", true);
  expect(store.listOutstandingPostMergeSteps().length).toBe(1); // one still owed
  const rec = store.setPostMergeStepDone(s.id, "ms2", true);
  expect(rec!.clearedAt).not.toBeNull();
  expect(store.listOutstandingPostMergeSteps().length).toBe(0);

  // un-ticking re-opens it
  store.setPostMergeStepDone(s.id, "ms2", false);
  expect(store.listOutstandingPostMergeSteps().length).toBe(1);
});

test("dismiss clears the whole record at once", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);
  await makeService(store, fakeForge()).onMerged(store.get(s.id)!, 7, "t");

  const rec = store.dismissPostMergeSteps(s.id);
  expect(rec!.clearedAt).not.toBeNull();
  expect(store.listOutstandingPostMergeSteps().length).toBe(0);
});

test("no forge → still materializes locally (no outbound), never throws", async () => {
  const store = newStore();
  const s = newSession(store);
  store.setSessionManualSteps(s.id, STEPS);
  await makeService(store, null).onMerged(store.get(s.id)!, 7, "t");
  expect(store.listOutstandingPostMergeSteps().length).toBe(1);
});
