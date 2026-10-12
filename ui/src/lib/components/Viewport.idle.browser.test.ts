// Idle cost of the live terminal (#3035): a hidden window pauses the PTY stream after a grace
// period and resumes it on return.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { Session } from "#lib/types.js";

const pty = { pause: vi.fn(), poke: vi.fn() };
vi.mock("#lib/pty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/pty.js")>()),
  connectPty: vi.fn(() => ({
    send: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    poke: pty.poke,
    pause: pty.pause,
    takeover: vi.fn(),
  })),
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
});

afterEach(() => {
  vi.useRealTimers();
  // drop the instance override so the prototype getter is back for other files
  delete (document as { visibilityState?: unknown }).visibilityState;
  document.body.innerHTML = "";
});

async function mount() {
  const target = document.createElement("div");
  target.style.cssText = "height: 600px; display: flex; flex-direction: column";
  document.body.append(target);
  await render(Viewport, {
    target,
    props: { session: session({ id: "idle", status: "running" }) },
  });
}

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
