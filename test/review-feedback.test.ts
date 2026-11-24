import { expect, test } from "bun:test";
import { EventHub } from "../src/events";
import type { GitForge, GitState, PrFeedback, PrFeedbackItem } from "../src/forge/types";
import {
  MAX_STEER_ITEMS,
  STEER_QUIET_MS,
  type ReviewFeedbackMode,
} from "../src/review-feedback-core";
import {
  FETCH_MIN_GAP_MS,
  ReviewFeedbackService,
  type ReviewFeedbackEvent,
  type ReviewFeedbackTimers,
} from "../src/review-feedback";
import { SessionStore } from "../src/store";
import type { SessionStatus } from "../src/types";

/** Manual clock: timeouts and intervals fire only on `advance`. */
function fakeClock(start: number) {
  let now = start;
  type Timer = { at: number; every: number | null; fn: () => void };
  const timers = new Set<Timer>();
  const api: ReviewFeedbackTimers = {
    setTimeout: (fn, ms) => {
      const t: Timer = { at: now + ms, every: null, fn };
      timers.add(t);
      return t;
    },
    clearTimeout: (h) => timers.delete(h as Timer),
    setInterval: (fn, ms) => {
      const t: Timer = { at: now + ms, every: ms, fn };
      timers.add(t);
      return t;
    },
    clearInterval: (h) => timers.delete(h as Timer),
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every === null) timers.delete(due);
      else due.at += due.every;
      due.fn();
    }
    now = target;
  };
  return { now: () => now, timers: api, advance };
}

