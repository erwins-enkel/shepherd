import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Epic, EpicChild, EpicChildState } from "$lib/types";

const { default: EpicGroupHeader } = await import("./EpicGroupHeader.svelte");

const child = (state: EpicChildState, number: number): EpicChild => ({
  number,
  title: `c${number}`,
  url: "",
  order: number,
  body: "",
  blockedBy: [],
  state,
  sessionId: null,
  prNumber: null,
  issueClosed: false,
  claimed: false,
});

const epic = (children: EpicChild[], p: Partial<Epic> = {}): Epic => ({
  repoPath: "/home/u/Work/community-map",
  parentIssueNumber: 327,
  parentTitle: "Ship the new map",
  source: "native",
  children,
  warnings: [],
  run: {
    repoPath: "/home/u/Work/community-map",
    parentIssueNumber: 327,
    mode: "auto",
    status: "running",
  },
  ...p,
});

const noCues = { ciFailed: 0, needsRework: 0, branchProtectionBlocked: 0, ready: 0, blocked: 0 };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EpicGroupHeader", () => {
  it("renders the epic title, #N and the embedded EPIC x/y meter", async () => {
    // 4 children, 1 merged → EPIC 1/4
    const e = epic([
      child("merged", 1),
      child("in-review", 2),
      child("running", 3),
      child("ready", 4),
    ]);
    render(EpicGroupHeader, { epic: e, collapsed: false, cues: noCues, ontoggle: () => {} });
    await expect.element(page.getByText("Ship the new map")).toBeInTheDocument();
    await expect.element(page.getByText("#327")).toBeInTheDocument();
    await expect.element(page.getByText("EPIC 1/4")).toBeInTheDocument();
  });

  it("clicking the toggle calls ontoggle", async () => {
    const ontoggle = vi.fn();
    render(EpicGroupHeader, {
      epic: epic([child("running", 1)]),
      collapsed: false,
      cues: noCues,
      ontoggle,
    });
    const btn = document.querySelector(".epic-toggle") as HTMLButtonElement;
    btn.click();
    expect(ontoggle).toHaveBeenCalledTimes(1);
  });

  it("aria-expanded + aria-label reflect collapsed=false (expanded → offers collapse)", async () => {
    render(EpicGroupHeader, {
      epic: epic([child("running", 1)]),
      collapsed: false,
      cues: noCues,
      ontoggle: () => {},
    });
    const btn = document.querySelector(".epic-toggle") as HTMLButtonElement;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.getAttribute("aria-label")).toContain("Collapse epic #327");
  });

  it("aria-expanded + aria-label reflect collapsed=true (collapsed → offers expand)", async () => {
    render(EpicGroupHeader, {
      epic: epic([child("running", 1)]),
      collapsed: true,
      cues: noCues,
      ontoggle: () => {},
    });
    const btn = document.querySelector(".epic-toggle") as HTMLButtonElement;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-label")).toContain("Expand epic #327");
  });

  it("shows cue chips with their counts when > 0", async () => {
    render(EpicGroupHeader, {
      epic: epic([child("running", 1)]),
      collapsed: true,
      cues: { ciFailed: 2, needsRework: 4, branchProtectionBlocked: 5, ready: 3, blocked: 1 },
      ontoggle: () => {},
    });
    // each chip = leading aria-hidden glyph + count, so textContent ends with the count
    expect(document.querySelector(".cue-ci")?.textContent).toContain("2");
    expect(document.querySelector(".cue-ready")?.textContent).toContain("3");
    expect(document.querySelector(".cue-needs-rework")?.textContent).toContain("4");
    expect(document.querySelector(".cue-branch-blocked")?.textContent).toContain("5");
    expect(document.querySelector(".cue-blocked")?.textContent).toContain("1");
    expect(document.querySelector(".cue-blocked")?.getAttribute("title")).toContain("1");
  });

  it("ci-failed and blocked chips render DIFFERENT leading glyphs (both share the red hue)", async () => {
    // --status-blocked === --color-red, so ci-failed + blocked are the same color;
    // the leading shape mark is what keeps them distinguishable at a glance.
    render(EpicGroupHeader, {
      epic: epic([child("running", 1)]),
      collapsed: true,
      cues: { ciFailed: 1, needsRework: 0, branchProtectionBlocked: 0, ready: 0, blocked: 1 },
      ontoggle: () => {},
    });
    const ciGlyph = document.querySelector(".cue-ci .cue-glyph")?.textContent;
    const blockedGlyph = document.querySelector(".cue-blocked .cue-glyph")?.textContent;
    expect(ciGlyph).toBeTruthy();
    expect(blockedGlyph).toBeTruthy();
    expect(ciGlyph).not.toBe(blockedGlyph);
    // glyphs are decorative — meaning still lives on title/aria-label
    expect(document.querySelector(".cue-ci .cue-glyph")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".cue-blocked .cue-glyph")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("omits a cue chip when its count is 0", async () => {
    render(EpicGroupHeader, {
      epic: epic([child("running", 1)]),
      collapsed: false,
      cues: { ciFailed: 0, needsRework: 0, branchProtectionBlocked: 0, ready: 2, blocked: 0 },
      ontoggle: () => {},
    });
    expect(document.querySelector(".cue-ci")).toBeNull();
    expect(document.querySelector(".cue-blocked")).toBeNull();
    expect(document.querySelector(".cue-ready")?.textContent).toContain("2");
  });

  it("clicking the embedded badge calls onepic(repoPath, issueNumber)", async () => {
    const onepic = vi.fn();
    const e = epic([child("merged", 1), child("ready", 2)]);
    render(EpicGroupHeader, {
      epic: e,
      collapsed: false,
      cues: noCues,
      ontoggle: () => {},
      onepic,
    });
    const badge = document.querySelector(".epic-badge") as HTMLButtonElement;
    badge.click();
    expect(onepic).toHaveBeenCalledTimes(1);
    expect(onepic).toHaveBeenCalledWith("/home/u/Work/community-map", 327);
  });
});
