import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import TriageDrawer from "./TriageDrawer.svelte";
import { m } from "$lib/paraglide/messages";
import type { BlockedEntry } from "$lib/triage";
import type { Session } from "$lib/types";

function session(id: string): Session {
  return {
    id,
    desig: `TASK-${id}`,
    name: `task ${id}`,
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
    status: "blocked",
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
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
  };
}

function quotaEntry(
  id: string,
  quotaKind: "rework" | "review" | "error" | "plan",
  tail: string[] = ["finding 1", "finding 2"],
): BlockedEntry {
  return {
    session: session(id),
    reason: { shape: "quota", options: [], tail, quotaKind },
    since: Date.now() - 5000,
  };
}

const noop = () => {};

describe("TriageDrawer quota branch", () => {
  it("renders the rework explanatory line for quotaKind=rework", async () => {
    render(TriageDrawer, {
      entries: [quotaEntry("q1", "rework")],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: noop,
      ontakeover: noop,
      onabandon: noop,
    });
    await expect.element(page.getByText(m.triage_quota_rework())).toBeInTheDocument();
  });

  it("renders Resume, Take over, Abandon buttons for a quota entry", async () => {
    render(TriageDrawer, {
      entries: [quotaEntry("q2", "review")],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: noop,
      ontakeover: noop,
      onabandon: noop,
    });
    await expect.element(page.getByText(m.triage_quota_resume())).toBeInTheDocument();
    await expect.element(page.getByText(m.triage_quota_takeover())).toBeInTheDocument();
    await expect.element(page.getByText(m.triage_quota_abandon())).toBeInTheDocument();
  });

  it("does NOT render the reply input for a quota entry", async () => {
    render(TriageDrawer, {
      entries: [quotaEntry("q3", "plan")],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: noop,
      ontakeover: noop,
      onabandon: noop,
    });
    await expect
      .element(page.getByPlaceholder(m.triage_reply_placeholder()))
      .not.toBeInTheDocument();
  });

  it("clicking Resume calls onresume with the session id", async () => {
    let resumed: string | null = null;
    render(TriageDrawer, {
      entries: [quotaEntry("q4", "rework")],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: (id: string) => (resumed = id),
      ontakeover: noop,
      onabandon: noop,
    });
    await page.getByText(m.triage_quota_resume()).click();
    expect(resumed).toBe("q4");
  });

  it("clicking Take over calls ontakeover with the session id", async () => {
    let taken: string | null = null;
    render(TriageDrawer, {
      entries: [quotaEntry("q5", "review")],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: noop,
      ontakeover: (id: string) => (taken = id),
      onabandon: noop,
    });
    await page.getByText(m.triage_quota_takeover()).click();
    expect(taken).toBe("q5");
  });

  it("clicking Abandon calls onabandon with the session id", async () => {
    let abandoned: string | null = null;
    render(TriageDrawer, {
      entries: [quotaEntry("q6", "error")],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: noop,
      ontakeover: noop,
      onabandon: (id: string) => (abandoned = id),
    });
    await page.getByText(m.triage_quota_abandon()).click();
    expect(abandoned).toBe("q6");
  });

  it("does NOT render an empty <pre> for error-kind quota (empty tail)", async () => {
    render(TriageDrawer, {
      entries: [quotaEntry("q7", "error", [])],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: noop,
      ontakeover: noop,
      onabandon: noop,
    });
    // The tail pre is absent when tail is empty
    await expect.element(page.getByText(m.triage_quota_error())).toBeInTheDocument();
    // No pre.tail element should appear at all for empty findings
    expect(document.querySelector("pre.tail")).toBeNull();
  });

  it("renders the tail <pre> when findings are present", async () => {
    render(TriageDrawer, {
      entries: [quotaEntry("q8", "rework", ["finding A"])],
      nowMs: Date.now(),
      onreply: noop,
      ondismiss: noop,
      onopen: noop,
      onclose: noop,
      onresume: noop,
      ontakeover: noop,
      onabandon: noop,
    });
    await expect.element(page.getByText(/finding A/)).toBeInTheDocument();
    expect(document.querySelector("pre.tail")).not.toBeNull();
  });
});
