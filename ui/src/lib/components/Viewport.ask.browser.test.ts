import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { PendingAsk, Session } from "#lib/types.js";
import type { connectPty } from "#lib/pty.js";

const clients: {
  receive: Parameters<typeof connectPty>[3];
  reconnect: () => void;
  park: () => void;
  end: (reason: "gone" | "unreachable") => void;
}[] = [];
const ptySend = vi.fn();
const ptyResize = vi.fn();
vi.mock("#lib/pty.js", () => ({
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

const ask = (toolUseId: string): PendingAsk => ({
  toolUseId,
  questions: [
    {
      question: "Pick a pet?",
      header: "Pet",
      multiSelect: false,
      options: [
        { label: "Cat", description: "" },
        { label: "Dog", description: "" },
      ],
    },
  ],
});
const dialogEl = () => page.getByRole("dialog", { name: /Claude is asking|Claude fragt/ });
const answerStrip = () => page.getByRole("button", { name: /^(Answer|Beantworten)$/ });

beforeEach(async () => {
  clients.length = 0;
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(initial: PendingAsk | null) {
  const target = document.createElement("div");
  target.style.cssText = "height: 800px; display: flex; flex-direction: column";
  document.body.append(target);
  const s = session({ id: "asking", status: "blocked" });
  const { rerender } = await render(Viewport, { target, props: { session: s, ask: initial } });
  await vi.waitFor(() => expect(clients.length).toBe(1));
  return (next: PendingAsk | null) => rerender({ session: s, ask: next });
}

describe("AskUserQuestion dialog in the Viewport (#3165)", () => {
  it("auto-opens once per tool_use id, closes when the ask leaves, and the strip reopens it", async () => {
    const setAsk = await mount(ask("toolu_1"));
    await expect.element(dialogEl()).toBeVisible();
    await expect.element(page.getByText("Pick a pet?").first()).toBeVisible();

    // Operator dismisses → a re-emit of the SAME ask must not reopen it; the strip does.
    await page
      .elementLocator(document.querySelector<HTMLButtonElement>("[role=dialog] .x")!)
      .click();
    await expect.element(dialogEl()).not.toBeInTheDocument();
    await setAsk({ ...ask("toolu_1") });
    await expect.element(dialogEl()).not.toBeInTheDocument();
    await answerStrip().click();
    await expect.element(dialogEl()).toBeVisible();

    // Answered in the terminal → the block loses `ask` → the dialog closes.
    await setAsk(null);
    await expect.element(dialogEl()).not.toBeInTheDocument();
    await expect.element(answerStrip()).not.toBeInTheDocument();

    // A new question auto-opens again.
    await setAsk(ask("toolu_2"));
    await expect.element(dialogEl()).toBeVisible();
  });

  it("lists other sessions' questions beside this one and closes on a session switch", async () => {
    const target = document.createElement("div");
    target.style.cssText = "height: 800px; display: flex; flex-direction: column";
    document.body.append(target);
    const s = session({ id: "asking", status: "blocked" });
    const other = session({ id: "other", desig: "TASK-02", name: "task two", repoPath: "/repo/b" });
    const pendingAsks = [{ session: other, ask: ask("toolu_other"), since: Date.now() }];
    const { rerender } = await render(Viewport, {
      target,
      props: { session: s, ask: ask("toolu_3"), pendingAsks },
    });
    const center = page.getByRole("dialog", { name: /Open questions|Offene Fragen/ });
    await expect.element(center).toBeVisible();
    await expect.element(center.getByRole("button", { name: /TASK-02/ })).toBeVisible();

    await rerender({ session: other, ask: null, pendingAsks });
    await expect.element(center).not.toBeInTheDocument();
  });
});
