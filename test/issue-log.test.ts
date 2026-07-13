import { test, expect, mock } from "bun:test";
import { issueLogEntries, createIssueLogger } from "../src/issue-log";
import { SessionStore } from "../src/store";
import { SHEPHERD_ISSUE_LOG_MARKER } from "../src/forge/types";
import type { GitState } from "../src/forge/types";

const never = () => false;

// Every issue-log body carries the invisible marker so a task spawned from the issue can
// filter Shepherd's own workflow notes back out of the comment thread it feeds the agent.
const stamped = (body: string) => `${body}\n\n${SHEPHERD_ISSUE_LOG_MARKER}`;

function open(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "success",
    number: 7,
    deployConfigured: false,
    ...over,
  };
}

// ── issueLogEntries (pure decision) ──────────────────────────────────────────

test("open+green+reviewer handoff → one waiting entry naming the reviewer", () => {
  const e = issueLogEntries(open({ handoff: "reviewer", handoffWho: "scoop" }), never);
  expect(e).toEqual([
    { key: "waiting:7", body: stamped("⏸️ Waiting on review of PR #7 by @scoop.") },
  ]);
});

test("open+green+reviewBlock → one changes-requested entry, not passive waiting", () => {
  const e = issueLogEntries(
    open({
      handoff: "reviewer",
      handoffWho: "scoop",
      reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
    }),
    never,
  );
  expect(e).toEqual([
    {
      key: "changes-requested:7",
      body: stamped("⚠️ Changes requested on PR #7 by @scoop."),
    },
  ]);
});

test("open+green+merger handoff → one waiting entry naming the merger", () => {
  const e = issueLogEntries(open({ handoff: "merger", handoffWho: "scoop" }), never);
  expect(e).toEqual([{ key: "waiting:7", body: stamped("⏸️ Waiting on @scoop to merge PR #7.") }]);
});

test("handoff without a login → generic waiting wording", () => {
  const e = issueLogEntries(open({ handoff: "merger" }), never);
  expect(e).toEqual([{ key: "waiting:7", body: stamped("⏸️ Waiting on PR #7 to merge.") }]);
});

test("no-CI repo (noCi + checks:none) + merger handoff → waiting entry", () => {
  const e = issueLogEntries(
    open({ checks: "none", noCi: true, handoff: "merger", handoffWho: "scoop" }),
    never,
  );
  expect(e).toEqual([{ key: "waiting:7", body: stamped("⏸️ Waiting on @scoop to merge PR #7.") }]);
});

test("checks:none WITHOUT noCi + handoff → NO waiting entry (CI repo pre-green)", () => {
  const e = issueLogEntries(
    open({ checks: "none", handoff: "merger", handoffWho: "scoop" }),
    never,
  );
  expect(e).toEqual([]);
});

test("merged → one merged entry, phrased issue-state-agnostic", () => {
  const e = issueLogEntries(open({ state: "merged" }), never);
  expect(e).toEqual([{ key: "merged:7", body: stamped("✅ PR #7 merged.") }]);
});

test("every authored body carries the invisible issue-log marker", () => {
  const waiting = issueLogEntries(open({ handoff: "merger", handoffWho: "scoop" }), never);
  const merged = issueLogEntries(open({ state: "merged" }), never);
  expect(waiting[0]?.body).toContain(SHEPHERD_ISSUE_LOG_MARKER);
  expect(merged[0]?.body).toContain(SHEPHERD_ISSUE_LOG_MARKER);
  // marker is appended, not prepended — leading wording stays intact for the spawn filter
  expect(waiting[0]?.body.startsWith("⏸️ Waiting on")).toBe(true);
});

test("auto-inferred handoff (no roles.json) → NO waiting entry (gated to configured roles)", () => {
  const inferred = open({ handoff: "merger", handoffWho: "scoop", handoffInferred: true });
  expect(issueLogEntries(inferred, never)).toEqual([]);
  // the SAME state without the inferred flag (configured) → comments as before
  const configured = open({ handoff: "merger", handoffWho: "scoop" });
  expect(issueLogEntries(configured, never)).toEqual([
    { key: "waiting:7", body: stamped("⏸️ Waiting on @scoop to merge PR #7.") },
  ]);
});

