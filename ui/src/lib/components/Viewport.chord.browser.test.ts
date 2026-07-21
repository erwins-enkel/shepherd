import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";

// Capture everything the terminal would write to the PTY. Registered BEFORE the
// component import so xterm's onData wires into this spy instead of a real WS.
const ptySend = vi.fn();
vi.mock("$lib/pty", () => ({
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
import type { Session } from "$lib/types";

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
