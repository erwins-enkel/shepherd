import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import QuestionFormBlock from "./QuestionFormBlock.svelte";

const answerPlanQuestions = vi.fn<
  (id: string, answers: unknown[]) => Promise<{ delivered: boolean }>
>(async () => ({ delivered: true }));
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    answerPlanQuestions: (...a: unknown[]) =>
      answerPlanQuestions(...(a as Parameters<typeof answerPlanQuestions>)),
  };
});

afterEach(() => answerPlanQuestions.mockClear());

describe("QuestionFormBlock", () => {
  it("renders single-kind prompt, options as radios, and kind hint", async () => {
    const { container } = await render(QuestionFormBlock, {
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
    const { container } = await render(QuestionFormBlock, {
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
    const { container } = await render(QuestionFormBlock, {
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
    const { container } = await render(QuestionFormBlock, {
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
    const { container } = await render(QuestionFormBlock, {
      block,
      answerCtx: { sessionId: "s1", locked: false },
    });
    const inputs = container.querySelectorAll("input");
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.disabled).toBe(false);
  });

  it("keeps submit disabled until single + freeform are answered, then submits the payload", async () => {
    const { container } = await render(QuestionFormBlock, {
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

  it("Enter in the freeform field submits to the plan gate", async () => {
    const { container } = await render(QuestionFormBlock, {
      block,
      answerCtx: { sessionId: "sess-9", locked: false },
    });
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await page.elementLocator(radios[0]!).click();
    const text = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    await page.elementLocator(text).fill("ok");
    await userEvent.keyboard("{Enter}");
    expect(answerPlanQuestions).toHaveBeenCalledTimes(1);
  });

  it("disables submit while a plan review is in flight (locked)", async () => {
    render(QuestionFormBlock, { block, answerCtx: { sessionId: "s1", locked: true } });
    await expect.element(page.getByRole("button")).toBeDisabled();
  });

  it("surfaces an undelivered note when the steer can't reach the agent", async () => {
    answerPlanQuestions.mockResolvedValueOnce({ delivered: false });
    const { container } = await render(QuestionFormBlock, {
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

// Callback mode (#2158): the New Task shaping round has no session to post answers to, so the form
// hands them to the parent instead. The plan-gate path above must stay untouched by this.
describe("QuestionFormBlock — callback mode (onanswer present)", () => {
  const block = {
    type: "question-form" as const,
    id: "shape-questions",
    questions: [
      { id: "q1", prompt: "Which reaper?", kind: "single" as const, options: ["tab", "transient"] },
      { id: "q2", prompt: "Out of scope?", kind: "freeform" as const },
    ],
  };

  it("enables the form, uses the caller's submit label, and never posts to a session", async () => {
    const onanswer = vi.fn();
    const { container } = await render(QuestionFormBlock, {
      block,
      onanswer,
      submitLabel: "Use brief",
    });
    const button = page.getByRole("button", { name: "Use brief" });
    await expect.element(button).toBeDisabled();

    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await page.elementLocator(radios[0]!).click();
    const text = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    await page.elementLocator(text).fill("herdr itself");
    await expect.element(button).toBeEnabled();
    await button.click();

    expect(onanswer).toHaveBeenCalledTimes(1);
    expect(onanswer.mock.calls[0]![0]).toEqual([
      { blockId: "shape-questions", questionId: "q1", optionIndices: [0] },
      { blockId: "shape-questions", questionId: "q2", text: "herdr itself" },
    ]);
    // The plan-gate transport must not fire for a round with no session.
    expect(answerPlanQuestions).not.toHaveBeenCalled();
    // No "sent to the planning agent" confirmation — there is no agent.
    expect(container.textContent).not.toContain("Answers sent to the planning agent.");
  });

  it("locks after one emit so a double-click can't send the round twice", async () => {
    const onanswer = vi.fn();
    const { container } = await render(QuestionFormBlock, {
      block: { ...block, questions: [block.questions[0]!] },
      onanswer,
      submitLabel: "Use brief",
    });
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await page.elementLocator(radios[0]!).click();
    const button = page.getByRole("button", { name: "Use brief" });
    await button.click();
    await expect.element(button).toBeDisabled();
    expect(onanswer).toHaveBeenCalledTimes(1);
  });

  it("stays read-only when neither answerCtx nor onanswer is given", async () => {
    const { container } = await render(QuestionFormBlock, { block });
    const inputs = container.querySelectorAll("input");
    for (const input of inputs) expect(input.disabled).toBe(true);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("QuestionFormBlock — allowOther (AskUserQuestion, #3165)", () => {
  const block = {
    type: "question-form" as const,
    id: "toolu_1",
    questions: [
      {
        id: "0",
        prompt: "Color?",
        kind: "single" as const,
        options: ["Red", "Blue"],
        optionDescriptions: ["warm hue", "Blue"],
        header: "Color",
        allowOther: true,
      },
      {
        id: "1",
        prompt: "Tops?",
        kind: "multi" as const,
        options: ["Cheese", "Ham"],
        allowOther: true,
      },
    ],
  };

  it("renders header + descriptions, hides a description that only repeats the label", async () => {
    const { container } = await render(QuestionFormBlock, { block, onanswer: vi.fn() });
    await expect.element(page.getByText("warm hue")).toBeInTheDocument();
    await expect.element(page.getByText("Color", { exact: true })).toBeInTheDocument();
    expect(container.querySelectorAll(".qf-option-desc")).toHaveLength(1);
    // a multi with Other is required, not "(optional)"
    expect(container.textContent).not.toContain("(optional)");
  });

  it("Other reveals a text input, gates submit on its text, and sends it as `text`", async () => {
    const onanswer = vi.fn();
    const { container } = await render(QuestionFormBlock, { block, onanswer, submitLabel: "Go" });
    const button = page.getByRole("button", { name: "Go" });
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(3); // Red, Blue, Other
    await page.elementLocator(radios[2]!).click(); // single → Other
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(3); // Cheese, Ham, Other
    await page.elementLocator(boxes[1]!).click(); // Ham
    await expect.element(button).toBeDisabled(); // single's Other has no text yet
    const others = () => container.querySelectorAll<HTMLInputElement>("input.qf-freeform-input");
    expect(others()).toHaveLength(1);
    await page.elementLocator(others()[0]!).fill("Green");
    await expect.element(button).toBeEnabled();
    await page.elementLocator(boxes[2]!).click(); // multi Other too
    await expect.element(button).toBeDisabled();
    await page.elementLocator(others()[1]!).fill("Kiwi");
    await button.click();
    expect(onanswer.mock.calls[0]![0]).toEqual([
      { blockId: "toolu_1", questionId: "0", optionIndices: [], text: "Green" },
      { blockId: "toolu_1", questionId: "1", optionIndices: [1], text: "Kiwi" },
    ]);
  });

  it("Enter in an Other field submits the whole form once everything is answered", async () => {
    const onanswer = vi.fn();
    const { container } = await render(QuestionFormBlock, { block, onanswer });
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await page.elementLocator(radios[0]!).click(); // Red
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await page.elementLocator(boxes[2]!).click(); // multi → Other
    const other = page.elementLocator(container.querySelector("input.qf-other-input")!);
    await other.fill("Kiwi");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onanswer).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onanswer).toHaveBeenCalledOnce();
    expect(onanswer.mock.calls[0]![0]).toEqual([
      { blockId: "toolu_1", questionId: "0", optionIndices: [0] },
      { blockId: "toolu_1", questionId: "1", optionIndices: [], text: "Kiwi" },
    ]);
  });

  it("Enter with a question still open focuses that question instead of submitting", async () => {
    const onanswer = vi.fn();
    const { container } = await render(QuestionFormBlock, { block, onanswer });
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await page.elementLocator(boxes[2]!).click(); // multi → Other; the single is unanswered
    const other = page.elementLocator(container.querySelector("input.qf-other-input")!);
    await other.fill("Kiwi");
    await userEvent.keyboard("{Enter}");
    expect(onanswer).not.toHaveBeenCalled();
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(document.activeElement).toBe(radios[0]);
  });

  it("a multi with allowOther needs at least one choice", async () => {
    const { container } = await render(QuestionFormBlock, {
      block: { ...block, questions: [block.questions[1]!] },
      onanswer: vi.fn(),
      submitLabel: "Go",
    });
    const button = page.getByRole("button", { name: "Go" });
    await expect.element(button).toBeDisabled();
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await page.elementLocator(boxes[0]!).click();
    await expect.element(button).toBeEnabled();
  });
});

describe("QuestionFormBlock — links", () => {
  const url = "https://claude.ai/artifact/GWC6c82ryRzbZfTmTKfhJK";
  const prompt = `Drei Varianten ganz oben auf ${url} (Version 3). Welche nehmen wir?`;

  it("renders a URL in the prompt as a new-tab link, keeping the prompt text intact", async () => {
    const { container } = await render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qfl1",
        questions: [{ id: "q1", prompt, kind: "single", options: ["Yes", "No"] }],
      },
      onanswer: vi.fn(),
    });
    const p = container.querySelector(".qf-prompt")!;
    expect(p.textContent).toBe(prompt);
    const links = p.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe(url);
    expect(links[0]!.textContent).toBe(url);
    expect(links[0]!.target).toBe("_blank");
    expect(links[0]!.rel).toBe("noopener noreferrer");
  });

  it("links a URL in an option description but not in the option label", async () => {
    const { container } = await render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qfl2",
        questions: [
          {
            id: "q1",
            prompt: "Which one?",
            kind: "single",
            options: [`Take ${url}`, "Other one"],
            optionDescriptions: [`Preview at ${url}.`, "No link"],
          },
        ],
      },
      onanswer: vi.fn(),
    });
    const descs = container.querySelectorAll(".qf-option-desc");
    expect(descs[0]!.textContent).toBe(`Preview at ${url}.`);
    expect(descs[0]!.querySelector("a")?.getAttribute("href")).toBe(url);
    expect(descs[1]!.querySelector("a")).toBeNull();
    const labels = container.querySelectorAll(".qf-option-text > span:first-child");
    expect(labels[0]!.textContent).toBe(`Take ${url}`);
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("renders no link for a prompt without a URL", async () => {
    const { container } = await render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qfl3",
        questions: [{ id: "q1", prompt: "Visit www.example.com?", kind: "freeform" }],
      },
    });
    expect(container.querySelector(".qf-prompt")!.textContent).toBe("Visit www.example.com?");
    expect(container.querySelector("a")).toBeNull();
  });
});

it("seeds its inputs from a draft and reports edits", async () => {
  const ondraft = vi.fn();
  const { container } = await render(QuestionFormBlock, {
    block: {
      type: "question-form",
      id: "qd",
      questions: [
        { id: "s", prompt: "One?", kind: "single", options: ["A", "B"], allowOther: true },
        { id: "f", prompt: "Why?", kind: "freeform" },
      ],
    },
    onanswer: vi.fn(),
    draft: {
      single: { s: -1 },
      multi: {},
      freeform: { f: "because" },
      otherChecked: {},
      otherText: { s: "C" },
    },
    ondraft,
  });
  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect(radios[2]!.checked).toBe(true);
  await expect.element(page.getByRole("textbox", { name: /One\?/ })).toHaveValue("C");
  await expect.element(page.getByPlaceholder(/./).last()).toHaveValue("because");

  await page.elementLocator(radios[1]!).click();
  await vi.waitFor(() =>
    expect(ondraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ single: { s: 1 }, freeform: { f: "because" } }),
    ),
  );
});

describe("QuestionFormBlock — answer rows", () => {
  it("tags a (Recommended) option instead of showing the suffix, and still sends its index", async () => {
    const onanswer = vi.fn();
    const { container } = await render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qrec",
        questions: [
          {
            id: "q1",
            prompt: "Which?",
            kind: "single",
            options: ["Plain", "Online backfill (Recommended)"],
          },
        ],
      },
      onanswer,
    });
    const labels = container.querySelectorAll(".qf-option-label");
    expect(labels[1]!.textContent).toBe("Online backfill");
    expect(container.querySelectorAll(".qf-rec")).toHaveLength(1);
    expect(container.querySelector(".qf-rec .qf-rec-tag")).not.toBeNull();
    // A click on the row's text, not the radio, picks the answer.
    await userEvent.click(page.getByText("Online backfill"));
    await page.getByRole("button", { name: /send/i }).click();
    expect(onanswer).toHaveBeenCalledWith([
      { blockId: "qrec", questionId: "q1", optionIndices: [1] },
    ]);
  });
});
