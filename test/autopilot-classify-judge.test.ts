import { test, expect } from "bun:test";
import {
  JUDGE_QUESTION_ID,
  classifierPrompt,
  judgeClassifierQuestion,
  judgeVerdict,
  normalize,
  stripInputFooter,
  summaryFromTail,
} from "../src/autopilot-classify-core";
import type { JudgeChoiceAnswer } from "../src/judge";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The judge leg's PURE half (#2369): the question, the verdict adapter, and the tail excerpt that
// replaces the model-written summary. No network, no config, no filesystem — this module is a leaf
// on purpose and these tests keep it one.

function choice(over: Partial<JudgeChoiceAnswer> = {}): JudgeChoiceAnswer {
  return {
    type: "choice",
    choice: "gate",
    probabilities: { gate: 0.72, unknown: 0.28 },
    vendorConfidence: 0.64,
    ...over,
  };
}

// ── the question ────────────────────────────────────────────────────────────────

test("the question offers exactly the five kinds, with BARE option names", () => {
  const q = judgeClassifierQuestion();
  expect(q.type).toBe("choice");
  expect(Object.keys(q.criteria).sort()).toEqual([
    "complete",
    "finished",
    "gate",
    "question",
    "unknown",
  ]);
  // Every description is null BY DESIGN. The state carries the production prompt verbatim, which
  // already defines each kind; repeating the definitions here would say the same thing twice, and
  // the measured comparison against a purpose-authored criteria set went the other way — the
  // authored framing failed the ambiguous bucket toward `gate`, the direction that types `1` into a
  // live PTY.
  expect(Object.values(q.criteria).every((v) => v === null)).toBe(true);
});

test("the question is asked against the real production prompt, not a paraphrase of it", () => {
  // Not an assertion about wording — an assertion that the two legs share ONE source. The spawn
  // path builds this same string, so the classifier's definitions cannot drift between them.
  const prompt = classifierPrompt(["waiting for your call"], "ship the thing");
  expect(prompt).toContain('"gate"');
  expect(prompt).toContain("terminal tail");
});

// ── the verdict adapter ─────────────────────────────────────────────────────────

test("a choice becomes the verdict shape `normalize` already reads", () => {
  const raw = judgeVerdict(choice(), ["Ready to commit?"]);
  expect(raw).toEqual({ kind: "gate", summary: "Ready to commit?" });
  expect(normalize(raw)).toEqual({ kind: "gate", summary: "Ready to commit?" });
});

test("an off-enum choice returns null — fall back to the spawn, do NOT surface", () => {
  // Deliberately different from `normalize`'s off-enum handling. `normalize(null)` surfaces because
  // a spawn that wrote nonsense has already been paid for; here the spawn is still available and is
  // the better answer than pausing the session.
  expect(judgeVerdict(choice({ choice: "GATE" }), ["x"])).toBeNull();
  expect(judgeVerdict(choice({ choice: "" }), ["x"])).toBeNull();
  // For contrast: the surfacing path is what `normalize` does with nothing at all.
  expect(normalize(null)).toEqual({ kind: "unknown", summary: "" });
});

test("no confidence gate: a barely-won choice is taken at face value", () => {
  // Measured, not assumed. The abstains come back MORE confident than the correct `gate` calls, so
  // a low-confidence-to-`unknown` rule converts correct gates into surfaced sessions rather than
  // buying caution.
  const raw = judgeVerdict(
    choice({
      probabilities: { gate: 0.34, unknown: 0.33, question: 0.33 },
      vendorConfidence: 0.05,
    }),
    ["Ready?"],
  );
  expect(raw).toEqual({ kind: "gate", summary: "Ready?" });
});

test("the model abstains by CHOOSING unknown, which passes through unchanged", () => {
  expect(judgeVerdict(choice({ choice: "unknown" }), ["hmm"])).toEqual({
    kind: "unknown",
    summary: "hmm",
  });
});

