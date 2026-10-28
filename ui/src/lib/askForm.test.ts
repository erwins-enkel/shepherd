import { describe, expect, it } from "vitest";
import { askToQuestionForm } from "./askForm";

describe("askToQuestionForm", () => {
  it("maps an AskUserQuestion to a question-form keyed by tool_use id + question index", () => {
    expect(
      askToQuestionForm({
        toolUseId: "toolu_1",
        questions: [
          {
            question: "Color?",
            header: "Color",
            multiSelect: false,
            options: [
              { label: "Red", description: "warm" },
              { label: "Blue", description: "cool" },
            ],
          },
          {
            question: "Tops?",
            header: "Tops",
            multiSelect: true,
            options: [{ label: "Ham", description: "" }],
          },
        ],
      }),
    ).toEqual({
      type: "question-form",
      id: "toolu_1",
      questions: [
        {
          id: "0",
          prompt: "Color?",
          kind: "single",
          options: ["Red", "Blue"],
          optionDescriptions: ["warm", "cool"],
          header: "Color",
          allowOther: true,
        },
        {
          id: "1",
          prompt: "Tops?",
          kind: "multi",
          options: ["Ham"],
          optionDescriptions: [""],
          header: "Tops",
          allowOther: true,
        },
      ],
    });
  });
});

it("preserves Codex question IDs after partial answers and renders free text", () => {
  const form = askToQuestionForm({
    toolUseId: "codex",
    questions: [
      {
        id: "2",
        question: "Details?",
        header: "",
        multiSelect: false,
        options: [],
        kind: "freeform",
        allowOther: true,
      },
    ],
  });
  expect(form.questions[0]).toMatchObject({ id: "2", kind: "freeform", allowOther: false });
});
