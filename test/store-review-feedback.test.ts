import { expect, test } from "bun:test";
import type { PrFeedbackItem } from "../src/forge/types";
import { REVIEW_FEEDBACK_PRESET_BOTS } from "../src/review-feedback-core";
import { SessionStore } from "../src/store";

const review: PrFeedbackItem = {
  id: "review:1",
  kind: "review",
  author: "alice",
  isBot: false,
  body: "please rename",
  createdAt: 1000,
  reviewState: "changes_requested",
};
const inline: PrFeedbackItem = {
  id: "rc:2",
  kind: "rc",
  author: "coderabbitai",
  isBot: true,
  body: "nit",
  createdAt: 2000,
  path: "src/a.ts",
  line: null,
  parentReviewId: "review:1",
};
const convo: PrFeedbackItem = {
  id: "ic:3",
  kind: "ic",
  author: "bob",
  isBot: false,
  body: "lgtm?",
  createdAt: 3000,
};

test("review_feedback: round-trips items as PrFeedbackItem plus delivery state", () => {
  const store = new SessionStore(":memory:");
  expect(store.insertReviewFeedbackIfAbsent("s1", review, "pending")).toBe(true);
  expect(store.insertReviewFeedbackIfAbsent("s1", inline, "pending")).toBe(true);
  expect(store.insertReviewFeedbackIfAbsent("s1", convo, "primed")).toBe(true);
  expect(store.listPendingReviewFeedback("s1")).toEqual([
    { ...review, status: "pending", sentAt: null, sentBy: null },
    { ...inline, status: "pending", sentAt: null, sentBy: null },
  ]);
  expect(store.knownReviewFeedbackIds("s1")).toEqual(new Set(["review:1", "rc:2", "ic:3"]));
  expect(store.knownReviewFeedbackIds("s2").size).toBe(0);
});

test("review_feedback: insert-if-absent is idempotent and never overwrites an edit", () => {
  const store = new SessionStore(":memory:");
  expect(store.insertReviewFeedbackIfAbsent("s1", review, "pending")).toBe(true);
  expect(store.insertReviewFeedbackIfAbsent("s1", { ...review, body: "edited" }, "pending")).toBe(
    false,
  );
  expect(store.listPendingReviewFeedback("s1").map((r) => r.body)).toEqual(["please rename"]);
  // The same id in another session is its own row.
  expect(store.insertReviewFeedbackIfAbsent("s2", review, "pending")).toBe(true);
});

test("review_feedback: pending → sent / dismissed; only pending rows transition", () => {
  const store = new SessionStore(":memory:");
  for (const item of [review, inline, convo])
    store.insertReviewFeedbackIfAbsent("s1", item, "pending");
  store.insertReviewFeedbackIfAbsent("s2", review, "pending");
  expect([...store.listPendingReviewFeedbackAll().keys()].sort()).toEqual(["s1", "s2"]);

  store.markReviewFeedbackSent("s1", ["review:1"], "auto", 5000);
  store.markReviewFeedbackDismissed("s1", ["rc:2", "review:1"]);
  expect(store.listPendingReviewFeedback("s1").map((r) => r.id)).toEqual(["ic:3"]);
  // A dismissed or sent row is not re-sent by a later mark.
  store.markReviewFeedbackSent("s1", ["rc:2"], "operator", 6000);
  store.markReviewFeedbackSent("s1", ["ic:3"], "operator", 6000);
  expect(store.listPendingReviewFeedback("s1")).toEqual([]);
  expect(store.listPendingReviewFeedbackAll().get("s1")).toBeUndefined();
  expect(
    store
      .listPendingReviewFeedbackAll()
      .get("s2")
      ?.map((r) => r.id),
  ).toEqual(["review:1"]);
});

