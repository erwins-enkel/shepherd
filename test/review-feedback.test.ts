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
    resolve?: boolean;
    repoMode?: "forge" | "lightweight";
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
  if (opts.resolve !== undefined || opts.repoMode)
    store.setRepoConfig("/r", {
      ...store.getRepoConfig("/r"),
      reviewFeedbackResolve: opts.resolve ?? false,
      repoMode: opts.repoMode ?? "forge",
    });
  const t0 = Math.max(s.createdAt, store.reviewFeedbackActivatedAt()) + 1000;
  const clock = fakeClock(t0 + 10_000);

  const feedback: PrFeedback = { prAuthor: "agent-bot", items: [] };
  const writers = new Set(["alice"]);
  const forgeCalls: number[] = [];
  const writeChecks: string[] = [];
  const resolveCalls: [string, string][] = [];
  const forge = {
    replyAndResolveThread: async (threadId: string, body: string) => {
      resolveCalls.push([threadId, body]);
      if (st.resolveError) throw st.resolveError;
    },
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
    resolveError: null as Error | null,
    /** What `freshGit` answers: a state, a failure, or nothing. */
    fresh: undefined as GitState | Error | undefined,
    freshCalls: 0,
  };
  const emitted: ReviewFeedbackEvent[] = [];
  const git = (updatedAt: string, headSha = "abc1234", over: Partial<GitState> = {}): GitState =>
    ({
      kind: "github",
      state: "open",
      number: 7,
      checks: "success",
      headSha,
      updatedAt,
      ...over,
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
    freshGit: async () => {
      st.freshCalls++;
      if (st.fresh instanceof Error) throw st.fresh;
      return st.fresh;
    },
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
    resolveCalls,
    git,
    sent,
    st,
    emitted,
    svc,
    item,
    pushGit: (updatedAt: string, headSha?: string, over?: Partial<GitState>) =>
      events.emit("session:git", { id: s.id, git: git(updatedAt, headSha, over) }),
    setStatus: (status: SessionStatus) => {
      store.update(s.id, { status });
      events.emit("session:status", { id: s.id, status });
    },
    newSession: () => events.emit("session:new", store.get(s.id)),
    reviewingDone: () => events.emit("session:reviewing", { id: s.id, reviewing: false }),
    archive: () => {
      store.update(s.id, { status: "archived" });
      events.emit("session:archived", { id: s.id });
    },
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

  expect(await h.svc.sendNow(h.id)).toBe("sent");
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
  expect(await h.svc.sendNow(h.id, ["ic:2"])).toBe("sent");
  expect(h.pending().map((r) => r.id)).toEqual(["review:1"]);
  h.svc.dismiss(h.id, ["review:1"]);
  expect(h.pending()).toEqual([]);
  expect(await h.svc.sendNow(h.id)).toBe("nothing_pending"); // nothing left
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
  expect(await h.svc.sendNow(h.id)).toBe("sent");
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

test("archive → restore → fetch: handled feedback stays handled (#4144)", async () => {
  const h = harness({ autopilot: false });
  const ic = (n: number) => h.item({ id: `ic:${n}`, kind: "ic", reviewState: undefined });
  h.feedback.items.push(ic(1), ic(2), ic(3));
  h.pushGit("u1");
  await settle();
  expect(await h.svc.sendNow(h.id, ["ic:1"])).toBe("sent");
  h.svc.dismiss(h.id, ["ic:2"]);
  expect(h.pending().map((r) => r.id)).toEqual(["ic:3"]);

  h.archive();
  expect(h.svc.pendingAll()).toEqual({}); // archived: nothing shown
  expect(h.store.knownReviewFeedbackIds(h.id).size).toBe(3); // rows kept

  // SessionService.restore: same id, live again; the poller re-announces the open PR.
  h.store.update(h.id, { status: "idle" });
  h.feedback.items.push(ic(4));
  h.clock.advance(FETCH_MIN_GAP_MS);
  h.pushGit("u2");
  await settle();
  expect(h.pending().map((r) => r.id)).toEqual(["ic:3", "ic:4"]);
  expect(await h.svc.sendNow(h.id)).toBe("sent");
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]).not.toContain("ic:1");
  expect(h.store.listPendingReviewFeedback(h.id)).toEqual([]);
});

