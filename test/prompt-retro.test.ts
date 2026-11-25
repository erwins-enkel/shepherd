import { describe, expect, it } from "bun:test";
import {
  summarize,
  type RetroMessage,
  type RetroMessages,
  type RetroSession,
} from "../agent-skills/.claude/skills/prompt-retro/collect";

const REPO = "/repo/a";
const T0 = 1_000_000;
const HOUR = 3_600_000;

function session(over: Partial<RetroSession> & { id: string }): RetroSession {
  return {
    desig: over.id.toUpperCase(),
    prompt: `prompt of ${over.id}`,
    repoPath: REPO,
    auto: false,
    issueNumber: null,
    scheduleId: null,
    terminal: false,
    archiveReason: "merged",
    createdAt: T0,
    settledAt: T0 + 3 * HOUR,
    archivedAt: T0 + 4 * HOUR,
    ...over,
  };
}

const user = (text: string, ts: number, extra: Partial<RetroMessage> = {}): RetroMessage => ({
  role: "user",
  text,
  ts,
  ...extra,
});

const ok = (messages: RetroMessage[]): RetroMessages => ({ messages, unavailable: null });

describe("prompt-retro summarize()", () => {
  it("labels origin and keeps the opening prompt only for typed sessions", () => {
    const sessions = [
      session({ id: "t1" }),
      session({ id: "i1", issueNumber: 7 }),
      session({ id: "a1", auto: true, issueNumber: 8 }),
      session({ id: "s1", scheduleId: "sch" }),
      session({ id: "r1", landingRepair: true }),
      // Relaunches repeat t1's prompt; they don't make it canned.
      session({ id: "t1r1", prompt: "prompt of t1", archiveReason: "relaunch" }),
      session({ id: "t1r2", prompt: "prompt of t1", archiveReason: "relaunch" }),
      // The same opening on 3 archived sessions, in any repo, is a canned prompt.
      session({
        id: "m1",
        prompt: "Run a merge train for the PRs I flagged. Review each one, then merge #1",
      }),
      session({
        id: "m2",
        prompt: "Run a merge train for the PRs I flagged. Review each one, then merge #2",
      }),
      session({
        id: "m3",
        repoPath: "/repo/b",
        prompt: "Run a merge train for the PRs I flagged. Review each one, then merge #3",
      }),
    ];
    const out = summarize(sessions, new Map(), { repo: REPO, limit: 30 });
    const by = Object.fromEntries(out.sessions.map((s) => [s.desig, s]));
    expect(by.T1?.origin).toBe("typed");
    expect(by.T1?.openingPrompt).toBe("prompt of t1");
    expect(by.I1?.origin).toBe("issue");
    expect(by.A1?.origin).toBe("auto");
    expect(by.S1?.origin).toBe("schedule");
    expect(by.R1?.origin).toBe("repair");
    expect(by.M1?.origin).toBe("template");
    expect(by.T1?.origin).toBe("typed");
    for (const d of ["I1", "A1", "S1", "R1", "M1", "M2"]) expect(by[d]?.openingPrompt).toBeNull();
  });

  it("skips terminal, relaunched, unarchived and other-repo sessions and counts them", () => {
    const sessions = [
      session({ id: "keep" }),
      session({ id: "term", terminal: true }),
      session({ id: "relaunch", archiveReason: "relaunch" }),
      session({ id: "noop", scheduleId: "sch", archiveReason: "noop" }),
      session({ id: "live", archivedAt: null }),
      session({ id: "other", repoPath: "/repo/b" }),
    ];
    const out = summarize(sessions, new Map(), { repo: REPO, limit: 30 });
    expect(out.sessions.map((s) => s.desig)).toEqual(["KEEP"]);
    expect(out.sample.skipped).toEqual({
      terminal: 1,
      relaunch: 1,
      noop: 1,
      unarchived: 1,
      otherRepo: 1,
    });
    expect(out.sample.considered).toBe(1);
  });

  it("takes every repo when repo is null", () => {
    const sessions = [session({ id: "a" }), session({ id: "b", repoPath: "/repo/b" })];
    const out = summarize(sessions, new Map(), { repo: null, limit: 30 });
    expect(out.sessions).toHaveLength(2);
    expect(out.sample.skipped.otherRepo).toBe(0);
  });

  it("keeps the newest `limit` sessions by archive time, newest first", () => {
    const sessions = [1, 2, 3, 4].map((n) => session({ id: `s${n}`, archivedAt: T0 + n * HOUR }));
    const out = summarize(sessions, new Map(), { repo: REPO, limit: 2 });
    expect(out.sessions.map((s) => s.desig)).toEqual(["S4", "S3"]);
  });

  it("buckets operator steers by thirds of the session's life", () => {
    const s = session({ id: "p", createdAt: 0, settledAt: 3 * HOUR });
    const msgs = ok([
      user("opening", 0, { initial: true }),
      { role: "assistant", text: "working", ts: 10 },
      user("early", 0.5 * HOUR),
      user("middle", 1.5 * HOUR),
      user("late", 2.9 * HOUR),
      user("unknown time", 0),
    ]);
    const [d] = summarize([s], new Map([["p", msgs]]), { repo: REPO, limit: 30 }).sessions;
    expect(d?.operatorSteers).toEqual([
      { phase: "start", text: "early" },
      { phase: "mid", text: "middle" },
      { phase: "end", text: "late" },
      { phase: "mid", text: "unknown time" },
    ]);
  });

  it("spans phases over transcript activity, not the idle time before the archive", () => {
    const s = session({ id: "p", createdAt: 0, settledAt: null, archivedAt: 30 * HOUR });
    const msgs = ok([
      user("early", 0.5 * HOUR),
      user("late", 2.5 * HOUR),
      { role: "assistant", text: "done", ts: 3 * HOUR },
      user("Shepherd: PR #9 merged into main.", 20 * HOUR),
      { role: "assistant", text: "nothing left to do", ts: 20 * HOUR },
      user("Heads-up: your base branch moved. origin/main has 4", 28 * HOUR),
      { role: "assistant", text: "no rebase needed", ts: 28 * HOUR },
    ]);
    const [d] = summarize([s], new Map([["p", msgs]]), { repo: REPO, limit: 30 }).sessions;
    expect(d?.operatorSteers.map((x) => x.phase)).toEqual(["start", "end"]);
    expect(d?.durationMin).toBe(1800);
  });

  it("counts Shepherd steers by kind, including `Shepherd:`-prefixed ones, never as operator steers", () => {
    const msgs = ok([
      user("The PR critic reviewed your latest push", T0 + 1, { steer: "review" }),
      user("You're in autopilot and CI is failing", T0 + 2, { steer: "ci_fix" }),
      user("x", T0 + 3, { steer: "ci_fix" }),
      user("x", T0 + 4, { steer: "brand_new_kind" }),
      user("Shepherd: CI finished on abc123: failed — lint. Read the logs", T0 + 5),
      user("Shepherd: CI finished on abc123: all checks passed.", T0 + 6),
      user("Shepherd: PR #4 merged into main. Your work has landed", T0 + 7),
      user("please also handle the empty case", T0 + 8),
    ]);
    const [d] = summarize([session({ id: "k" })], new Map([["k", msgs]]), {
      repo: REPO,
      limit: 30,
    }).sessions;
    expect(d?.shepherdSteers).toEqual({
      review: 1,
      ci_fix: 2,
      brand_new_kind: 1,
      ci_red: 1,
      merged: 1,
      shepherd_other: 1,
    });
    expect(d?.operatorSteers.map((s) => s.text)).toEqual(["please also handle the empty case"]);
  });

  it("drops harness records, unwraps pastes, and tags pasted Shepherd steers", () => {
    const msgs = ok([
      user("<task-notification> <task-id>a1</task-id> done", T0 + 1),
      user("<command-name>/effort</command-name>", T0 + 2),
      user("<local-command-stdout>Set effort level</local-command-stdout>", T0 + 3),
      user("This session is being continued from a previous conversation that ran out", T0 + 4),
      user("[Request interrupted by user for tool use]", T0 + 5),
      user(
        '<pasted_content id="x">\nHeads-up: your base branch moved. origin/main has 3\n</pasted_content id="x">',
        T0 + 6,
      ),
      user(
        '<pasted_content id="y">\nShepherd: CI on PR #2 failed before starting any job\n</pasted_content id="y">',
        T0 + 7,
      ),
      user('<pasted_content id="z">\nship the narrow fix first\n</pasted_content id="z">', T0 + 8),
    ]);
    const [d] = summarize([session({ id: "h" })], new Map([["h", msgs]]), {
      repo: REPO,
      limit: 30,
    }).sessions;
    expect(d?.shepherdSteers).toEqual({ base_moved: 1, ci_red: 1 });
    expect(d?.operatorSteers.map((s) => s.text)).toEqual(["ship the narrow fix first"]);
  });

  it("caps operator steers to the first 4 and last 4 and truncates long text", () => {
    const steers = Array.from({ length: 10 }, (_, i) => user(`steer ${i}`, T0 + i + 1));
    steers[0] = user("x".repeat(500), T0 + 1);
    const s = session({ id: "c", prompt: "p".repeat(1500) });
    const [d] = summarize([s], new Map([["c", ok(steers)]]), { repo: REPO, limit: 30 }).sessions;
    expect(d?.operatorSteerCount).toBe(10);
    expect(d?.operatorSteers.map((x) => x.text.slice(0, 7))).toEqual([
      "xxxxxxx",
      "steer 1",
      "steer 2",
      "steer 3",
      "steer 6",
      "steer 7",
      "steer 8",
      "steer 9",
    ]);
    expect(d?.operatorSteers[0]?.text).toHaveLength(401);
    expect(d?.operatorSteers[0]?.text.endsWith("…")).toBe(true);
    expect(d?.openingPrompt).toHaveLength(1201);
  });

  it("marks the window complete when it reached the opening prompt or held fewer than 100 messages", () => {
    const full = Array.from({ length: 100 }, (_, i) => user(`m${i}`, T0 + i + 1));
    const withInitial = [user("opening", T0, { initial: true }), ...full.slice(1)];
    const map = new Map([
      ["cut", ok(full)],
      ["start", ok(withInitial)],
      ["short", ok(full.slice(0, 5))],
    ]);
    const sessions = ["cut", "start", "short"].map((id) => session({ id }));
    const out = summarize(sessions, map, { repo: REPO, limit: 30 });
    const by = Object.fromEntries(out.sessions.map((s) => [s.desig, s.windowComplete]));
    expect(by).toEqual({ CUT: false, START: true, SHORT: true });
  });

  it("passes an unreadable transcript through instead of dropping the session", () => {
    const map = new Map<string, RetroMessages>([
      ["gone", { messages: [], unavailable: "file-missing" }],
    ]);
    const out = summarize([session({ id: "gone" }), session({ id: "nomsg" })], map, {
      repo: REPO,
      limit: 30,
    });
    const by = Object.fromEntries(out.sessions.map((s) => [s.desig, s.transcript]));
    expect(by).toEqual({ GONE: "file-missing", NOMSG: "not-fetched" });
  });
});
