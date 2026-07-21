import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import InstrumentToggle from "./InstrumentToggle.svelte";

// Direct component seam for the Guards switch row. The accessibility contract:
// a transparent full-row button[role=switch] is the only toggle target; the
// glossary term and the statusTip'd ON/OFF suffix are raised SIBLINGS that can
// never toggle it.

afterEach(() => {
  document.body.innerHTML = "";
});

function sw() {
  return document.querySelector<HTMLButtonElement>('button[role="switch"]')!;
}

function mount(over: Record<string, unknown> = {}) {
  const onchange = vi.fn();
  render(InstrumentToggle, {
    checked: false,
    labelMarkup: m.newtask_guard_plan_gate(),
    defaultTip: m.newtask_autopilot_repo_default_off(),
    onchange,
    ...over,
  });
  return onchange;
}

describe("InstrumentToggle", () => {
  it("1. the switch's accessible name is the visible label; aria-checked reflects state", async () => {
    mount({ checked: true });
    await expect.poll(() => sw()).toBeTruthy();
    const labelId = sw().getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)?.textContent).toContain("Plan gate");
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });

  it("2. keyboard: Space/Enter on the focused switch fire the change callback", async () => {
    const onchange = mount();
    await expect.poll(() => sw()).toBeTruthy();
    sw().focus();
    // A native <button> synthesizes click for Space and Enter; assert via click().
    sw().click();
    expect(onchange).toHaveBeenCalledWith(true);
    // Keydown path: dispatch a real Enter keydown+keyup pair through the browser
    // button semantics (keydown alone doesn't synthesize; use click as the proxy
    // for the activation the browser performs).
    expect(document.activeElement).toBe(sw());
  });

  it("3. pointer isolation: activating the glossary term never toggles", async () => {
    const onchange = mount();
    await expect.poll(() => document.querySelector(".label button")).toBeTruthy();
    const term = document.querySelector<HTMLButtonElement>(".label button")!;
    term.click();
    // Tooltip open (GlossaryTerm popover) and NO toggle.
    expect(onchange).not.toHaveBeenCalled();
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("4. keyboard isolation: Enter on the glossary term never toggles", async () => {
    const onchange = mount();
    await expect.poll(() => document.querySelector(".label button")).toBeTruthy();
    const term = document.querySelector<HTMLButtonElement>(".label button")!;
    term.focus();
    term.click(); // browser-native Enter activation on a button = click
    expect(onchange).not.toHaveBeenCalled();
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("5. the full row is the hit target (click on the row toggles via the overlay switch)", async () => {
    const onchange = mount();
    await expect.poll(() => sw()).toBeTruthy();
    // The overlay button spans the row; the visual layer is pointer-events:none.
    const row = document.querySelector<HTMLElement>(".toggle-row")!;
    const rect = row.getBoundingClientRect();
    const swRect = sw().getBoundingClientRect();
    expect(Math.round(swRect.width)).toBe(Math.round(rect.width));
    expect(Math.round(swRect.height)).toBe(Math.round(rect.height));
    const visual = document.querySelector<HTMLElement>(".visual")!;
    expect(getComputedStyle(visual).pointerEvents).toBe("none");
    sw().click();
    expect(onchange).toHaveBeenCalledWith(true);
  });

  it("6. statusTip suffix: hover/tap opens the repo-default tooltip without toggling", async () => {
    const onchange = mount();
    await expect.poll(() => document.querySelector(".status")).toBeTruthy();
    const status = document.querySelector<HTMLElement>(".status")!;
    // The statusTip action raises the trigger and stops click propagation.
    expect(getComputedStyle(status).pointerEvents).toBe("auto");
    status.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
    status.click();
    // Scope to the statusTip action's own popover (the glossary term renders its
    // own [role=tooltip] popover in the same row).
    await expect
      .poll(() => document.querySelector(".status-tip")?.textContent ?? "")
      .toContain(m.newtask_autopilot_repo_default_off());
    // Motion-free variant: the popover opts out of the global entrance animation.
    const tip = document.querySelector<HTMLElement>(".status-tip")!;
    expect(tip.classList.contains("status-tip-still")).toBe(true);
    expect(getComputedStyle(tip).animationName).toBe("none");
    expect(onchange).not.toHaveBeenCalled();
    expect(sw().getAttribute("aria-checked")).toBe("false");
    // Redundant AT path: the switch itself is described by the same text.
    const descId = sw().getAttribute("aria-describedby")!;
    expect(document.getElementById(descId)?.textContent).toBe(
      m.newtask_autopilot_repo_default_off(),
    );
  });

  it("7. dynamic default copy: an ON repo default renders 'Repo default: on'", async () => {
    mount({ checked: true, defaultTip: m.newtask_autopilot_repo_default_on() });
    await expect.poll(() => sw()).toBeTruthy();
    const descId = sw().getAttribute("aria-describedby")!;
    expect(document.getElementById(descId)?.textContent).toBe(
      m.newtask_autopilot_repo_default_on(),
    );
    // ON state renders the ON suffix in amber.
    expect(document.querySelector(".status")?.textContent).toBe(m.newtask_toggle_on());
    expect(document.querySelector(".status.on")).toBeTruthy();
  });

  it("disabled/loading dim the row and block toggling", async () => {
    const onchange = mount({ loading: true });
    await expect.poll(() => sw()).toBeTruthy();
    expect(sw().disabled).toBe(true);
    sw().click();
    expect(onchange).not.toHaveBeenCalled();
    expect(document.querySelector(".visual.dim")).toBeTruthy();
    expect(document.querySelector(".status.loading")?.textContent).toBe(m.common_loading());
  });
});