test("review_feedback: autoSentSince returns one stamp per automatic steer", () => {
  const store = new SessionStore(":memory:");
  for (const item of [review, inline, convo])
    store.insertReviewFeedbackIfAbsent("s1", item, "pending");
  store.markReviewFeedbackSent("s1", ["review:1", "rc:2"], "auto", 1000);
  store.markReviewFeedbackSent("s1", ["ic:3"], "operator", 2000);
  expect(store.reviewFeedbackAutoSentSince("s1", 0)).toEqual([1000]);
  expect(store.reviewFeedbackAutoSentSince("s1", 1001)).toEqual([]);
  expect(store.reviewFeedbackAutoSentSince("s2", 0)).toEqual([]);
});

const sessionBase = {
  name: "rf",
  prompt: "p",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/rf",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
};

test("review_feedback: an archived session keeps its rows but lists none pending (#4144)", () => {
  const store = new SessionStore(":memory:");
  const a = store.create({ ...sessionBase, herdrAgentId: "term_1" });
  const b = store.create({ ...sessionBase, herdrAgentId: "term_2" });
  store.insertReviewFeedbackIfAbsent(a.id, review, "pending");
  store.insertReviewFeedbackIfAbsent(b.id, review, "pending");
  store.archive(a.id);
  expect([...store.listPendingReviewFeedbackAll().keys()]).toEqual([b.id]);
  expect(store.knownReviewFeedbackIds(a.id)).toEqual(new Set(["review:1"]));
});

test("review_feedback: pruning an archived session takes its rows with it (#4144)", () => {
  const store = new SessionStore(":memory:");
  const a = store.create({ ...sessionBase, herdrAgentId: "term_1" });
  const b = store.create({ ...sessionBase, herdrAgentId: "term_2" });
  store.insertReviewFeedbackIfAbsent(a.id, review, "pending");
  store.insertReviewFeedbackIfAbsent(b.id, review, "pending");
  store.archive(a.id);
  expect(store.pruneArchivedSessions({ maxAgeMs: 0, keepNewest: 0 })).toBe(1);
  expect(store.knownReviewFeedbackIds(a.id).size).toBe(0);
  expect(store.knownReviewFeedbackIds(b.id).size).toBe(1);
});

test("review_feedback: activation stamp is set at creation and stable", () => {
  const before = Date.now();
  const store = new SessionStore(":memory:");
  const at = store.reviewFeedbackActivatedAt();
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
  expect(store.reviewFeedbackActivatedAt()).toBe(at);
});

test("repo_config: review-feedback fields default to autopilot + preset bots", () => {
  const store = new SessionStore(":memory:");
  const cfg = store.getRepoConfig("/repo");
  expect(cfg.reviewFeedbackMode).toBe("autopilot");
  expect(cfg.reviewFeedbackBots).toEqual([...REVIEW_FEEDBACK_PRESET_BOTS]);
});

test("repo_config: review-feedback fields persist, and a write that omits them keeps them", () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", {
    ...store.getRepoConfig("/repo"),
    reviewFeedbackMode: "manual",
    reviewFeedbackBots: ["coderabbitai"],
  });
  expect(store.getRepoConfig("/repo").reviewFeedbackMode).toBe("manual");
  expect(store.getRepoConfig("/repo").reviewFeedbackBots).toEqual(["coderabbitai"]);

  const partial = { ...store.getRepoConfig("/repo"), criticEnabled: false };
  delete partial.reviewFeedbackMode;
  delete partial.reviewFeedbackBots;
  store.setRepoConfig("/repo", partial);
  const after = store.getRepoConfig("/repo");
  expect(after.criticEnabled).toBe(false);
  expect(after.reviewFeedbackMode).toBe("manual");
  expect(after.reviewFeedbackBots).toEqual(["coderabbitai"]);
});

test("repo_config: bad stored review-feedback values hydrate to the defaults", () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), reviewFeedbackMode: "always" });
  (store as unknown as { db: import("bun:sqlite").Database }).db.run(
    `UPDATE repo_config SET reviewFeedbackMode = 'sometimes', reviewFeedbackBots = '{nope'
     WHERE repoPath = '/repo'`,
  );
  const cfg = store.getRepoConfig("/repo");
  expect(cfg.reviewFeedbackMode).toBe("autopilot");
  expect(cfg.reviewFeedbackBots).toEqual([...REVIEW_FEEDBACK_PRESET_BOTS]);
});