test("no handoff / pending checks / no PR number → nothing owed", () => {
  expect(issueLogEntries(open(), never)).toEqual([]); // green but self-turn
  expect(issueLogEntries(open({ handoff: "merger", checks: "pending" }), never)).toEqual([]);
  expect(issueLogEntries(open({ handoff: "merger", number: undefined }), never)).toEqual([]);
});

test("already-logged keys are owed nothing (flap/restart dedup)", () => {
  const logged = new Set(["waiting:7"]);
  const e = issueLogEntries(open({ handoff: "merger", handoffWho: "scoop" }), (k) => logged.has(k));
  expect(e).toEqual([]);
  // a NEW PR number logs again
  const e2 = issueLogEntries(open({ handoff: "merger", handoffWho: "scoop", number: 9 }), (k) =>
    logged.has(k),
  );
  expect(e2.map((x) => x.key)).toEqual(["waiting:9"]);
});

// ── createIssueLogger (wiring: comment → stamp, best-effort) ─────────────────

const session = { id: "s1", repoPath: "/r", issueNumber: 42 };

function logger(over: { comment?: () => Promise<void>; forge?: null } = {}) {
  const store = new SessionStore(":memory:");
  const comment = mock<(issueNumber: number, body: string) => Promise<void>>(
    over.comment ?? (async () => {}),
  );
  const log = createIssueLogger({
    resolveForge: () => (over.forge === null ? null : { commentIssue: comment }),
    store,
  });
  return { store, comment, log };
}

test("posts the owed comment once, stamps it, and never re-posts", async () => {
  const { store, comment, log } = logger();
  const git = open({ handoff: "merger", handoffWho: "scoop" });
  await log(session, git);
  await log(session, git); // flap / restart replay
  expect(comment.mock.calls).toEqual([[42, stamped("⏸️ Waiting on @scoop to merge PR #7.")]]);
  expect(store.hasIssueLog("s1", "waiting:7")).toBe(true);
});

test("waiting then merged: two comments, two stamps", async () => {
  const { store, comment, log } = logger();
  await log(session, open({ handoff: "reviewer", handoffWho: "scoop" }));
  await log(session, open({ state: "merged" }));
  expect(comment.mock.calls.length).toBe(2);
  expect(store.hasIssueLog("s1", "merged:7")).toBe(true);
});

test("failed comment is NOT stamped → retried on the next event", async () => {
  let calls = 0;
  const { store, comment, log } = logger({
    comment: async () => {
      if (++calls === 1) throw new Error("gh down");
    },
  });
  const git = open({ handoff: "merger", handoffWho: "scoop" });
  await expect(log(session, git)).rejects.toThrow("gh down");
  expect(store.hasIssueLog("s1", "waiting:7")).toBe(false);
  await log(session, git); // next session:git event retries
  expect(comment.mock.calls.length).toBe(2);
  expect(store.hasIssueLog("s1", "waiting:7")).toBe(true);
});

test("no issueNumber / no forge / forge without commentIssue → silent, no stamp", async () => {
  const { comment, log } = logger();
  await log({ ...session, issueNumber: null }, open({ handoff: "merger" }));
  expect(comment.mock.calls.length).toBe(0);

  const noForge = logger({ forge: null });
  await noForge.log(session, open({ handoff: "merger" }));
  expect(noForge.store.hasIssueLog("s1", "waiting:7")).toBe(false);

  const bare = new SessionStore(":memory:");
  const noComment = createIssueLogger({ resolveForge: () => ({}), store: bare });
  await noComment(session, open({ handoff: "merger" }));
  expect(bare.hasIssueLog("s1", "waiting:7")).toBe(false);
});

test("concurrent events for the same owed comment post it once (in-flight guard)", async () => {
  let resolveComment: () => void = () => {};
  const { comment, log } = logger({
    comment: () =>
      new Promise<void>((res) => {
        resolveComment = res;
      }),
  });
  const git = open({ handoff: "merger", handoffWho: "scoop" });
  const first = log(session, git); // hangs in commentIssue
  const second = log(session, git); // same key in flight → skipped
  resolveComment();
  await Promise.all([first, second]);
  expect(comment.mock.calls.length).toBe(1);
});
