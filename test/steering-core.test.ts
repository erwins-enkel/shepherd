import { describe, expect, it } from "bun:test";
import { summarize } from "../agent-skills/.claude/skills/prompt-retro/collect";
import {
  STEERING_RESULT_FILE,
  THIN_TYPED_MIN,
  buildSteeringPrompt,
  computeSteeringTables,
  labelsForStatus,
  latestSteeringFindings,
  parseSteeringResult,
  selectSteeringSessions,
  steeringHeadline,
  steeringStatus,
  steeringTrend,
  summarizeSteering,
  weeklySteeringDue,
  type SteeringDigest,
  type SteeringLabels,
  type SteeringMessage,
  type SteeringMessages,
  type SteeringReport,
  type SteeringReportSession,
  type SteeringSessionDigest,
  type SteeringSessionInput,
} from "../src/steering-core";
import { UNTRUSTED_CONTENT_DIRECTIVE } from "../src/untrusted";

const REPO = "/repo/a";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;
const T0 = NOW - 2 * DAY;
const WEEK = { now: NOW, windowMs: 7 * DAY, cap: 60 };

function session(over: Partial<SteeringSessionInput> & { id: string }): SteeringSessionInput {
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

const user = (text: string, ts: number, extra: Partial<SteeringMessage> = {}): SteeringMessage => ({
  role: "user",
  text,
  ts,
  ...extra,
});

const ok = (messages: SteeringMessage[]): SteeringMessages => ({ messages, unavailable: null });

const byDesig = (d: SteeringDigest) => Object.fromEntries(d.sessions.map((s) => [s.desig, s]));

describe("summarizeSteering() reduction", () => {
  it("labels origin (incl. template) and keeps the opening prompt only for typed sessions", () => {
    const merge = "Run a merge train for the PRs I flagged. Review each one, then merge";
    const sessions = [
      session({ id: "t1" }),
      session({ id: "i1", issueNumber: 7 }),
      session({ id: "a1", auto: true, issueNumber: 8 }),
      session({ id: "s1", scheduleId: "sch" }),
      session({ id: "r1", landingRepair: true }),
      session({ id: "t1r1", prompt: "prompt of t1", archiveReason: "relaunch" }),
      session({ id: "t1r2", prompt: "prompt of t1", archiveReason: "relaunch" }),
      session({ id: "m1", prompt: `${merge} #1` }),
      session({ id: "m2", prompt: `${merge} #2` }),
      // Out of the window, other repo: still counts toward the template set.
      session({ id: "m3", repoPath: "/repo/b", prompt: `${merge} #3`, archivedAt: 1 }),
    ];
    const by = byDesig(summarizeSteering(sessions, new Map(), WEEK));
    expect(by.T1?.origin).toBe("typed");
    expect(by.T1?.openingPrompt).toBe("prompt of t1");
    expect(by.T1?.repo).toBe("a");
    expect(by.I1?.origin).toBe("issue");
    expect(by.A1?.origin).toBe("auto");
    expect(by.S1?.origin).toBe("schedule");
    expect(by.R1?.origin).toBe("repair");
    expect(by.M1?.origin).toBe("template");
    expect(by.M3).toBeUndefined();
    for (const d of ["I1", "A1", "S1", "R1", "M1", "M2"]) expect(by[d]?.openingPrompt).toBeNull();
  });

  it("skips unarchived, terminal, relaunch, noop and out-of-window sessions and counts them", () => {
    const sessions = [
      session({ id: "keep" }),
      session({ id: "edge", archivedAt: NOW - 7 * DAY }),
      session({ id: "term", terminal: true }),
      session({ id: "relaunch", archiveReason: "relaunch" }),
      session({ id: "noop", scheduleId: "sch", archiveReason: "noop" }),
      session({ id: "live", archivedAt: null }),
      session({ id: "old", archivedAt: NOW - 7 * DAY - 1 }),
    ];
    const out = summarizeSteering(sessions, new Map(), WEEK);
    expect(out.sessions.map((s) => s.desig)).toEqual(["KEEP", "EDGE"]);
    expect(out.sample).toEqual({
      windowStart: NOW - 7 * DAY,
      windowEnd: NOW,
      considered: 2,
      capped: false,
      skipped: { unarchived: 1, terminal: 1, relaunch: 1, noop: 1, outOfWindow: 1 },
    });
  });

  it("keeps the newest `cap` sessions, newest first, and records the cap", () => {
    const sessions = [1, 2, 3, 4].map((n) => session({ id: `s${n}`, archivedAt: T0 + n * HOUR }));
    const out = summarizeSteering(sessions, new Map(), { ...WEEK, cap: 2 });
    expect(out.sessions.map((s) => s.desig)).toEqual(["S4", "S3"]);
    expect(out.sample.capped).toBe(true);
    expect(out.sample.considered).toBe(2);
    const sel = selectSteeringSessions(sessions, { ...WEEK, cap: 2 });
    expect(sel.kept.map((s) => s.id)).toEqual(["s4", "s3"]);
    expect(sel.capped).toBe(true);
    expect(selectSteeringSessions(sessions, WEEK).capped).toBe(false);
  });

  it("buckets operator steers by thirds and gives each a stable index", () => {
    const s = session({ id: "p", createdAt: T0, settledAt: T0 + 3 * HOUR });
    const msgs = ok([
      user("opening", T0, { initial: true }),
      { role: "assistant", text: "working", ts: T0 + 10 },
      user("early", T0 + 0.5 * HOUR),
      user("middle", T0 + 1.5 * HOUR),
      user("late", T0 + 2.9 * HOUR),
      user("unknown time", 0),
    ]);
    const [d] = summarizeSteering([s], new Map([["p", msgs]]), WEEK).sessions;
    expect(d?.operatorSteers).toEqual([
      { index: 0, phase: "start", text: "early" },
      { index: 1, phase: "mid", text: "middle" },
      { index: 2, phase: "end", text: "late" },
      { index: 3, phase: "mid", text: "unknown time" },
    ]);
  });

  it("ignores tail-kind activity when spanning phases", () => {
    const s = session({ id: "p", createdAt: T0, settledAt: null, archivedAt: T0 + 30 * HOUR });
    const msgs = ok([
      user("early", T0 + 0.5 * HOUR),
      user("late", T0 + 2.5 * HOUR),
      { role: "assistant", text: "done", ts: T0 + 3 * HOUR },
      user("Shepherd: PR #9 merged into main.", T0 + 20 * HOUR),
      { role: "assistant", text: "nothing left", ts: T0 + 20 * HOUR },
      user("Heads-up: your base branch moved. origin/main has 4", T0 + 28 * HOUR),
      { role: "assistant", text: "no rebase needed", ts: T0 + 28 * HOUR },
    ]);
    const [d] = summarizeSteering([s], new Map([["p", msgs]]), WEEK).sessions;
    expect(d?.operatorSteers.map((x) => x.phase)).toEqual(["start", "end"]);
    expect(d?.shepherdSteers).toEqual({ merged: 1, base_moved: 1 });
    expect(d?.durationMin).toBe(1800);
  });

  it("drops harness noise, unwraps pastes, counts Shepherd steers by kind", () => {
    const msgs = ok([
      user("<task-notification> <task-id>a1</task-id> done", T0 + 1),
      user("<command-name>/effort</command-name>", T0 + 2),
      user("<local-command-stdout>Set effort</local-command-stdout>", T0 + 3),
      user("This session is being continued from a previous conversation that ran out", T0 + 4),
      user("[Request interrupted by user for tool use]", T0 + 5),
      user("critic", T0 + 6, { steer: "review" }),
      user("Shepherd: CI finished on abc: failed — lint", T0 + 7),
      user("Shepherd: CI finished on abc: all checks passed.", T0 + 8),
      user('<pasted_content id="z">\nship the narrow fix first\n</pasted_content id="z">', T0 + 9),
    ]);
    const [d] = summarizeSteering([session({ id: "h" })], new Map([["h", msgs]]), WEEK).sessions;
    expect(d?.shepherdSteers).toEqual({ review: 1, ci_red: 1, shepherd_other: 1 });
    expect(d?.operatorSteers.map((s) => s.text)).toEqual(["ship the narrow fix first"]);
  });

  it("keeps first and last 4 steers with their indices in the full list", () => {
    const steers = Array.from({ length: 10 }, (_, i) => user(`steer ${i}`, T0 + i + 1));
    const [d] = summarizeSteering(
      [session({ id: "c" })],
      new Map([["c", ok(steers)]]),
      WEEK,
    ).sessions;
    expect(d?.operatorSteerCount).toBe(10);
    expect(d?.operatorSteers.map((x) => x.index)).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
    expect(d?.operatorSteers[4]?.text).toBe("steer 6");
  });

  it("passes transcript availability through", () => {
    const map = new Map<string, SteeringMessages>([
      ["gone", { messages: [], unavailable: "file-missing" }],
    ]);
    const out = summarizeSteering([session({ id: "gone" }), session({ id: "nomsg" })], map, WEEK);
    const by = Object.fromEntries(out.sessions.map((s) => [s.desig, s.transcript]));
    expect(by).toEqual({ GONE: "file-missing", NOMSG: "not-fetched" });
  });
});

describe("parity with the /prompt-retro collect.ts reduction", () => {
  it("agrees per session on every shared field", () => {
    const merge = "Run a merge train for the PRs I flagged. Review each one, then merge";
    const sessions = [
      session({ id: "t1", prompt: "p".repeat(1500), archivedAt: T0 + 9 * HOUR }),
      session({ id: "t2", repoPath: "/repo/b", settledAt: null, archiveReason: "operator" }),
      session({ id: "i1", issueNumber: 3 }),
      session({ id: "m1", prompt: `${merge} #1` }),
      session({ id: "m2", prompt: `${merge} #2` }),
      session({ id: "m3", prompt: `${merge} #3` }),
      session({ id: "rl", archiveReason: "relaunch" }),
      session({ id: "gone" }),
    ];
    const steers = Array.from({ length: 12 }, (_, i) =>
      user(`s${i} ${"x".repeat(i * 50)}`, T0 + i),
    );
    const map = new Map<string, SteeringMessages>([
      ["t1", ok(steers)],
      [
        "t2",
        ok([
          user("opening", T0, { initial: true }),
          user("fix the tests", T0 + HOUR),
          user("x", T0 + 2 * HOUR, { steer: "ci_fix" }),
          user("Shepherd: PR #1 merged into main.", T0 + 3 * HOUR),
          { role: "assistant", text: "ok", ts: T0 + 4 * HOUR },
        ]),
      ],
      ["i1", ok([user("<command-name>/x</command-name>", T0 + 1), user("go on", T0 + 2)])],
      ["gone", { messages: [], unavailable: "file-missing" }],
    ]);
    const ref = summarize(sessions, map, { repo: null, limit: 60 });
    const ours = summarizeSteering(sessions, map, { now: NOW, windowMs: 365 * DAY, cap: 60 });
    expect(ours.sessions.map((s) => s.desig)).toEqual(ref.sessions.map((s) => s.desig));
    const shared = (s: SteeringSessionDigest | (typeof ref.sessions)[number]) => ({
      desig: s.desig,
      origin: s.origin,
      openingPrompt: s.openingPrompt,
      outcome: s.outcome,
      durationMin: s.durationMin,
      shepherdSteers: s.shepherdSteers,
      operatorSteerCount: s.operatorSteerCount,
      operatorSteers: s.operatorSteers.map(({ phase, text }) => ({ phase, text })),
      windowComplete: s.windowComplete,
      transcript: s.transcript,
    });
    expect(ours.sessions.map(shared)).toEqual(ref.sessions.map(shared));
  });
});

// ── labels ──────────────────────────────────────────────────────────────────────────────────────

/** Six sessions: five typed (A..E) and one issue session (I) with steers. */
function labelledDigest(): SteeringDigest {
  const typed = ["a", "b", "c", "d", "e"].map((id, n) =>
    session({ id, createdAt: T0, settledAt: T0 + (n + 1) * 10 * 60_000 }),
  );
  const sessions = [...typed, session({ id: "i", issueNumber: 1, archiveReason: "operator" })];
  const map = new Map<string, SteeringMessages>([
    [
      "a",
      ok([
        user("wrong file", T0 + 1),
        user("x", T0 + 2, { steer: "review" }),
        { role: "assistant", text: "fixed", ts: T0 + 10 * 60_000 },
      ]),
    ],
    [
      "b",
      ok([
        user("x", T0 + 1, { steer: "ci_fix" }),
        user("Shepherd: CI on abc failed", T0 + 2),
        user("x", T0 + 3, { steer: "plan_review" }),
      ]),
    ],
    ["i", ok([user("also do Y", T0 + 1), user("looks good", T0 + 5 * 60_000)])],
  ]);
  return summarizeSteering(sessions, map, WEEK);
}

const fullRaw = () => ({
  prompts: [
    { desig: "A", type: "bugfix", style: "prescribing" },
    { desig: "B", type: "bugfix", style: "describing" },
    { desig: "C", type: "feature", style: "describing" },
    { desig: "D", type: "Feature Work", style: "describing" },
    { desig: "E", type: "bugfix", style: "prescribing" },
  ],
  steers: [
    { desig: "A", index: 0, intent: "correction" },
    { desig: "I", index: 0, intent: "scope" },
    { desig: "I", index: 1, intent: "approval" },
  ],
  findings: [{ text: "Prescribing prompts drew corrections.", desigs: ["A", "E"] }],
  examples: [{ desig: "A", quote: "prompt of a", evidence: "1 correction", rewrite: "Better." }],
});

describe("parseSteeringResult()", () => {
  const digest = labelledDigest();

  it("accepts a well-formed result and normalizes type labels", () => {
    const labels = parseSteeringResult(fullRaw(), digest);
    expect(labels?.prompts).toHaveLength(5);
    expect(labels?.prompts.find((p) => p.desig === "D")?.type).toBe("feature-work");
    expect(labels?.steers).toHaveLength(3);
    expect(labels?.findings).toEqual(fullRaw().findings);
    expect(labels?.examples).toHaveLength(1);
  });

  it("drops unknown desigs, untyped prompt labels, missing steer indices and off-enum labels", () => {
    const raw = {
      prompts: [
        { desig: "A", type: "bugfix", style: "prescribing" },
        { desig: "ZZ", type: "bugfix", style: "describing" },
        { desig: "I", type: "bugfix", style: "describing" },
        { desig: "B", type: "bugfix", style: "vague" },
        { desig: "C", type: "  ", style: "describing" },
      ],
      steers: [
        { desig: "A", index: 0, intent: "correction" },
        { desig: "A", index: 5, intent: "correction" },
        { desig: "I", index: 0, intent: "rant" },
        { desig: "ZZ", index: 0, intent: "scope" },
        { desig: "I", index: "1", intent: "scope" },
      ],
      findings: [{ text: "cites nothing real", desigs: ["ZZ"] }],
      examples: [{ desig: "ZZ", quote: "q", evidence: "e", rewrite: "r" }],
    };
    const labels = parseSteeringResult(raw, digest);
    expect(labels?.prompts.map((p) => p.desig)).toEqual(["A"]);
    expect(labels?.steers).toEqual([{ desig: "A", index: 0, intent: "correction" }]);
    expect(labels?.findings).toEqual([]);
    expect(labels?.examples).toEqual([]);
  });

  it("clamps findings to 3 and examples to 5, and strips unknown desigs from findings", () => {
    const raw = {
      ...fullRaw(),
      findings: Array.from({ length: 5 }, (_, i) => ({ text: `f${i}`, desigs: ["A", "QQ"] })),
      examples: Array.from({ length: 7 }, (_, i) => ({
        desig: "B",
        quote: `q${i}`,
        evidence: "e",
        rewrite: "r",
      })),
    };
    const labels = parseSteeringResult(raw, digest);
    expect(labels?.findings.map((f) => f.text)).toEqual(["f0", "f1", "f2"]);
    expect(labels?.findings[0]?.desigs).toEqual(["A"]);
    expect(labels?.examples).toHaveLength(5);
  });

  it("caps string lengths and redacts secrets in prose", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
    const raw = {
      ...fullRaw(),
      findings: [{ text: `leaked ${token} here`, desigs: ["A"] }],
      examples: [
        {
          desig: "A",
          quote: `use ${token}`,
          evidence: `ev ${token}`,
          rewrite: "r".repeat(5000),
        },
      ],
    };
    const labels = parseSteeringResult(raw, digest);
    const ex = labels?.examples[0];
    expect(labels?.findings[0]?.text).toBe("leaked <redacted> here");
    expect(ex?.quote).toBe("use <redacted>");
    expect(ex?.evidence).toBe("ev <redacted>");
    expect(ex?.rewrite.length).toBeLessThan(5000);
  });

  it("returns null for junk or nothing usable", () => {
    expect(parseSteeringResult(null, digest)).toBeNull();
    expect(parseSteeringResult("hi", digest)).toBeNull();
    expect(parseSteeringResult([], digest)).toBeNull();
    expect(parseSteeringResult({}, digest)).toBeNull();
    expect(parseSteeringResult({ prompts: "x", steers: [{ desig: "ZZ" }] }, digest)).toBeNull();
  });
});

