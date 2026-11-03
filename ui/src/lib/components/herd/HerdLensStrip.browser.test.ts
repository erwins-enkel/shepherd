import { describe, it, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import HerdLensStrip from "./HerdLensStrip.svelte";
import HerdSegRow from "./HerdSegRow.svelte";
import { overwriteGetLocale } from "#lib/paraglide/runtime.js";
import { m } from "#lib/paraglide/messages.js";
import { upNext } from "#lib/up-next.svelte.js";
import { upNextUi } from "#lib/up-next-ui.svelte.js";
import type { UpNextPr } from "#lib/types.js";

const base = {
  filter: "all" as const,
  statusFilter: null,
  statusLabel: "",
  collapsible: false,
};

// The strip lives in a 300–360px sidebar. Pin a 300px frame (the sidebar floor) so the
// single-row + label-fit guarantees are exercised at the worst case, matching the plan's
// step-7 measurement.
function mount300() {
  const frame = document.createElement("div");
  frame.style.width = "300px";
  document.body.appendChild(frame);
  render(HerdLensStrip, { props: base, target: frame });
  return frame;
}

afterEach(() => {
  overwriteGetLocale(() => "en");
  upNext.snapshot = null;
  document.body.replaceChildren();
});

describe("HerdSegRow: tapping Next", () => {
  const OPEN = "~/projects/homeassistant#2";
  const SCROLLED = 400;

  function scrollDown() {
    const tall = document.createElement("div");
    tall.style.height = "5000px";
    document.body.appendChild(tall);
    window.scrollTo({ top: SCROLLED });
    expect(window.scrollY).toBe(SCROLLED);
  }
  function tapNext() {
    document.querySelector<HTMLElement>(".seg-btn")!.click();
  }

  afterEach(() => {
    upNextUi.reset();
    window.scrollTo({ top: 0 });
  });

  it("closes the open preview and returns to the top when Next is already active", () => {
    upNextUi.previewKey = OPEN;
    render(HerdSegRow, { props: { filter: "next", statusFilter: null } });
    scrollDown();
    tapNext();
    expect(upNextUi.previewKey).toBeNull();
    expect(window.scrollY).toBe(0);
  });

  it("scrolls the list back to the top when no preview is open", () => {
    render(HerdSegRow, { props: { filter: "next", statusFilter: null } });
    scrollDown();
    tapNext();
    expect(window.scrollY).toBe(0);
  });

  it("keeps the preview and the scroll when arriving from another lens", async () => {
    upNextUi.previewKey = OPEN;
    render(HerdSegRow, { props: { filter: "all", statusFilter: null } });
    scrollDown();
    tapNext();
    await tick();
    const next = document.querySelector<HTMLElement>(".seg-btn")!;
    expect(next.getAttribute("aria-pressed")).toBe("true");
    expect(upNextUi.previewKey).toBe(OPEN);
    expect(window.scrollY).toBe(SCROLLED);
  });

  it("keeps the preview and the scroll when arriving from a status filter", () => {
    upNextUi.previewKey = OPEN;
    const onstatusfilter = vi.fn();
    render(HerdSegRow, { props: { filter: "next", statusFilter: "running", onstatusfilter } });
    scrollDown();
    tapNext();
    expect(onstatusfilter).toHaveBeenCalledWith(null);
    expect(upNextUi.previewKey).toBe(OPEN);
    expect(window.scrollY).toBe(SCROLLED);
  });

  it("keeps ticked rows on a re-tap", () => {
    upNextUi.previewKey = OPEN;
    upNextUi.selected.add(OPEN);
    render(HerdSegRow, { props: { filter: "next", statusFilter: null } });
    tapNext();
    expect(upNextUi.selected.has(OPEN)).toBe(true);
  });
});

describe("HerdLensStrip layout at the 300px sidebar floor", () => {
  it("keeps all five lenses on a single row", async () => {
    const frame = mount300();
    const btns = [...frame.querySelectorAll<HTMLElement>(".lens")];
    expect(btns).toHaveLength(5);
    // single row ⇒ every segment shares the same offsetTop
    const tops = new Set(btns.map((b) => b.offsetTop));
    expect(tops.size).toBe(1);
  });

  it("does not clip the longest DE label (Nächstes) — no ellipsis overflow", async () => {
    overwriteGetLocale(() => "de");
    const frame = mount300();
    const labels = [...frame.querySelectorAll<HTMLElement>(".lens .lb")];
    expect(labels.length).toBe(5);
    // a clipped label has scrollWidth > clientWidth (text-overflow:ellipsis kicked in)
    for (const lb of labels) {
      expect(lb.scrollWidth).toBeLessThanOrEqual(lb.clientWidth);
    }
  });
});

describe("HerdLensStrip header bits", () => {
  it("renders the collapse control only when collapsible", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, collapsible: true }, target: frame });
    const btn = frame.querySelector<HTMLElement>("#herd-collapse-btn");
    expect(btn).not.toBeNull();
    // shares the lens row (no row of its own) but is not one of the lenses
    const lens = frame.querySelector<HTMLElement>(".lens")!;
    expect(
      Math.abs(btn!.getBoundingClientRect().top - lens.getBoundingClientRect().top),
    ).toBeLessThanOrEqual(1);
    expect(btn!.closest('[role="group"]')).toBeNull();
  });

  it("keeps five lenses on one row, DE labels unclipped, beside the collapse control", async () => {
    overwriteGetLocale(() => "de");
    const frame = document.createElement("div");
    // the touch-wide sidebar column (.grid.compact caps it at 288px)
    frame.style.width = "288px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, collapsible: true }, target: frame });
    const lenses = [...frame.querySelectorAll<HTMLElement>(".lens")];
    const top = lenses[0].getBoundingClientRect().top;
    for (const lens of lenses) expect(lens.getBoundingClientRect().top).toBe(top);
    for (const lb of frame.querySelectorAll<HTMLElement>(".lens .lb")) {
      expect(lb.scrollWidth).toBeLessThanOrEqual(lb.clientWidth);
    }
  });

  it("renders the status chip only when a status filter is active", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, {
      props: { ...base, statusFilter: "running", statusLabel: "Busy" },
      target: frame,
    });
    expect(frame.querySelector(".statchip")).not.toBeNull();
  });
});

