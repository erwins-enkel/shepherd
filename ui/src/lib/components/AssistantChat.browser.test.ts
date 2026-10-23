import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { AnswerAskResult, SessionMessages } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { getLocale, setLocale } from "#lib/paraglide/runtime.js";

const originalLocale = getLocale();

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getSessionMessages: vi.fn(), answerAsk: vi.fn() };
});

let refresh: (() => void) | undefined;

// Drive transcript reloads without interval timing.
vi.mock("#lib/visibility.js", () => ({
  pollWhileVisible: (load: () => void) => {
    refresh = load;
    return () => {
      refresh = undefined;
    };
  },
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
  setLocale("en", { reload: false });
  mockMessages.mockReset();
  mockMessages.mockResolvedValue(reply([]));
});

afterEach(() => {
  setLocale(originalLocale, { reload: false });
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

const history = (): SessionMessages["messages"] =>
  Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: `Message ${i}\n\n${"A paragraph of conversation. ".repeat(12)}`,
    ts: i + 1,
  }));

async function mountHistory(over: Record<string, unknown> = {}, delayed = false) {
  let resolveLoad: ((value: SessionMessages) => void) | undefined;
  if (delayed)
    mockMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
  else mockMessages.mockResolvedValue(reply(history()));
  const target = document.createElement("div");
  target.style.cssText = "height: 480px; width: 420px; display: flex; flex-direction: column";
  document.body.append(target);
  const view = await render(AssistantChat, { target, props: props(over) });
  const thread = target.querySelector<HTMLDivElement>(".ac-thread")!;
  resolveLoad?.(reply(history()));
  await expect.poll(() => thread.scrollHeight).toBeGreaterThan(thread.clientHeight);
  return { ...view, thread, target };
}

async function atBottom(thread: HTMLElement) {
  await expect
    .poll(() => Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop))
    .toBeLessThanOrEqual(2);
}

async function reload(messages: SessionMessages["messages"]) {
  mockMessages.mockResolvedValue(reply(messages));
  refresh!();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await expect.poll(() => document.querySelectorAll(".ac-msg").length).toBe(messages.length);
}

describe("AssistantChat scroll following", () => {
  it("follows a delayed initial transcript and reopening", async () => {
    const first = await mountHistory({}, true);
    await atBottom(first.thread);
    await page.getByRole("log").wheel({ delta: { y: -500 } });
    await expect
      .poll(() => first.thread.scrollTop)
      .toBeLessThan(first.thread.scrollHeight - first.thread.clientHeight - 100);
    await first.unmount();
    first.target.remove();
    const reopened = await mountHistory({}, true);
    await atBottom(reopened.thread);
  });

  it("resumes following after scrolling back to the bottom", async () => {
    const { thread } = await mountHistory();
    await atBottom(thread);
    await page.getByRole("log").wheel({ delta: { y: -500 } });
    await expect
      .poll(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop)
      .toBeGreaterThan(100);
    await page.getByRole("log").wheel({ delta: { y: 20000 } });
    await atBottom(thread);
    await reload([
      ...history(),
      { role: "assistant", text: "New response\n\n" + "Detail.\n\n".repeat(50), ts: 40 },
    ]);
    await atBottom(thread);
  });

  it("starts a replacement session at its end after reading older messages", async () => {
    const { thread, rerender } = await mountHistory();
    await atBottom(thread);
    await page.getByRole("log").wheel({ delta: { y: -500 } });
    await expect
      .poll(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop)
      .toBeGreaterThan(100);
    await rerender({ sessionId: "a2" });
    await atBottom(thread);
  });

  it("keeps manual scroll-up through reloads and resumes on successful send", async () => {
    const { thread } = await mountHistory();
    await atBottom(thread);
    await page.getByRole("log").wheel({ delta: { y: -500 } });
    await expect
      .poll(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop)
      .toBeGreaterThan(100);
    const top = thread.scrollTop;
    await reload([...history(), { role: "assistant", text: "A later reply", ts: 40 }]);
    await expect.poll(() => thread.scrollTop).toBeCloseTo(top, 0);
    await composer().fill("resume");
    await userEvent.keyboard("{Enter}");
    await atBottom(thread);
  });

  it("keeps manual scroll-up after a failed send", async () => {
    const { thread } = await mountHistory({ onsend: () => false });
    await atBottom(thread);
    await page.getByRole("log").wheel({ delta: { y: -500 } });
    await expect
      .poll(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop)
      .toBeGreaterThan(100);
    await composer().fill("unsent");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("alert")).toBeVisible();
    await reload([...history(), { role: "assistant", text: "Later reply", ts: 40 }]);
    expect(thread.scrollHeight - thread.clientHeight - thread.scrollTop).toBeGreaterThan(100);
  });

  it("opens a long transcript at its end and follows sends, replies and reloads", async () => {
    const { thread } = await mountHistory();
    await atBottom(thread);
    await composer().fill("new question");
    await userEvent.keyboard("{Enter}");
    await atBottom(thread);
    const messages = [
      ...history(),
      { role: "user" as const, text: "new question", ts: Date.now() },
      {
        role: "assistant" as const,
        text: "Reply\n\n" + "More detail.\n\n".repeat(40),
        ts: Date.now() + 1,
      },
    ];
    await reload(messages);
    await atBottom(thread);
    await reload(messages);
    await atBottom(thread);
    messages[messages.length - 1] = {
      ...messages[messages.length - 1],
      text: "Updated Markdown\n\n" + "More paragraphs.\n\n".repeat(70),
    };
    await reload(messages);
    await atBottom(thread);
    const window = [
      ...history(),
      ...history().map((e) => ({ ...e, ts: e.ts + 50 })),
      ...messages.slice(-2),
    ].slice(-50);
    await reload(window);
    await atBottom(thread);
  });

  it("follows viewport shrinkage while reading the end", async () => {
    const { thread, target } = await mountHistory();
    await atBottom(thread);
    target.style.height = "280px";
    await atBottom(thread);
  });
});