/** Let the service's promise chains (fetch → ingest → flush → reply) run out. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function harness(
  opts: {
    mode?: ReviewFeedbackMode;
    autopilot?: boolean;
    status?: SessionStatus;
    seedUpdatedAt?: string;
  } = {},
) {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_x",
  });
  store.update(s.id, { status: opts.status ?? "idle" });
  if (opts.mode)
    store.setRepoConfig("/r", { ...store.getRepoConfig("/r"), reviewFeedbackMode: opts.mode });
  const t0 = Math.max(s.createdAt, store.reviewFeedbackActivatedAt()) + 1000;
  const clock = fakeClock(t0 + 10_000);

  const feedback: PrFeedback = { prAuthor: "agent-bot", items: [] };
  const writers = new Set(["alice"]);
  const forgeCalls: number[] = [];
  const writeChecks: string[] = [];
  const forge = {
    listPrFeedback: async (n: number) => {
      forgeCalls.push(n);
      return structuredClone(feedback);
    },
    hasWriteAccess: async (login: string) => {
      writeChecks.push(login);
      return writers.has(login);
    },
  } as unknown as GitForge;

  const sent: string[] = [];
  const st = {
    replyResult: true,
    steerAt: undefined as number | undefined,
    critic: null as string | null,
    autopilot: opts.autopilot ?? true,
  };
  const emitted: ReviewFeedbackEvent[] = [];
  const git = (updatedAt: string, headSha = "abc1234"): GitState =>
    ({
      kind: "github",
      state: "open",
      number: 7,
      checks: "success",
      headSha,
      updatedAt,
    }) as GitState;
  const svc = new ReviewFeedbackService({
    store,
    resolveForge: () => forge,
    reply: async (_id, text) => {
      st.steerAt = clock.now(); // SessionService.reply stamps lastSteerAt on entry
      sent.push(text);
      return st.replyResult;
    },
    lastSteerAt: () => st.steerAt,
    autopilotOn: () => st.autopilot,
    criticHeld: (_id, head) => st.critic === head,
    emit: (e) => emitted.push(e),
    seed: opts.seedUpdatedAt ? { [s.id]: git(opts.seedUpdatedAt) } : undefined,
    now: clock.now,
    timers: clock.timers,
  });
  const events = new EventHub();
  svc.attach(events);

  const item = (over: Partial<PrFeedbackItem> = {}): PrFeedbackItem => ({
    id: "review:1",
    kind: "review",
    author: "alice",
    isBot: false,
    body: "Please fix the null check",
    createdAt: t0 + 1,
    reviewState: "changes_requested",
    ...over,
  });
  return {
    store,
    id: s.id,
    t0,
    clock,
    feedback,
    forgeCalls,
    writeChecks,
    sent,
    st,
    emitted,
    svc,
    item,
    pushGit: (updatedAt: string, headSha?: string) =>
      events.emit("session:git", { id: s.id, git: git(updatedAt, headSha) }),
    setStatus: (status: SessionStatus) => {
      store.update(s.id, { status });
      events.emit("session:status", { id: s.id, status });
    },
    reviewingDone: () => events.emit("session:reviewing", { id: s.id, reviewing: false }),
    archive: () => events.emit("session:archived", { id: s.id }),
    pending: () => store.listPendingReviewFeedback(s.id),
  };
}

test("autopilot: a write-access CHANGES_REQUESTED review is steered once, on the first idle", async () => {
  const h = harness({ status: "running" });
  h.feedback.items.push(h.item());
  h.setStatus("running");
  h.pushGit("u1");
  await settle();
  expect(h.forgeCalls).toEqual([7]);
  expect(h.sent).toEqual([]); // busy: held
  expect(h.pending()).toHaveLength(1);

  h.clock.advance(1000);
  h.setStatus("idle");
  await settle();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("PR #7");
  expect(h.sent[0]).toContain("⟦UNTRUSTED:review comment:");
  expect(h.sent[0]).toContain("Please fix the null check");
  expect(h.pending()).toEqual([]);

  // Same and newer updatedAt later: already sent, never again.
  h.pushGit("u1");
  h.pushGit("u2");
  h.clock.advance(FETCH_MIN_GAP_MS);
  await settle();
  h.setStatus("running");
  h.clock.advance(1000);
  h.setStatus("idle");
  await settle();
  expect(h.forgeCalls).toHaveLength(2);
  expect(h.sent).toHaveLength(1);
});

test("an edited comment (same id, new body) is not re-sent", async () => {
  const h = harness();
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(h.sent).toHaveLength(1);

  h.feedback.items[0] = h.item({ body: "Edited: also rename it" });
  h.pushGit("u2");
  h.clock.advance(FETCH_MIN_GAP_MS);
  await settle();
  h.clock.advance(STEER_QUIET_MS);
  await settle();
  expect(h.forgeCalls).toHaveLength(2);
  expect(h.sent).toHaveLength(1);
  expect(h.store.knownReviewFeedbackIds(h.id)).toEqual(new Set(["review:1"]));
});

test("attended (mode autopilot, autopilot off): card only, then sendNow delivers", async () => {
  const h = harness({ autopilot: false });
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(h.sent).toEqual([]);
  expect(h.emitted.at(-1)?.pending).toHaveLength(1);
  expect(h.svc.pendingAll()[h.id]?.items).toHaveLength(1);

  expect(await h.svc.sendNow(h.id)).toBe(true);
  expect(h.sent).toHaveLength(1);
  expect(h.pending()).toEqual([]);
  expect(h.emitted.at(-1)?.pending).toEqual([]);
  expect(h.svc.pendingAll()[h.id]).toBeUndefined();
});

test("sendNow sends only the selected items; dismiss removes items from pending", async () => {
  const h = harness({ mode: "manual" });
  h.feedback.items.push(h.item(), h.item({ id: "ic:2", kind: "ic", reviewState: undefined }));
  h.pushGit("u1");
  await settle();
  expect(h.pending()).toHaveLength(2);
  expect(await h.svc.sendNow(h.id, ["ic:2"])).toBe(true);
  expect(h.pending().map((r) => r.id)).toEqual(["review:1"]);
  h.svc.dismiss(h.id, ["review:1"]);
  expect(h.pending()).toEqual([]);
  expect(await h.svc.sendNow(h.id)).toBe(false); // nothing left
});

test("a held critic run holds the steer until session:reviewing false", async () => {
  const h = harness();
  h.st.critic = "abc1234";
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(h.sent).toEqual([]);
  h.st.critic = null;
  h.reviewingDone();
  await settle();
  expect(h.sent).toHaveLength(1);
});

test("back-to-back, findings case: an unconsumed findings steer blocks until running → idle", async () => {
  const h = harness();
  h.st.critic = "abc1234";
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  // The critic's findings steer goes out (stamps lastSteerAt), then the run settles.
  h.st.steerAt = h.clock.now();
  h.st.critic = null;
  h.reviewingDone();
  await settle();
  expect(h.sent).toEqual([]);

  h.clock.advance(1000);
  h.setStatus("running");
  h.clock.advance(1000);
  h.setStatus("idle");
  await settle();
  expect(h.sent).toHaveLength(1);
});

test("back-to-back, CI case: a CI steer from the same session:git blocks until running → idle", async () => {
  const h = harness();
  h.feedback.items.push(h.item());
  h.st.steerAt = h.clock.now(); // the CI steer fired from the same event
  h.pushGit("u1");
  await settle();
  expect(h.pending()).toHaveLength(1);
  expect(h.sent).toEqual([]);

  h.clock.advance(1000);
  h.setStatus("running");
  h.clock.advance(1000);
  h.setStatus("idle");
  await settle();
  expect(h.sent).toHaveLength(1);
});

test("quiet fallback: a steer that never started a turn stops blocking after 10 minutes", async () => {
  const h = harness();
  h.feedback.items.push(h.item());
  h.st.steerAt = h.clock.now();
  h.pushGit("u1");
  await settle();
  h.clock.advance(STEER_QUIET_MS - 60_000);
  await settle();
  expect(h.sent).toEqual([]);
  h.clock.advance(60_000);
  await settle();
  expect(h.sent).toHaveLength(1);
});

test("the 6th automatic steer within the hour is not sent and reads autoPaused", async () => {
  const h = harness();
  const now = h.clock.now();
  for (let i = 0; i < 5; i++) {
    const old = h.item({ id: `ic:${100 + i}`, kind: "ic", reviewState: undefined });
    h.store.insertReviewFeedbackIfAbsent(h.id, old, "pending");
    h.store.markReviewFeedbackSent(h.id, [old.id], "auto", now - (i + 1) * 60_000);
  }
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(h.sent).toEqual([]);
  expect(h.pending()).toHaveLength(1);
  expect(h.emitted.at(-1)).toMatchObject({ autoPaused: true });
  expect(h.svc.pendingAll()[h.id]?.autoPaused).toBe(true);

  // The operator is never capped.
  expect(await h.svc.sendNow(h.id)).toBe(true);
});

test("a dead pane (reply false) keeps the items pending", async () => {
  const h = harness();
  h.st.replyResult = false;
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(h.sent).toHaveLength(1);
  expect(h.pending()).toHaveLength(1);
});

test("mode off never calls the forge", async () => {
  const h = harness({ mode: "off" });
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(h.forgeCalls).toEqual([]);
});

test("archive drops the session's rows", async () => {
  const h = harness({ autopilot: false });
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(h.pending()).toHaveLength(1);
  h.archive();
  expect(h.store.knownReviewFeedbackIds(h.id).size).toBe(0);
  expect(h.svc.pendingAll()).toEqual({});
});

test("restart seeding: an unchanged PR is not refetched, a moved one is", async () => {
  const h = harness({ seedUpdatedAt: "u1" });
  h.pushGit("u1");
  await settle();
  expect(h.forgeCalls).toEqual([]);
  h.pushGit("u2");
  await settle();
  expect(h.forgeCalls).toEqual([7]);
});

test("fetches keep a 60s gap: a burst is deferred, not dropped", async () => {
  const h = harness();
  h.pushGit("u1");
  await settle();
  h.pushGit("u2");
  h.pushGit("u3");
  await settle();
  expect(h.forgeCalls).toHaveLength(1);
  h.clock.advance(FETCH_MIN_GAP_MS);
  await settle();
  expect(h.forgeCalls).toHaveLength(2);
});

test("primed: feedback older than the cutoff is never shown nor sent", async () => {
  const h = harness();
  h.feedback.items.push(h.item({ createdAt: h.t0 - 5000 }));
  h.pushGit("u1");
  await settle();
  expect(h.store.knownReviewFeedbackIds(h.id)).toEqual(new Set(["review:1"]));
  expect(h.pending()).toEqual([]);
  expect(h.sent).toEqual([]);
  expect(h.emitted).toEqual([]);
});

test("no standing: non-write human, non-allowlisted bot and the PR author store nothing", async () => {
  const h = harness();
  h.feedback.items.push(
    h.item({ id: "review:1", author: "mallory" }),
    h.item({ id: "ic:2", kind: "ic", author: "randombot[bot]", isBot: true }),
    h.item({ id: "ic:3", kind: "ic", author: "agent-bot" }),
  );
  h.pushGit("u1");
  await settle();
  expect(h.writeChecks).toEqual(["mallory"]);
  expect(h.store.knownReviewFeedbackIds(h.id).size).toBe(0);
  expect(h.sent).toEqual([]);
});

test("an allowlisted bot counts without a write check", async () => {
  const h = harness();
  h.feedback.items.push(
    h.item({ id: "ic:2", kind: "ic", author: "coderabbitai[bot]", isBot: true }),
  );
  h.pushGit("u1");
  await settle();
  expect(h.writeChecks).toEqual([]);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("@coderabbitai[bot] (bot)");
});

test("a steer carries at most MAX_STEER_ITEMS; the overflow stays pending for the next one", async () => {
  const h = harness();
  for (let i = 1; i <= MAX_STEER_ITEMS + 5; i++)
    h.feedback.items.push(
      h.item({ id: `ic:${i}`, kind: "ic", reviewState: undefined, body: `c${i}` }),
    );
  h.pushGit("u1");
  await settle();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).not.toContain("more — see the PR");
  expect(h.pending()).toHaveLength(5);
});
