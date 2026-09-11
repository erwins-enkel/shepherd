import { test, expect, beforeEach } from "bun:test";
import {
  peekIssue,
  clearIssuePeekCacheForTests,
  PEEK_TTL_MS,
  PEEK_BODY_MAX,
} from "../src/issue-peek";
import type { GitForge, Issue } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";

const ISSUE: Issue = {
  number: 72,
  title: "Stufe B: die Niederschrift",
  body: "Gesprochenes wird Text mit Zeitmarken.",
  url: "https://example.test/issues/72",
  labels: ["enhancement"],
  createdAt: 1_700_000_000_000,
  assignees: [],
};

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "github",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    openPr: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
    ...over,
  };
}

beforeEach(() => clearIssuePeekCacheForTests());

test("reads the issue through the forge and hands it back", async () => {
  const forge = fakeForge({ getIssue: async () => ISSUE });
  expect(await peekIssue(forge, "/repo", 72)).toEqual(ISSUE);
});

test("serves a second read from cache inside the TTL", async () => {
  let calls = 0;
  const forge = fakeForge({
    getIssue: async () => {
      calls++;
      return ISSUE;
    },
  });
  await peekIssue(forge, "/repo", 72);
  await peekIssue(forge, "/repo", 72);
  expect(calls).toBe(1);
});

test("reads again once the entry has aged past the TTL", async () => {
  let calls = 0;
  const forge = fakeForge({
    getIssue: async () => {
      calls++;
      return ISSUE;
    },
  });
  let now = 1_000;
  const clock = () => now;
  await peekIssue(forge, "/repo", 72, clock);
  now += PEEK_TTL_MS;
  await peekIssue(forge, "/repo", 72, clock);
  expect(calls).toBe(2);
});

test("caches per repo and per issue number", async () => {
  const seen: string[] = [];
  const forge = fakeForge({
    getIssue: async (n) => {
      seen.push(String(n));
      return { ...ISSUE, number: n };
    },
  });
  await peekIssue(forge, "/repo-a", 72);
  await peekIssue(forge, "/repo-a", 73);
  await peekIssue(forge, "/repo-b", 72);
  await peekIssue(forge, "/repo-a", 72);
  expect(seen).toEqual(["72", "73", "72"]);
});

// The point of the whole module: a hover sweep must not spawn one `gh` per card.
test("coalesces concurrent reads of one issue into a single forge call", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  const forge = fakeForge({
    getIssue: async () => {
      calls++;
      await gate;
      return ISSUE;
    },
  });
  const both = Promise.all([peekIssue(forge, "/repo", 72), peekIssue(forge, "/repo", 72)]);
  release!();
  const [a, b] = await both;
  expect(calls).toBe(1);
  expect(a).toEqual(ISSUE);
  expect(b).toEqual(ISSUE);
});

test("truncates an overlong body before it reaches the wire", async () => {
  const long = "x".repeat(PEEK_BODY_MAX + 500);
  const forge = fakeForge({ getIssue: async () => ({ ...ISSUE, body: long }) });
  const peeked = await peekIssue(forge, "/repo", 72);
  expect(peeked?.body.length).toBe(PEEK_BODY_MAX);
});

test("leaves a short body untouched", async () => {
  const forge = fakeForge({ getIssue: async () => ISSUE });
  expect((await peekIssue(forge, "/repo", 72))?.body).toBe(ISSUE.body);
});

test("answers null on a forge without single-issue reads", async () => {
  expect(await peekIssue(fakeForge(), "/repo", 72)).toBeNull();
});

test("answers null when the forge throws, and does not retry inside the TTL", async () => {
  let calls = 0;
  const forge = fakeForge({
    getIssue: async () => {
      calls++;
      throw new Error("rate limited");
    },
  });
  expect(await peekIssue(forge, "/repo", 72)).toBeNull();
  expect(await peekIssue(forge, "/repo", 72)).toBeNull();
  expect(calls).toBe(1);
});

test("caches a null answer for a gone issue", async () => {
  let calls = 0;
  const forge = fakeForge({
    getIssue: async () => {
      calls++;
      return null;
    },
  });
  await peekIssue(forge, "/repo", 72);
  await peekIssue(forge, "/repo", 72);
  expect(calls).toBe(1);
});
