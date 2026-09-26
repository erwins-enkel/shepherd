import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { cdp, page } from "vitest/browser";
import "../../app.css";
import type { Session } from "$lib/types";
import type { connectPty } from "$lib/pty";

const clients: {
  receive: Parameters<typeof connectPty>[3];
  reconnect: () => void;
  park: () => void;
  end: (reason: "gone" | "unreachable") => void;
}[] = [];
const ptySend = vi.fn();
const ptyResize = vi.fn();
vi.mock("$lib/pty", () => ({
  connectPty: vi.fn((...args: Parameters<typeof connectPty>) => {
    clients.push({ receive: args[3], reconnect: args[4]!, park: args[5]!, end: args[6]! });
    return { send: ptySend, resize: ptyResize, close: vi.fn(), poke: vi.fn(), takeover: vi.fn() };
  }),
}));
const { default: Viewport } = await import("./Viewport.svelte");

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

const hint = "? 2 questions\r\n  alt + ↑ to answer";
const repaint = (text: string) => "\x1b[2J\x1b[H" + text;
const questionButton = () => page.getByRole("button", { name: /Open questions|Fragen öffnen/ });

beforeEach(async () => {
  clients.length = 0;
  ptySend.mockClear();
  ptyResize.mockClear();
  await page.viewport(390, 844);
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(provider: "codex" | "claude" = "codex") {
  const props = {
    session: session({ id: "questions", agentProvider: provider, status: "running" }),
    mobile: true,
    touch: true,
  };
  const target = document.createElement("div");
  target.style.cssText = "height: 800px; display: flex; flex-direction: column";
  document.body.append(target);
  const result = await render(Viewport, { target, props });
  await vi.waitFor(() => expect(clients.length).toBe(1));
  return { view: result, props };
}

describe("Codex question hint in the live terminal", () => {
  it("opens questions while running, then hides after the terminal clears the hint", async () => {
    await mount();
    const client = clients[0];
    client.receive(repaint("? 2 questions\r\n  alt +"));
    await expect.element(questionButton()).not.toBeInTheDocument();
    client.receive(" ↑ to answer");
    await expect.element(questionButton()).toBeVisible();
    ptySend.mockClear();
    const box = questionButton().element().getBoundingClientRect();
    const input = cdp();
    await input.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.left + box.width / 2, y: box.top + box.height / 2 }],
    });
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(ptySend.mock.calls).toEqual([["\x1b[1;3A"]]);
    expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(false);
    client.receive(repaint("Which layout?\r\n1. Compact\r\n2. Expanded\r\nEnter to submit"));
    await expect.element(questionButton()).not.toBeInTheDocument();
    expect(clients).toHaveLength(1); // no terminal rebuild on detection changes
  });

  it("refits once the button appears and disappears, then settles", async () => {
    await mount();
    const frames = async () => {
      for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    };
    await frames();
    const before = ptyResize.mock.calls.at(-1)![1];
    clients[0].receive(repaint(hint));
    await expect.element(questionButton()).toBeVisible();
    await frames();
    expect(ptyResize.mock.calls.at(-1)![1]).toBeLessThan(before);
    const shownCount = ptyResize.mock.calls.length;
    await frames();
    expect(ptyResize).toHaveBeenCalledTimes(shownCount);
    await expect.element(questionButton()).toBeVisible();
    clients[0].receive(repaint("Questions answered"));
    await expect.element(questionButton()).not.toBeInTheDocument();
    await frames();
    expect(ptyResize.mock.calls.at(-1)![1]).toBe(before);
    const hiddenCount = ptyResize.mock.calls.length;
    await frames();
    expect(ptyResize).toHaveBeenCalledTimes(hiddenCount);
  });

  it("recognizes a soft-wrapped hint on a narrow phone", async () => {
    await mount();
    await page.viewport(320, 844);
    clients[0].receive(repaint("? 2 questions\r\n" + " ".repeat(35) + "alt + ↑ to answer"));
    await expect.element(questionButton()).toBeVisible();
  });

  it("ignores an old hint left in scrollback", async () => {
    await mount();
    clients[0].receive(repaint(hint));
    await expect.element(questionButton()).toBeVisible();
    clients[0].receive("\r\n" + "ordinary output\r\n".repeat(150));
    await expect.element(questionButton()).not.toBeInTheDocument();
  });

  it("does not offer Codex's shortcut in a Claude session", async () => {
    await mount("claude");
    clients[0].receive(repaint(hint + "\r\nNotes: press n to add notes"));
    await expect.element(page.getByRole("button", { name: /notes|Notiz/i })).toBeVisible();
    await expect.element(questionButton()).not.toBeInTheDocument();
  });

  it("resets when switching sessions", async () => {
    const view = await mount();
    clients[0].receive(repaint(hint));
    await expect.element(questionButton()).toBeVisible();
    await view.view.rerender({
      ...view.props,
      session: session({ id: "other", agentProvider: "codex" }),
    });
    await expect.element(questionButton()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(clients.length).toBe(2));
    clients[1].receive(repaint(hint));
    await expect.element(questionButton()).toBeVisible();
  });

  it.each(["park", "end", "reconnect"] as const)("clears the affordance on %s", async (event) => {
    await mount();
    clients[0].receive(repaint(hint));
    await expect.element(questionButton()).toBeVisible();
    if (event === "end") clients[0].end("gone");
    else clients[0][event]();
    await expect.element(questionButton()).not.toBeInTheDocument();
    if (event === "reconnect") {
      clients[0].receive(repaint(hint));
      await expect.element(questionButton()).toBeVisible();
    }
  });
});
