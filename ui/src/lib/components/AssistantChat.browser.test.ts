import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { AnswerAskResult, SessionMessages } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getSessionMessages: vi.fn(), answerAsk: vi.fn() };
});

// Load once, no interval: each test drives the data it needs.
vi.mock("#lib/visibility.js", () => ({
  pollWhileVisible: () => () => {},
}));

const { default: AssistantChat } = await import("./AssistantChat.svelte");
const { getSessionMessages, answerAsk } = await import("#lib/api.js");
const mockMessages = vi.mocked(getSessionMessages);
const mockAnswer = vi.mocked(answerAsk);
const ask = {
  toolUseId: "ask-1",
  questions: [
    {
      question: "Close the completed issues?",
      header: "Close",
      multiSelect: false,
      options: [
        { label: "Yes", description: "Close both issues" },
        { label: "No", description: "Leave open" },
      ],
    },
  ],
};

const reply = (messages: SessionMessages["messages"]): SessionMessages => ({
  messages,
  awaitingInput: false,
  pendingQuestion: null,
  unavailable: null,
});

function props(over: Record<string, unknown> = {}) {
  return {
    sessionId: "a1",
    status: "idle" as const,
    onsend: vi.fn(() => true),
    oninterrupt: vi.fn(),
    onterminal: vi.fn(),
    ...over,
  };
}

const composer = () => page.getByRole("textbox", { name: m.assistant_chat_input_label() });

