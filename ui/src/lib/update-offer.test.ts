import { afterEach, expect, test, vi } from "vitest";
import { toasts } from "./toasts.svelte";
import { m } from "#lib/paraglide/messages.js";
import { checkForUpdate, offerUpdateReload } from "./update-offer";

const check = vi.fn();
vi.mock("$app/state", () => ({ updated: { current: false, check: () => check() } }));

afterEach(() => {
  for (const t of [...toasts.items]) toasts.close(t.id);
  check.mockReset();
});

test("offerUpdateReload: one sticky Reload toast, deduped", () => {
  offerUpdateReload();
  offerUpdateReload();
  expect(toasts.items).toHaveLength(1);
  expect(toasts.items[0]?.text).toBe(m.app_updated());
  expect(toasts.items[0]?.actionLabel).toBe(m.viewport_browser_reload());
  expect(toasts.items[0]?.durationMs).toBeUndefined();
});

test("checkForUpdate: swallows a failed version fetch", async () => {
  check.mockRejectedValue(new Error("offline"));
  expect(() => checkForUpdate()).not.toThrow();
  await Promise.resolve();
  expect(check).toHaveBeenCalledOnce();
});
