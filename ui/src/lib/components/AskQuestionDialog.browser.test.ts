import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { AnswerAskResult, PendingAsk, Session } from "#lib/types.js";
import type { AskEntry } from "#lib/ask-center.js";
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

const ask = (toolUseId: string, question = "Pet?"): PendingAsk => ({
  toolUseId,
  questions: [
    {
      question,
      header: "Pet",
      multiSelect: false,
      options: [
        { label: "Cat", description: "" },
        { label: "Dog", description: "" },
      ],
    },
  ],
});
const session = (id: string, extra: Partial<Session> = {}): Session =>
  ({
    id,
    desig: "TASK-2240",
    name: "repo-coding-cli",
    prompt: "pick the coding CLI per repo",
    repoPath: "/home/me/shepherd",
    branch: "shepherd/repo-coding-cli",
    model: null,
    ...extra,
  }) as Session;

afterEach(() => {
  answerAsk.mockClear();
  toasts.items = [];
});

async function mount(entries: AskEntry[], onnavigate?: (id: string) => void) {
  const onclose = vi.fn();
  const { container } = await render(AskQuestionDialog, {
    entries,
    focusId: entries[0]!.session.id,
    onclose,
    onnavigate,
  });
  return { container, onclose };
}

const pickSecondAndSubmit = async (container: HTMLElement) => {
  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  await page.elementLocator(radios[1]!).click();
  await page.elementLocator(container.querySelector<HTMLButtonElement>("button.primary")!).click();
};

let seq = 0;
// A fresh tool_use id per render: the dialog's toast is keyed by it, and the store's key map
// outlives a test's `toasts.items = []` reset.
async function answer(result: AnswerAskResult | Error, toolUseId = `toolu_${++seq}`) {
  if (result instanceof Error) answerAsk.mockRejectedValueOnce(result);
  else answerAsk.mockResolvedValueOnce(result);
  const { container, onclose } = await mount([{ session: session("s1"), ask: ask(toolUseId) }]);
  await pickSecondAndSubmit(container);
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

  it("names the repo, task, session and prompt the question comes from", async () => {
    const { container } = await mount([{ session: session("s1"), ask: ask(`toolu_${++seq}`) }]);
    // The detail pane, not the list beside it, which repeats repo, task and session.
    const detail = page.elementLocator(container.querySelector(".detail")!);
    await expect.element(detail.getByText("shepherd", { exact: true })).toBeVisible();
    await expect.element(detail.getByText("TASK-2240", { exact: true })).toBeVisible();
    await expect.element(detail.getByText("repo-coding-cli", { exact: true })).toBeVisible();
    await expect.element(detail.getByText("pick the coding CLI per repo")).toBeVisible();
    await expect.element(detail.getByText(/shepherd\/repo-coding-cli/)).toBeVisible();
    await expect.element(detail.getByText(/(terminal of|Terminal von) TASK-2240/)).toBeVisible();
  });

  it("keeps the question-center layout for a single open question", async () => {
    await mount([{ session: session("s1"), ask: ask(`toolu_${++seq}`) }]);
    const dialog = page.getByRole("dialog", { name: /Open questions|Offene Fragen/ });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(page.getByRole("navigation").getByText("shepherd", { exact: true }))
      .toBeVisible();
    await expect.element(dialog.getByText(/Question 1 of 1|Frage 1 von 1/)).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: /^(Skip|Überspringen)$/ }))
      .toBeDisabled();
    await expect
      .element(dialog.getByRole("button", { name: /^(Answer|Antworten)$/ }))
      .toBeVisible();
  });

  it("lists other sessions' questions by repo and moves on to the next after an answer", async () => {
    const first = `toolu_${++seq}`;
    const second = `toolu_${++seq}`;
    const { container, onclose } = await mount([
      { session: session("s1"), ask: ask(first, "Pet?") },
      {
        session: session("s2", {
          desig: "TASK-7",
          name: "ics-export",
          repoPath: "/home/me/calendar",
        }),
        ask: ask(second, "Export RRULE?"),
        since: Date.now() - 5 * 60_000,
      },
    ]);
    const nav = page.getByRole("navigation");
    await expect.element(nav.getByText("calendar", { exact: true })).toBeVisible();
    await expect.element(nav.getByText(/Pet · Export RRULE\?/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^(Answer & next|Antworten & weiter)$/ }))
      .toBeVisible();

    await pickSecondAndSubmit(container);
    expect(answerAsk).toHaveBeenCalledWith("s1", first, expect.any(Array));
    expect(onclose).not.toHaveBeenCalled();
    await expect.element(page.getByText("Export RRULE?", { exact: true })).toBeVisible();
    // The last open question keeps the same layout instead of jumping to a narrower one.
    await expect.element(nav.getByText("calendar", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Question 1 of 1|Frage 1 von 1/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^(Skip|Überspringen)$/ }))
      .toBeDisabled();
  });

  it("opens another session's question in its session", async () => {
    const onnavigate = vi.fn();
    const { onclose } = await mount(
      [
        { session: session("s1"), ask: ask(`toolu_${++seq}`) },
        { session: session("s2", { desig: "TASK-7" }), ask: ask(`toolu_${++seq}`) },
      ],
      onnavigate,
    );
    // The focused session is already on screen: no jump offered for it.
    await expect
      .element(page.getByRole("button", { name: /Open session|Session öffnen/ }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: /TASK-7/ }).click();
    await page.getByRole("button", { name: /Open session|Session öffnen/ }).click();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onnavigate).toHaveBeenCalledWith("s2");
  });
});

