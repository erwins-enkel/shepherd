import { test, expect } from "bun:test";
import {
  INTENT_ISSUE_TEMPLATE,
  INTENT_SECTIONS,
  composeTaskBrief,
  type TaskBriefDraft,
} from "../src/intent-shape";
import type { ResolvedAnswer } from "../src/plan-gate";
import type { PlanQuestion } from "../src/visual-blocks";

const draft: TaskBriefDraft = {
  problem: "The reaper leaks tabs across a restart.",
  outcome: "No orphan tab survives a Shepherd restart.",
  constraints: ["Keep the existing label vocabulary", "  "],
  nonGoals: ["Rewriting herdr"],
};

const questions: PlanQuestion[] = [
  { id: "q1", prompt: "Which reaper is in scope?", kind: "single", options: ["tab", "transient"] },
  { id: "q2", prompt: "Which labels?", kind: "multi", options: ["review", "namer"] },
  { id: "q3", prompt: "What is out of scope?", kind: "freeform" },
];

function answer(over: Partial<ResolvedAnswer> & { questionId: string }): ResolvedAnswer {
  return {
    blockId: "b",
    prompt: questions.find((q) => q.id === over.questionId)?.prompt ?? "",
    kind: "single",
    selected: [],
    ...over,
  };
}

test("renders every section, one answer per question, in intent-shape order", () => {
  const brief = composeTaskBrief(draft, questions, [
    answer({ questionId: "q1", kind: "single", selected: ["tab"] }),
    answer({ questionId: "q2", kind: "multi", selected: ["review", "namer"] }),
    answer({ questionId: "q3", kind: "freeform", text: "herdr itself" }),
  ]);
  expect(brief).toBe(
    [
      "## Problem",
      "The reaper leaks tabs across a restart.",
      "",
      "## Outcome",
      "No orphan tab survives a Shepherd restart.",
      "",
      "## Constraints",
      "- Keep the existing label vocabulary",
      "",
      "## Non-goals",
      "- Rewriting herdr",
      "",
      "## Clarifications",
      "- Which reaper is in scope?",
      "  → tab",
      "- Which labels?",
      "  → review, namer",
      "- What is out of scope?",
      "  → herdr itself",
      "",
    ].join("\n"),
  );
});

test("an empty multi answer is answered, not open", () => {
  const brief = composeTaskBrief(
    draft,
    [questions[1]!],
    [answer({ questionId: "q2", kind: "multi", selected: [] })],
  );
  expect(brief).toContain("→ (none selected)");
  expect(brief).not.toContain("## Open questions");
});

test("a question with no resolved answer is carried into Open questions, never dropped", () => {
  const brief = composeTaskBrief(draft, questions, [
    answer({ questionId: "q1", kind: "single", selected: ["tab"] }),
  ]);
  expect(brief).toContain("## Clarifications\n- Which reaper is in scope?");
  expect(brief).toContain("## Open questions\n- Which labels?\n- What is out of scope?");
});

test("empty draft sections are omitted rather than left as bare headings", () => {
  const brief = composeTaskBrief(
    { problem: "p", outcome: "", constraints: [], nonGoals: [] },
    [],
    [],
  );
  expect(brief).toBe("## Problem\np\n");
});

test("the issue template carries every intent section as a fillable skeleton", () => {
  for (const s of INTENT_SECTIONS) {
    expect(INTENT_ISSUE_TEMPLATE).toContain(`## ${s.heading}`);
    expect(INTENT_ISSUE_TEMPLATE).toContain(`<!-- ${s.hint} -->`);
  }
  expect(INTENT_ISSUE_TEMPLATE.startsWith("---\nname: Task\n")).toBe(true);
});

test("brief headings and template headings come from the same section list", () => {
  const brief = composeTaskBrief(draft, [questions[0]!], []);
  // Every draft-backed section of the brief is a heading the template also ships.
  for (const heading of ["Problem", "Outcome", "Constraints", "Non-goals", "Open questions"]) {
    expect(INTENT_SECTIONS.some((s) => s.heading === heading)).toBe(true);
    expect(brief).toContain(`## ${heading}`);
  }
});
