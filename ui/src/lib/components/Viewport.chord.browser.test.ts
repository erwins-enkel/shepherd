import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";

// Capture everything the terminal would write to the PTY. Registered BEFORE the
// component import so xterm's onData wires into this spy instead of a real WS.
const ptySend = vi.fn();
vi.mock("#lib/pty.js", () => ({
  connectPty: vi.fn(() => ({
    send: ptySend,
    resize: vi.fn(),
    close: vi.fn(),
    poke: vi.fn(),
    takeover: vi.fn(),
  })),
}));

// Component must be imported AFTER the mock is registered.
const { default: Viewport } = await import("./Viewport.svelte");
import type { Session } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { isTypingTarget } from "./herd-keynav";

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

async function terminalTextarea(): Promise<HTMLTextAreaElement> {
  // xterm creates its helper textarea on term.open(); poll briefly for it.
  for (let i = 0; i < 100; i++) {
    const el = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (el) return el;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("xterm helper textarea never appeared");
}

describe("Viewport PTY suppression of the settings chord", () => {
  it("a printable key reaches the PTY; Ctrl+, is suppressed (preventDefault, no byte)", async () => {
    await render(Viewport, { session: session({ id: "chord1" }) });
    const ta = await terminalTextarea();
    ta.focus();

    // xterm's evaluateKeyboardEvent branches on the legacy keyCode, which the
    // KeyboardEvent constructor never sets — stamp it on the synthetic events.
    function keyEvent(init: KeyboardEventInit, keyCode: number): KeyboardEvent {
      const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { value: keyCode });
      return ev;
    }

    // Control: a plain printable keydown flows through xterm to the PTY send.
    ptySend.mockClear();
    ta.dispatchEvent(keyEvent({ key: "x", code: "KeyX" }, 88));
    await vi.waitFor(() => expect(ptySend).toHaveBeenCalled());
    expect(ptySend.mock.calls.some(([d]) => String(d).includes("x"))).toBe(true);

    // The settings chord: our custom key handler preventDefaults and returns false,
    // so xterm processes nothing and no byte reaches the PTY.
    ptySend.mockClear();
    const chord = keyEvent({ key: ",", code: "Comma", ctrlKey: true }, 188);
    ta.dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(true);
    // give any (wrong) async send a beat to fire before asserting silence
    await new Promise((r) => setTimeout(r, 50));
    expect(ptySend).not.toHaveBeenCalled();
  });
});

describe("Viewport Alt+arrow input", () => {
  it.each([
    { code: "ArrowUp", keyCode: 38, sequence: "\x1b[1;3A" },
    { code: "ArrowDown", keyCode: 40, sequence: "\x1b[1;3B" },
  ])("forwards Alt+$code to the agent", async ({ code, keyCode, sequence }) => {
    await render(Viewport, { session: session({ id: "alt-arrow" }) });
    const ta = await terminalTextarea();
    ta.focus();
    ptySend.mockClear();

    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: code,
        code,
        keyCode,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(ptySend.mock.calls).toEqual([[sequence]]);
  });
});

// #4221: clicking the Terminal tab left focus on the tab button, so a plain ↑/↓ fell through
// the page's typing guard into herd keynav and switched sessions instead of reaching the agent.
describe("Terminal tab focus (#4221)", () => {
  async function switchToTerminal() {
    await page.getByRole("tab", { name: m.viewport_files_tab() }).click();
    await page.getByRole("tab", { name: m.viewport_terminal_tab() }).click();
  }

  it("clicking the Terminal tab focuses the terminal; ↑ reaches the PTY, not keynav", async () => {
    await render(Viewport, { session: session({ id: "tab-focus" }) });
    await terminalTextarea();
    await switchToTerminal();
    await vi.waitFor(() =>
      expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(true),
    );
    // the page's plain-key tier stands down for this target
    expect(isTypingTarget(document.activeElement)).toBe(true);

    ptySend.mockClear();
    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() => expect(ptySend.mock.calls).toContainEqual(["\x1b[A"]));
  });

  it("leaves focus alone on touch (no soft keyboard pop)", async () => {
    await render(Viewport, { session: session({ id: "tab-focus-touch" }), touch: true });
    await terminalTextarea();
    await switchToTerminal();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(false);
  });
});