beforeEach(() => {
  mockAnswer.mockReset();
  mockAnswer.mockResolvedValue("verified");
  mockMessages.mockReset();
  mockMessages.mockResolvedValue(reply([]));
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AssistantChat", () => {
  it("answers a structured question in chat without sending prompt text", async () => {
    const p = props({ status: "blocked", ask });
    render(AssistantChat, p);
    await expect.element(page.getByText(ask.questions[0].question)).toBeVisible();
    await expect.element(page.getByText("Close both issues")).toBeVisible();
    await page.getByRole("radio", { name: "Yes Close both issues" }).click();
    await page.getByRole("button", { name: m.qform_submit(), exact: true }).click();
    await vi.waitFor(() =>
      expect(mockAnswer).toHaveBeenCalledExactlyOnceWith("a1", "ask-1", [
        { blockId: "ask-1", questionId: "0", optionIndices: [0] },
      ]),
    );
    expect(p.onsend).not.toHaveBeenCalled();
    await expect.element(page.getByText(m.ask_result_verified())).toBeVisible();
  });

  it("keeps a draft and blocks Enter while a question or answer is pending", async () => {
    let finish!: (result: AnswerAskResult) => void;
    mockAnswer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const p = props({ ask });
    const view = await render(AssistantChat, p);
    await composer().fill("keep this draft");
    await userEvent.keyboard("{Enter}");
    expect(p.onsend).not.toHaveBeenCalled();
    await expect.element(composer()).toHaveValue("keep this draft");
    await expect
      .element(page.getByRole("button", { name: m.assistant_chat_send(), exact: true }))
      .toBeDisabled();
    await page.getByRole("radio", { name: "Yes Close both issues" }).click();
    const submit = page.getByRole("button", { name: m.qform_submit(), exact: true });
    await submit.click();
    await expect.element(submit).toBeDisabled();
    await expect.element(page.getByText(m.ask_result_sending())).toBeVisible();
    await view.rerender({ ...p, ask: null });
    await userEvent.keyboard("{Enter}");
    expect(p.onsend).not.toHaveBeenCalled();
    finish("verified");
    await expect.element(page.getByText(m.ask_result_verified())).toBeVisible();
    await composer().click();
    await userEvent.keyboard("{Enter}");
    expect(p.onsend).toHaveBeenCalledExactlyOnceWith("keep this draft");
    expect(mockAnswer).toHaveBeenCalledTimes(1);
  });

  it.each(["verified", "unverified", "mismatch", "failed"] as const)(
    "reports %s without automatically resending",
    async (result) => {
      if (result === "failed") mockAnswer.mockRejectedValueOnce(new Error("409"));
      else mockAnswer.mockResolvedValueOnce(result);
      const p = props({ ask });
      render(AssistantChat, p);
      await page.getByRole("radio", { name: "No Leave open" }).click();
      await page.getByRole("button", { name: m.qform_submit(), exact: true }).click();
      const message = {
        verified: m.ask_result_verified,
        unverified: m.ask_result_unverified,
        mismatch: m.ask_result_mismatch,
        failed: m.ask_result_failed,
      }[result]();
      await expect.element(page.getByText(message)).toBeVisible();
      if (result !== "verified") {
        await page.getByRole("button", { name: m.assistant_chat_open_terminal() }).click();
        expect(p.onterminal).toHaveBeenCalledOnce();
      }
      expect(mockAnswer).toHaveBeenCalledTimes(1);
      await expect
        .element(page.getByRole("button", { name: m.qform_submit(), exact: true }))
        .toBeDisabled();
    },
  );

  it("still offers the terminal for a later unrelated block after a verified answer", async () => {
    const p = props({ ask });
    const view = await render(AssistantChat, p);
    await page.getByRole("radio", { name: "Yes Close both issues" }).click();
    await page.getByRole("button", { name: m.qform_submit(), exact: true }).click();
    await expect.element(page.getByText(m.ask_result_verified())).toBeVisible();
    await view.rerender({ ...p, ask: null, status: "blocked" });
    await expect.element(page.getByText(m.assistant_chat_blocked())).toBeVisible();
    await page.getByRole("button", { name: m.assistant_chat_open_terminal() }).click();
    expect(p.onterminal).toHaveBeenCalledOnce();
  });

  it("supports multiple questions, multiple choices and a custom answer", async () => {
    const questions = {
      ...ask,
      questions: [
        ask.questions[0],
        {
          question: "Which tasks?",
          header: "Tasks",
          multiSelect: true,
          options: [
            { label: "First", description: "" },
            { label: "Second", description: "" },
          ],
        },
      ],
    };
    render(AssistantChat, props({ ask: questions }));
    const submit = page.getByRole("button", { name: m.qform_submit(), exact: true });
    await expect.element(submit).toBeDisabled();
    await page.getByRole("radio", { name: "Yes Close both issues" }).click();
    await expect.element(submit).toBeDisabled();
    await page.getByRole("checkbox", { name: "First", exact: true }).click();
    await page.getByRole("checkbox", { name: "Second", exact: true }).click();
    await page.getByRole("checkbox", { name: m.qform_other(), exact: true }).click();
    await expect.element(submit).toBeDisabled();
    await page.getByRole("textbox", { name: "Which tasks?: " + m.qform_other() }).fill("Third");
    await submit.click();
    expect(mockAnswer).toHaveBeenCalledExactlyOnceWith("a1", "ask-1", [
      { blockId: "ask-1", questionId: "0", optionIndices: [0] },
      { blockId: "ask-1", questionId: "1", optionIndices: [0, 1], text: "Third" },
    ]);
  });

  it.each(["question", "session"])("ignores a late result after a new %s", async (change) => {
    let finish!: (result: AnswerAskResult) => void;
    mockAnswer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const p = props({ ask });
    const view = await render(AssistantChat, p);
    await page.getByRole("radio", { name: "Yes Close both issues" }).click();
    await page.getByRole("button", { name: m.qform_submit(), exact: true }).click();
    const next =
      change === "question"
        ? { ...p, ask: { ...ask, toolUseId: "ask-2" } }
        : { ...p, sessionId: "a2" };
    await view.rerender(next);
    await expect
      .element(page.getByRole("radio", { name: "Yes Close both issues" }))
      .not.toBeChecked();
    finish("mismatch");
    await vi.waitFor(() => expect(page.getByText(m.ask_result_mismatch()).query()).toBeNull());
    await page.getByRole("radio", { name: "No Leave open" }).click();
    await page.getByRole("button", { name: m.qform_submit(), exact: true }).click();
    await expect.element(page.getByText(m.ask_result_verified())).toBeVisible();
    expect(mockAnswer).toHaveBeenLastCalledWith(
      change === "session" ? "a2" : "a1",
      change === "question" ? "ask-2" : "ask-1",
      [{ blockId: change === "question" ? "ask-2" : "ask-1", questionId: "0", optionIndices: [1] }],
    );
  });

  it("removes an externally answered question and resets the next form", async () => {
    const p = props({ status: "blocked", ask });
    const view = await render(AssistantChat, p);
    await page.getByRole("radio", { name: "Yes Close both issues" }).click();
    await view.rerender({ ...p, ask: null, status: "running" });
    await vi.waitFor(() => expect(page.getByText(ask.questions[0].question).query()).toBeNull());
    expect(mockAnswer).not.toHaveBeenCalled();
    await view.rerender({ ...p, ask: { ...ask, toolUseId: "ask-2" } });
    await expect
      .element(page.getByRole("radio", { name: "Yes Close both issues" }))
      .not.toBeChecked();
  });

  it("shows the operator's words as their own bubble and the assistant's reply as text", async () => {
    mockMessages.mockResolvedValue(
      reply([
        { role: "user", text: "wie ist der status?", ts: 1 },
        { role: "assistant", text: "Alles **grün**.", ts: 2 },
        {
          role: "user",
          text: "<task-notification>\n<summary>Monitor event: calendar</summary>\n</task-notification>",
          ts: 3,
        },
      ]),
    );
    render(AssistantChat, props());

    await expect.element(page.getByText("wie ist der status?")).toBeVisible();
    await expect.element(page.getByText("grün")).toBeVisible();
    await expect.element(page.getByText("Monitor event: calendar")).toBeVisible();
    // Only the operator's message is a bubble; the background notice is a quiet event row.
    expect(document.querySelectorAll(".ac-bubble")).toHaveLength(1);
    expect(document.querySelector(".ac-event")?.textContent).toContain("Monitor event: calendar");
    expect(mockMessages).toHaveBeenCalledWith("a1", 50);
  });

  it("invites a first question when the conversation is empty", async () => {
    render(AssistantChat, props());
    await expect.element(page.getByText(m.assistant_chat_empty())).toBeVisible();
  });

  it("Enter sends the draft through onsend and shows it until the transcript logs it", async () => {
    const p = props();
    render(AssistantChat, p);
    await composer().fill("starte die queue");
    await userEvent.keyboard("{Enter}");

    expect(p.onsend).toHaveBeenCalledWith("starte die queue");
    await expect.element(composer()).toHaveValue("");
    await expect.element(page.getByText(m.assistant_chat_sent())).toBeVisible();
  });

  it("Shift+Enter breaks the line instead of sending", async () => {
    const p = props();
    render(AssistantChat, p);
    await composer().fill("zeile eins");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(p.onsend).not.toHaveBeenCalled();
  });

  it("keeps the draft and says so when the terminal can't carry the send", async () => {
    const p = props({ onsend: vi.fn(() => false) });
    render(AssistantChat, p);
    await composer().fill("hallo");
    await page.getByRole("button", { name: m.assistant_chat_send() }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent(m.assistant_chat_send_failed());
    await expect.element(composer()).toHaveValue("hallo");
  });

  it("while the assistant works: a working line, and Stop or Esc interrupts it", async () => {
    const p = props({ status: "running" });
    render(AssistantChat, p);
    await expect.element(page.getByText(m.assistant_chat_working())).toBeVisible();

    await page.getByRole("button", { name: m.assistant_chat_stop() }).click();
    expect(p.oninterrupt).toHaveBeenCalledTimes(1);

    await composer().click();
    await userEvent.keyboard("{Escape}");
    expect(p.oninterrupt).toHaveBeenCalledTimes(2);
  });

  it("at rest there is no Stop, and Esc does nothing", async () => {
    const p = props();
    render(AssistantChat, p);
    await expect.element(composer()).toBeVisible();
    expect(document.body.textContent).not.toContain(m.assistant_chat_stop());
    await composer().click();
    await userEvent.keyboard("{Escape}");
    expect(p.oninterrupt).not.toHaveBeenCalled();
  });

  it("blocked: points to the terminal", async () => {
    const p = props({ status: "blocked" });
    render(AssistantChat, p);
    await expect.element(page.getByText(m.assistant_chat_blocked())).toBeVisible();
    await page.getByRole("button", { name: m.assistant_chat_open_terminal() }).click();
    expect(p.onterminal).toHaveBeenCalledOnce();
  });

  it("an Ask prefill lands in the composer unsent", async () => {
    const onprefilled = vi.fn();
    const p = props({ prefill: { text: "Was ist mit TASK-7 los?", tick: 4 }, onprefilled });
    render(AssistantChat, p);
    await expect.element(composer()).toHaveValue("Was ist mit TASK-7 los?");
    expect(onprefilled).toHaveBeenCalledWith(4);
    expect(p.onsend).not.toHaveBeenCalled();
  });
});

describe("AssistantChat session navigation", () => {
  it.each([false, true])("links assistant replies through onnavigate (touch=%s)", async (touch) => {
    mockMessages.mockResolvedValue(
      reply([
        { role: "user", text: "TASK-31", ts: 1 },
        { role: "assistant", text: "**TASK-31**", ts: 2 },
      ]),
    );
    const onnavigate = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container } = await render(
      AssistantChat,
      props({
        touch,
        mobile: touch,
        herd: [{ id: "s31", desig: "TASK-31" }],
        onnavigate,
      }),
    );
    await page.getByRole("link", { name: "TASK-31" }).click();
    expect(onnavigate).toHaveBeenCalledWith("s31");
    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector(".ac-mine a")).toBeNull();
    open.mockRestore();
  });
});
