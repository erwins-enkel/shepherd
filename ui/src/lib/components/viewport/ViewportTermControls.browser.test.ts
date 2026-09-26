import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
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
  attachFiles: () => {},
  onsummon: () => {},
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ViewportTermControls attach picker", () => {
  // The picker used to carry accept="image/*,video/*", which made an EPS (and every other
  // non-media file) unpickable with no explanation anywhere. Any type is accepted now.
  it("puts no type filter on the file input", async () => {
    render(ViewportTermControls, baseProps());
    await tick();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input!.hasAttribute("accept")).toBe(false);
    expect(input!.multiple).toBe(true);
  });
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

describe("Codex questions control", () => {
  const questionButton = () => page.getByRole("button", { name: /Open questions|Fragen öffnen/ });

  it("sends Alt+Up once per click and keyboard activation", async () => {
    const send = vi.fn();
    render(ViewportTermControls, { ...baseProps(), codexQuestions: true, send });
    await questionButton().click();
    expect(send.mock.calls).toEqual([["\x1b[1;3A"]]);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(send.mock.calls).toEqual([["\x1b[1;3A"], ["\x1b[1;3A"], ["\x1b[1;3A"]]);
  });

  it.each([
    { mobile: true, touch: true, tab: "term", codexQuestions: false },
    { mobile: false, touch: true, tab: "term", codexQuestions: true },
    { mobile: false, touch: false, tab: "term", codexQuestions: true },
    { mobile: true, touch: true, tab: "diff", codexQuestions: true },
  ])("hides when inapplicable: %j", async (props) => {
    render(ViewportTermControls, { ...baseProps(), ...props });
    await expect.element(questionButton()).not.toBeInTheDocument();
  });

  it.each([320, 390])("fits above the key row at %ipx", async (width) => {
    await page.viewport(width, 844);
    render(ViewportTermControls, { ...baseProps(), codexQuestions: true });
    await expect.element(questionButton()).toBeVisible();
    const button = questionButton().element().getBoundingClientRect();
    const row = document.querySelector(".ctrl-row")!.getBoundingClientRect();
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(width);
    expect(button.bottom).toBeLessThanOrEqual(row.top);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (width === 390) {
      const bar = document.querySelector(".ctrl-bar")!.getBoundingClientRect();
      for (const arrow of ["←", "→", "↑", "↓"]) {
        expect(rectOf(arrow).left).toBeGreaterThanOrEqual(bar.left - 0.5);
        expect(rectOf(arrow).right).toBeLessThanOrEqual(bar.right + 0.5);
      }
    }
  });
});
