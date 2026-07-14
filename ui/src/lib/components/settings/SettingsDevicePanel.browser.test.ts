import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import { infoTips } from "$lib/info-tips.svelte";

// Stub $lib/push so pushState resolves to unsupported — avoids navigator.
vi.mock("$lib/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/push")>();
  return {
    ...actual,
    pushState: vi.fn(async () => ({
      supported: false,
      permission: "unsupported" as const,
      subscribed: false,
    })),
    getPushCategories: vi.fn(async () => ({ agent: true, reviews: true, ci: true })),
  };
});

const { default: SettingsDevicePanel } = await import("./SettingsDevicePanel.svelte");

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --font-mono: ui-monospace, monospace;
    --color-panel: #1a1a1a;
    --color-line: #333;
    --color-line-bright: #555;
    --color-inset: #111;
    --color-ink: #ccc;
    --color-ink-bright: #fff;
    --color-muted: #666;
    --color-faint: #444;
    --color-amber: #f5a623;
    --color-green: #4caf50;
    --color-red: #f44336;
    --fs-base: 13px;
    --fs-meta: 12px;
    --fs-micro: 10px;
    --fs-lg: 15px;
    --fs-xl: 18px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

const switchEl = () => page.getByRole("switch", { name: m.settings_reduced_push_title() });

describe("SettingsDevicePanel reduced-notifications switch", () => {
  it("renders aria-checked=true and On state when reducedPushMode is true", async () => {
    render(SettingsDevicePanel, { reducedPushMode: true });

    await expect.element(switchEl()).toBeInTheDocument();
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByText(m.settings_reduced_push_on(), { exact: true }))
      .toBeInTheDocument();
  });

  it("renders aria-checked=false when reducedPushMode is false", async () => {
    render(SettingsDevicePanel, { reducedPushMode: false });

    await expect.element(switchEl()).toBeInTheDocument();
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "false");
  });

  it("calls onToggleReducedPush when the switch is clicked", async () => {
    const spy = vi.fn();
    render(SettingsDevicePanel, { reducedPushMode: false, onToggleReducedPush: spy });

    await expect.element(switchEl()).toBeInTheDocument();
    await switchEl().click();

    expect(spy).toHaveBeenCalledOnce();
  });
});

// The hide-info-tips switch is a device pref, so the panel drives the store directly
// (like tabTicker / theme) rather than taking a prop. Its accessible name comes from the
// state label, matching the contrast / colourblind / tab-ticker rows.
const tipsSwitch = () => page.getByRole("switch", { name: m.settings_hide_info_tips_off() });
const tipsSwitchOn = () => page.getByRole("switch", { name: m.settings_hide_info_tips_on() });

describe("SettingsDevicePanel hide-info-tips switch", () => {
  afterEach(() => infoTips.set(false));

  it("defaults to off (tooltips shown)", async () => {
    render(SettingsDevicePanel, {});

    await expect.element(tipsSwitch()).toBeInTheDocument();
    await expect.element(tipsSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("clicking it hides info tips and flips aria-checked", async () => {
    render(SettingsDevicePanel, {});

    await expect.element(tipsSwitch()).toBeInTheDocument();
    await tipsSwitch().click();

    expect(infoTips.hidden).toBe(true);
    await expect.element(tipsSwitchOn()).toHaveAttribute("aria-checked", "true");
  });
});
