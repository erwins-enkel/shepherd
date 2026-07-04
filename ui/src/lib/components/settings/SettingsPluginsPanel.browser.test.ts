import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsPluginsPanel from "./SettingsPluginsPanel.svelte";
import type { PluginInfo, InstalledPlugin, PluginUpdatesStatus } from "$lib/types";

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

/** Stub the scan + the activate POST. `activate` receives the parsed body and returns the
 *  JSON payload the endpoint would (`{ plugin }` on success, `{ error }` on failure) with an
 *  optional status. */
function stubActivate(
  rows: InstalledPlugin[],
  activate: (body: { folder?: string }) => { payload: unknown; status?: number },
) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/plugins/manage/activate")) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { folder?: string }) : {};
      const { payload, status = 200 } = activate(body);
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/plugins/manage/installed")) {
      return new Response(JSON.stringify({ installed: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
}

/** An update snapshot whose one plugin (`p1` unless overridden) is update-available. */
function updSnapshot(
  over: Partial<PluginUpdatesStatus["plugins"][number]> = {},
): PluginUpdatesStatus {
  return {
    plugins: [
      {
        id: "p1",
        name: "Test Plugin",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        source: "git",
        state: "update-available",
        ...over,
      },
    ],
    updateAvailable: true,
    checkedAt: 1700000000000,
  };
}

/** Stub the scan + the update-apply POST. `apply` returns the endpoint's JSON payload
 *  (`{ ok: true, ... }` on success, `{ error, detail? }` on failure) with an optional status. */
function stubApply(rows: InstalledPlugin[], apply: () => { payload: unknown; status?: number }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/plugin-update/apply")) {
      calls.push(init?.body ? String(init.body) : "");
      const { payload, status = 200 } = apply();
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/plugins/manage/installed")) {
      return new Response(JSON.stringify({ installed: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  return calls;
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

  it("a pending plugin shows an activate-to-load row + Activate button, NOT the restart banner", async () => {
    stubScan([inst({ id: "fresh", name: "Fresh Plugin", folder: "fresh" })]);
    render(SettingsPluginsPanel, { plugins: [] });
    await expect.element(page.getByText("Fresh Plugin")).toBeVisible();
    await expect.element(page.getByText(/activate to load/i)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Activate" })).toBeVisible();
    // A pending plugin is activatable in-process, so it must NOT raise the restart banner.
    expect(document.body.textContent).not.toContain("systemctl --user restart shepherd");
  });

  it("shows the restart banner for a removed (loaded-but-uninstalled) plugin", async () => {
    // Loaded in-process (in `plugins`) but its folder is gone from the scan → `removed`:
    // unloading it needs a restart, so the banner + command are shown.
    stubScan([]);
    render(SettingsPluginsPanel, { plugins: [plugin({ id: "gone", name: "Gone Plugin" })] });
    await expect.element(page.getByText(/restart to unload/i)).toBeVisible();
    await expect.element(page.getByText("systemctl --user restart shepherd")).toBeVisible();
  });

  it("a pending plugin exposes an Activate button that posts + triggers a store refresh", async () => {
    let activateCalls = 0;
    stubActivate([inst({ id: "fresh", name: "Fresh Plugin", folder: "fresh" })], () => {
      activateCalls++;
      return { payload: { plugin: plugin({ id: "fresh", name: "Fresh Plugin", health: "ok" }) } };
    });
    const onpluginschanged = vi.fn();
    render(SettingsPluginsPanel, { plugins: [], onpluginschanged });

    const btn = page.getByRole("button", { name: "Activate" });
    await expect.element(btn).toBeVisible();
    await btn.click();

    await vi.waitFor(() => expect(activateCalls).toBe(1));
    // The store-refresh callback fires so the parent can seed the freshly-loaded id.
    await vi.waitFor(() => expect(onpluginschanged).toHaveBeenCalled());
  });

  it("once the store gains the activated plugin it renders as a loaded card (no pending row)", async () => {
    // Simulates the post-activation state: parent re-seeded store.plugins + scan reports loaded.
    stubScan([inst({ id: "fresh", name: "Fresh Plugin", folder: "fresh", loaded: true })]);
    render(SettingsPluginsPanel, {
      plugins: [plugin({ id: "fresh", name: "Fresh Plugin", health: "ok" })],
    });
    await expect.element(page.getByText("Fresh Plugin")).toBeVisible();
    // Loaded card shows the health label; no Activate button, no pending state.
    await expect.element(page.getByText("OK")).toBeVisible();
    expect(document.body.textContent).not.toContain("activate to load");
    expect(page.getByRole("button", { name: "Activate" }).elements()).toHaveLength(0);
  });

  it("a failed activation surfaces a mapped message, not a raw code, and keeps the row pending", async () => {
    stubActivate([inst({ id: "fresh", name: "Fresh Plugin", folder: "fresh" })], () => ({
      payload: { error: "id_collision" },
      status: 400,
    }));
    render(SettingsPluginsPanel, { plugins: [] });

    await page.getByRole("button", { name: "Activate" }).click();
    // errorMessage() maps id_collision → the human string (never the bare code).
    await expect
      .element(page.getByText("A plugin with that id is already installed."))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("id_collision");
    // Still pending — nothing loaded (id_collision means loadOne never recorded this folder).
    await expect.element(page.getByText(/activate to load/i)).toBeVisible();
  });

  it("disables the Activate button while its request is in flight (no double-fire)", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    let activateCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/plugins/manage/activate")) {
        activateCalls++;
        await gate;
        return new Response(JSON.stringify({ plugin: plugin({ id: "fresh", health: "ok" }) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/plugins/manage/installed")) {
        return new Response(
          JSON.stringify({
            installed: [inst({ id: "fresh", name: "Fresh Plugin", folder: "fresh" })],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    render(SettingsPluginsPanel, { plugins: [] });

    await page.getByRole("button", { name: "Activate" }).click();
    // Mid-flight the button flips to the busy label and is disabled.
    const busy = page.getByRole("button", { name: "Activating…" });
    await expect.element(busy).toBeDisabled();
    expect(activateCalls).toBe(1);
    resolve();
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

  it("a loaded card shows the update badge + Update button when the snapshot says so", async () => {
    stubScan([inst({ loaded: true })]);
    render(SettingsPluginsPanel, {
      plugins: [plugin()],
      updates: updSnapshot(),
    });
    // "update available" surfaces INSIDE the plugin card (issue: user looked here first)
    await expect.element(page.getByText("Update available → v1.1.0")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  });

  it("no badge when the plugin is up to date", async () => {
    stubScan([inst({ loaded: true })]);
    render(SettingsPluginsPanel, {
      plugins: [plugin()],
      updates: updSnapshot({ state: "up-to-date", latestVersion: "1.0.0" }),
    });
    await expect.element(page.getByText("Test Plugin")).toBeVisible();
    expect(document.body.textContent).not.toContain("Update available");
    expect(page.getByRole("button", { name: "Update", exact: true }).elements()).toHaveLength(0);
  });

  it("a pending (not-loaded) row also carries the update badge + button", async () => {
    stubScan([inst({ id: "fresh", name: "Fresh Plugin", folder: "fresh" })]);
    render(SettingsPluginsPanel, {
      plugins: [],
      updates: updSnapshot({ id: "fresh", name: "Fresh Plugin" }),
    });
    await expect.element(page.getByText("Update available → v1.1.0")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  });

  it("inline apply (live) shows the running note and pushes the snapshot up", async () => {
    const calls = stubApply([inst({ loaded: true })], () => ({
      payload: {
        ok: true,
        restartRequired: false,
        updatedTo: "1.1.0",
        status: { plugins: [], updateAvailable: false, checkedAt: 2 },
      },
    }));
    const onpluginapplied = vi.fn();
    render(SettingsPluginsPanel, {
      plugins: [plugin()],
      updates: updSnapshot(),
      onpluginapplied,
    });
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect.element(page.getByText("Updated to v1.1.0 — now running.")).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!)).toEqual({ id: "p1" });
    await vi.waitFor(() => expect(onpluginapplied).toHaveBeenCalled());
    // A live update owes no restart.
    expect(document.body.textContent).not.toContain("systemctl --user restart shepherd");
  });

  it("inline apply on a running plugin surfaces the restart note + banner", async () => {
    stubApply([inst({ loaded: true })], () => ({
      payload: {
        ok: true,
        restartRequired: true,
        updatedTo: "1.1.0",
        status: { plugins: [], updateAvailable: false, checkedAt: 2 },
      },
    }));
    render(SettingsPluginsPanel, {
      plugins: [plugin()],
      updates: updSnapshot(),
    });
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect.element(page.getByText(/Updated to v1\.1\.0\. Restart Shepherd/)).toBeVisible();
    await expect.element(page.getByText("systemctl --user restart shepherd")).toBeVisible();
  });

  it("a failed apply shows the mapped message AND the server detail", async () => {
    stubApply([inst({ loaded: true })], () => ({
      payload: { error: "update_failed", detail: "not a fast-forward" },
      status: 400,
    }));
    render(SettingsPluginsPanel, {
      plugins: [plugin()],
      updates: updSnapshot(),
    });
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect.element(page.getByText("Update failed.")).toBeVisible();
    // The verbatim server diagnostic — a generic message alone is undebuggable.
    await expect.element(page.getByText("not a fast-forward")).toBeVisible();
  });

  it("Check now posts to /api/plugin-update/check and shows a busy state mid-flight", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    let checkCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/plugin-update/check")) {
        expect(init?.method).toBe("POST");
        checkCalls++;
        await gate;
        return new Response(JSON.stringify(updSnapshot()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/plugins/manage/installed")) {
        return new Response(JSON.stringify({ installed: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    render(SettingsPluginsPanel, { plugins: [] });

    await page.getByRole("button", { name: "Check for updates" }).click();
    // Mid-flight the button flips to the busy label and is disabled (no double-fire).
    await expect.element(page.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(checkCalls).toBe(1);
    resolve();
    // Back to idle once the check resolves (rows refresh via the status broadcast).
    await expect.element(page.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("a failed manual check surfaces an error line", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/plugin-update/check")) {
        return new Response("{}", { status: 503 });
      }
      if (url.includes("/api/plugins/manage/installed")) {
        return new Response(JSON.stringify({ installed: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    render(SettingsPluginsPanel, { plugins: [] });
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect.element(page.getByText("Update check failed.")).toBeVisible();
  });

  it("shows the last-checked time from the snapshot", async () => {
    stubScan([]);
    render(SettingsPluginsPanel, { plugins: [], updates: updSnapshot() });
    // Locale-dependent rendering — assert the stable message prefix.
    await expect.element(page.getByText(/last checked/)).toBeVisible();
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
