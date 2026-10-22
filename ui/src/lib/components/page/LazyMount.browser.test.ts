import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { toasts } from "#lib/toasts.svelte.js";
import { m } from "#lib/paraglide/messages.js";
import LazyMountHarness from "./LazyMountHarness.svelte";
import LazyMountProbe from "./LazyMountProbe.svelte";

afterEach(() => {
  toasts.items = [];
});

describe("LazyMount", () => {
  it("renders the loaded component with its props", async () => {
    render(LazyMountHarness, {
      load: () => Promise.resolve({ default: LazyMountProbe }),
    });
    await expect.element(page.getByTestId("lazy-probe")).toHaveTextContent("loaded");
  });

  it("renders nothing and raises one Reload toast when the chunk fails", async () => {
    const failed = Promise.reject(new Error("Failed to fetch dynamically imported module"));
    render(LazyMountHarness, { load: () => failed });
    await expect.poll(() => toasts.items.length).toBe(1);
    expect(toasts.items[0]?.text).toBe(m.lazy_load_failed());
    expect(toasts.items[0]?.actionLabel).toBe(m.viewport_browser_reload());
    expect(document.querySelector("[data-testid=lazy-probe]")).toBeNull();
  });
});
