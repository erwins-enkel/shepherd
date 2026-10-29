import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { BlockReason } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { steers } from "#lib/steers.svelte.js";

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

describe("ChatView layout", () => {
  it("code blocks and tables break out of the prose measure", async () => {
    await page.viewport(1600, 900);
    const prose = "Anmeldung erst in die Standliste übernehmen und Zusage später am Stand. ".repeat(
      6,
    );
    const code = "Dev issue: #<N> " + "x".repeat(300);
    mockMessages.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          text: `${prose}\n\n\`\`\`\n${code}\n\`\`\`\n\n| a | b |\n| - | - |\n| ${"y".repeat(300)} | z |\n`,
          ts: 0,
        },
      ],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    });
    render(ChatView, props({ status: "idle" }));
    await expect.element(page.getByText(code)).toBeInTheDocument();
    await expect.poll(() => document.querySelector(".md-body table")).not.toBeNull();
    const width = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().width;
    const measure = parseFloat(getComputedStyle(document.querySelector(".md-body p")!).maxWidth);
    expect(width(".md-body p")).toBeLessThanOrEqual(measure);
    expect(width(".md-body pre")).toBeGreaterThan(width(".md-body p"));
    expect(width(".md-body table")).toBeGreaterThan(width(".md-body p"));
  });
});

describe("ChatView steers", () => {
  const critic =
    "The PR critic reviewed your latest push. These are the BLOCKING points:\n\n1. fix it";
  const wrapped = `\n\n<pasted_content id="2c65">\n${critic}\n</pasted_content id="2c65">\n`;
  let previous: typeof steers.list;
  beforeEach(() => {
    previous = steers.list;
    steers.list = [
      {
        id: "t",
        label: "Retest",
        emoji: "🧪",
        text: "Run the tests again",
        inSteerBar: true,
        onIssues: false,
      },
    ];
  });
  afterEach(() => {
    steers.list = previous;
  });

  it("a Shepherd steer is a collapsed card that expands to its text", async () => {
    mockMessages.mockResolvedValue({
      messages: [{ role: "user", text: wrapped, ts: 1000, steer: "review" }],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    });
    render(ChatView, props({ status: "idle" }));
    const summary = page.getByText(m.session_chat_steer_by({ kind: m.pulse_event_review() }));
    await expect.element(summary).toBeVisible();
    await expect.element(page.getByText("1. fix it", { exact: false })).not.toBeVisible();
    await summary.click();
    await expect.element(page.getByText("1. fix it", { exact: false })).toBeVisible();
    expect(document.body.textContent).not.toContain("pasted_content");
    expect(document.querySelector(".ac-mine")).toBeNull();
  });

  it("a message that is a saved steer names its chip, in a session only", async () => {
    mockMessages.mockResolvedValue({
      messages: [{ role: "user", text: "Run the tests again", ts: 0 }],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    });
    const view = await render(ChatView, props({ status: "idle" }));
    await expect.element(page.getByText(`${m.assistant_chat_you()} · 🧪 Retest`)).toBeVisible();
    await view.unmount();
    render(ChatView, props({ status: "idle", variant: "assistant" }));
    await expect.element(page.getByText("Run the tests again")).toBeVisible();
    expect(page.getByText("🧪 Retest", { exact: false }).query()).toBeNull();
  });

  it("echo shows a steer as sent, and drops it when the send fails", async () => {
    const view = await render(ChatView, props({ status: "idle" }));
    let fail!: (ok: boolean) => void;
    view.component.echo("Run the tests again", new Promise<boolean>((r) => (fail = r)));
    await expect.element(page.getByText("Run the tests again")).toBeVisible();
    await expect.element(page.getByText(m.assistant_chat_sent())).toBeVisible();
    fail(false);
    await expect.element(page.getByText(m.session_chat_send_failed())).toBeVisible();
    expect(page.getByText("Run the tests again").query()).toBeNull();
  });
});

describe("HUD asynchronous delivery", () => {
  it("retains the operator draft when a switch rejects delivery", async () => {
    render(
      ChatView,
      props({ variant: "assistant", status: "done", onsend: vi.fn(async () => false) }),
    );
    const input = page.getByRole("textbox");
    await input.fill("keep this question");
    await page.getByRole("button", { name: m.assistant_chat_send(), exact: true }).click();
    await expect.element(input).toHaveValue("keep this question");
  });
});
