import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import type { BlockReason, SlashCommand } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { steers } from "#lib/steers.svelte.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getSessionMessages: vi.fn(), getCommands: vi.fn() };
});
vi.mock("#lib/visibility.js", () => ({ pollWhileVisible: () => () => {} }));

const { default: ChatView } = await import("./ChatView.svelte");
const { getCommands, getSessionMessages } = await import("#lib/api.js");
const mockMessages = vi.mocked(getSessionMessages);
const mockCommands = vi.mocked(getCommands);

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

  it("gives an assistant code block a copy button", async () => {
    mockMessages.mockResolvedValue({
      messages: [{ role: "assistant", text: "```\necho hi\n```", ts: 0 }],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    });
    render(ChatView, props({ status: "idle" }));
    await expect
      .element(page.getByRole("button", { name: m.markdown_copy_code() }))
      .toBeInTheDocument();
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

  it("the initial prompt reads as Markdown without fence markers; later messages stay plain", async () => {
    const prompt =
      "Fix it\n⟦UNTRUSTED:issue #8 body:ab12⟧\n## Problem\n\nOn `/settings/staff` it fails.\n⟦/UNTRUSTED:issue #8 body:ab12⟧";
    mockMessages.mockResolvedValue({
      messages: [
        { role: "user", text: prompt, ts: 1000, initial: true },
        { role: "user", text: "## not a heading", ts: 2000 },
      ],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    });
    render(ChatView, props({ status: "idle" }));
    await expect
      .poll(() => document.querySelector(".ac-bubble .md-body h2")?.textContent)
      .toBe("Problem");
    expect(document.querySelector(".ac-bubble .md-body code")?.textContent).toBe("/settings/staff");
    expect(document.body.textContent).not.toContain("UNTRUSTED");
    const bubbles = document.querySelectorAll(".ac-bubble");
    expect(bubbles[1]?.querySelector(".md-body")).toBeNull();
    expect(bubbles[1]?.querySelector("p")?.textContent).toBe("## not a heading");
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

  it("a settled echo stays gone once its row leaves the message window", async () => {
    const view = await render(ChatView, props({ status: "idle" }));
    view.component.echo("so we need to upgrade?", Promise.resolve(true));
    await expect.element(page.getByText(m.assistant_chat_sent())).toBeVisible();
    const window = (text: string) => ({
      messages: [{ role: "user" as const, text, ts: Date.now() + 1000 }],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    });
    mockMessages.mockResolvedValue(window("so we need to upgrade?"));
    await view.rerender({ status: "running" });
    await expect.poll(() => page.getByText(m.assistant_chat_sent()).query()).toBeNull();
    // Newer messages pushed the echo's row out of the window the server returns.
    mockMessages.mockResolvedValue(window("a later message"));
    await view.rerender({ status: "idle" });
    await expect.element(page.getByText("a later message")).toBeVisible();
    expect(page.getByText("so we need to upgrade?").query()).toBeNull();
    expect(page.getByText(m.assistant_chat_sent()).query()).toBeNull();
  });
});

describe("ChatView command menu", () => {
  const command = (name: string, provider: "claude" | "codex" = "claude"): SlashCommand => ({
    id: `test:${provider}:${name}`,
    name,
    description: `${name} description`,
    scope: "user",
    kind: "skill",
    invocationName: name,
    providers: [provider],
    invocations: { [provider]: provider === "codex" ? `$${name}` : `/${name}` },
  });
  const typed = (over: Record<string, unknown> = {}) =>
    props({ status: "idle", repoPath: "/repo", ...over });
  const rows = () => [...document.querySelectorAll(".sc-name")].map((el) => el.textContent);
  const menuOpen = () => expect.poll(() => rows().length).toBeGreaterThan(0);
  const input = () => page.getByRole("textbox");

  beforeEach(() => {
    mockCommands.mockReset();
    mockCommands.mockResolvedValue({ commands: [command("review")] });
  });

  it("/ lists the repo's commands plus /compact, not /clear", async () => {
    render(ChatView, typed());
    await input().fill("/");
    await menuOpen();
    expect(rows()).toEqual(["/compact", "/review"]);
    expect(mockCommands).toHaveBeenCalledWith("/repo", { provider: "claude" });
  });

  it("a repo command named compact shadows the built-in", async () => {
    mockCommands.mockResolvedValue({ commands: [command("compact")] });
    render(ChatView, typed());
    await input().fill("/comp");
    await menuOpen();
    expect(rows()).toEqual(["/compact"]);
    expect(document.querySelector(".sc-desc")?.textContent?.trim()).toBe("compact description");
  });

  it("Enter fills the command, a second Enter sends it", async () => {
    const onsend = vi.fn(() => true);
    render(ChatView, typed({ onsend }));
    await input().fill("/rev");
    await menuOpen();
    await userEvent.keyboard("{Enter}");
    await expect.element(input()).toHaveValue("/review ");
    expect(onsend).not.toHaveBeenCalled();
    await expect.poll(() => rows()).toEqual([]);
    await userEvent.keyboard("{Enter}");
    expect(onsend).toHaveBeenCalledWith("/review");
  });

  it("Tab fills, arrows move the highlight, a click fills", async () => {
    render(ChatView, typed());
    await input().fill("/");
    await menuOpen();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .poll(() => document.querySelector(".sc-row.active .sc-name")?.textContent)
      .toBe("/review");
    await userEvent.keyboard("{Tab}");
    await expect.element(input()).toHaveValue("/review ");

    await input().fill("/");
    await menuOpen();
    // Mounted bare, the composer tops the page and the upward menu has no room to be clicked.
    document
      .querySelector(".sc-row")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await expect.element(input()).toHaveValue("/compact ");
  });

  it("Shift+Enter keeps breaking the line while the menu is open", async () => {
    const onsend = vi.fn(() => true);
    render(ChatView, typed({ onsend }));
    await input().fill("/rev");
    await menuOpen();
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
    (document.querySelector("textarea") as HTMLTextAreaElement).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onsend).not.toHaveBeenCalled();
  });

  it("Escape closes the menu; only the next one interrupts a working agent", async () => {
    const oninterrupt = vi.fn();
    render(ChatView, typed({ status: "running", oninterrupt }));
    await input().fill("/");
    await menuOpen();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => rows()).toEqual([]);
    expect(oninterrupt).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(oninterrupt).toHaveBeenCalledOnce();
  });

  it("with no match, Enter sends what was typed", async () => {
    const onsend = vi.fn(() => true);
    render(ChatView, typed({ onsend }));
    await input().fill("/unknown");
    await expect.element(page.getByText(m.slash_menu_empty())).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(onsend).toHaveBeenCalledWith("/unknown");
  });

  it("a failed load still offers /compact and never blocks sending", async () => {
    mockCommands.mockRejectedValue(new Error("down"));
    render(ChatView, typed());
    await input().fill("/");
    await menuOpen();
    expect(rows()).toEqual(["/compact"]);
  });

  it("a mid-text path opens no menu and Enter sends", async () => {
    const onsend = vi.fn(() => true);
    render(ChatView, typed({ onsend }));
    await input().fill("see /review");
    await userEvent.keyboard("{Enter}");
    expect(onsend).toHaveBeenCalledWith("see /review");
    expect(mockCommands).not.toHaveBeenCalled();
  });

  it("escapes a pane that clips it, and stays on screen", async () => {
    mockCommands.mockResolvedValue({
      commands: Array.from({ length: 12 }, (_, i) => command(`cmd-${i + 10}`)),
    });
    render(ChatView, typed());
    const pane = document.querySelector(".ac")!.parentElement!;
    Object.assign(pane.style, {
      position: "relative",
      marginTop: "150px",
      height: "120px",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    });
    await input().fill("/");
    await menuOpen();
    const panel = document.querySelector(".sc-panel")!.getBoundingClientRect();
    expect(panel.top).toBeLessThan(pane.getBoundingClientRect().top);
    expect(panel.top).toBeGreaterThanOrEqual(0);
    const first = document.querySelector(".sc-row")!.getBoundingClientRect();
    const hit = document.elementFromPoint(first.left + 20, first.top + 10);
    expect(hit?.closest(".sc-row")).not.toBeNull();
  });

  it("a Codex session offers $ mentions only, in place, without /compact", async () => {
    mockCommands.mockResolvedValue({ commands: [command("codex-only", "codex")] });
    render(ChatView, typed({ agentProvider: "codex" }));
    await input().fill("/");
    expect(mockCommands).not.toHaveBeenCalled();
    await input().fill("use $");
    await menuOpen();
    expect(rows()).toEqual(["$codex-only"]);
    await userEvent.keyboard("{Enter}");
    await expect.element(input()).toHaveValue("use $codex-only ");
  });

  it("without a repo (the assistant) there is no menu", async () => {
    render(ChatView, typed({ repoPath: undefined, variant: "assistant" }));
    await input().fill("/");
    expect(mockCommands).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
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