describe("computeSteeringTables()", () => {
  const digest = labelledDigest();
  const labels = parseSteeringResult(fullRaw(), digest) as SteeringLabels;

  it("builds rows by type with n, thin flag and medians (odd and even)", () => {
    const { byType } = computeSteeringTables(digest, labels);
    expect(byType.map((r) => r.key)).toEqual(["bugfix", "feature", "feature-work"]);
    const bugfix = byType[0];
    // A, B, E: durations 10, 20, 50 min; A one operator steer + one review; B ci 2 + plan 1.
    expect(bugfix).toEqual({
      key: "bugfix",
      n: 3,
      thin: false,
      mergedShare: 1,
      medianOperatorSteers: 0,
      medianReview: 0,
      medianCi: 0,
      medianPlanReview: 0,
      medianDurationMin: 20,
    });
    expect(byType[1]?.thin).toBe(true);
  });

  it("builds rows by style; even-n medians average the middle pair", () => {
    const { byStyle } = computeSteeringTables(digest, labels);
    const pres = byStyle.find((r) => r.key === "prescribing");
    const desc = byStyle.find((r) => r.key === "describing");
    // prescribing = A (10m), E (50m)
    expect(pres?.n).toBe(2);
    expect(pres?.medianDurationMin).toBe(30);
    expect(pres?.medianOperatorSteers).toBe(0.5);
    expect(pres?.medianReview).toBe(0.5);
    // describing = B (20m, ci 2), C (30m), D (40m)
    expect(desc?.n).toBe(3);
    expect(desc?.medianDurationMin).toBe(30);
    expect(desc?.medianCi).toBe(0);
  });

  it("computes merged share from outcome or a merged steer", () => {
    const d = summarizeSteering(
      [
        session({ id: "x", archiveReason: "operator" }),
        session({ id: "y", archiveReason: "operator" }),
        session({ id: "z", archiveReason: "operator" }),
        session({ id: "w", archiveReason: "merged", settledAt: null, archivedAt: T0 }),
      ],
      new Map([["x", ok([user("Shepherd: PR #1 merged into main.", T0 + 1)])]]),
      WEEK,
    );
    const l = parseSteeringResult(
      {
        prompts: ["X", "Y", "Z", "W"].map((desig) => ({ desig, type: "ops", style: "describing" })),
      },
      d,
    ) as SteeringLabels;
    const [row] = computeSteeringTables(d, l).byType;
    expect(row?.mergedShare).toBe(0.5);
    expect(row?.medianDurationMin).toBe(180);
  });

  it("returns null duration median when no session has a duration", () => {
    const digest2: SteeringDigest = {
      ...digest,
      sessions: digest.sessions.map((s) => ({ ...s, durationMin: null })),
    };
    const { byType } = computeSteeringTables(digest2, labels);
    expect(byType[0]?.medianDurationMin).toBeNull();
  });

  it("counts steer intents by phase", () => {
    const { intents } = computeSteeringTables(digest, labels);
    expect(intents).toEqual([
      { intent: "correction", start: 1, mid: 0, end: 0 },
      { intent: "scope", start: 1, mid: 0, end: 0 },
      { intent: "clarification", start: 0, mid: 0, end: 0 },
      { intent: "approval", start: 0, mid: 0, end: 1 },
    ]);
  });
});

