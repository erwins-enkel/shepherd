import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import UnitRow from "./UnitRow.svelte";
import { overwriteGetLocale } from "#lib/paraglide/runtime.js";
import type { Session } from "#lib/types.js";

// The badge's look lives in UnitRowRight's cross-component rules, so these mount the real row:
// a badge missing from its class lists keeps its own box, and the phone rail then strips only
// part of that box.

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "triage-feedback-aetherial-8",
    prompt: "/triage-feedback",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: "opus",
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
    scheduleId: "sched-1",
    scheduleName: "triage-feedback",
    ...partial,
  };
}

function mount(
  partial: Partial<Session> & { id: string },
  phone: boolean,
  { width = phone ? 360 : 560, showCli = true } = {},
) {
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  host.style.containerType = "inline-size";
  host.style.containerName = "herd";
  if (phone) host.classList.add("units", "flow");
  document.body.appendChild(host);
  render(UnitRow, {
    target: host,
    props: {
      session: session(partial),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      showCli,
    },
  });
  const badge = host.querySelector<HTMLElement>(".schedule-badge");
  expect(badge).not.toBeNull();
  return { host, badge: badge! };
}

afterEach(() => {
  overwriteGetLocale(() => "en");
  document.querySelectorAll("body > div").forEach((n) => n.remove());
});

function visibleText(badge: HTMLElement): string {
  return badge.innerText.trim().toLowerCase();
}

describe("ScheduleBadge in the phone rail", () => {
  it("is a borderless segment showing the kind only", () => {
    const { badge } = mount({ id: "rail" }, true);
    const style = getComputedStyle(badge);
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      expect(style[`border${side}Width`], side).toBe("0px");
    }
    expect(visibleText(badge)).toBe("scheduled");
  });

  it("uses the German kind label", () => {
    overwriteGetLocale(() => "de");
    const { badge } = mount({ id: "rail-de" }, true);
    expect(visibleText(badge)).toBe("geplant");
  });

  it("keeps the schedule name for assistive tech", () => {
    const { badge } = mount({ id: "rail-aria" }, true);
    expect(badge.getAttribute("aria-label")).toContain("triage-feedback");
  });

  it("puts the schedule name in the tooltip", () => {
    const { badge } = mount({ id: "rail-tip" }, true);
    badge.click();
    const tip = document.querySelector<HTMLElement>("[popover]:popover-open");
    expect(tip?.textContent).toContain("triage-feedback");
  });
});

describe("ScheduleBadge in the desktop strip", () => {
  it("matches the other segments: only a hairline on the left", () => {
    const { badge } = mount({ id: "strip" }, false);
    const style = getComputedStyle(badge);
    expect(style.borderTopWidth).toBe("0px");
    expect(style.borderRightWidth).toBe("0px");
    expect(style.borderBottomWidth).toBe("0px");
    expect(style.borderLeftWidth).toBe("1px");
  });

  it("shows the whole schedule name", () => {
    const { badge } = mount({ id: "strip-name" }, false);
    expect(visibleText(badge)).toBe("scheduled · triage-feedback");
    const full = badge.querySelector<HTMLElement>(".full")!;
    expect(full.scrollWidth).toBeLessThanOrEqual(full.clientWidth);
  });

  it("ends a long name in an ellipsis in a narrow strip", () => {
    const { host, badge } = mount(
      { id: "strip-narrow", scheduleName: "nightly-dependency-audit-and-cleanup" },
      false,
      { width: 260 },
    );
    const strip = host.querySelector<HTMLElement>(".u-badges")!;
    expect(badge.getBoundingClientRect().right).toBeLessThanOrEqual(
      strip.getBoundingClientRect().right + 1,
    );
    const full = badge.querySelector<HTMLElement>(".full")!;
    expect(full.scrollWidth).toBeGreaterThan(full.clientWidth);
  });

  it("gets the strip's rule when it is the only segment", () => {
    const { host } = mount({ id: "strip-rule" }, false, { showCli: false });
    const right = host.querySelector<HTMLElement>(".u-right")!;
    expect(getComputedStyle(right).borderTopWidth).toBe("1px");
  });
});

describe("ScheduleBadge without a name", () => {
  for (const phone of [true, false]) {
    it(`falls back to the bare marker and tooltip (${phone ? "rail" : "strip"})`, () => {
      const { badge } = mount({ id: `bare-${phone}`, scheduleName: null }, phone);
      expect(visibleText(badge)).toBe("scheduled");
      badge.click();
      const tip = document.querySelector<HTMLElement>("[popover]:popover-open");
      expect(tip?.textContent).toContain("Started by a repo schedule");
    });
  }
});
