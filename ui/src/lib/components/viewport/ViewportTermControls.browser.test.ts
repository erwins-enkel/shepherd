import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { tick } from "svelte";
import "../../../app.css";
import { enterKey } from "$lib/controlKeys";

const { default: ViewportTermControls } = await import("./ViewportTermControls.svelte");

const baseProps = () => ({
  mobile: true,
  touch: true,
  tab: "term",
  send: () => {},
  notesKey: null,
  enter: enterKey(),
  uploading: false,
  uploadFailed: false,
  attachImages: () => {},
  onsummon: () => {},
});

afterEach(() => {
  document.body.innerHTML = "";
});

const rectOf = (label: string) => {
  const btn = [...document.querySelectorAll<HTMLElement>(".ctrl-bar .key")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!btn) throw new Error(`control key "${label}" not found`);
  return btn.getBoundingClientRect();
};

describe("ViewportTermControls arrow visibility (portrait)", () => {
  // The optimization's stated goal: the full cursor-arrow cluster stays visible
  // without horizontal scrolling on a portrait phone. The arrow group leads the
  // scroll region (controlKeys nav-before-edit) and the row's frozen edges are
  // just upload (left) + Enter (right), leaving the arrows room. This test is the
  // empirical guard: it renders the real row at 390px and asserts every arrow is
  // fully inside the scroll viewport with scrollLeft === 0.
  it("shows all four arrows within the scroll viewport, no scroll, at 390px", async () => {
    await page.viewport(390, 844); // iPhone-class portrait
    render(ViewportTermControls, baseProps());
    await tick();

    const bar = document.querySelector<HTMLElement>(".ctrl-row .ctrl-bar")!;
    expect(bar, "scroll container present").not.toBeNull();
    const barRect = bar.getBoundingClientRect();

    const arrows = ["←", "→", "↑", "↓"];
    const arrowRects = arrows.map((a) => ({ a, r: rectOf(a) }));

    // No horizontal scroll engaged, and every arrow lies fully inside the viewport.
    expect(bar.scrollLeft, "scroll container not scrolled").toBe(0);
    for (const { a, r } of arrowRects) {
      expect(r.left, `arrow ${a} left inside bar`).toBeGreaterThanOrEqual(barRect.left - 0.5);
      expect(r.right, `arrow ${a} right inside bar`).toBeLessThanOrEqual(barRect.right + 0.5);
    }

    // Before/after evidence (measured at 390px on this layout): the scroll region is
    // ~270px; the arrows fit with ~79px to spare, while the Tab/␣ (edit) group spans
    // ~92px. Because spare (79) < edit-group span (92), the pre-reorder order (edit
    // ahead of nav) would have pushed the last arrow ~13px past the viewport — the
    // arrows-first reorder is what keeps the full cluster on-screen. That margin isn't
    // asserted (it drifts with row width); the durable contract is the per-arrow
    // visibility above. Here we only assert the arrows clear the frozen edges.
    const lastArrowRight = Math.max(...arrowRects.map(({ r }) => r.right));
    expect(
      barRect.right - lastArrowRight,
      "arrows clear the frozen upload/Enter edges",
    ).toBeGreaterThanOrEqual(0);
  });
});
