import { afterEach, describe, expect, test } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import { isUnconfirmed, reduceRemoteDispatches, resolvedMessage } from "./remote-dispatches";
import { HerdStore } from "./store.svelte";
import { toasts } from "./toasts.svelte";
import type { RemoteDispatch } from "./types";

const HOST = { instanceId: "m1", name: "MacBook", platform: "macos" };
const d = (id: string, state: RemoteDispatch["state"], over: Partial<RemoteDispatch> = {}) =>
  ({ id, state, host: HOST, summary: "port it", createdAt: 1, updatedAt: 1, ...over }) as const;

afterEach(() => {
  toasts.items = [];
});

describe("remote dispatches (#2774)", () => {
  test("only an unknown start or a pending cancel is shown", () => {
    expect(isUnconfirmed(d("a", "unknown"))).toBe(true);
    expect(isUnconfirmed(d("a", "canceling"))).toBe(true);
    for (const state of ["sending", "started", "held", "rejected", "canceled"] as const) {
      expect(isUnconfirmed(d("a", state))).toBe(false);
    }
  });

  test("an unconfirmed one is added or replaced; a settled one that was shown resolves", () => {
    let r = reduceRemoteDispatches([], d("a", "unknown"));
    expect(r).toEqual({ list: [d("a", "unknown")], resolved: null });
    r = reduceRemoteDispatches(r.list, d("a", "canceling"));
    expect(r.list).toEqual([d("a", "canceling")]);
    const started = d("a", "started", { sessionId: "s-1" });
    expect(reduceRemoteDispatches(r.list, started)).toEqual({ list: [], resolved: started });
  });

  test("a settled one that was not shown changes nothing", () => {
    const shown = [d("a", "unknown")];
    expect(reduceRemoteDispatches(shown, d("b", "started"))).toEqual({
      list: shown,
      resolved: null,
    });
  });

  test("how it ended is said with the machine; one that did not start is an alert", () => {
    expect(resolvedMessage(d("a", "started"))).toEqual({
      text: m.toast_dispatch_started_on({ machine: "MacBook" }),
      alert: false,
    });
    expect(resolvedMessage(d("a", "held"))?.alert).toBe(false);
    expect(resolvedMessage(d("a", "canceled"))?.alert).toBe(false);
    expect(resolvedMessage(d("a", "rejected", { reason: "restarted" }))).toEqual({
      text: m.toast_dispatch_declined_on({ machine: "MacBook", reason: "restarted" }),
      alert: true,
    });
    expect(resolvedMessage(d("a", "unknown"))).toBeNull();
  });

  test("the store goes from unknown to running: the row leaves and a toast says where", () => {
    const store = new HerdStore();
    store.setRemoteDispatches([d("a", "unknown")]);
    store.apply({ event: "remote:dispatch", data: d("b", "unknown") });
    expect(store.remoteDispatches.map((x) => x.id)).toEqual(["a", "b"]);

    store.apply({ event: "remote:dispatch", data: d("a", "started", { sessionId: "s-1" }) });
    expect(store.remoteDispatches.map((x) => x.id)).toEqual(["b"]);
    expect(toasts.items.map((t) => t.text)).toEqual([
      m.toast_dispatch_started_on({ machine: "MacBook" }),
    ]);
    // Not about a local session: nothing local changed.
    expect(store.sessions).toEqual([]);
    expect(store.remoteSessions).toEqual([]);
  });
});
