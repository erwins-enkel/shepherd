import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { tick } from "svelte";
import { m } from "$lib/paraglide/messages";
// MUST import the stylesheet: the inset is calc()'d from the design tokens
// (--mobile-actionbar-hit/-pad/--actionbar-border, all defined in app.css).
// Without it the calc is invalid and getComputedStyle().bottom is `auto`, not px.
import "../../app.css";

const { default: Toasts } = await import("./Toasts.svelte");
const { toasts } = await import("$lib/toasts.svelte");

function toastsBottomPx(): number {
  const el = document.querySelector(".toasts") as HTMLElement;
  expect(el, ".toasts rendered").not.toBeNull();
  return parseFloat(getComputedStyle(el).bottom);
}

beforeEach(() => {
  toasts.items = [];
});

afterEach(async () => {
  toasts.items = [];
  document.body.innerHTML = "";
  await page.viewport(1280, 900); // restore a sane width for other suites
});

describe("Toasts mobile inset above the action bar (#810)", () => {
  it("env(safe-area-inset-bottom) resolves to 0 in headless chromium (keeps 66px stable)", () => {
    // Sanity: the expected inset assumes no notch safe-area. If a future headless
    // env reported a non-zero inset, the 66px assertion below would drift — guard it.
    const probe = document.createElement("div");
    probe.style.paddingBottom = "env(safe-area-inset-bottom)";
    document.body.appendChild(probe);
    expect(parseFloat(getComputedStyle(probe).paddingBottom)).toBe(0);
    probe.remove();
  });

  it("insets the banner above the action bar when aboveActionBar is set", async () => {
    await page.viewport(400, 900); // ≤768px → mobile banner block
    toasts.info("decommissioned", { sticky: true });
    render(Toasts, { aboveActionBar: true });
    await tick();
    // --mobile-actionbar-h (44 + 10 + 2·1 = 56px) + max(--mobile-actionbar-pad 10px, 0) = 66px
    const inset = toastsBottomPx();
    expect(inset).toBeCloseTo(66, 0); // within ~0.5px
    expect(inset).toBeGreaterThan(0); // strictly above the flush (false) case
  });

  it("stays flush to the bottom edge (0px) when no action bar is present", async () => {
    await page.viewport(400, 900);
    toasts.info("decommissioned", { sticky: true });
    render(Toasts, { aboveActionBar: false });
    await tick();
    expect(toastsBottomPx()).toBe(0); // today's flush behavior; pre-fix value in both states
  });
});

/* A long action label ("Decommission & update local") used to squeeze .msg — the
   only shrinkable child of a nowrap 440px row — into a 3-line column. The row now
   wraps and the controls are one atomic flex item. Geometry is asserted against
   REAL css (app.css is imported above), and every string comes from the real
   message fns, so a future label change re-triggers these checks. */
function el<T extends HTMLElement>(sel: string): T {
  const node = document.querySelector(sel) as T;
  expect(node, `${sel} rendered`).not.toBeNull();
  return node;
}

/* .toast is align-items:center and .undo (~25px) / .x (~21px) differ in height, so
   two items on one row do NOT share a `top`. Compare vertical centers instead. */
function centerY(node: HTMLElement): number {
  const r = node.getBoundingClientRect();
  return r.top + r.height / 2;
}
function expectSameRow(a: HTMLElement, b: HTMLElement) {
  expect(Math.abs(centerY(a) - centerY(b))).toBeLessThanOrEqual(2);
}

/** Line boxes the message text actually occupies — 3 with the bug, 1 when fixed.
 *  A Range counts line boxes even though the flex item is blockified. */
function msgLineCount(msg: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(msg);
  return range.getClientRects().length;
}

const LONG_LABEL = m.gitrail_decommission_update_action(); // "Decommission & update local"
const MERGED = m.toast_merged({ name: "cli-dropdown-alignment" });

async function renderToast(text: string, label?: string, scale?: string) {
  toasts.info(text, {
    sticky: true,
    ...(label ? { action: { label, run: () => {} } } : {}),
  });
  render(Toasts, {});
  await tick();
  // The iOS Dynamic Type probe sets --ui-scale on :root (app.css:80-86, capped 1.5).
  if (scale) document.documentElement.style.setProperty("--ui-scale", scale);
  await tick();
}