describe("steeringStatus()", () => {
  it("is ok with >= THIN_TYPED_MIN typed sessions", () => {
    expect(THIN_TYPED_MIN).toBe(5);
    expect(steeringStatus(labelledDigest())).toBe("ok");
  });

  it("is thin with fewer typed sessions, and thin drops findings", () => {
    const d = summarizeSteering([session({ id: "a" })], new Map(), WEEK);
    expect(steeringStatus(d)).toBe("thin");
    const labels = parseSteeringResult(fullRaw(), labelledDigest()) as SteeringLabels;
    expect(labelsForStatus(labels, "thin").findings).toEqual([]);
    expect(labelsForStatus(labels, "ok").findings).toHaveLength(1);
  });

  it("is empty with no typed sessions and no operator steers", () => {
    const d = summarizeSteering([session({ id: "i", issueNumber: 2 })], new Map(), WEEK);
    expect(steeringStatus(d)).toBe("empty");
    const withSteer = summarizeSteering(
      [session({ id: "i", issueNumber: 2 })],
      new Map([["i", ok([user("do more", T0 + 1)])]]),
      WEEK,
    );
    expect(steeringStatus(withSteer)).toBe("thin");
  });
});

describe("buildSteeringPrompt()", () => {
  it("fences the digest once under the untrusted directive and names the result file", () => {
    const digest = labelledDigest();
    const prompt = buildSteeringPrompt(digest, "en");
    expect(prompt.split(UNTRUSTED_CONTENT_DIRECTIVE).length - 1).toBe(1);
    expect(prompt).toMatch(/⟦UNTRUSTED:steering digest:[0-9a-f]+⟧/);
    expect(prompt).toContain('"desig":"A"');
    expect(prompt).toContain(STEERING_RESULT_FILE);
    expect(prompt.indexOf(UNTRUSTED_CONTENT_DIRECTIVE)).toBeLessThan(prompt.indexOf("⟦UNTRUSTED"));
    expect(prompt).not.toContain("German");
  });

  it("asks for German prose when the operator language is de", () => {
    expect(buildSteeringPrompt(labelledDigest(), "de")).toContain("German");
  });
});

