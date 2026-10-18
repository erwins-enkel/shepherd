import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { AnswerAskResult } from "#lib/types.js";
import { toasts } from "#lib/toasts.svelte.js";

const answerAsk = vi.fn<
  (id: string, toolUseId: string, answers: unknown[]) => Promise<AnswerAskResult>
>(async () => "verified");
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    answerAsk: (...a: unknown[]) => answerAsk(...(a as Parameters<typeof answerAsk>)),
  };
});
const { default: AskQuestionDialog } = await import("./AskQuestionDialog.svelte");

const ask = {
  toolUseId: "toolu_9",
  questions: [
    {
      question: "Pet?",
      header: "Pet",
      multiSelect: false,
      options: [
        { label: "Cat", description: "" },
        { label: "Dog", description: "" },
      ],
    },
  ],
};

afterEach(() => {
  answerAsk.mockClear();
  toasts.items = [];
});

let seq = 0;
// A fresh tool_use id per render: the dialog's toast is keyed by it, and the store's key map
// outlives a test's `toasts.items = []` reset.
async function answer(result: AnswerAskResult | Error, toolUseId = `toolu_${++seq}`) {
  if (result instanceof Error) answerAsk.mockRejectedValueOnce(result);
  else answerAsk.mockResolvedValueOnce(result);
  const onclose = vi.fn();
  const { container } = await render(AskQuestionDialog, {
    sessionId: "s1",
    ask: { ...ask, toolUseId },
    onclose,
  });
  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  await page.elementLocator(radios[1]!).click();
  await page.elementLocator(container.querySelector<HTMLButtonElement>("button.primary")!).click();
  return onclose;
}

describe("AskQuestionDialog", () => {
  it("posts the answers keyed to the tool_use id, closes, and toasts the verified result", async () => {
    const onclose = await answer("verified", "toolu_9");
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(answerAsk).toHaveBeenCalledWith("s1", "toolu_9", [
      { blockId: "toolu_9", questionId: "0", optionIndices: [1] },
    ]);
    await vi.waitFor(() => expect(toasts.items.at(-1)?.text).toMatch(/delivered|übermittelt/));
    expect(toasts.items).toHaveLength(1); // the "typing…" toast was refreshed, not stacked
  });

  it("a mismatch or a failed request warns and points at the terminal", async () => {
    await answer("mismatch");
    await vi.waitFor(() => expect(toasts.items.at(-1)?.alert).toBe(true));
    expect(toasts.items.at(-1)?.text).toMatch(/terminal/i);
    toasts.items = [];
    await answer(new Error("409"));
    await vi.waitFor(() => expect(toasts.items.at(-1)?.alert).toBe(true));
  });
});
