import { test, expect, vi, beforeEach, afterEach } from "vitest";

// Exercises the singleton against a real DOM: the constructor's initial
// getComputedStyle read and the MutationObserver pickup of the inline-style
// writes the app.html Dynamic Type probe performs. The module is re-imported
// fresh per test (vi.resetModules) so each case gets its own constructor run.

async function freshStore() {
  vi.resetModules();
  return (await import("./ui-scale.svelte")).uiScale;
}

beforeEach(() => {
  document.documentElement.style.removeProperty("--ui-scale");
});

afterEach(() => {
  document.documentElement.style.removeProperty("--ui-scale");
});

test("defaults to 1 when --ui-scale is not set (probe never ran)", async () => {
  const uiScale = await freshStore();
  expect(uiScale.value).toBe(1);
});

test("reads a pre-existing inline value at construction (pre-paint probe ran first)", async () => {
  document.documentElement.style.setProperty("--ui-scale", "1.3");
  const uiScale = await freshStore();
  expect(uiScale.value).toBe(1.3);
});

test("tracks live probe updates via the style-attribute MutationObserver", async () => {
  const uiScale = await freshStore();
  expect(uiScale.value).toBe(1);
  document.documentElement.style.setProperty("--ui-scale", "1.25");
  await vi.waitFor(() => expect(uiScale.value).toBe(1.25));
  document.documentElement.style.setProperty("--ui-scale", "0.85");
  await vi.waitFor(() => expect(uiScale.value).toBe(0.85));
});

test("falls back to 1 on a removed or unparseable value", async () => {
  document.documentElement.style.setProperty("--ui-scale", "1.5");
  const uiScale = await freshStore();
  expect(uiScale.value).toBe(1.5);
  document.documentElement.style.removeProperty("--ui-scale");
  await vi.waitFor(() => expect(uiScale.value).toBe(1));
  document.documentElement.style.setProperty("--ui-scale", "garbage");
  // stays 1 (NaN → fallback); waitFor still applies — the observer fires async
  await vi.waitFor(() => expect(uiScale.value).toBe(1));
  document.documentElement.style.setProperty("--ui-scale", "-2");
  await vi.waitFor(() => expect(uiScale.value).toBe(1));
});