describe("AssistantChat quick replies", () => {
  const question = { role: "assistant" as const, text: "Soll ich fortfahren? (Ja/Nein)", ts: 2 };
  const yes = () => page.getByRole("button", { name: "Yes", exact: true });
  const no = () => page.getByRole("button", { name: "No", exact: true });

  it.each(["Yes", "No"])("sends %s once without touching the draft on mobile", async (answer) => {
    mockMessages.mockResolvedValue(reply([question]));
    const p = props({ mobile: true, touch: true });
    render(AssistantChat, p);
    await composer().fill("Entwurf");
    await page.getByRole("button", { name: answer, exact: true }).click();
    expect(p.onsend).toHaveBeenCalledExactlyOnceWith(answer);
    await expect.element(composer()).toHaveValue("Entwurf");
    await expect.element(yes()).not.toBeInTheDocument();
    await expect.element(no()).not.toBeInTheDocument();
  });

  it.each(["Ja", "Nein"])("sends the German answer %s", async (answer) => {
    setLocale("de", { reload: false });
    mockMessages.mockResolvedValue(reply([question]));
    const p = props();
    render(AssistantChat, p);
    await page.getByRole("button", { name: answer, exact: true }).click();
    expect(p.onsend).toHaveBeenCalledExactlyOnceWith(answer);
  });

  it("collects all numbered answers before sending one message", async () => {
    mockMessages.mockResolvedValue(
      reply([{ ...question, text: "1. Starten? (Ja/Nein)\n2. Stoppen? (Ja/Nein)" }]),
    );
    const p = props();
    render(AssistantChat, p);
    const send = page.getByRole("button", { name: "Send answers", exact: true });
    await expect.element(send).toBeDisabled();
    await yes().nth(0).click();
    await expect.element(send).toBeDisabled();
    expect(p.onsend).not.toHaveBeenCalled();
    await no().nth(1).click();
    await send.click();
    expect(p.onsend).toHaveBeenCalledExactlyOnceWith("1. Yes\n2. No");
  });

  it("offers a retry after failed delivery", async () => {
    mockMessages.mockResolvedValue(reply([question]));
    const send = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    render(AssistantChat, props({ onsend: send }));
    await yes().click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await yes().click();
    expect(send).toHaveBeenCalledTimes(2);
    await expect.element(yes()).not.toBeInTheDocument();
  });

  it.each(["running", "blocked"])("does not offer text answers while %s", async (status) => {
    mockMessages.mockResolvedValue(reply([question]));
    render(AssistantChat, props({ status }));
    await expect.element(composer()).toBeVisible();
    await expect.element(yes()).not.toBeInTheDocument();
  });

  it.each(["idle", "blocked"])(
    "defers to a pending structured question while %s",
    async (status) => {
      mockMessages.mockResolvedValue(reply([question]));
      render(AssistantChat, props({ status, ask }));
      await expect.element(page.getByText(ask.questions[0].question)).toBeVisible();
      await expect.element(yes()).not.toBeInTheDocument();
      await expect.element(no()).not.toBeInTheDocument();
    },
  );

  it("does not revive an answered question", async () => {
    mockMessages.mockResolvedValue(reply([question, { role: "user", text: "No", ts: 1 }]));
    render(AssistantChat, props());
    await expect.element(page.getByText("No", { exact: true })).toBeVisible();
    await expect.element(yes()).not.toBeInTheDocument();
  });

  it("ignores event rows when finding the latest question", async () => {
    mockMessages.mockResolvedValue(
      reply([
        question,
        {
          role: "user",
          ts: 3,
          text: "<task-notification><summary>Event</summary></task-notification>",
        },
      ]),
    );
    render(AssistantChat, props());
    await expect.element(yes()).toBeVisible();
  });
});

describe("AssistantChat quick reply updates", () => {
  const list = (text = "1. Starten? (Ja/Nein)\n2. Stoppen? (Ja/Nein)") =>
    reply([{ role: "assistant", text, ts: 2 }]);

  it("clears choices when the question changes or a new session loads", async () => {
    mockMessages.mockResolvedValue(list());
    const p = props();
    const view = await render(AssistantChat, p);
    const yes = () => page.getByRole("button", { name: "Yes", exact: true }).nth(0);
    const send = () => page.getByRole("button", { name: "Send answers", exact: true });
    await yes().click();
    await expect.element(yes()).toHaveAttribute("aria-pressed", "true");
    mockMessages.mockResolvedValue(list("1. Anders starten? (Ja/Nein)\n2. Stoppen? (Ja/Nein)"));
    refresh!();
    await expect
      .element(page.getByRole("group", { name: "Anders starten? (Ja/Nein)", exact: true }))
      .toBeVisible();
    await expect.element(yes()).toHaveAttribute("aria-pressed", "false");
    await expect.element(send()).toBeDisabled();
    await yes().click();
    await view.rerender({ ...p, sessionId: "a2" });
    await expect.element(yes()).toHaveAttribute("aria-pressed", "false");
    await expect.element(send()).toBeDisabled();
  });

  it("hides a question immediately when the composer sends", async () => {
    mockMessages.mockResolvedValue(list("Starten? (Ja/Nein)"));
    const p = props();
    render(AssistantChat, p);
    await expect.element(page.getByRole("button", { name: "Yes", exact: true })).toBeVisible();
    await composer().fill("Später");
    await page.getByRole("button", { name: m.assistant_chat_send(), exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Yes", exact: true }))
      .not.toBeInTheDocument();
  });
});
