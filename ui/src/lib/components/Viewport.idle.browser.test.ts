// Idle cost of the live terminal (#3035): a hidden window pauses the PTY stream after a grace
// period and resumes it on return; an unattended window paces output and drops the
// screen-reader mirror.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { Terminal } from "@xterm/xterm";
import "../../app.css";
import type { Session } from "#lib/types.js";
import type { connectPty } from "#lib/pty.js";

const pty = { pause: vi.fn(), poke: vi.fn() };
const received: Parameters<typeof connectPty>[3][] = [];
vi.mock("#lib/pty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/pty.js")>()),
  connectPty: vi.fn((...args: Parameters<typeof connectPty>) => {
    received.push(args[3]);
    return {
      send: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      poke: pty.poke,
      pause: pty.pause,
      takeover: vi.fn(),
    };
  }),
}));
const { default: Viewport } = await import("./Viewport.svelte");
/** Viewport's grace period before a hidden window pauses its terminal. */
const PTY_HIDDEN_PAUSE_MS = 30_000;

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

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  pty.pause.mockClear();
  pty.poke.mockClear();
  received.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // drop the instance override so the prototype getter is back for other files
  delete (document as { visibilityState?: unknown }).visibilityState;
  document.body.innerHTML = "";
});

async function mount(extra: { attended?: boolean } = {}) {
  const target = document.createElement("div");
  target.style.cssText = "height: 600px; display: flex; flex-direction: column";
  document.body.append(target);
  const props = { session: session({ id: "idle", status: "running" }), ...extra };
  const view = await render(Viewport, { target, props });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  return { rerender: (next: { attended: boolean }) => view.rerender({ ...props, ...next }) };
}

const mirror = () => document.querySelector(".xterm-accessibility");

describe("terminal stream while the window is hidden", () => {
  it("pauses only after the grace period and resumes on return", async () => {
    await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setVisibility("hidden");
    vi.advanceTimersByTime(PTY_HIDDEN_PAUSE_MS - 1);
    expect(pty.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pty.pause).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(pty.poke).toHaveBeenCalledTimes(1);
  });

  it("does not pause on a quick app switch", async () => {
    await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setVisibility("hidden");
    vi.advanceTimersByTime(PTY_HIDDEN_PAUSE_MS / 2);
    setVisibility("visible");
    vi.advanceTimersByTime(PTY_HIDDEN_PAUSE_MS);
    expect(pty.pause).not.toHaveBeenCalled();
  });
});

describe("terminal while the window is unattended", () => {
  it("keeps the screen-reader mirror and writes straight through when attended", async () => {
    const write = vi.spyOn(Terminal.prototype, "write");
    await mount();
    expect(mirror()).not.toBeNull();
    write.mockClear();
    received[0]("live");
    expect(write.mock.calls).toEqual([["live"]]);
  });

  it("paces output to 1×/s without the mirror, and catches up at once on focus", async () => {
    const write = vi.spyOn(Terminal.prototype, "write");
    const { rerender } = await mount({ attended: false });
    expect(mirror()).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    write.mockClear();
    received[0]("⠋ Working");
    received[0]("\r⠙ Working");
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls).toEqual([["⠋ Working\r⠙ Working"]]);
    received[0]("\r⠹ Working");
    vi.useRealTimers();
    await rerender({ attended: true });
    expect(write.mock.calls.at(-1)).toEqual(["\r⠹ Working"]);
    await vi.waitFor(() => expect(mirror()).not.toBeNull());
    received[0]("next");
    expect(write.mock.calls.at(-1)).toEqual(["next"]);
  });
});
