import { afterEach, describe, expect, test } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import {
  dispatchDetail,
  dispatchLabel,
  isShown,
  offlineLabel,
  redirectLabel,
  reduceRemoteDispatches,
  resolvedMessage,
} from "./remote-dispatches";
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
  test("an unknown start, a pending cancel, a wait and a hold there are shown (#2775)", () => {
    for (const state of ["unknown", "canceling", "waiting", "held"] as const) {
      expect(isShown(d("a", state))).toBe(true);
    }
    for (const state of ["sending", "started", "rejected", "canceled", "redirected"] as const) {
      expect(isShown(d("a", state))).toBe(false);
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
    // Taken to run here: its session shows up, nothing to say.
    expect(resolvedMessage(d("a", "redirected"))).toBeNull();
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

describe("the four states a task for a machine can wait in (#2775)", () => {
  const placement = {
    mode: "auto" as const,
    target: HOST,
    requirements: ["xcode"],
    basis: "requirements" as const,
    preferred: null,
    by: { instanceId: "here", name: "moes-tavern" },
    decidedAt: 1,
  };
  const offline = d("a", "waiting", {
    placement,
    readiness: { state: "offline", status: "timeout" },
    alternatives: [],
  });
  const blocked = d("a", "waiting", {
    placement,
    readiness: {
      state: "missing_capabilities",
      missing: [{ capability: "xcode", reason: "license_not_accepted" }],
    },
  });

  test("offline, busy, missing capability and unknown each read differently", () => {
    const labels = [offline, d("a", "held"), blocked, d("a", "unknown")].map(dispatchLabel);
    expect(labels).toEqual([
      m.remote_dispatch_waiting(),
      m.remote_dispatch_held(),
      m.remote_dispatch_blocked(),
      m.remote_dispatch_unknown(),
    ]);
    expect(new Set(labels).size).toBe(4);
  });

  test("the detail says what it needs, what the machine lacks, or that the machine holds it", () => {
    expect(dispatchDetail(offline)).toBe(m.placement_basis_requirements({ list: "Xcode" }));
    expect(dispatchDetail(blocked)).toBe(
      m.remote_dispatch_missing_detail({
        list: `Xcode (${m.settings_machines_cap_reason_license_not_accepted()})`,
      }),
    );
    expect(dispatchDetail(d("a", "held"))).toBe(m.remote_dispatch_held_detail());
    expect(dispatchDetail(d("a", "waiting", { readiness: { state: "project_missing" } }))).toBe(
      m.remote_dispatch_project_detail(),
    );
    expect(dispatchDetail(d("a", "unknown"))).toBeNull();
  });

  test("an unreachable machine reads as unreachable; a token problem says so", () => {
    expect(offlineLabel("timeout")).toBe(m.settings_machines_status_unreachable());
    expect(offlineLabel("unauthorized")).toBe(m.settings_machines_status_unauthorized());
  });

  test("this Shepherd is 'Run here', another machine is named", () => {
    expect(
      redirectLabel(offline, { instanceId: "here", name: "moes-tavern", platform: "linux" }),
    ).toBe(m.remote_dispatch_run_here());
    expect(redirectLabel(offline, { instanceId: "box", name: "Box", platform: "linux" })).toBe(
      m.remote_dispatch_run_on({ machine: "Box" }),
    );
  });
});
