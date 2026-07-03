import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsPluginsPanel from "./SettingsPluginsPanel.svelte";
import type { PluginInfo, InstalledPlugin } from "$lib/types";

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

function inst(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: "p1",
    name: "Test Plugin",
    version: "1.0.0",
    folder: "p1",
    loaded: false,
    disabled: false,
    broken: false,
    ...overrides,
  };
}

/** Stub the management scan fetch so the panel's onMount load resolves to `rows`. */
function stubScan(rows: InstalledPlugin[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/plugins/manage/installed")) {
      return new Response(JSON.stringify({ installed: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("SettingsPluginsPanel", () => {
  it("always shows the install-from-URL section", async () => {
    stubScan([]);
    render(SettingsPluginsPanel, { plugins: [] });
    await expect.element(page.getByPlaceholder("https://github.com/owner/repo")).toBeVisible();
  });

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

    // Expand via the plugin's own header toggle (not the Install button)
    await page.getByRole("button", { name: /Test Plugin/ }).click();
    // Now raw JSON dump appears (status value is present)
    await expect.element(page.getByText(/"secret": 99/)).toBeInTheDocument();
  });

  it("null-ui plugin shows JSON dump behind toggle (back-compat)", async () => {
    render(SettingsPluginsPanel, {
      plugins: [plugin({ ui: null, status: { n: 42 } })],
    });
    // JSON is hidden initially
    expect(document.querySelector("pre")).toBeNull();

    // Click the plugin header toggle
    await page.getByRole("button", { name: /Test Plugin/ }).click();
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
    await page.getByRole("button", { name: /Test Plugin/ }).click();
    await expect.element(page.getByText(/"side": true/)).toBeInTheDocument();
  });

  it("each plugin card has a plugin-card-<id> DOM id", async () => {
    render(SettingsPluginsPanel, {
      plugins: [plugin({ id: "alpha" }), plugin({ id: "beta", name: "Beta Plugin" })],
    });
    expect(document.getElementById("plugin-card-alpha")).not.toBeNull();
    expect(document.getElementById("plugin-card-beta")).not.toBeNull();
  });

  it("shows a pending-restart row + restart banner for an installed-but-unloaded plugin", async () => {
    stubScan([inst({ id: "fresh", name: "Fresh Plugin", folder: "fresh" })]);
    render(SettingsPluginsPanel, { plugins: [] });
    await expect.element(page.getByText("Fresh Plugin")).toBeVisible();
    await expect.element(page.getByText(/pending restart/i)).toBeVisible();
    // The restart banner surfaces the command.
    await expect.element(page.getByText("systemctl --user restart shepherd")).toBeVisible();
  });

  it("shows a broken row for a folder with an invalid manifest", async () => {
    stubScan([
      inst({
        id: "weird-folder",
        name: "weird-folder",
        version: "",
        broken: true,
        folder: "weird-folder",
      }),
    ]);
    render(SettingsPluginsPanel, { plugins: [] });
    await expect.element(page.getByText("weird-folder")).toBeVisible();
    await expect.element(page.getByText(/unrecognized/i)).toBeVisible();
  });

  it("focusId scrolls the card to the top of the panel (block:start, not center)", async () => {
    // #1254: a tall plugin card centered (block:center) lands the operator mid-panel;
    // it must align its top to the panel viewport instead.
    const calls: ScrollIntoViewOptions[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
      calls.push((arg ?? {}) as ScrollIntoViewOptions);
    };
    try {
      render(SettingsPluginsPanel, {
        plugins: [plugin({ id: "tall-plugin", name: "Tall Plugin" })],
        focusId: "tall-plugin",
      });
      // The $effect runs after mount; wait a microtask for it to fire.
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.length, "scrollIntoView was called").toBeGreaterThan(0);
      expect(calls[0].block).toBe("start");
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
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