// ── the tail excerpt ────────────────────────────────────────────────────────────

test("the excerpt is the agent's own last substantive lines", () => {
  const tail = ["ran the tests", "all green", "Shall I open the PR?"];
  expect(summaryFromTail(tail)).toBe("ran the tests all green Shall I open the PR?");
});

test("only the last few lines survive, so the gloss stays a gloss", () => {
  const tail = ["one", "two", "three", "four", "five"];
  expect(summaryFromTail(tail)).toBe("three four five");
});

test("box-drawing and punctuation-only chrome is dropped", () => {
  const tail = ["╭────────────╮", "│ Continue?  │", "╰────────────╯", "───", "  "];
  expect(summaryFromTail(tail)).toBe("│ Continue?  │");
});

test('an empty or chrome-only tail yields "", leaving the caller\'s existing constant in place', () => {
  // This is what keeps autopilot's control flow identical whichever classifier answered: every use
  // site is already `v.summary || SURFACE_MESSAGE` / `|| COMPLETE_MESSAGE`.
  expect(summaryFromTail([])).toBe("");
  expect(summaryFromTail(["   ", "\t"])).toBe("");
  expect(summaryFromTail(["─────", "═══"])).toBe("");
});

test("the excerpt is clipped to the same budget a model summary is", () => {
  const long = "x".repeat(500);
  expect(summaryFromTail([long])).toHaveLength(280);
});

test("non-Latin output survives — the excerpt needs no language directive to render German", () => {
  // The spawn path needs a prompt directive to get a German summary AND to stop the model
  // translating the enum token with it. An excerpt is in whatever language the agent wrote.
  expect(summaryFromTail(["Soll ich den PR öffnen?"])).toBe("Soll ich den PR öffnen?");
  expect(summaryFromTail(["完了しました"])).toBe("完了しました");
});

test("the question id the verdict is read under is the one the question is asked under", () => {
  expect(JUDGE_QUESTION_ID).toBe("kind");
});

// ── the idle input box + status line (#3224) ───────────────────────────────────

const fixture = (name: string): string[] =>
  readFileSync(join(import.meta.dir, `fixtures/fullscreen/${name}.txt`), "utf8").split("\n");

const RULE = "─".repeat(60);
const ISSUE_TAIL = [
  "PR #639 is green and ready for review.",
  RULE,
  "❯ ",
  RULE,
  "  …/.shepherd-worktrees/aetherial-vertretung-631 shepherd/vertretung-631 ⣿⣿⣿⡇ 34% ctx Opus 5.5 (1M context)",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #639",
  "                     Update available! Run: mise upgrade claude",
];

test("the idle input box and everything below it is cut off", () => {
  expect(stripInputFooter(ISSUE_TAIL)).toEqual(["PR #639 is green and ready for review."]);
  for (const name of ["fullscreen-idle", "classic-idle", "queued-messages"]) {
    const tail = fixture(name);
    const out = stripInputFooter(tail);
    expect(out.length).toBeLessThan(tail.length);
    expect(out.join("\n")).not.toMatch(/shift\+tab to cycle|Update available/);
  }
});

test("a menu or dialog has no input box, so nothing is cut", () => {
  for (const name of ["classic-menu", "fullscreen-menu"]) {
    const tail = fixture(name);
    expect(stripInputFooter(tail)).toEqual(tail);
  }
  expect(stripInputFooter([RULE, "❯ 1. Yes", "  2. No"])).toEqual([RULE, "❯ 1. Yes", "  2. No"]);
  expect(stripInputFooter(["no box here", "Shall I?"])).toEqual(["no box here", "Shall I?"]);
});

test("the excerpt is the agent's last words, never the status line", () => {
  expect(summaryFromTail(ISSUE_TAIL)).toBe("PR #639 is green and ready for review.");
  expect(summaryFromTail([RULE, "❯", RULE, "⏵⏵ bypass permissions on (shift+tab to cycle)"])).toBe(
    "",
  );
});
