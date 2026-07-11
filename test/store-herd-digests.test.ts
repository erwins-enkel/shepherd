import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { HerdDigest } from "../src/types";

const d = (over: Partial<HerdDigest> = {}): HerdDigest => ({
  dayKey: "2026-06-15",
  state: "generating",
  overnight: "",
  decisions: [],
  ciRework: [],
  train: "",
  focusNext: [],
  epicsToLand: [],
  attentionFingerprint: {},
  spawnSessionId: "spawn-1",
  cwd: "/tmp/rundown-1",
  model: "claude-opus-4-8",
  spawnedAt: 1000,
  generatedAt: null,
  updatedAt: 1000,
  ...over,
});

test("herd_digests: put→get round-trip (incl. JSON columns)", () => {
  const s = new SessionStore(":memory:");
  expect(s.getHerdDigest("2026-06-15")).toBeNull();
  s.putHerdDigest(
    d({
      state: "ready",
      overnight: "2 PRs merged",
      decisions: [{ label: "answer auth", sessionId: "s1" }],
      ciRework: [{ label: "ci red", pr: 42 }],
      train: "1 ready",
      focusNext: [{ label: "review migration" }],
      attentionFingerprint: { s1: ["ci-red", "in-flight"] },
      epicsToLand: [{ repo: "/repo/a", parent: 7, title: "Epic A", landingPr: 99, stranded: true }],
      generatedAt: 2000,
    }),
  );
  const got = s.getHerdDigest("2026-06-15");
  expect(got).not.toBeNull();
  expect(got?.state).toBe("ready");
  expect(got?.overnight).toBe("2 PRs merged");
  expect(got?.decisions).toEqual([{ label: "answer auth", sessionId: "s1" }]);
  expect(got?.ciRework).toEqual([{ label: "ci red", pr: 42 }]);
  expect(got?.focusNext).toEqual([{ label: "review migration" }]);
  expect(got?.epicsToLand).toEqual([
    {
      repo: "/repo/a",
      parent: 7,
      title: "Epic A",
      landingPr: 99,
      stranded: true,
      ciFailing: false,
    },
  ]);
  expect(got?.attentionFingerprint).toEqual({ s1: ["ci-red", "in-flight"] });
  expect(got?.model).toBe("claude-opus-4-8");
  expect(got?.generatedAt).toBe(2000);
});

test("herd_digests: upsert overwrites existing row", () => {
  const s = new SessionStore(":memory:");
  s.putHerdDigest(d());
  s.putHerdDigest(d({ state: "failed", generatedAt: 3000, updatedAt: 3000 }));
  const got = s.getHerdDigest("2026-06-15");
  expect(got?.state).toBe("failed");
  expect(got?.generatedAt).toBe(3000);
});

test("herd_digests: getLatest by spawnedAt desc; generating filter", () => {
  const s = new SessionStore(":memory:");
  s.putHerdDigest(d({ dayKey: "2026-06-14", spawnedAt: 100, state: "ready" }));
  s.putHerdDigest(d({ dayKey: "2026-06-15", spawnedAt: 200, state: "generating" }));
  expect(s.getLatestHerdDigest()?.dayKey).toBe("2026-06-15");
  const gen = s.generatingHerdDigests();
  expect(gen.length).toBe(1);
  expect(gen[0]!.dayKey).toBe("2026-06-15");
});

test("overnightDelta: merged PRs from issue_log and archived sessions after sinceTs", () => {
  const s = new SessionStore(":memory:");
  s.markIssueLog("s1", "merged:42");
  s.markIssueLog("s1", "waiting:7"); // non-merged key ignored
  s.markIssueLog("s2", "merged:99");

  const sess = s.create({
    name: "t",
    prompt: "",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "feat",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "",
    model: null,
  } as any);
  s.archive(sess.id);

  const delta = s.overnightDelta(0);
  expect(delta.mergedPrs.sort((a, b) => a - b)).toEqual([42, 99]);
  expect(delta.archivedSessions.map((a) => a.id)).toContain(sess.id);
  expect(delta.archivedSessions[0]!.desig).toBe(sess.desig);

  // Nothing after a future cutoff.
  const future = s.overnightDelta(Date.now() + 10_000);
  expect(future.mergedPrs).toEqual([]);
  expect(future.archivedSessions).toEqual([]);
});
