import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import PluginLoadedCard from "./PluginLoadedCard.svelte";
import type { PluginInfo, PluginUINode } from "$lib/types";

// iPhone 14 Pro Max. The settings pane (.pbody) pads 18px either side, so a plugin
// card gets 394px — the width the reported overflow was measured against.
const PHONE_WIDTH = 430;
const PHONE_HEIGHT = 932;
const CARD_SLOT = 394;

function card(root: PluginUINode): PluginInfo {
  return {
    id: "p1",
    name: "test-plugin",
    version: "1.0.0",
    health: "ok",
    lastError: null,
    status: null,
    ui: { schemaVersion: 1, slot: "settings-panel", root },
    gearItem: null,
  };
}

async function renderAtPhoneWidth(root: PluginUINode): Promise<HTMLElement> {
  await page.viewport(PHONE_WIDTH, PHONE_HEIGHT);
  document.body.style.cssText = `margin:0;width:${CARD_SLOT}px`;
  const { container } = await render(PluginLoadedCard, {
    props: { plugin: card(root), folder: "p1", onuninstall: () => {} },
  });
  return container;
}

/** Descendants whose right edge escapes the card slot, described for a readable failure. */
function spill(container: HTMLElement): string[] {
  const limit = container.getBoundingClientRect().right;
  return Array.from(container.querySelectorAll("*"))
    .filter((el) => el.getBoundingClientRect().right - limit > 0.5)
    .map((el) => {
      const box = el.getBoundingClientRect();
      const cls = el.className
        .toString()
        .replace(/svelte-\w+/g, "")
        .trim();
      return `<${el.tagName.toLowerCase()} class="${cls}"> w=${Math.round(box.width)} over=${Math.round(box.right - limit)}`;
    });
}

afterEach(async () => {
  document.body.innerHTML = "";
  document.body.style.cssText = "";
  await page.viewport(1280, 900);
});

describe("PluginLoadedCard at phone width", () => {
  // Regression: a <select> takes its intrinsic width from its widest <option>, and a
  // vertical `stack` used to be a MULTI-LINE column flex container (flex-wrap: wrap), whose
  // flex line is sized to the widest child rather than to the container. One long option
  // therefore stretched every sibling — callout, key-value rows, fields, buttons — past the
  // card and made the settings pane scroll sideways on a phone.
  it("keeps every child inside the card when a select carries a long option", async () => {
    const container = await renderAtPhoneWidth({
      type: "stack",
      props: { direction: "vertical", gap: "sm" },
      children: [
        {
          type: "key-value",
          props: {
            pairs: [
              { key: "default channel", value: "ab89f51e-22d4-4fd3-8b38-4248a6446fdd" },
              { key: "posted / skipped / failed", value: "0 / 0 / 0" },
            ],
          },
        },
        {
          type: "callout",
          props: {
            tone: "warn",
            text: "BUZZ_PRIVATE_KEY is unset in the Shepherd server environment, so the bridge can neither list channels nor post.",
          },
        },
        {
          type: "select",
          props: {
            name: "channel",
            label: "default channel",
            value: "ab89f51e-22d4-4fd3-8b38-4248a6446fdd",
            options: [
              { value: "", label: "(none — skip unlinked sessions)" },
              {
                value: "ab89f51e-22d4-4fd3-8b38-4248a6446fdd",
                label: "ab89f51e-22d4-4fd3-8b38-4248a6446fdd (not discovered)",
              },
            ],
          },
        },
        {
          type: "text-input",
          props: { name: "relay", label: "relay URL", value: "https://buzz.erwins-enkel.dev" },
        },
        {
          type: "action-button",
          props: { label: "Save settings", route: { method: "POST", path: "save" }, submit: true },
        },
      ],
    });

    expect(spill(container)).toEqual([]);
    expect(container.scrollWidth).toBe(container.clientWidth);
  });

  // Guards the other side of the same fix: wrapping is still what a HORIZONTAL stack needs,
  // so the direction-aware flex-wrap must not have been flattened to a blanket `nowrap`.
  it("still wraps a horizontal stack too wide for one line", async () => {
    const container = await renderAtPhoneWidth({
      type: "stack",
      props: { direction: "horizontal", gap: "sm" },
      children: [
        "Reload channels",
        "Test transcription",
        "Rotate signing key",
        "Send test post",
      ].map((label, i) => ({
        type: "action-button",
        props: { label, route: { method: "POST", path: `act-${i}` } },
      })),
    });

    const buttons = Array.from(container.querySelectorAll("button.pui-action"));
    expect(buttons).toHaveLength(4);
    const rows = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
    expect(rows.size).toBeGreaterThan(1);
    expect(spill(container)).toEqual([]);
  });

  // A nested stack is itself a flex item, and its default `min-width: auto` resolves to its
  // min-content width — which for a <select> is the full intrinsic width of its widest
  // option. So a stack nested inside a horizontal one could not shrink and overflowed even
  // once the direction-aware flex-wrap above was in place; `.pui-stack { min-width: 0 }`
  // is what closes this second path.
  it("keeps a nested stack shrinkable when its select carries a long option", async () => {
    const container = await renderAtPhoneWidth({
      type: "stack",
      props: { direction: "horizontal", gap: "sm" },
      children: [
        {
          type: "stack",
          props: { direction: "vertical", gap: "sm" },
          children: [
            {
              type: "select",
              props: {
                name: "channel",
                label: "default channel",
                options: [
                  { value: "x", label: "ab89f51e-22d4-4fd3-8b38-4248a6446fdd (not discovered)" },
                ],
              },
            },
          ],
        },
        { type: "action-button", props: { label: "Save", route: { method: "POST", path: "s" } } },
      ],
    });
    expect(spill(container)).toEqual([]);
  });
});
