import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const { default: CliBadge } = await import("./CliBadge.svelte");

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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CliBadge", () => {
  it("labels a Codex session", async () => {
    render(CliBadge, { session: session({ id: "a", agentProvider: "codex" }) });
    await expect.element(page.getByText(m.clibadge_label_codex(), { exact: true })).toBeVisible();
  });

  it("labels a Claude session", async () => {
    render(CliBadge, { session: session({ id: "b", agentProvider: "claude" }) });
    await expect.element(page.getByText(m.clibadge_label_claude(), { exact: true })).toBeVisible();
  });

  it("a pre-field row with no provider reads as Claude", async () => {
    render(CliBadge, { session: session({ id: "c" }) });
    await expect.element(page.getByText(m.clibadge_label_claude(), { exact: true })).toBeVisible();
  });

  it("names the CLI to assistive tech and on hover", async () => {
    render(CliBadge, { session: session({ id: "d", agentProvider: "codex" }) });
    const el = document.querySelector(".cli-badge") as HTMLElement;
    const expected = m.clibadge_title({ cli: m.clibadge_label_codex() });
    expect(el.getAttribute("aria-label")).toBe(expected);
    expect(el.title).toBe(expected);
  });

  // The badge is on every card forever, unlike its state-scoped neighbours. It must therefore own no
  // hover overlay that could sit between the pointer and the chips beside it — see the note in the
  // component. A `statusTip` popover takes pointer events on purpose, so it is the wrong tool here.
  it("renders no popover overlay", async () => {
    render(CliBadge, { session: session({ id: "e", agentProvider: "codex" }) });
    const el = document.querySelector(".cli-badge") as HTMLElement;
    await el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    expect(document.querySelector(".status-tip")).toBeNull();
  });
});