test("restore without a PR change re-shows what was pending at archive (#4144)", async () => {
  const h = harness({ autopilot: false });
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  h.archive();
  h.emitted.length = 0;

  // SessionService.restore → server emits session:new; the poller sends no session:git for an
  // unchanged PR.
  h.store.update(h.id, { status: "idle" });
  h.newSession();
  expect(h.emitted.at(-1)?.pending.map((r) => r.id)).toEqual(["review:1"]);
  expect(h.svc.pendingAll()[h.id]?.items).toHaveLength(1);
  expect(await h.svc.sendNow(h.id)).toBe("sent"); // the PR is still known
});

test("restore in autopilot flushes what was pending at archive", async () => {
  const h = harness({ status: "running" });
  h.feedback.items.push(h.item());
  h.setStatus("running");
  h.pushGit("u1");
  await settle();
  h.archive();
  h.store.update(h.id, { status: "idle" });
  h.newSession();
  await settle();
  expect(h.emitted.some((e) => e.pending.length === 1)).toBe(true);
  expect(h.sent).toHaveLength(1);
});

test("session:new for a session with nothing pending emits nothing", () => {
  const h = harness();
  h.newSession();
  expect(h.emitted).toEqual([]);
});

test("a red autopilot PR holds the feedback steer until CI is green and the agent idles (#4144)", async () => {
  const h = harness({ status: "running" });
  h.feedback.items.push(h.item());
  h.pushGit("u1", "abc1234", { checks: "failure" });
  await settle();
  h.clock.advance(1000);
  h.setStatus("idle"); // the done edge autopilot's CI-fix steer owns
  await settle();
  h.clock.advance(FETCH_MIN_GAP_MS);
  await settle();
  expect(h.sent).toEqual([]);
  expect(h.pending()).toHaveLength(1);

  h.pushGit("u2", "def5678", { checks: "success" });
  h.setStatus("running");
  h.clock.advance(1000);
  h.setStatus("idle");
  await settle();
  expect(h.sent).toHaveLength(1);
});

test("attended sessions are not held by red CI", async () => {
  const h = harness({ mode: "always", autopilot: false });
  h.feedback.items.push(h.item());
  h.pushGit("u1", "abc1234", { checks: "failure" });
  await settle();
  expect(h.sent).toHaveLength(1);
});

test("a merged or closed PR dismisses pending feedback and refuses sends (#4144)", async () => {
  for (const state of ["merged", "closed"] as const) {
    const h = harness({ autopilot: false });
    h.feedback.items.push(h.item());
    h.pushGit("u1");
    await settle();
    expect(h.pending()).toHaveLength(1);
    h.pushGit("u2", "abc1234", { state });
    expect(h.pending()).toEqual([]);
    expect(h.emitted.at(-1)?.pending).toEqual([]);
    expect(await h.svc.sendNow(h.id)).toBe("pr_closed");
    expect(h.sent).toEqual([]);
  }
});

test("a closed PR in the restart seed dismisses its pending feedback", () => {
  const store = new SessionStore(":memory:");
  const item: PrFeedbackItem = {
    id: "ic:1",
    kind: "ic",
    author: "alice",
    isBot: false,
    body: "b",
    createdAt: 1,
  };
  store.insertReviewFeedbackIfAbsent("s1", item, "pending");
  new ReviewFeedbackService({
    store,
    resolveForge: () => null,
    reply: async () => true,
    lastSteerAt: () => undefined,
    autopilotOn: () => true,
    criticHeld: () => false,
    emit: () => {},
    seed: { s1: { kind: "github", state: "merged", number: 7 } as GitState },
  });
  expect(store.listPendingReviewFeedback("s1")).toEqual([]);
});

