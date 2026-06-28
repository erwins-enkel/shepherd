import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { tick } from "svelte";
import "../../app.css";
import PluginUIRoot from "./PluginUIRoot.svelte";
import PuiActionButton from "./PuiActionButton.svelte";
import type { PluginUINode } from "$lib/types";

/** Mount an action-button inside its PluginUIRoot wrapper (so the plugin-id context is set,
 *  exactly as the Settings panel mounts it) and resolve it through the live registry. */
function renderInPlugin(pluginId: string, props: Record<string, unknown>) {
  const node: PluginUINode = { type: "stack", children: [{ type: "action-button", props }] };
  return render(PluginUIRoot, { pluginId, node });
}

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => impl(url as string, init));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const ROUTE = { method: "POST", path: "switch-primary" };

describe("PuiActionButton", () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch(() => new Response("ok", { status: 200 }));
  });

  it("renders the label", async () => {
    const { container } = renderInPlugin("acct", { label: "Make primary", route: ROUTE });
    const btn = container.querySelector(".pui-action") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent?.trim()).toBe("Make primary");
    expect(btn.disabled).toBe(false);
  });

  it("click (no confirm) POSTs the body to the plugin's own namespaced route", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mockFetch((url, init) => {
      calls.push({ url, init });
      return new Response("switched", { status: 200 });
    });
    const body = { mode: "specific", account: 2 };
    const { container } = renderInPlugin("acct", { label: "Make primary", route: ROUTE, body });
    (container.querySelector(".pui-action") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/plugins/acct/switch-primary");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe(JSON.stringify(body));
  });

  it("with confirm set, a click opens a dialog and only Confirm fires the POST", async () => {
    const fetchFn = mockFetch(() => new Response("ok", { status: 200 }));
    const { container } = renderInPlugin("acct", {
      label: "Make primary",
      route: ROUTE,
      confirm: "Switch the primary account?",
    });
    // First click opens the confirm dialog — no fetch yet.
    (container.querySelector(".pui-action") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(container.querySelector(".card")).toBeTruthy());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(container.querySelector(".card .desc")?.textContent).toBe("Switch the primary account?");

    // Cancel closes the dialog without firing.
    (container.querySelector(".card .actions .gbtn:not(.primary)") as HTMLButtonElement).click();
    await tick();
    expect(container.querySelector(".card")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();

    // Re-open and Confirm fires the POST.
    (container.querySelector(".pui-action") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(container.querySelector(".card .primary")).toBeTruthy());
    (container.querySelector(".card .primary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  });

  it("a failed POST does not throw and re-enables the button", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const { container } = renderInPlugin("acct", { label: "Go", route: ROUTE });
    const btn = container.querySelector(".pui-action") as HTMLButtonElement;
    btn.click();
    // Button disables while in flight, then re-enables after the (rejected) request settles.
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("an unsafe route path renders disabled and never fetches", async () => {
    const fetchFn = mockFetch(() => new Response("ok", { status: 200 }));
    const { container } = renderInPlugin("acct", {
      label: "Escape",
      route: { method: "POST", path: "../../etc" },
    });
    const btn = container.querySelector(".pui-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    await tick();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("without a plugin-id context (bare mount) renders disabled and never fetches", async () => {
    const fetchFn = mockFetch(() => new Response("ok", { status: 200 }));
    // Rendered directly, NOT via PluginUIRoot — no context.
    const { container } = render(PuiActionButton, {
      node: { type: "action-button", props: { label: "Orphan", route: ROUTE } },
    });
    const btn = container.querySelector(".pui-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    await tick();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
