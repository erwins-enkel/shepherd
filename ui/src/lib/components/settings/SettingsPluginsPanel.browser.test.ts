import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsPluginsPanel from "./SettingsPluginsPanel.svelte";
import type { PluginInfo } from "$lib/types";

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "p1",
    name: "Test Plugin",
    version: "1.0.0",
    health: "ok",
    lastError: null,
    status: { key: "value" },
    ui: null,
    gearItem: null,
    ...overrides,
  };
}

describe("SettingsPluginsPanel", () => {
  it("renders a settings-panel view always-visible (no click needed)", async () => {
    render(SettingsPluginsPanel, {
      plugins: [
        plugin({
          ui: {
            schemaVersion: 1,
            slot: "settings-panel",
            title: "Quota Info",
            root: { type: "text", props: { value: "95 % used" } },
          },
        }),
      ],
    });
    // The rendered view text is visible without expanding
    await expect.element(page.getByText("95 % used")).toBeVisible();
    // The view title (verbatim plugin text) is visible
    await expect.element(page.getByText("Quota Info")).toBeVisible();
  });

  it("raw JSON is hidden until expand for a view-bearing plugin", async () => {
    render(SettingsPluginsPanel, {
      plugins: [
        plugin({
          status: { secret: 99 },
          ui: {
            schemaVersion: 1,
            slot: "settings-panel",
            root: { type: "text", props: { value: "panel content" } },
          },
        }),
      ],
    });
    // Status JSON must NOT be visible before expanding
    expect(document.querySelector("pre")).toBeNull();

    // Expand via the toggle button
    await page.getByRole("button").click();
    // Now raw JSON dump appears (status value is present)
    await expect.element(page.getByText(/"secret": 99/)).toBeInTheDocument();
  });

  it("null-ui plugin shows JSON dump behind toggle (back-compat)", async () => {
    render(SettingsPluginsPanel, {
      plugins: [plugin({ ui: null, status: { n: 42 } })],
    });
    // JSON is hidden initially
    expect(document.querySelector("pre")).toBeNull();

    // Click expand
    await page.getByRole("button").click();
    // Status dump now visible
    await expect.element(page.getByText(/"n": 42/)).toBeInTheDocument();
  });

  it("slot-gated: session-sidebar ui does NOT render the view (falls back to JSON path)", async () => {
    render(SettingsPluginsPanel, {
      plugins: [
        plugin({
          ui: {
            schemaVersion: 1,
            slot: "session-sidebar",
            root: { type: "text", props: { value: "sidebar only content" } },
          },
          status: { side: true },
        }),
      ],
    });
    // The sidebar view text must NOT appear (slot gate)
    expect(document.body.textContent).not.toContain("sidebar only content");

    // JSON is behind the toggle (falls back to status dump)
    expect(document.querySelector("pre")).toBeNull();
    await page.getByRole("button").click();
    await expect.element(page.getByText(/"side": true/)).toBeInTheDocument();
  });

  it("each plugin card has a plugin-card-<id> DOM id", async () => {
    render(SettingsPluginsPanel, {
      plugins: [plugin({ id: "alpha" }), plugin({ id: "beta", name: "Beta Plugin" })],
    });
    expect(document.getElementById("plugin-card-alpha")).not.toBeNull();
    expect(document.getElementById("plugin-card-beta")).not.toBeNull();
  });

  it("focusId applies focus-flash class to the matching card", async () => {
    render(SettingsPluginsPanel, {
      plugins: [plugin({ id: "target-plugin", name: "Target Plugin" })],
      focusId: "target-plugin",
    });
    // The $effect runs after mount; wait a microtask for it to fire.
    await new Promise((r) => setTimeout(r, 0));
    const card = document.getElementById("plugin-card-target-plugin");
    expect(card, "card exists").not.toBeNull();
    expect(card!.classList.contains("focus-flash"), "focus-flash applied").toBe(true);
  });
});