test("sendNow names why it refused (#4144)", async () => {
  const noPr = harness({ autopilot: false });
  expect(await noPr.svc.sendNow(noPr.id)).toBe("no_pr");
  expect(await noPr.svc.sendNow("nope")).toBe("not_running");

  const h = harness({ autopilot: false });
  h.feedback.items.push(h.item());
  h.pushGit("u1");
  await settle();
  expect(await h.svc.sendNow(h.id, ["stale"])).toBe("nothing_pending");

  h.st.replyResult = false;
  expect(await h.svc.sendNow(h.id)).toBe("not_running");

  let release: (v: boolean) => void = () => {};
  const blocked = harness({ autopilot: false });
  blocked.feedback.items.push(blocked.item());
  blocked.pushGit("u1");
  await settle();
  const slow = new ReviewFeedbackService({
    store: blocked.store,
    resolveForge: () => null,
    reply: () => new Promise<boolean>((r) => (release = r)),
    lastSteerAt: () => undefined,
    autopilotOn: () => false,
    criticHeld: () => false,
    emit: () => {},
    seed: { [blocked.id]: { kind: "github", state: "open", number: 7 } as GitState },
  });
  const first = slow.sendNow(blocked.id);
  expect(await slow.sendNow(blocked.id)).toBe("busy");
  release(true);
  expect(await first).toBe("sent");

  const thrower = new ReviewFeedbackService({
    store: h.store,
    resolveForge: () => null,
    reply: async () => {
      throw new Error("boom");
    },
    lastSteerAt: () => undefined,
    autopilotOn: () => false,
    criticHeld: () => false,
    emit: () => {},
    seed: { [h.id]: { kind: "github", state: "open", number: 7 } as GitState },
  });
  expect(await thrower.sendNow(h.id)).toBe("failed");
  expect(h.pending()).toHaveLength(1);
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

// ── resolve addressed threads (#4139) ─────────────────────────────────────────

/** An inline comment on thread `thread`, steered at head `abc1234`. */
async function steeredInline(h: ReturnType<typeof harness>, ids: [string, string][]) {
  for (const [id, thread] of ids)
    h.feedback.items.push(
      h.item({
        id,
        kind: "rc",
        reviewState: undefined,
        path: "src/a.ts",
        line: 3,
        threadId: thread,
      }),
    );
  h.pushGit("u1", "abc1234");
  await settle();
  expect(h.sent).toHaveLength(1);
}

test("resolve on: the steer shows inline ids; sent rows remember the head", async () => {
  const h = harness({ resolve: true });
  h.feedback.items.push(h.item());
  await steeredInline(h, [["rc:5", "T1"]]);
  expect(h.sent[0]).toContain("src/a.ts:3 [id rc:5]:");
  expect(h.sent[0]).toContain("`review_feedback_addressed`");
  expect(h.sent[0]).not.toContain("[id review:1]");
  const [row] = h.store.getReviewFeedbackItems(h.id, ["rc:5"]);
  expect(row).toMatchObject({ status: "sent", threadId: "T1", sentHeadSha: "abc1234" });
});

test("resolve off or lightweight: the steer carries no ids and markAddressed refuses", async () => {
  for (const opts of [{}, { resolve: true, repoMode: "lightweight" as const }]) {
    const h = harness(opts);
    await steeredInline(h, [["rc:5", "T1"]]);
    expect(h.sent[0]).not.toContain("[id");
    expect(h.sent[0]).not.toContain("review_feedback_addressed");
    h.st.fresh = h.git("u2", "def5678");
    const out = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "Fixed" }]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not enabled");
    expect(h.resolveCalls).toEqual([]);
  }
});

test("markAddressed: cached head stale but freshGit moved ⇒ replies + resolves", async () => {
  const h = harness({ resolve: true });
  await steeredInline(h, [["rc:5", "T1"]]);
  h.st.fresh = h.git("u2", "def5678abc"); // the push the poller has not announced yet
  const out = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "Fixed the check" }]);
  expect(out).toEqual({ ok: true, results: [{ id: "rc:5", result: "resolved" }] });
  expect(h.st.freshCalls).toBe(1);
  expect(h.resolveCalls).toEqual([
    ["T1", "Fixed the check\n\nAddressed in def5678.\n\n<!-- shepherd:review-feedback -->"],
  ]);
  expect(h.store.getReviewFeedbackItems(h.id, ["rc:5"])[0]?.resolvedAt).toBe(h.clock.now());
  // A second declaration finds it resolved; nothing is posted twice.
  const again = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "x" }]);
  expect(again.results).toEqual([{ id: "rc:5", result: "already-resolved" }]);
  expect(h.resolveCalls).toHaveLength(1);
});

