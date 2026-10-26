import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { BlockReason } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getSessionMessages: vi.fn() };
});
vi.mock("#lib/visibility.js", () => ({ pollWhileVisible: () => () => {} }));

const { default: ChatView } = await import("./ChatView.svelte");
const { getSessionMessages } = await import("#lib/api.js");
const mockMessages = vi.mocked(getSessionMessages);

const reason = (over: Partial<BlockReason>): BlockReason => ({
  shape: "awaiting-input",
  options: [],
  tail: [],
  ...over,
});

function props(over: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    status: "blocked" as const,
    variant: "session" as const,
    onsend: vi.fn(() => true),
    onkeys: vi.fn(() => true),
    oninterrupt: vi.fn(),
    onterminal: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockMessages.mockReset();
  mockMessages.mockResolvedValue({
    messages: [],
    awaitingInput: false,
    pendingQuestion: null,
    unavailable: null,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ChatView block answers", () => {
  it("a (y/n) prompt types its letter and Enter", async () => {
    const p = props({ block: reason({ shape: "yes-no", tail: ["Overwrite dist? (y/n)"] }) });
    render(ChatView, p);
    await expect.element(page.getByText("Overwrite dist? (y/n)")).toBeVisible();
    await page.getByRole("button", { name: m.assistant_chat_yes(), exact: true }).click();
    expect(p.onkeys).toHaveBeenCalledWith("y\r");
  });

  it("a plan approval shows the plan behind a toggle", async () => {
    const block = reason({
      shape: "menu",
      options: [
        { label: "Yes, auto-accept edits", send: "1" },
        { label: "No, keep planning", send: "3" },
      ],
      tail: ["Would you like to proceed?", "❯ 1. Yes, auto-accept edits", "  3. No, keep planning"],
      plan: { toolUseId: "p1", plan: "1. Add the Chat tab", truncated: false },
    });
    const p = props({ block });
    render(ChatView, p);
    await page.getByRole("button", { name: m.plan_banner_show() }).click();
    await expect.element(page.getByText("1. Add the Chat tab")).toBeVisible();
    await page.getByRole("button", { name: "No, keep planning" }).click();
    expect(p.onkeys).toHaveBeenCalledWith("3");
  });

  it("an unsent answer points to the terminal", async () => {
    const p = props({
      block: reason({ shape: "menu", options: [{ label: "Yes", send: "1" }] }),
      onkeys: vi.fn(() => false),
    });
    render(ChatView, p);
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    await expect.element(page.getByText(m.chat_block_keys_failed())).toBeVisible();
    await page.getByRole("button", { name: m.assistant_chat_open_terminal() }).click();
    expect(p.onterminal).toHaveBeenCalled();
  });

  it("an exhausted quota shows its notice and the terminal link", async () => {
    render(ChatView, props({ block: reason({ shape: "quota", quotaKind: "rework" }) }));
    await expect.element(page.getByText(m.hold_quota_rework())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.assistant_chat_open_terminal() }))
      .toBeVisible();
    expect(page.getByText(m.session_chat_blocked()).query()).toBeNull();
  });

  it("a prompt the Chat can't represent points to the terminal", async () => {
    render(ChatView, props({ block: reason({ tail: ["Trust this folder?"] }) }));
    await expect.element(page.getByText(m.session_chat_blocked())).toBeVisible();
  });

  it("an inactive view never reads the transcript", async () => {
    render(ChatView, props({ active: false }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMessages).not.toHaveBeenCalled();
  });
});
