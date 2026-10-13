import { describe, expect, it } from "vitest";
import { ApiError, PlacementRefusedError } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import type { RemoteInstance } from "#lib/types.js";
import {
  connectedMachines,
  dispatchKeyFor,
  isUnansweredSend,
  keyedSend,
  machineLabel,
  pendingAfter,
  placementFailureMessage,
  runOnFailureMessage,
  runOnMachines,
} from "./run-on";

function machine(over: Partial<RemoteInstance> = {}): RemoteInstance {
  return {
    instanceId: "m1",
    name: "MacBook",
    label: null,
    reportedName: "MacBook",
    url: "http://mac.test",
    tokenHint: null,
    createdAt: 1,
    status: "connected",
    reason: null,
    checkedAt: 1,
    lastSeenAt: 1,
    info: { version: "2.2.0", federationApi: 1, platform: "macos", arch: "arm64" },
    projects: ["acme/app"],
    capabilities: null,
    released: true,
    ...over,
  };
}

describe("Run on machines (#2763)", () => {
  it("offers connected machines that have the project checked out", () => {
    const machines = [
      machine(),
      machine({ instanceId: "m2", projects: ["acme/other"] }),
      machine({ instanceId: "m3", status: "unreachable" }),
    ];
    expect(connectedMachines(machines).map((x) => x.instanceId)).toEqual(["m1", "m2"]);
    expect(runOnMachines(machines, "acme/app").map((x) => x.instanceId)).toEqual(["m1"]);
    expect(runOnMachines(machines, undefined)).toEqual([]);
    expect(runOnMachines([machine({ projects: null })], "acme/app")).toEqual([]);
  });

  it("never offers a machine whose platform is not released (Windows, #2770)", () => {
    const windows = machine({
      instanceId: "w1",
      info: { version: "2.2.0", federationApi: 1, platform: "windows", arch: "x64" },
      released: false,
    });
    expect(runOnMachines([windows, machine()], "acme/app").map((x) => x.instanceId)).toEqual([
      "m1",
    ]);
    expect(runOnMachines([windows], "acme/app")).toEqual([]);
    expect(connectedMachines([windows])).toEqual([]);
  });

  it("labels a machine with its platform once it is known", () => {
    expect(machineLabel(machine())).toBe("MacBook (macOS)");
    expect(machineLabel(machine({ info: null }))).toBe("MacBook");
  });
});

describe("dispatch keys (#2763)", () => {
  let n = 0;
  const fresh = () => `fresh-${++n}`;

  it("reuses an unanswered send's key only for the same task", () => {
    const pending = { key: "k1", payload: '{"prompt":"a"}' };
    expect(dispatchKeyFor(pending, '{"prompt":"a"}', fresh)).toBe("k1");
    expect(dispatchKeyFor(pending, '{"prompt":"b"}', fresh)).toMatch(/^fresh-/);
    expect(dispatchKeyFor(null, '{"prompt":"a"}', fresh)).toMatch(/^fresh-/);
  });

  it("treats no answer — from the machine or on the way here — as unanswered", () => {
    expect(isUnansweredSend(new ApiError(504, "x", "remote_dispatch_unknown", true))).toBe(true);
    expect(isUnansweredSend(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnansweredSend(new ApiError(422, "x", "remote_rejected", true))).toBe(false);
    expect(isUnansweredSend(new Error("x"))).toBe(false);
  });
});

describe("keyed sends (#2763, #2772)", () => {
  it("is null while the machine choice is not active: no key, as before", () => {
    expect(keyedSend(false, null, { prompt: "a" })).toBeNull();
  });

  it("keeps the key across attempts of the same task, whatever the spawn id", () => {
    const first = keyedSend(true, null, { prompt: "a", spawnId: "s1" })!;
    const pending = pendingAfter(first, new ApiError(504, "x", "remote_dispatch_unknown", true));
    const again = keyedSend(true, pending, { prompt: "a", spawnId: "s2" })!;
    expect(again.key).toBe(first.key);
    expect(keyedSend(true, pending, { prompt: "b", spawnId: "s3" })!.key).not.toBe(first.key);
  });

  it("forgets the key after an answered failure", () => {
    const send = keyedSend(true, null, { prompt: "a" })!;
    expect(pendingAfter(send, new ApiError(422, "x", "remote_rejected", true))).toBeNull();
    expect(pendingAfter(null, new TypeError("x"))).toBeNull();
  });
});

describe("placementFailureMessage (#2772)", () => {
  it("puts a refused machine choice into words, and leaves anything else alone", () => {
    const refusal = {
      code: "missing_capabilities",
      error: "MacBook is missing capabilities: xcode (not_installed)",
      host: { instanceId: "m1", name: "MacBook", platform: "macos" },
      missing: [{ capability: "xcode", reason: "not_installed" }],
    };
    const err = new PlacementRefusedError(
      new ApiError(422, refusal.error, "missing_capabilities", true),
      refusal,
    );
    expect(placementFailureMessage(err)).toBe(
      m.placement_refusal_missing({
        machine: "MacBook",
        list: `${m.settings_machines_cap_xcode()} (${m.settings_machines_cap_reason_not_installed()})`,
      }),
    );
    expect(placementFailureMessage(new ApiError(422, "x", "remote_rejected", true))).toBeNull();
  });
});

describe("runOnFailureMessage (#2763)", () => {
  it("names the machine and, for a refusal, its reason", () => {
    const err = (code: string, message = "x") => new ApiError(422, message, code, true);
    expect(runOnFailureMessage(err("remote_rejected", "base missing"), "MacBook")).toBe(
      m.newtask_runon_rejected({ machine: "MacBook", reason: "base missing" }),
    );
    expect(runOnFailureMessage(err("remote_dispatch_unknown"), "MacBook")).toBe(
      m.newtask_runon_unknown({ machine: "MacBook" }),
    );
    expect(runOnFailureMessage(err("remote_target_unavailable"), "MacBook")).toBe(
      m.newtask_runon_unavailable({ machine: "MacBook" }),
    );
    expect(runOnFailureMessage(err("remote_target_unreleased"), "MacBook")).toBe(
      m.newtask_runon_unreleased({ machine: "MacBook" }),
    );
    expect(runOnFailureMessage(err("remote_project_missing"), "MacBook")).toBe(
      m.newtask_runon_project_missing({ machine: "MacBook" }),
    );
    expect(runOnFailureMessage(err("remote_target_unknown"), "MacBook")).toBe(
      m.newtask_runon_gone({ machine: "MacBook" }),
    );
    expect(runOnFailureMessage(err("remote_project_unknown"), "MacBook")).toBe(
      m.newtask_runon_project_unknown(),
    );
  });

  // #2766: an attachment that did not reach the machine — nothing was started.
  it("names the machine and what failed when an attachment did not get there", () => {
    const err = new ApiError(
      502,
      "attachment 1 of 1: the machine answered 413",
      "remote_upload_failed",
      true,
    );
    expect(runOnFailureMessage(err, "MacBook")).toBe(
      m.newtask_runon_upload_failed({
        machine: "MacBook",
        reason: "attachment 1 of 1: the machine answered 413",
      }),
    );
  });

  it("leaves other failures to the dialog's generic message", () => {
    expect(
      runOnFailureMessage(new ApiError(409, "x", "spawn_canceled", true), "MacBook"),
    ).toBeNull();
    expect(runOnFailureMessage(new Error("x"), "MacBook")).toBeNull();
  });
});
