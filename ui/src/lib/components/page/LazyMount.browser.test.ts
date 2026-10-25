import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { toasts } from "#lib/toasts.svelte.js";
import { m } from "#lib/paraglide/messages.js";
import LazyMountHarness from "./LazyMountHarness.svelte";
import LazyMountProbe from "./LazyMountProbe.svelte";

const updated = vi.hoisted(() => ({ current: false, check: async () => false }));
vi.mock("$app/state", () => ({ updated }));

afterEach(() => {
  toasts.items = [];
  updated.current = false;
});

describe("LazyMount", () => {
  it("renders the loaded component with its props", async () => {
    render(LazyMountHarness, {
      load: () => Promise.resolve({ default: LazyMountProbe }),
    });
    await expect.element(page.getByTestId("lazy-probe")).toHaveTextContent("loaded");
  });

  it("renders nothing, raises one sticky Reload toast and reports the failure", async () => {
    const failed = Promise.reject(new Error("Failed to fetch dynamically imported module"));
    const onerror = vi.fn();
    render(LazyMountHarness, { load: () => failed, onerror });
    await expect.poll(() => toasts.items.length).toBe(1);
    expect(onerror).toHaveBeenCalledOnce();
    // Sticky: no countdown, so the recovery action can't time out.
    expect(toasts.items[0]?.durationMs).toBeUndefined();
    expect(toasts.items[0]?.text).toBe(m.lazy_load_failed());
    expect(toasts.items[0]?.actionLabel).toBe(m.viewport_browser_reload());
    expect(document.querySelector("[data-testid=lazy-probe]")).toBeNull();
  });

  it("offers the update reload instead when a newer build is live", async () => {
    updated.current = true;
    const failed = Promise.reject(new Error("Failed to fetch dynamically imported module"));
    const onerror = vi.fn();
    render(LazyMountHarness, { load: () => failed, onerror });
    await expect.poll(() => toasts.items.length).toBe(1);
    expect(onerror).toHaveBeenCalledOnce();
    expect(toasts.items[0]?.text).toBe(m.app_updated());
    expect(toasts.items[0]?.actionLabel).toBe(m.viewport_browser_reload());
  });
});
