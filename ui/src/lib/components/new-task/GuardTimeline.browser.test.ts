import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { tick } from "svelte";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import GuardTimeline from "./GuardTimeline.svelte";
import RunSettingsGroups from "./RunSettingsGroups.svelte";
import type { GuardRepoConfig } from "$lib/guard-timeline";

// Rendering seam for the guard timeline. The derivation itself is covered without a DOM in
// guard-timeline.test.ts; this file asserts the collapse/expand contract, the marker classes
// that carry the human-vs-automatic distinction, and the nested automation popover — which
// must never close the surrounding New Task dialog (the typed prompt would be lost).

const REPO: GuardRepoConfig = {
  critic: true,
  autoAddress: true,
  autoMerge: true,
  draftMode: false,
};

afterEach(() => {
  document.body.innerHTML = "";
});

const head = () => document.querySelector<HTMLButtonElement>(".gtl-head")!;
const steps = () => Array.from(document.querySelectorAll<HTMLElement>(".gtl-step"));
const openBtns = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".gtl-open"));

function mount(over: Record<string, unknown> = {}) {
  render(GuardTimeline, {
    planGate: true,
    autopilot: false,
    provider: "claude",
    baseBranch: "main",
    repo: REPO,
    repoPath: "/tmp/repo",
    ...over,
  });
}

async function expand(over: Record<string, unknown> = {}) {
  mount(over);
  await expect.poll(() => head()).toBeTruthy();
  head().click();
  await tick();
}

describe("GuardTimeline — header", () => {
  it("names the combination and starts collapsed", async () => {
    mount();
    await expect.poll(() => head()).toBeTruthy();
    expect(head().textContent).toContain(m.guardtl_head_plan_manual());
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".gtl-list")).toBeNull();
  });

  it("swaps the header when autopilot flips, without expanding", async () => {
    mount({ autopilot: true });
    await expect.poll(() => head()).toBeTruthy();
    expect(head().textContent).toContain(m.guardtl_head_plan_auto());
    expect(document.querySelector(".gtl-list")).toBeNull();
  });

  it("expands and collapses on click", async () => {
    await expand();
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(steps().length).toBeGreaterThan(0);
    head().click();
    await tick();
    expect(document.querySelector(".gtl-list")).toBeNull();
  });
});

describe("GuardTimeline — markers", () => {
  it("marks the grill as yours and the release as yours when autopilot is off", async () => {
    await expand({ autopilot: false });
    const [grill, review, release] = steps();
    expect(grill!.querySelector(".gtl-marker.human")).toBeTruthy();
    expect(grill!.textContent).toContain(m.guardtl_step_grill());
    expect(review!.querySelector(".gtl-marker.conditional")).toBeTruthy();
    expect(release!.textContent).toContain(m.guardtl_step_release_you());
    expect(release!.querySelector(".gtl-marker.human")).toBeTruthy();
  });

  it("still marks the grill as yours when autopilot is on — only the release flips", async () => {
    await expand({ autopilot: true });
    const [grill, , release] = steps();
    expect(grill!.querySelector(".gtl-marker.human")).toBeTruthy();
    expect(release!.querySelector(".gtl-marker.auto")).toBeTruthy();
    expect(release!.textContent).toContain(m.guardtl_step_release_auto());
  });

  it("renders the repo divider and numbers the post-PR steps continuously", async () => {
    await expand({ autopilot: true });
    expect(document.querySelector(".gtl-divider")?.textContent).toBe(m.guardtl_divider());
    const lists = document.querySelectorAll<HTMLOListElement>(".gtl-list");
    expect(lists.length).toBe(2);
    // Plan gate on + autopilot on → grill, review, release, to-PR = 4 local steps.
    expect(lists[1]!.getAttribute("start")).toBe("5");
  });

  it("renders no automatic marker at all for a Codex task", async () => {
    await expand({ autopilot: true, provider: "codex" });
    expect(head().textContent).toContain(m.guardtl_head_plan_auto_codex());
    expect(document.querySelector(".gtl-marker.auto")).toBeNull();
    expect(steps()[2]!.textContent).toContain(m.guardtl_step_release_auto_codex());
  });

  it("never marks a post-PR step as unconditionally automatic", async () => {
    await expand({ autopilot: true });
    for (const btn of openBtns()) {
      const step = btn.closest(".gtl-step")!;
      expect(step.querySelector(".gtl-marker.auto")).toBeNull();
    }
  });

  it("omits the post-PR steps while the repo config is unloaded", async () => {
    await expand({ repo: null });
    expect(openBtns().length).toBe(0);
    expect(document.querySelector(".gtl-divider")).toBeNull();
  });
});

describe("GuardTimeline — automation popover", () => {
  it("opens the automation panel from a repo step", async () => {
    await expand({ autopilot: true });
    expect(openBtns().length).toBe(2);
    expect(document.querySelector(".auto-pop")).toBeNull();
    openBtns()[0]!.click();
    await expect.poll(() => document.querySelector(".auto-pop")).toBeTruthy();
    expect(openBtns()[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  // The card's use:dialog Escape handler bails on defaultPrevented, so consuming Escape here
  // is what keeps the dialog (and the typed prompt) alive while the popover closes.
  it("consumes Escape so the surrounding dialog stays open", async () => {
    await expand({ autopilot: true });
    openBtns()[0]!.click();
    await expect.poll(() => document.querySelector(".auto-pop")).toBeTruthy();

    const target = document.querySelector<HTMLElement>(".auto-pop")!;
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    await tick();

    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector(".auto-pop")).toBeNull();
    // The timeline itself survives — only the popover closed.
    expect(head()).toBeTruthy();
  });

  it("leaves Escape alone when no popover is open, so the dialog can close", async () => {
    await expand({ autopilot: true });
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.querySelector<HTMLElement>(".gtl")!.dispatchEvent(ev);
    await tick();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("closes on a click outside the block", async () => {
    await expand({ autopilot: true });
    openBtns()[0]!.click();
    await expect.poll(() => document.querySelector(".auto-pop")).toBeTruthy();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await tick();
    expect(document.querySelector(".auto-pop")).toBeNull();
  });
});

describe("RunSettingsGroups — guard timeline placement", () => {
  function mountGroups(over: Record<string, unknown> = {}) {
    render(RunSettingsGroups, {
      agentProvider: "claude",
      model: "inherit",
      effort: "inherit",
      sandboxProfile: "default",
      planGate: true,
      autopilot: false,
      modeLocked: false,
      planGateLoading: false,
      autopilotLoading: false,
      planGateDefault: false,
      autopilotDefault: false,
      baseBranch: "main",
      repoPath: "/tmp/repo",
      guardRepo: REPO,
      holdLikely: false,
      fableAvailable: false,
      research: false,
      onProviderChange: vi.fn(),
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      onSandboxChange: vi.fn(),
      onPlanGateChange: vi.fn(),
      onAutopilotChange: vi.fn(),
      ...over,
    });
  }

  it("renders the timeline in the guards group", async () => {
    mountGroups();
    await expect.poll(() => document.querySelector(".gtl-head")).toBeTruthy();
  });

  // Research and epic authoring run their own directives; the guard switches are forced off
  // and locked, so a timeline would describe a path the task never takes.
  it("hides the timeline in a locked mode", async () => {
    mountGroups({ modeLocked: true, research: true, planGate: false });
    await expect.poll(() => document.querySelector('button[role="switch"]')).toBeTruthy();
    expect(document.querySelector(".gtl-head")).toBeNull();
  });
});