describe("HerdLensStrip OWED count badge (#1257)", () => {
  it("hides the badge when owedCount is 0 (or default)", async () => {
    const frame = mount300();
    expect(frame.querySelector(".owed-badge")).toBeNull();
  });

  it("renders the badge with the count when owedCount > 0", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, owedCount: 3 }, target: frame });
    const badge = frame.querySelector(".owed-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("3");
    // The badge anchors to the OWED lens (absolute → inside a position:relative segment).
    expect(frame.querySelector(".lens-owed .owed-badge")).not.toBeNull();
  });

  it("caps a large count at 99+", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, owedCount: 250 }, target: frame });
    expect(frame.querySelector(".owed-badge")!.textContent).toBe("99+");
  });

  it("keeps all five lenses on a single row at the 300px floor with a 2-digit badge", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, owedCount: 42 }, target: frame });
    const btns = [...frame.querySelectorAll<HTMLElement>(".lens")];
    expect(btns).toHaveLength(5);
    // single row ⇒ every segment shares the same offsetTop (the absolute badge adds no flow width)
    expect(new Set(btns.map((b) => b.offsetTop)).size).toBe(1);
    // the badge itself must not overflow the OWED segment's box
    const owed = frame.querySelector<HTMLElement>(".lens-owed")!;
    const badge = frame.querySelector<HTMLElement>(".owed-badge")!;
    expect(badge.offsetWidth).toBeLessThanOrEqual(owed.offsetWidth);
  });
});

describe("Up Next ready-PR badge", () => {
  const pr = (number: number, over: Partial<UpNextPr>): UpNextPr => ({
    repoPath: "/r/a",
    repoSlug: null,
    repoLabel: "a",
    number,
    title: `pr ${number}`,
    url: "",
    author: "me",
    kind: "regular",
    createdAt: 0,
    checks: "success",
    mergeable: true,
    band: "ready",
    action: "merge",
    ...over,
  });
  const seed = (pullRequests: UpNextPr[]) => {
    upNext.snapshot = {
      generatedAt: 1,
      sections: [],
      repoCount: 1,
      fallback: null,
      failedRepoCount: 0,
      pullRequests,
    };
  };
  const PRS = [
    pr(1, {}),
    pr(2, {}),
    pr(3, { checks: "pending", action: null }),
    pr(4, { band: "dependabot", kind: "dependabot" }),
  ];

  it("counts the PRs that can merge now on the desktop lens, in green", async () => {
    seed(PRS);
    const frame = mount300();
    const badge = frame.querySelector<HTMLElement>(".lens-next .ready-badge")!;
    expect(badge.textContent).toBe("2");
    expect(badge.getAttribute("aria-label")).toBe(m.upnext_pr_ready_badge({ count: 2 }));
    const probe = document.createElement("span");
    probe.style.color = "var(--color-green)";
    document.body.appendChild(probe);
    expect(getComputedStyle(badge).color).toBe(getComputedStyle(probe).color);
  });

  it("hides the badge when nothing can merge", async () => {
    seed([pr(3, { checks: "pending", action: null })]);
    const frame = mount300();
    expect(frame.querySelector(".ready-badge")).toBeNull();
  });

  it("shows the same count on the phone's Nächstes segment", async () => {
    seed(PRS);
    render(HerdSegRow, { props: { filter: "all", statusFilter: null } });
    const badge = document.querySelector<HTMLElement>(".seg-btn .ready-badge")!;
    expect(badge.textContent).toBe("2");
    expect(badge.getAttribute("aria-label")).toBe(m.upnext_pr_ready_badge({ count: 2 }));
  });
});
