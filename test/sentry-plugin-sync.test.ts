// Sentry ⟷ GitHub lifecycle sync (#2466): one test per transition, over the recorded
// issue-details fixture with fake Sentry/forge/session seams and in-memory state.

import { test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SentryResult } from "../src/plugins/bundled/sentry/api";
import { writeFiled, type FiledRecord } from "../src/plugins/bundled/sentry/state";
import { syncFiled, type SyncDeps } from "../src/plugins/bundled/sentry/sync";
import type { PluginIssue, PluginSessionSnapshot, PluginState } from "../src/plugins/types";

const DETAILS = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/sentry/recorded-issue-details.json"), "utf8"),
) as Record<string, unknown>;

function memState(): PluginState {
  const m = new Map<string, string>();
  return {
    get: <T>(k: string) => (m.has(k) ? (JSON.parse(m.get(k)!) as T) : null),
    set: (k, v) => void m.set(k, JSON.stringify(v ?? null)),
    delete: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

const res = (status: number, data: unknown = null): SentryResult =>
  status >= 200 && status < 300
    ? { ok: true, status, data, headers: new Headers() }
    : { ok: false, status, headers: new Headers(), error: `HTTP ${status}` };

const REPO = "/repos/web";

let state: PluginState;
let details: Record<string, unknown>;
let postStatus: number;
let gets: string[];
let posts: Array<{ path: string; text: string }>;
let closes: Array<{ number: number; comment?: string }>;
let gh: Partial<PluginIssue> | null;
let sessions: PluginSessionSnapshot[];

beforeEach(() => {
  state = memState();
  // Unresolved + unassigned by default; tests override status/assignedTo.
  details = { ...DETAILS, status: "unresolved", assignedTo: null };
  postStatus = 201;
  gets = [];
  posts = [];
  closes = [];
  gh = { state: "open", labels: [] };
  sessions = [];
});

function file(sentryId = "4501", over: Partial<FiledRecord> = {}): void {
  writeFiled(state, sentryId, {
    repo: REPO,
    number: 101,
    url: "https://github.com/o/r/issues/101",
    attempts: 1,
    filedAt: "2026-09-25T10:00:00.000Z",
    ...over,
  });
}

const rec = (sentryId = "4501") => state.get<FiledRecord>(`map:${sentryId}`)!;

function deps(): SyncDeps {
  return {
    state,
    issues: {
      get: async (_r, number) =>
        gh ? { number, title: "t", body: "", url: "u", labels: [], state: "open", ...gh } : null,
      close: async (_r, number, comment) => void closes.push({ number, comment }),
    },
    sessions: { list: () => sessions },
    get: async (path) => {
      gets.push(path);
      return res(200, details);
    },
    post: async (path, body) => {
      posts.push({ path, text: (body as { text: string }).text });
      return res(postStatus);
    },
    org: "acme",
    now: () => new Date("2026-09-25T12:00:00Z"),
    log: { log: () => {}, warn: () => {} },
  };
}

function session(pr: PluginSessionSnapshot["pr"], over: Partial<PluginSessionSnapshot> = {}) {
  return {
    id: "s1",
    repoPath: REPO,
    issueNumber: 101,
    status: "running",
    createdAt: 1,
    pr,
    ...over,
  } as PluginSessionSnapshot;
}

test("filed → one Sentry note linking the GitHub issue; not re-posted, retried after a failure", async () => {
  file();
  postStatus = 500;
  expect(await syncFiled(deps())).toEqual({});
  expect(rec().notedIssue).toBeUndefined();

  postStatus = 201;
  expect(await syncFiled(deps())).toEqual({ "sync-noted-issue": 1 });
  expect(posts.at(-1)).toEqual({
    path: "organizations/acme/issues/4501/notes/",
    text: "Shepherd filed this error as https://github.com/o/r/issues/101",
  });
  posts = [];
  await syncFiled(deps());
  expect(posts).toHaveLength(0);
});

test("a permanent 4xx on the note (e.g. token without event:write) is not retried every poll", async () => {
  file();
  postStatus = 403;
  await syncFiled(deps());
  expect(rec().notedIssue).toBe(true);
  await syncFiled(deps());
  expect(posts).toHaveLength(1);
});

test("PR opened by the claiming session → one note per distinct PR URL, PR recorded", async () => {
  file("4501", { notedIssue: true });
  sessions = [
    session({ state: "open", number: 7, url: "https://github.com/o/r/pull/7", checks: "none" }),
  ];
  expect(await syncFiled(deps())).toEqual({ "sync-noted-pr": 1, "sync-claimed": 1 });
  expect(posts.map((p) => p.text)).toEqual([
    "Shepherd opened a fix: https://github.com/o/r/pull/7",
  ]);
  expect(rec()).toMatchObject({ pr: { number: 7, url: "https://github.com/o/r/pull/7" } });

  await syncFiled(deps());
  expect(posts).toHaveLength(1);

  sessions = [
    session({ state: "open", number: 8, url: "https://github.com/o/r/pull/8", checks: "none" }),
  ];
  await syncFiled(deps());
  expect(posts.map((p) => p.text).at(-1)).toBe(
    "Shepherd opened a fix: https://github.com/o/r/pull/8",
  );
  expect(rec().notedPr).toBe("https://github.com/o/r/pull/8");
});

test("session without a PR (state none) → no PR note", async () => {
  file("4501", { notedIssue: true });
  sessions = [session({ state: "none", checks: "none" })];
  await syncFiled(deps());
  expect(posts).toHaveLength(0);
});

for (const [status, reason] of [
  ["resolved", "sentry-resolved"],
  ["ignored", "sentry-ignored"],
] as const) {
  test(`unclaimed + Sentry ${status} → GitHub issue closed with a comment, record closed`, async () => {
    file("4501", { notedIssue: true });
    details = { ...details, status };
    expect(await syncFiled(deps())).toEqual({ [`sync-${reason}`]: 1 });
    expect(gets).toEqual(["organizations/acme/issues/4501/"]);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.number).toBe(101);
    expect(closes[0]!.comment).toContain(status);
    expect(rec()).toMatchObject({ sync: "closed", closedReason: reason });

    // Terminal: no further calls.
    gets = [];
    await syncFiled(deps());
    expect(gets).toHaveLength(0);
    expect(closes).toHaveLength(1);
  });
}

test("claimed by a session (any status) → never closed, Sentry details not even fetched", async () => {
  file("4501", { notedIssue: true });
  details = { ...details, status: "resolved" };
  sessions = [session(null, { status: "done" })];
  expect(await syncFiled(deps())).toEqual({ "sync-claimed": 1 });
  expect(gets).toHaveLength(0);
  expect(closes).toHaveLength(0);
});

test("claimed via the drain's shepherd:active label → never closed", async () => {
  file("4501", { notedIssue: true });
  details = { ...details, status: "resolved", assignedTo: { type: "user" } };
  gh = { state: "open", labels: ["sentry", "shepherd:active"] };
  await syncFiled(deps());
  expect(closes).toHaveLength(0);
  expect(rec().sync).toBeUndefined();
});

test("unclaimed + a human assigned in Sentry → closed; a team assignee is not a human", async () => {
  file("4501", { notedIssue: true });
  details = { ...details, assignedTo: { type: "team", name: "web" } };
  await syncFiled(deps());
  expect(closes).toHaveLength(0);

  details = { ...details, assignedTo: { type: "user", name: "Jane" } };
  expect(await syncFiled(deps())).toEqual({ "sync-human-assigned": 1 });
  expect(closes[0]!.comment).toContain("person was assigned");
  expect(rec()).toMatchObject({ sync: "closed", closedReason: "human-assigned" });
});

test("fix PR opened AND merged between visits (issue already closed) → PR still recorded + noted", async () => {
  file("4501", { notedIssue: true });
  gh = { state: "closed", labels: [] };
  sessions = [
    session(
      { state: "merged", number: 7, url: "https://github.com/o/r/pull/7", checks: "success" },
      { status: "done" },
    ),
  ];
  expect(await syncFiled(deps())).toEqual({ "sync-noted-pr": 1, "sync-gh-closed": 1 });
  expect(posts.map((p) => p.text)).toEqual([
    "Shepherd opened a fix: https://github.com/o/r/pull/7",
  ]);
  expect(rec()).toMatchObject({
    sync: "closed",
    pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    notedPr: "https://github.com/o/r/pull/7",
  });
});

test("GitHub issue closed elsewhere → record goes terminal without any Sentry call", async () => {
  file();
  gh = { state: "closed", labels: [] };
  expect(await syncFiled(deps())).toEqual({ "sync-gh-closed": 1 });
  expect(rec().sync).toBe("closed");
  expect(gets).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("forge read failure (null) → skipped, nothing written but the sync stamp", async () => {
  file();
  gh = null;
  expect(await syncFiled(deps())).toEqual({ "sync-gh-unavailable": 1 });
  expect(rec().sync).toBeUndefined();
  expect(closes).toHaveLength(0);
});

test("Sentry 429 stops the pass; oldest-synced records go first; at most 10 per pass", async () => {
  for (let i = 0; i < 12; i++) file(String(4600 + i), { notedIssue: true, syncedAt: 100 - i });
  const d = deps();
  d.get = async (path) => {
    gets.push(path);
    return res(gets.length === 3 ? 429 : 200, details);
  };
  expect(await syncFiled(d)).toEqual({ "sync-rate-limited": 1 });
  expect(gets).toHaveLength(3);
  // syncedAt 100-11 = 89 is the oldest.
  expect(gets[0]).toBe("organizations/acme/issues/4611/");

  gets = [];
  await syncFiled(deps());
  expect(gets).toHaveLength(10);
});

test("a re-filing during the pass is never overwritten by the stale record's patch", async () => {
  file("4501", { notedIssue: true });
  details = { ...details, status: "resolved" };
  const d = deps();
  d.issues.close = async () => {
    file("4501", { number: 102, filedAt: "2026-09-26T10:00:00.000Z", attempts: 2 });
  };
  await syncFiled(d);
  expect(rec()).toMatchObject({ number: 102, attempts: 2 });
  expect(rec().sync).toBeUndefined();
});
