import { describe, expect, it } from "vitest";
import { ApiError } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import type { RemoteInstance } from "#lib/types.js";
import {
  connectedMachines,
  dispatchKeyFor,
  isUnansweredSend,
  machineLabel,
  machineSend,
  pendingAfter,
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

describe("machine sends (#2763)", () => {
  it("is null for a task that starts here", () => {
    expect(machineSend(null, null, { prompt: "a" })).toBeNull();
  });

  it("keeps the key across attempts of the same task, whatever the spawn id", () => {
    const first = machineSend(machine(), null, { prompt: "a", spawnId: "s1" })!;
    const pending = pendingAfter(first, new ApiError(504, "x", "remote_dispatch_unknown", true));
    const again = machineSend(machine(), pending, { prompt: "a", spawnId: "s2" })!;
    expect(again.key).toBe(first.key);
    expect(machineSend(machine(), pending, { prompt: "b", spawnId: "s3" })!.key).not.toBe(
      first.key,
    );
  });

  it("forgets the key after an answered failure", () => {
    const send = machineSend(machine(), null, { prompt: "a" })!;
    expect(pendingAfter(send, new ApiError(422, "x", "remote_rejected", true))).toBeNull();
    expect(pendingAfter(null, new TypeError("x"))).toBeNull();
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

  it("leaves other failures to the dialog's generic message", () => {
    expect(
      runOnFailureMessage(new ApiError(409, "x", "spawn_canceled", true), "MacBook"),
    ).toBeNull();
    expect(runOnFailureMessage(new Error("x"), "MacBook")).toBeNull();
  });
});