it("selects two requests from the same session independently", async () => {
  const { container } = await mount([
    { session: session("same"), ask: ask("first", "First request?") },
    { session: session("same"), ask: ask("second", "Second request?") },
  ]);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /Second request/ })
    .click();
  await pickSecondAndSubmit(container);
  expect(answerAsk).toHaveBeenCalledWith("same", "second", expect.any(Array));
  await expect.element(page.getByText("First request?", { exact: true })).toBeVisible();
});

it("keeps unverified answers editable and does not send again automatically", async () => {
  answerAsk.mockResolvedValueOnce("unverified");
  const { container, onclose } = await mount([{ session: session("retry"), ask: ask("retry") }]);
  await pickSecondAndSubmit(container);
  await expect
    .element(page.elementLocator(container.querySelector<HTMLButtonElement>("button.primary")!))
    .toBeEnabled();
  expect(onclose).not.toHaveBeenCalled();
  expect(answerAsk).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.checked).toBe(
    true,
  );
});

it("stays on the question shown when another one arrives ahead of it", async () => {
  const s1 = session("s1");
  const s2 = session("s2", { desig: "TASK-7", repoPath: "/home/me/calendar" });
  const a1 = { session: s1, ask: ask("pin_1", "Pet?") };
  const a2 = { session: s2, ask: ask("pin_2", "Export RRULE?") };
  const { container, rerender } = await render(AskQuestionDialog, {
    entries: [a1, a2],
    focusId: "s1",
    onclose: vi.fn(),
  });
  // Answering s1's question moves on to s2's; pick there without sending.
  await pickSecondAndSubmit(container);
  await expect.element(page.getByText("Export RRULE?", { exact: true })).toBeVisible();
  const radios = () => container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  await page.elementLocator(radios()[1]!).click();

  // s1 asks again: its new question sorts first, but the selection and the pick stay put.
  const a3 = { session: s1, ask: ask("pin_3", "Colour?") };
  await rerender({ entries: [a3, a2], focusId: "s1", onclose: vi.fn() });
  await expect.element(page.getByText("Export RRULE?", { exact: true })).toBeVisible();
  expect(radios()[1]!.checked).toBe(true);
});

it("keeps each question's unsent draft when switching between them", async () => {
  const multiAsk: PendingAsk = {
    toolUseId: "draft_2",
    questions: [
      {
        question: "Toppings?",
        header: "Pizza",
        multiSelect: true,
        options: [
          { label: "Ham", description: "" },
          { label: "Olives", description: "" },
        ],
      },
    ],
  };
  const { container } = await mount([
    { session: session("s1"), ask: ask("draft_1", "Pet?") },
    { session: session("s2", { desig: "TASK-7" }), ask: multiAsk },
  ]);
  const inputs = (type: string) =>
    container.querySelectorAll<HTMLInputElement>(`.detail input[type="${type}"]`);
  // Single: Other with text.
  await page.elementLocator(inputs("radio")[2]!).click();
  await page.getByPlaceholder(/./).fill("Hamster");

  await page.getByRole("button", { name: /TASK-7/ }).click();
  await page.elementLocator(inputs("checkbox")[1]!).click();

  await page.getByRole("button", { name: /TASK-2240/ }).click();
  expect(inputs("radio")[2]!.checked).toBe(true);
  await expect.element(page.getByPlaceholder(/./)).toHaveValue("Hamster");

  await page.getByRole("button", { name: /TASK-7/ }).click();
  expect(inputs("checkbox")[1]!.checked).toBe(true);
});
