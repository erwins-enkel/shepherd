import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import QuestionFormBlock from "./QuestionFormBlock.svelte";

const answerPlanQuestions = vi.fn<
  (id: string, answers: unknown[]) => Promise<{ delivered: boolean }>
>(async () => ({ delivered: true }));
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    answerPlanQuestions: (...a: unknown[]) =>
      answerPlanQuestions(...(a as Parameters<typeof answerPlanQuestions>)),
  };
});

afterEach(() => answerPlanQuestions.mockClear());

describe("QuestionFormBlock", () => {
  it("renders single-kind prompt, options as radios, and kind hint", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf1",
        questions: [
          {
            id: "q1",
            prompt: "Which approach do you prefer?",
            kind: "single",
            options: ["Option A", "Option B"],
          },
        ],
      },
    });
    await expect.element(page.getByText("Which approach do you prefer?")).toBeInTheDocument();
    // kind hint
    await expect.element(page.getByText("Select one")).toBeInTheDocument();
    // radio inputs
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(2);
    await expect.element(page.getByText("Option A")).toBeInTheDocument();
    await expect.element(page.getByText("Option B")).toBeInTheDocument();
  });

  it("renders multi-kind options as checkboxes", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf2",
        questions: [
          {
            id: "q2",
            prompt: "Select all valid options",
            kind: "multi",
            options: ["Choice X", "Choice Y", "Choice Z"],
          },
        ],
      },
    });
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(3);
    await expect.element(page.getByText("Select all that apply")).toBeInTheDocument();
  });

  it("renders freeform prompt with free-response affordance and no options", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf3",
        questions: [
          {
            id: "q3",
            prompt: "Describe your reasoning",
            kind: "freeform",
          },
        ],
      },
    });
    await expect.element(page.getByText("Describe your reasoning")).toBeInTheDocument();
    await expect.element(page.getByText("Free response")).toBeInTheDocument();
    // no radio or checkbox inputs for freeform
    const inputs = container.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    expect(inputs.length).toBe(0);
  });

  it("all rendered inputs are disabled", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf4",
        questions: [
          {
            id: "q4",
            prompt: "Pick one",
            kind: "single",
            options: ["Yes", "No"],
          },
          {
            id: "q5",
            prompt: "Pick many",
            kind: "multi",
            options: ["A", "B"],
          },
        ],
      },
    });
    const allInputs = container.querySelectorAll("input");
    expect(allInputs.length).toBeGreaterThan(0);
    for (const input of allInputs) {
      expect(input.disabled).toBe(true);
    }
  });
});

describe("QuestionFormBlock — interactive (answerCtx present)", () => {
  const block = {
    type: "question-form" as const,
    id: "qf",
    questions: [
      { id: "q1", prompt: "Which approach?", kind: "single" as const, options: ["Reuse", "New"] },
      { id: "q2", prompt: "Edge cases?", kind: "multi" as const, options: ["Empty", "Huge"] },
      { id: "q3", prompt: "Notes?", kind: "freeform" as const },
    ],
  };

  it("enables inputs when answerCtx is present", async () => {
    const { container } = render(QuestionFormBlock, {
      block,
      answerCtx: { sessionId: "s1", locked: false },
    });
    const inputs = container.querySelectorAll("input");
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.disabled).toBe(false);
  });

  it("keeps submit disabled until single + freeform are answered, then submits the payload", async () => {
    const { container } = render(QuestionFormBlock, {
      block,
      answerCtx: { sessionId: "sess-9", locked: false },
    });
    const button = page.getByRole("button");
    await expect.element(button).toBeDisabled();

    // Answer the required single + freeform (multi left empty on purpose).
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await page.elementLocator(radios[1]!).click(); // "New" → index 1
    const text = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    await page.elementLocator(text).fill("keep it minimal");

    await expect.element(button).toBeEnabled();
    await button.click();

    expect(answerPlanQuestions).toHaveBeenCalledTimes(1);
    const [sid, answers] = answerPlanQuestions.mock.calls[0]!;
    expect(sid).toBe("sess-9");
    expect(answers).toEqual([
      { blockId: "qf", questionId: "q1", optionIndices: [1] },
      { blockId: "qf", questionId: "q2", optionIndices: [] },
      { blockId: "qf", questionId: "q3", text: "keep it minimal" },
    ]);
    await expect.element(page.getByText("Answers sent to the planning agent.")).toBeInTheDocument();
  });

  it("disables submit while a plan review is in flight (locked)", async () => {
    render(QuestionFormBlock, { block, answerCtx: { sessionId: "s1", locked: true } });
    await expect.element(page.getByRole("button")).toBeDisabled();
  });

  it("surfaces an undelivered note when the steer can't reach the agent", async () => {
    answerPlanQuestions.mockResolvedValueOnce({ delivered: false });
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form" as const,
        id: "qf",
        questions: [{ id: "q1", prompt: "Pick", kind: "single" as const, options: ["a", "b"] }],
      },
      answerCtx: { sessionId: "s1", locked: false },
    });
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await page.elementLocator(radios[0]!).click();
    await page.getByRole("button").click();
    await expect
      .element(page.getByText("Couldn't reach the planning agent — it may have already moved on."))
      .toBeInTheDocument();
  });
});
