// The card and the session status bar must never disagree about ONE run's environment (#1823).
// They read the same resolver, but through different data paths: the card gets the live `activity`
// signal straight from the herd store, while the bar only sees it because Viewport forwards it — and
// a concluded session has no live signal at all and must fall back to the persisted row. These tests
// pin both halves at the rendered-text level, where a broken prop chain actually shows up.
import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { Session, SessionActivity } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const { default: UnitRow } = await import("./UnitRow.svelte");
const { default: SessionStatusBar } = await import("./SessionStatusBar.svelte");

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

function activity(identity: Partial<SessionActivity>): SessionActivity {
  return { lastActivityTs: 1, summary: null, recentTs: [], recentErrTs: [], ...identity };
}

/** Everything after the first "·" — i.e. the environment, minus the leading task id (card) or CLI
 *  name (bar). */
function tail(selector: string): string {
  const el = document.querySelector(selector) as HTMLElement;
  return el.textContent!.split("·").slice(1).join("·").trim();
}

const cardEnvironment = () => tail(".meta-text");
const barEnvironment = () => tail(".ssb-identity");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("card ↔ status bar parity", () => {
  it("a live session: both read the runtime identity off the same activity signal", async () => {
    // Configured values are deliberately WRONG here — if either surface fell back to them instead of
    // the observed signal, the two strings would differ and this fails.
    const s = session({ id: "live", agentProvider: "codex", model: "gpt-5.5", effort: "low" });
    const live = activity({ runtimeModel: "gpt-6-astra", runtimeEffort: "high" });

    render(UnitRow, { session: s, activity: live, onselect: () => {} } as never);
    const cardText = cardEnvironment();
    document.body.innerHTML = "";

    render(SessionStatusBar, { session: s, usage: null, activity: live });
    const barText = barEnvironment();

    expect(cardText).toBe("GPT-6 Astra · High");
    expect(barText).toBe(cardText);
  });

  it("a concluded session: both fall back to the persisted identity, no live signal", async () => {
    const s = session({
      id: "done",
      agentProvider: "codex",
      status: "done",
      model: null,
      effort: null,
      runtimeModel: "gpt-6-astra",
      runtimeEffort: "high",
    });

    render(UnitRow, { session: s, onselect: () => {} } as never);
    const cardText = cardEnvironment();
    document.body.innerHTML = "";

    render(SessionStatusBar, { session: s, usage: null });
    const barText = barEnvironment();

    expect(cardText).toBe("GPT-6 Astra · High");
    expect(barText).toBe(cardText);
  });

  it("nothing observed anywhere: one default segment on both, never the same word twice", async () => {
    const s = session({ id: "unknown", agentProvider: "codex" });

    render(UnitRow, { session: s, onselect: () => {} } as never);
    const cardText = cardEnvironment();
    document.body.innerHTML = "";

    render(SessionStatusBar, { session: s, usage: null });
    const barText = barEnvironment();

    expect(cardText).toBe(barText);
    expect(cardText).not.toContain("·");
  });

  // Mixed provenance travels the same way on both surfaces: neither may claim the configured effort
  // came from the runtime log.
  it("a mixed identity: both name the model as observed and the effort as configured", async () => {
    const s = session({
      id: "mixed",
      agentProvider: "claude",
      model: null,
      effort: "high",
      runtimeModel: "claude-opus-5",
    });
    const expected = `${m.session_env_model_observed({ model: "Opus 5" })} ${m.session_env_effort_configured({ effort: "High" })}`;

    render(UnitRow, { session: s, onselect: () => {} } as never);
    const cardText = cardEnvironment();
    // The card carries its explanation in a statusTip popover, not a native title — open it and
    // read the rendered text, so this asserts the card's own string and not the bar's.
    const meta = document.querySelector(".meta-text") as HTMLElement;
    meta.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const cardTip = (document.querySelector(".status-tip") as HTMLElement).textContent;
    document.body.innerHTML = "";

    render(SessionStatusBar, { session: s, usage: null });
    const barTip = (document.querySelector(".ssb-identity") as HTMLElement).title;
    const barText = barEnvironment();

    expect(cardText).toBe("Opus 5 · High");
    expect(barText).toBe(cardText);
    expect(cardTip).toBe(expected);
    expect(barTip).toBe(expected);
  });
});
