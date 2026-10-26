import { afterEach, expect, test, vi } from "vitest";
import { toasts } from "./toasts.svelte";
import { m } from "#lib/paraglide/messages.js";
import { clearOfflineNotice, showOfflineNotice } from "./offline-notice";

afterEach(() => {
  clearOfflineNotice();
  for (const t of [...toasts.items]) toasts.close(t.id);
});

test("one sticky alert toast with reason + Retry, deduped across failed attempts", () => {
  const retry = vi.fn();
  showOfflineNotice(0, retry);
  showOfflineNotice(0, retry);
  expect(toasts.items).toHaveLength(1);
  const t = toasts.items[0]!;
  expect(t.text).toBe(m.conn_offline_title());
  expect(t.alert).toBe(true);
  expect(t.durationMs).toBeUndefined();
  expect(t.actionLabel).toBe(m.conn_offline_retry());
  expect(t.detail?.reason).toContain(
    new Date(0).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  );
});

test("closed by the operator: a failed attempt does not bring it back", () => {
  showOfflineNotice(0, () => {});
  toasts.close(toasts.items[0]!.id);
  showOfflineNotice(0, () => {});
  expect(toasts.items).toHaveLength(0);
});

test("Retry reconnects; if that attempt fails the notice comes back", () => {
  const retry = vi.fn();
  showOfflineNotice(0, retry);
  toasts.act(toasts.items[0]!.id);
  expect(retry).toHaveBeenCalledOnce();
  expect(toasts.items).toHaveLength(0);
  showOfflineNotice(0, retry);
  expect(toasts.items).toHaveLength(1);
  showOfflineNotice(0, retry); // later backoff failures: no churn
  expect(toasts.items).toHaveLength(1);
});

test("clear: dismisses and confirms once; silent when never shown", () => {
  clearOfflineNotice();
  expect(toasts.items).toHaveLength(0);
  showOfflineNotice(0, () => {});
  clearOfflineNotice();
  expect(toasts.items.map((t) => t.text)).toEqual([m.conn_back_online()]);
  clearOfflineNotice();
  expect(toasts.items).toHaveLength(1);
});
