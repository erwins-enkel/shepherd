import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { SessionMessages } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getSessionMessages: vi.fn() };
});

// Load once, no interval: each test drives the data it needs.
vi.mock("#lib/visibility.js", () => ({
  pollWhileVisible: () => () => {},
}));

const { default: AssistantChat } = await import("./AssistantChat.svelte");
const { getSessionMessages } = await import("#lib/api.js");
const mockMessages = vi.mocked(getSessionMessages);

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
  mockMessages.mockReset();
  mockMessages.mockResolvedValue(reply([]));
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AssistantChat", () => {
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