describe("Toasts: long action label wraps instead of squishing the message", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--ui-scale");
  });

  it("keeps the message on ONE line and drops the controls to a second row", async () => {
    await page.viewport(1280, 900);
    await renderToast(MERGED, LONG_LABEL);
    const msg = el<HTMLElement>(".msg");
    const actions = el<HTMLElement>(".actions");

    // THE regression: pre-fix this was 3. Height/width would pass trivially now
    // that .msg has flex-grow, so assert the line boxes themselves.
    expect(msgLineCount(msg)).toBe(1);
    // Controls wrapped below the message rather than stealing its width.
    expect(actions.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      msg.getBoundingClientRect().bottom,
    );
  });

  it("keeps the ✕ beside the button on the wrapped row (no third-row orphan)", async () => {
    await page.viewport(1280, 900);
    await renderToast(MERGED, LONG_LABEL);
    const undo = el<HTMLElement>(".undo");
    const x = el<HTMLElement>(".x");

    expectSameRow(x, undo);
    // Adjacent, i.e. separated by exactly the .actions gap — not floated apart by
    // an auto-margin split (Flexbox §8.1) or orphaned to its own line.
    const gap = x.getBoundingClientRect().left - undo.getBoundingClientRect().right;
    expect(gap).toBeGreaterThan(12);
    expect(gap).toBeLessThan(16);
  });

  it("separates the two rows by the declared 8px row-gap, not the 14px shorthand", async () => {
    await page.viewport(1280, 900);
    await renderToast(MERGED, LONG_LABEL);
    const msg = el<HTMLElement>(".msg");
    const actions = el<HTMLElement>(".actions");
    const rowGap = actions.getBoundingClientRect().top - msg.getBoundingClientRect().bottom;
    expect(rowGap).toBeCloseTo(8, 0);
  });

  it("never overflows horizontally, even with an unbreakable branch name", async () => {
    await page.viewport(1280, 900);
    await renderToast(m.toast_merged({ name: "feat/" + "x".repeat(60) }), LONG_LABEL);
    const toast = el<HTMLElement>(".toast");
    // overflow-wrap: anywhere breaks the token instead of blowing out the panel.
    expect(toast.scrollWidth).toBeLessThanOrEqual(toast.clientWidth + 1);
  });

  it("leaves a short-label toast on a single row (unchanged)", async () => {
    await page.viewport(1280, 900);
    await renderToast(MERGED, m.common_retry());
    const msg = el<HTMLElement>(".msg");
    expectSameRow(el<HTMLElement>(".actions"), msg);
    expect(msgLineCount(msg)).toBe(1);
  });

  it("keeps .countdown a direct child of .toast (absolutely positioned against it)", async () => {
    await page.viewport(1280, 900);
    toasts.info(MERGED, {
      duration: 5000,
      action: { label: LONG_LABEL, run: () => {} },
    });
    render(Toasts, {});
    await tick();
    expect(document.querySelector(".toast > .countdown")).not.toBeNull();
  });

  for (const width of [390, 320]) {
    it(`keeps the ✕ beside the button on a ${width}px banner`, async () => {
      await page.viewport(width, 900);
      await renderToast(MERGED, LONG_LABEL);
      const toast = el<HTMLElement>(".toast");
      const undo = el<HTMLElement>(".undo");

      expectSameRow(el<HTMLElement>(".x"), undo);
      expect(undo.getBoundingClientRect().right).toBeLessThanOrEqual(
        toast.getBoundingClientRect().right,
      );
      expect(toast.scrollWidth).toBeLessThanOrEqual(toast.clientWidth + 1);
    });
  }

  // --fs-meta = calc(11px * --ui-scale) → 16.5px at the probe's 1.5 cap, growing
  // .undo past a 390px banner's ~362px content box. This is where flex-shrink on
  // .undo actually engages: the button must WRAP its label (it keeps overflow:hidden
  // for the .bar countdown, so clipping is a real failure mode), not overflow.
  it("keeps the ✕ beside the button and the label unclipped at --ui-scale: 1.5 (390px)", async () => {
    await page.viewport(390, 900);
    await renderToast(MERGED, LONG_LABEL, "1.5");
    const toast = el<HTMLElement>(".toast");
    const undo = el<HTMLElement>(".undo");

    // Sanity: the scale really applied (else this test proves nothing).
    expect(parseFloat(getComputedStyle(undo).fontSize)).toBeCloseTo(16.5, 1);

    expectSameRow(el<HTMLElement>(".x"), undo);
    expect(undo.getBoundingClientRect().right).toBeLessThanOrEqual(
      toast.getBoundingClientRect().right,
    );
    expect(toast.scrollWidth).toBeLessThanOrEqual(toast.clientWidth + 1);
    // Shrunk, so its label wrapped inside the button rather than being cut off.
    expect(undo.scrollWidth).toBeLessThanOrEqual(undo.clientWidth + 1);
    expect(undo.scrollHeight).toBeLessThanOrEqual(undo.clientHeight + 1);
  });
});