describe("weeklySteeringDue()", () => {
  it("is due with no weekly report yet", () => {
    expect(weeklySteeringDue(null, NOW)).toBe(true);
  });
  it("waits a week after a finished run", () => {
    expect(weeklySteeringDue({ createdAt: NOW - 6 * DAY, status: "ok" }, NOW)).toBe(false);
    expect(weeklySteeringDue({ createdAt: NOW - 7 * DAY, status: "empty" }, NOW)).toBe(true);
  });
  it("retries a failed run after a day", () => {
    expect(weeklySteeringDue({ createdAt: NOW - 23 * HOUR, status: "failed" }, NOW)).toBe(false);
    expect(weeklySteeringDue({ createdAt: NOW - DAY, status: "failed" }, NOW)).toBe(true);
  });
});

function reportSession(
  over: Partial<SteeringReportSession> & { desig: string },
): SteeringReportSession {
  return {
    repo: "a",
    origin: "typed",
    outcome: null,
    durationMin: null,
    operatorSteerCount: 0,
    shepherdSteers: {},
    ...over,
  };
}

function stored(over: Partial<SteeringReport> & { id: string }): SteeringReport {
  return {
    createdAt: NOW,
    windowStart: NOW - 7 * DAY,
    windowEnd: NOW,
    trigger: "weekly",
    status: "ok",
    error: null,
    model: null,
    sample: null,
    sessions: [],
    labels: { prompts: [], steers: [], findings: [], examples: [] },
    tables: null,
    ...over,
  };
}

