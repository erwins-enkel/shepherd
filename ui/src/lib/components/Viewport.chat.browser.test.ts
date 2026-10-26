import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { BlockReason, Session, SessionMessages } from "#lib/types.js";
import type { connectPty } from "#lib/pty.js";
import { m } from "#lib/paraglide/messages.js";

const clients: { receive: Parameters<typeof connectPty>[3] }[] = [];
const ptySend = vi.fn();
vi.mock("#lib/pty.js", () => ({
  connectPty: vi.fn((...args: Parameters<typeof connectPty>) => {
    clients.push({ receive: args[3] });
    return { send: ptySend, resize: vi.fn(), close: vi.fn(), poke: vi.fn(), takeover: vi.fn() };
  }),
}));
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getSessionMessages: vi.fn(), replySession: vi.fn() };
});
const { default: Viewport } = await import("./Viewport.svelte");
const { getSessionMessages, replySession } = await import("#lib/api.js");
const mockMessages = vi.mocked(getSessionMessages);
const mockReply = vi.mocked(replySession);

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  };
}

const transcript: SessionMessages = {
  messages: [
    { role: "user", text: "fix the build", ts: 1000 },
    { role: "assistant", text: "Found it.", ts: 4000 },
  ],
  awaitingInput: false,
  pendingQuestion: null,
  unavailable: null,
  tools: [
    { ts: 2000, tool: "Read", summary: "read build.ts", status: "ok" },
    { ts: 3000, tool: "Bash", summary: "$ bun run build", status: "error" },
  ],
};

const menu: BlockReason = {
  shape: "menu",
  options: [
    { label: "Yes", send: "1" },
    { label: "No", send: "2" },
  ],
  tail: ["● Bash(rm -rf dist)", "Do you want to proceed?", "❯ 1. Yes", "  2. No"],
};

const tab = (name: string) => page.getByRole("tab", { name, exact: true });
// A programmatic click: the shared browser cursor may hover the title's meta popover over the tabs.
async function open(name: string) {
  await expect.element(tab(name)).toBeInTheDocument();
  (tab(name).element() as HTMLElement).click();
  await expect.element(tab(name)).toHaveAttribute("aria-selected", "true");
}
const composer = () => page.getByRole("textbox", { name: m.session_chat_input_label() });

beforeEach(() => {
  clients.length = 0;
  ptySend.mockClear();
  mockMessages.mockReset();
  mockMessages.mockResolvedValue(transcript);
  mockReply.mockReset();
  mockReply.mockResolvedValue();
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(props: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  target.style.cssText = "height: 700px; display: flex; flex-direction: column";
  document.body.append(target);
  const p = { session: session({ id: "s1" }), ...props };
  const view = await render(Viewport, { target, props: p });
  await vi.waitFor(() => expect(clients.length).toBe(1));
  return { view, props: p };
}

describe("Viewport Chat tab", () => {
  it("comes first; desktop opens on the terminal and never reads the transcript", async () => {
    await mount();
    const tabs = page.getByRole("tab").elements();
    expect(tabs[0].textContent).toBe(m.viewport_chat_tab());
    await expect.element(tab(m.viewport_terminal_tab())).toHaveAttribute("aria-selected", "true");
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMessages).not.toHaveBeenCalled();
  });

  it("touch opens on the Chat: text and tool runs in order", async () => {
    await mount({ touch: true });
    await expect.element(tab(m.viewport_chat_tab())).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByText("Found it.")).toBeVisible();
    expect(mockMessages).toHaveBeenCalledWith("s1", 50, { tools: true });
    const run = page.getByRole("button", { name: /2 tool calls/ });
    await expect.element(run).toBeVisible();
    const log = page.getByRole("log").element().textContent ?? "";
    expect(log.indexOf("fix the build")).toBeLessThan(log.indexOf("2 tool calls"));
    expect(log.indexOf("2 tool calls")).toBeLessThan(log.indexOf("Found it."));
    await run.click();
    await expect.element(page.getByText("read build.ts")).toBeVisible();
    await expect.element(page.getByText("$ bun run build")).toBeVisible();
  });

  it("sends over the live terminal socket", async () => {
    await mount();
    clients[0].receive("$ ");
    await open(m.viewport_chat_tab());
    await composer().fill("run the tests");
    await page.getByRole("button", { name: m.assistant_chat_send(), exact: true }).click();
    await vi.waitFor(() =>
      expect(ptySend.mock.calls.some(([d]) => String(d).includes("run the tests"))).toBe(true),
    );
    expect(mockReply).not.toHaveBeenCalled();
    await expect.element(page.getByText(m.assistant_chat_sent(), { exact: true })).toBeVisible();
  });

  it("falls back to the reply route without a live terminal", async () => {
    await mount();
    await open(m.viewport_chat_tab());
    await composer().fill("go on");
    await page.getByRole("button", { name: m.assistant_chat_send(), exact: true }).click();
    await vi.waitFor(() => expect(mockReply).toHaveBeenCalledWith("s1", "go on"));
  });

  it("a Codex session always takes the reply route, never the pane's shell", async () => {
    await mount({ session: session({ id: "s1", agentProvider: "codex" }) });
    clients[0].receive("$ ");
    await open(m.viewport_chat_tab());
    await composer().fill("next step");
    await page.getByRole("button", { name: m.assistant_chat_send(), exact: true }).click();
    await vi.waitFor(() => expect(mockReply).toHaveBeenCalledWith("s1", "next step"));
    expect(ptySend.mock.calls.some(([d]) => String(d).includes("next step"))).toBe(false);
  });

  it("a failed reply takes the echo back", async () => {
    mockReply.mockRejectedValue(new Error("404"));
    await mount();
    await open(m.viewport_chat_tab());
    await composer().fill("go on");
    await page.getByRole("button", { name: m.assistant_chat_send(), exact: true }).click();
    await expect.element(page.getByText(m.session_chat_send_failed())).toBeVisible();
    expect(page.getByText(m.assistant_chat_sent(), { exact: true }).query()).toBeNull();
  });

  it("answers a blocked menu with the option's digit", async () => {
    await mount({ session: session({ id: "s1", status: "blocked" }), block: menu });
    clients[0].receive("$ ");
    await open(m.viewport_chat_tab());
    await expect.element(page.getByText("Do you want to proceed?")).toBeVisible();
    await page.getByRole("button", { name: "No", exact: true }).click();
    expect(ptySend).toHaveBeenLastCalledWith("2");
    await expect.element(page.getByRole("button", { name: "No", exact: true })).toBeDisabled();
  });

  it("a session switch returns to the device default", async () => {
    const { view, props } = await mount();
    await open(m.viewport_chat_tab());
    await expect.element(tab(m.viewport_chat_tab())).toHaveAttribute("aria-selected", "true");
    await view.rerender({ ...props, session: session({ id: "s2" }) });
    await expect.element(tab(m.viewport_terminal_tab())).toHaveAttribute("aria-selected", "true");
  });

  it("stops reading the transcript once another tab is open", async () => {
    await mount({ touch: true });
    await vi.waitFor(() => expect(mockMessages).toHaveBeenCalled());
    await open(m.viewport_terminal_tab());
    const calls = mockMessages.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(mockMessages).toHaveBeenCalledTimes(calls);
  });
});
