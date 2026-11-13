import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { Session } from "#lib/types.js";
import type { connectPty } from "#lib/pty.js";
import { CLEAN_TERMINAL_PREFIX as prefix } from "../../../../shared/clean-terminal";

const pty = vi.hoisted(() => ({
  args: null as Parameters<typeof connectPty> | null,
  send: vi.fn(),
}));
vi.mock("#lib/pty.js", () => ({
  connectPty: vi.fn((...args: Parameters<typeof connectPty>) => {
    pty.args = args;
    return {
      send: pty.send,
      resize: vi.fn(),
      close: vi.fn(),
      poke: vi.fn(),
      pause: vi.fn(),
      takeover: vi.fn(),
    };
  }),
}));
const { default: Viewport } = await import("./Viewport.svelte");
afterEach(() => {
  pty.args = null;
  pty.send.mockReset();
});
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

it("routes wheel and the jump buttons through the shell's endpoint history", async () => {
  const view = await render(Viewport, { session: session({ id: "shell", terminal: true }) });
  await vi.waitFor(() => expect(pty.args).not.toBeNull());
  let offset = 0;
  pty.send.mockImplementation((data: string) => {
    if (!data.startsWith(prefix)) return;
    const r = JSON.parse(data.slice(prefix.length));
    if (r.op === "scroll") offset = r.offset;
    queueMicrotask(() =>
      pty.args?.[3](
        prefix +
          JSON.stringify({
            id: r.id,
            scroll: { offset_from_bottom: offset, max_offset_from_bottom: 270, viewport_rows: 30 },
            ...(r.op !== "init" ? { revision: 12, text: `line ${270 - offset}` } : {}),
          }),
        true,
      ),
    );
  });
  pty.args![3]("line 270", false);
  await vi.waitFor(() => expect(pty.send).toHaveBeenCalled());
  document.querySelector(".xterm-screen")!.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: -5,
      deltaMode: 1,
      bubbles: true,
      cancelable: true,
    }),
  );
  await vi.waitFor(() => expect(offset).toBe(5));
  await vi.waitFor(() => expect(document.querySelectorAll(".scroll-jump button")).toHaveLength(2));
  const buttons = document.querySelectorAll<HTMLButtonElement>(".scroll-jump button");
  buttons[0]!.click();
  await vi.waitFor(() => expect(offset).toBe(270));
  buttons[1]!.click();
  await vi.waitFor(() => expect(offset).toBe(0));
  await vi.waitFor(() => expect(document.querySelector(".scroll-jump")).toBeNull());
  view.unmount();
});

it("does not opt an agent session into shell history controls", async () => {
  const view = await render(Viewport, { session: session({ id: "agent", terminal: false }) });
  await vi.waitFor(() => expect(pty.args).not.toBeNull());
  pty.args![3]("agent output", false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(pty.send.mock.calls.some(([data]) => String(data).startsWith(prefix))).toBe(false);
  view.unmount();
});