describe("steeringHeadline()", () => {
  it("is the first finding, or null", () => {
    const labels = {
      prompts: [],
      steers: [],
      findings: [
        { text: "first", desigs: [] },
        { text: "second", desigs: [] },
      ],
      examples: [],
    };
    expect(steeringHeadline({ labels })).toBe("first");
    expect(steeringHeadline({ labels: { ...labels, findings: [] } })).toBeNull();
    expect(steeringHeadline({ labels: null })).toBeNull();
  });
});

describe("steeringTrend()", () => {
  const full = stored({
    id: "w2",
    createdAt: NOW,
    sessions: [
      reportSession({ desig: "T-1", shepherdSteers: { review: 2, ci_fix: 1 } }),
      reportSession({ desig: "T-2", shepherdSteers: { ci_red: 2 } }),
      reportSession({ desig: "T-3", shepherdSteers: { review: 4 } }),
      // not typed / not labelled → excluded
      reportSession({ desig: "I-1", origin: "issue", shepherdSteers: { review: 9 } }),
      reportSession({ desig: "T-9", shepherdSteers: { review: 9 } }),
    ],
    labels: {
      prompts: [
        { desig: "T-1", type: "bug", style: "prescribing" },
        { desig: "T-2", type: "bug", style: "describing" },
        { desig: "T-3", type: "feature", style: "prescribing" },
        { desig: "I-1", type: "bug", style: "prescribing" },
      ],
      steers: [
        { desig: "T-1", index: 0, intent: "correction" },
        { desig: "T-1", index: 1, intent: "correction" },
        { desig: "T-2", index: 0, intent: "scope" },
        { desig: "T-3", index: 0, intent: "correction" },
      ],
      findings: [],
      examples: [],
    },
  });

  it("computes each metric over typed, prompt-labelled sessions", () => {
    const [p] = steeringTrend([full]);
    expect(p).toEqual({
      reportId: "w2",
      createdAt: NOW,
      windowEnd: NOW,
      n: 3,
      prescribingShare: 2 / 3,
      medianCorrections: 1,
      medianReview: 2,
      medianCi: 1,
    });
  });

  it("keeps weekly ok/thin reports only, oldest first", () => {
    const points = steeringTrend([
      full,
      stored({ id: "manual", trigger: "manual", createdAt: NOW - DAY }),
      stored({ id: "empty", status: "empty", labels: null, createdAt: NOW - 2 * DAY }),
      stored({ id: "failed", status: "failed", labels: null, createdAt: NOW - 3 * DAY }),
      stored({ id: "w1", status: "thin", createdAt: NOW - 7 * DAY }),
    ]);
    expect(points.map((p) => p.reportId)).toEqual(["w1", "w2"]);
  });

  it("nulls the metrics of a report with no labelled typed session", () => {
    const [p] = steeringTrend([stored({ id: "w", sessions: [reportSession({ desig: "T-1" })] })]);
    expect(p).toMatchObject({
      n: 0,
      prescribingShare: null,
      medianCorrections: null,
      medianReview: null,
      medianCi: null,
    });
  });
});

describe("latestSteeringFindings", () => {
  const report = (over: Partial<SteeringReport>): SteeringReport => ({
    id: "r1",
    createdAt: 1,
    windowStart: 0,
    windowEnd: 1,
    trigger: "manual",
    status: "ok",
    error: null,
    model: null,
    sample: null,
    sessions: [],
    labels: {
      prompts: [],
      steers: [],
      findings: [
        { text: "Names the file first", desigs: ["a"] },
        { text: "", desigs: [] },
      ],
      examples: [],
    },
    tables: null,
    ...over,
  });
  it("returns the finding texts of an ok report", () => {
    expect(latestSteeringFindings(report({}))).toEqual(["Names the file first"]);
  });
  it("is empty without a usable report", () => {
    expect(latestSteeringFindings(null)).toEqual([]);
    expect(latestSteeringFindings(report({ status: "failed" }))).toEqual([]);
    expect(latestSteeringFindings(report({ status: "thin" }))).toEqual([]);
    expect(latestSteeringFindings(report({ labels: null }))).toEqual([]);
  });
});
