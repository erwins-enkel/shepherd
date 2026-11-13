import { afterEach, expect, test, vi } from "vitest";
import { toasts } from "./toasts.svelte";
import { m } from "#lib/paraglide/messages.js";
import { clearOfflineNotice, showOfflineNotice } from "./offline-notice";

afterEach(() => {
  clearOfflineNotice();
  for (const t of [...toasts.items]) toasts.close(t.id);
});

test("reconnecting: one sticky polite toast without a button, no churn on repeats", () => {
  showOfflineNotice("reconnecting", 0, () => {});
  showOfflineNotice("reconnecting", 0, () => {});
  expect(toasts.items).toHaveLength(1);
  const t = toasts.items[0]!;
  expect(t.text).toBe(m.conn_reconnecting_title());
  expect(t.alert).toBeFalsy();
  expect(t.durationMs).toBeUndefined();
  expect(t.actionLabel).toBeUndefined();
});

test("unreachable: the same toast turns into a sticky alert with reason + Retry", () => {
  const retry = vi.fn();
  showOfflineNotice("reconnecting", 0, retry);
  showOfflineNotice("unreachable", 0, retry);
  showOfflineNotice("unreachable", 0, retry);
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

test("closing silences only the current phase", () => {
  showOfflineNotice("reconnecting", 0, () => {});
  toasts.close(toasts.items[0]!.id);
  showOfflineNotice("reconnecting", 0, () => {});
  expect(toasts.items).toHaveLength(0);
  showOfflineNotice("unreachable", 0, () => {});
  expect(toasts.items.map((t) => t.text)).toEqual([m.conn_offline_title()]);
  toasts.close(toasts.items[0]!.id);
  showOfflineNotice("unreachable", 0, () => {});
  expect(toasts.items).toHaveLength(0);
});

test("Retry reconnects; the notice comes back as reconnecting, then unreachable if it fails", () => {
  const retry = vi.fn();
  showOfflineNotice("unreachable", 0, retry);
  toasts.act(toasts.items[0]!.id);
  expect(retry).toHaveBeenCalledOnce();
  expect(toasts.items).toHaveLength(0);
  showOfflineNotice("reconnecting", 0, retry);
  expect(toasts.items.map((t) => t.text)).toEqual([m.conn_reconnecting_title()]);
  showOfflineNotice("unreachable", 0, retry);
  expect(toasts.items.map((t) => t.text)).toEqual([m.conn_offline_title()]);
});

test("clear: dismisses and confirms once; silent when never shown", () => {
  clearOfflineNotice();
  expect(toasts.items).toHaveLength(0);
  showOfflineNotice("reconnecting", 0, () => {});
  clearOfflineNotice();
  expect(toasts.items.map((t) => t.text)).toEqual([m.conn_back_online()]);
  clearOfflineNotice();
  expect(toasts.items).toHaveLength(1);
});
