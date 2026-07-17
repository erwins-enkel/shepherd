import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Session, SessionUsage } from "$lib/types";

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
    status: "running",
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

function usage(partial: Partial<SessionUsage> = {}): SessionUsage {
  return {
    available: true,
    source: "live",
    total: 1234,
    input: 1000,
    output: 234,
    cacheRead: 0,
    cacheWrite: 0,
    messageCount: 3,
    byModel: { opus: 1234 },
    ...partial,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SessionStatusBar", () => {
  it("renders identity, tokens and elapsed for a live Claude session", async () => {
    render(SessionStatusBar, {
      session: session({ id: "a", model: "opus", effort: "high" }),
      usage: usage(),
    });
    await expect.element(page.getByText("Claude Code · opus · High")).toBeInTheDocument();
    await expect.element(page.getByText("1.2k tok")).toBeInTheDocument();
    await expect.element(page.getByText("0m")).toBeInTheDocument(); // createdAt = now, minute floor
  });

  it("falls back to the localized default for a null model and effort", async () => {
    render(SessionStatusBar, { session: session({ id: "b" }), usage: usage() });
    await expect.element(page.getByText("Claude Code · default · default")).toBeInTheDocument();
  });

  it("legacy pre-feature session (no launch metadata) still renders identity", async () => {
    render(SessionStatusBar, {
      session: session({ id: "c", claudeSessionId: "" }),
      usage: null,
    });
    await expect.element(page.getByText("Claude Code · default · default")).toBeInTheDocument();
  });

  it("replacement to provider defaults wins over stale launch metadata", async () => {
    // "Continue with provider defaults" writes model/effort = null on the session row while
    // the ORIGINAL launch record still says opus/high — the bar must show the defaults,
    // not resurrect the pre-replacement environment.
    render(SessionStatusBar, {
      session: session({
        id: "k",
        model: null,
        effort: null,
        launchMetadata: {
          sourceKind: "user",
          prompt: "p",
          issue: null,
          attachments: [],
          branch: { baseBranch: "main", workBranch: "feat/x", sharedCheckout: false },
          uiState: null,
          submittedChoices: {
            planGateOverride: null,
            autopilotOverride: null,
            sandboxProfile: null,
            model: "opus",
            effort: "high",
          },
          resolvedLaunch: {
            research: false,
            planGateOptIn: false,
            autopilotOptIn: false,
            storedModel: "opus",
            effort: "high",
            sandboxApplied: null,
            sandboxDegraded: false,
            egressApplied: false,
            egressDegraded: false,
          },
          agent: { provider: "claude", model: "opus", effort: "high" },
        },
      }),
      usage: usage(),
    });
    await expect.element(page.getByText("Claude Code · default · default")).toBeInTheDocument();
  });

  it("codex session renders the Codex label and the codex-specific unavailable tokens", async () => {
    render(SessionStatusBar, {
      session: session({ id: "d", agentProvider: "codex", model: "gpt-5.5" }),
      usage: usage({ available: false, source: "none", total: 0 }),
    });
    await expect.element(page.getByText("Codex · gpt-5.5 · default")).toBeInTheDocument();
    const dash = document.querySelector(".ssb-unavailable") as HTMLElement;
    expect(dash.textContent).toBe("—");
    expect(dash.title).toBe("Token usage isn't tracked for Codex sessions yet");
  });

  it("unavailable usage shows the explained dash; a true zero shows 0 tok", async () => {
    render(SessionStatusBar, {
      session: session({ id: "e" }),
      usage: usage({ available: false, source: "none", total: 0 }),
    });
    const dash = document.querySelector(".ssb-unavailable") as HTMLElement;
    expect(dash.textContent).toBe("—");
    expect(dash.title).toBe("Token usage is unavailable for this session");
    document.body.innerHTML = "";

    render(SessionStatusBar, {
      session: session({ id: "f" }),
      usage: usage({ available: true, total: 0 }),
    });
    await expect.element(page.getByText("0 tok")).toBeInTheDocument();
    expect(document.querySelector(".ssb-unavailable")).toBeNull();
  });

  it("pending usage (null) shows the dash placeholder, not a fake zero", async () => {
    render(SessionStatusBar, { session: session({ id: "g" }), usage: null });
    expect((document.querySelector(".ssb-unavailable") as HTMLElement).textContent).toBe("—");
  });

  it("archived session shows the static total runtime from archivedAt", async () => {
    const H = 3_600_000;
    render(SessionStatusBar, {
      session: session({
        id: "h",
        status: "archived",
        createdAt: 0,
        archivedAt: 2 * H + 14 * 60_000,
      }),
      usage: usage({ source: "snapshot", byModel: null }),
    });
    await expect.element(page.getByText("2h 14m")).toBeInTheDocument();
  });

  it("idle session shows wall-clock age labeled as session age, not runtime", async () => {
    // No active-interval tracking exists server-side, so the value is deliberately AGE:
    // an idle session keeps aging and the title says exactly that.
    const M = 60_000;
    // clock.current may lag Date.now() by up to its 30s tick — the 40s cushion keeps the
    // minute floor at 45m for any lag in [0, 30s).
    render(SessionStatusBar, {
      session: session({ id: "n", status: "idle", createdAt: Date.now() - 45 * M - 40_000 }),
      usage: usage(),
    });
    const el = document.querySelector(".ssb-elapsed") as HTMLElement;
    expect(el.textContent).toBe("45m");
    expect(el.title).toContain("Session age 45m");
    expect(el.title).toContain("not active runtime");
  });

  it("restored session ages from creation on the live clock, not the stale archive stamp", async () => {
    // Bring-back clears archivedAt and flips status back to running; even if a stale
    // archivedAt survived, the live branch keys on status and must ignore it.
    const H = 3_600_000;
    // Same 40s cushion as above against the 30s clock lag.
    render(SessionStatusBar, {
      session: session({
        id: "o",
        status: "running",
        createdAt: Date.now() - 3 * H - 40_000,
        archivedAt: Date.now() - 2 * H, // stale leftover — must not cap the live age
      }),
      usage: usage(),
    });
    const el = document.querySelector(".ssb-elapsed") as HTMLElement;
    expect(el.textContent).toBe("3h 00m"); // full age since creation, incl. archived downtime
    expect(el.title).toContain("Session age 3h 00m");
  });

  it("archived session without archivedAt falls back to updatedAt", async () => {
    render(SessionStatusBar, {
      session: session({
        id: "i",
        status: "archived",
        createdAt: 0,
        archivedAt: null,
        updatedAt: 90 * 60_000,
      }),
      usage: null,
    });
    await expect.element(page.getByText("1h 30m")).toBeInTheDocument();
  });

  it("labels the identity as configured intent — spawn may substitute the model", async () => {
    // pushModelFlag applies usage-downgrade/availability fallbacks argv-only (never rewrites
    // session.model), so the bar knowingly shows the CONFIGURED model with an explanatory
    // title rather than claiming to know the effective spawn value.
    render(SessionStatusBar, {
      session: session({ id: "l", model: "fable", effort: "high" }),
      usage: usage(),
    });
    const id = document.querySelector(".ssb-identity") as HTMLElement;
    expect(id.textContent).toBe("Claude Code · fable · High");
    expect(id.title).toContain("Configured environment: Claude Code · fable · High");
    expect(id.title).toContain("usage downgrade");
  });

  it("labels a clamped codex effort tier as configured intent", async () => {
    // Codex clamps max → high at spawn while the stored intent keeps "max" — the bar shows
    // the stored tier, explicitly labeled as configuration, not the effective value.
    render(SessionStatusBar, {
      session: session({ id: "m", agentProvider: "codex", model: "gpt-5.5", effort: "max" }),
      usage: usage({ available: false, source: "none", total: 0 }),
    });
    const id = document.querySelector(".ssb-identity") as HTMLElement;
    expect(id.textContent).toBe("Codex · gpt-5.5 · Max");
    expect(id.title).toContain("Configured environment: Codex · gpt-5.5 · Max");
    expect(id.title).toContain("provider clamps");
  });

  it("is a labelled group and never an ARIA live region", async () => {
    render(SessionStatusBar, { session: session({ id: "j" }), usage: usage() });
    const bar = document.querySelector(".ssb") as HTMLElement;
    expect(bar.getAttribute("role")).toBe("group");
    expect(bar.getAttribute("aria-label")).toBe("Session status");
    expect(bar.getAttribute("aria-live")).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