test("markAddressed: freshGit throwing falls back to the cached head", async () => {
  const h = harness({ resolve: true });
  await steeredInline(h, [["rc:5", "T1"]]);
  h.st.fresh = new Error("gh down");
  const stale = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "Fixed" }]);
  expect(stale.results).toEqual([{ id: "rc:5", result: "not-pushed" }]);
  h.pushGit("u2", "def5678");
  await settle();
  const moved = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "Fixed" }]);
  expect(moved.results).toEqual([{ id: "rc:5", result: "resolved" }]);
  expect(h.resolveCalls).toHaveLength(1);
});

test("markAddressed: not pushed ⇒ not-pushed, no forge call; bad ids get their verdict", async () => {
  const h = harness({ resolve: true });
  h.feedback.items.push(h.item());
  await steeredInline(h, [["rc:5", "T1"]]);
  h.st.fresh = h.git("u1", "abc1234");
  const out = await h.svc.markAddressed(h.id, [
    { id: "rc:5", reply: "Fixed" },
    { id: "review:1", reply: "Fixed" },
    { id: "rc:404", reply: "Fixed" },
  ]);
  expect(out).toEqual({
    ok: true,
    results: [
      { id: "rc:5", result: "not-pushed" },
      { id: "review:1", result: "not-inline" },
      { id: "rc:404", result: "unknown" },
    ],
  });
  expect(h.resolveCalls).toEqual([]);
});

test("markAddressed: one forge call per thread, last note wins", async () => {
  const h = harness({ resolve: true });
  await steeredInline(h, [
    ["rc:5", "T1"],
    ["rc:6", "T1"],
    ["rc:7", "T2"],
  ]);
  h.st.fresh = h.git("u2", "def5678");
  const out = await h.svc.markAddressed(h.id, [
    { id: "rc:5", reply: "first" },
    { id: "rc:7", reply: "other" },
    { id: "rc:6", reply: "second" },
  ]);
  expect(out.results.map((r) => r.result)).toEqual(["resolved", "resolved", "resolved"]);
  expect(h.resolveCalls.map(([t, body]) => [t, body.split("\n")[0]])).toEqual([
    ["T1", "second"],
    ["T2", "other"],
  ]);
});

test("markAddressed: a forge error leaves the row sent and unresolved; never throws", async () => {
  const h = harness({ resolve: true });
  await steeredInline(h, [["rc:5", "T1"]]);
  h.st.fresh = h.git("u2", "def5678");
  h.st.resolveError = new Error("HTTP 502");
  const before = h.emitted.length;
  const out = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "Fixed" }]);
  expect(out.ok).toBe(true);
  expect(out.results).toEqual([{ id: "rc:5", result: "error", error: "HTTP 502" }]);
  expect(h.store.getReviewFeedbackItems(h.id, ["rc:5"])[0]).toMatchObject({
    status: "sent",
    resolvedAt: null,
  });
  expect(h.emitted.length).toBe(before);
});

test("markAddressed refuses without an open PR or a live session", async () => {
  const h = harness({ resolve: true });
  await steeredInline(h, [["rc:5", "T1"]]);
  h.st.fresh = { ...h.git("u2", "def5678"), state: "merged" } as GitState;
  const closed = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "Fixed" }]);
  expect(closed).toEqual({ ok: false, error: "This session has no open PR.", results: [] });
  h.store.update(h.id, { status: "archived" });
  const gone = await h.svc.markAddressed(h.id, [{ id: "rc:5", reply: "Fixed" }]);
  expect(gone.ok).toBe(false);
  expect(gone.error).toContain("not live");
  expect(h.resolveCalls).toEqual([]);
});
