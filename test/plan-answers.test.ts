import { describe, expect, it } from "bun:test";
import type { VisualBlock } from "../src/visual-blocks";
import { resolvePlanAnswers, planAnswerSteerText, type RawAnswer } from "../src/plan-gate";

const blocks: VisualBlock[] = [
  {
    type: "question-form",
    id: "qf1",
    questions: [
      {
        id: "q1",
        prompt: "Which approach?",
        kind: "single",
        options: ["Reuse column", "New table"],
      },
      { id: "q2", prompt: "Edge cases?", kind: "multi", options: ["Empty", "Huge", "Unicode"] },
      { id: "q3", prompt: "Notes?", kind: "freeform" },
    ],
  },
];

describe("resolvePlanAnswers", () => {
  it("resolves single/multi/freeform against persisted options", () => {
    const answers: RawAnswer[] = [
      { blockId: "qf1", questionId: "q1", optionIndices: [1] },
      { blockId: "qf1", questionId: "q2", optionIndices: [0, 2] },
      { blockId: "qf1", questionId: "q3", text: "  keep it minimal  " },
    ];
    const r = resolvePlanAnswers(blocks, answers);
    expect(r).toEqual([
      { prompt: "Which approach?", kind: "single", selected: ["New table"] },
      { prompt: "Edge cases?", kind: "multi", selected: ["Empty", "Unicode"] },
      { prompt: "Notes?", kind: "freeform", selected: [], text: "keep it minimal" },
    ]);
  });

  it("keeps an empty multi-select as an answered 'none selected'", () => {
    const r = resolvePlanAnswers(blocks, [{ blockId: "qf1", questionId: "q2", optionIndices: [] }]);
    expect(r).toEqual([{ prompt: "Edge cases?", kind: "multi", selected: [] }]);
  });

  it("drops unknown ids, out-of-range single indices, and blank freeform", () => {
    const r = resolvePlanAnswers(blocks, [
      { blockId: "qf1", questionId: "nope", optionIndices: [0] },
      { blockId: "other", questionId: "q1", optionIndices: [0] },
      { blockId: "qf1", questionId: "q1", optionIndices: [99] },
      { blockId: "qf1", questionId: "q3", text: "   " },
    ]);
    expect(r).toEqual([]);
  });

  it("dedups + drops out-of-range multi indices, order-preserving", () => {
    const r = resolvePlanAnswers(blocks, [
      { blockId: "qf1", questionId: "q2", optionIndices: [2, 0, 2, 5] },
    ]);
    expect(r).toEqual([{ prompt: "Edge cases?", kind: "multi", selected: ["Unicode", "Empty"] }]);
  });

  it("does not clobber the same questionId across two blocks (namespaced by blockId)", () => {
    const two: VisualBlock[] = [
      {
        type: "question-form",
        id: "a",
        questions: [{ id: "q", prompt: "A?", kind: "single", options: ["a0", "a1"] }],
      },
      {
        type: "question-form",
        id: "b",
        questions: [{ id: "q", prompt: "B?", kind: "single", options: ["b0", "b1"] }],
      },
    ];
    const r = resolvePlanAnswers(two, [
      { blockId: "a", questionId: "q", optionIndices: [0] },
      { blockId: "b", questionId: "q", optionIndices: [1] },
    ]);
    expect(r).toEqual([
      { prompt: "A?", kind: "single", selected: ["a0"] },
      { prompt: "B?", kind: "single", selected: ["b1"] },
    ]);
  });

  it("returns [] for non-array answers", () => {
    expect(resolvePlanAnswers(blocks, undefined as unknown as RawAnswer[])).toEqual([]);
  });
});

describe("planAnswerSteerText", () => {
  it("composes prose with each answered prompt + answer and the stop instruction", () => {
    const text = planAnswerSteerText([
      { prompt: "Which approach?", kind: "single", selected: ["New table"] },
      { prompt: "Edge cases?", kind: "multi", selected: ["Empty", "Unicode"] },
      { prompt: "Notes?", kind: "freeform", selected: [], text: "keep it minimal" },
    ]);
    expect(text).toContain(
      "Incorporate each answer into the plan, then stop so it can be re-reviewed",
    );
    expect(text).toContain("- Which approach?\n  → New table");
    expect(text).toContain("- Edge cases?\n  → Empty, Unicode");
    expect(text).toContain("- Notes?\n  → keep it minimal");
    expect(text).toContain("Don't start implementing yet");
  });

  it("renders an empty multi-select as (none selected)", () => {
    const text = planAnswerSteerText([{ prompt: "Edge cases?", kind: "multi", selected: [] }]);
    expect(text).toContain("- Edge cases?\n  → (none selected)");
  });
});
