import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { tick } from "svelte";
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
