import { describe, expect, it } from "vitest";
import { hasCodexQuestionsHint } from "./codexQuestionsAffordance";

describe("hasCodexQuestionsHint", () => {
  it.each([
    "? 2 questions\n  alt + ↑ to answer",
    "? 1 question\n  alt + ↑ to answer",
    "  ? 12 QUESTIONS\n    ALT + ↑ to answer  ",
    "Working\n? 2 questions\n  alt + ↑ to answer\n\n› Ask Codex to do anything",
    "? 2 questions\n  alt + ↑ to\nanswer",
  ])("recognizes the queued-question hint: %s", (screen) => {
    expect(hasCodexQuestionsHint(screen)).toBe(true);
  });

  it.each([
    "",
    "? 0 questions\n  alt + ↑ to answer",
    "? 2 questions",
    "alt + ↑ to answer",
    "The agent has 2 questions; press alt + ↑ to answer them.",
    "? 2 questions\nOther output\nalt + ↑ to answer",
    "? 2 questions\nalt + ↑ to answer later",
    "Would you like to proceed?\n1. Yes\n2. No\nEnter to select",
    "Which layout?\n1. Compact\n2. Expanded\nEnter to submit",
  ])("ignores unrelated or incomplete content: %s", (screen) => {
    expect(hasCodexQuestionsHint(screen)).toBe(false);
  });
});
