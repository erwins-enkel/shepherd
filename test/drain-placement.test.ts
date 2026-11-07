import { describe, expect, test } from "bun:test";
import {
  placementQuery,
  requirementsFromLabels,
  routeOf,
  type RouteInput,
} from "../src/drain-placement";
import type { Placement, PlacementDecision } from "../src/remote-instances/placement";

// Where a drain spawn runs: labels → requirements, when the machine choice is asked, and how its
// answer becomes a route or a hold.

const SELF = "b1111111-1111-4111-8111-111111111111";
const MAC = "a2222222-2222-4222-8222-222222222222";

const macHost = { instanceId: MAC, name: "macbook", platform: "macos" };
const selfHost = { instanceId: SELF, name: "moes-tavern", platform: "linux" };

function placed(target: Placement["target"]): Placement {
  return {
    mode: "auto",
    target,
    requirements: ["xcode"],
    basis: "requirements",
    preferred: null,
    by: { instanceId: SELF, name: "moes-tavern" },
    decidedAt: 1,
  };
}

const ctx = { selfId: SELF, stacked: false, machine: null };

describe("requirementsFromLabels", () => {
  test("requires-macos calls for Xcode, case-insensitively", () => {
    expect(requirementsFromLabels(["ios-app", "requires-macos"])).toEqual(["xcode"]);
    expect(requirementsFromLabels(["Requires-MacOS"])).toEqual(["xcode"]);
  });

  test("other labels call for nothing, duplicates collapse", () => {
    expect(requirementsFromLabels(["parity", "enhancement"])).toEqual([]);
    expect(requirementsFromLabels(["requires-macos", "requires-macos"])).toEqual(["xcode"]);
  });
});

describe("placementQuery", () => {
  const base: RouteInput = { requirements: [], machine: null, selfId: SELF, active: true };

  test("automatic without requirements runs here unasked", () => {
    expect(placementQuery(base)).toBeNull();
  });

  test("automatic with requirements asks the automatic choice", () => {
    expect(placementQuery({ ...base, requirements: ["xcode"] })).toEqual({ override: null });
  });

  test("with no other machine registered, requirements change nothing", () => {
    expect(placementQuery({ ...base, requirements: ["xcode"], active: false })).toBeNull();
  });

  test("a named machine is always asked for, even with none registered", () => {
    expect(placementQuery({ ...base, machine: MAC, active: false })).toEqual({ override: MAC });
  });

  test("this machine named: runs here without requirements, checked with them", () => {
    expect(placementQuery({ ...base, machine: SELF })).toBeNull();
    expect(placementQuery({ ...base, machine: SELF, requirements: ["xcode"] })).toEqual({
      override: SELF,
    });
  });
});

describe("routeOf", () => {
  test("placed here runs here", () => {
    expect(routeOf({ ok: true, placement: placed(selfHost) }, ctx)).toEqual({ kind: "here" });
  });

  test("placed on a connected machine goes there", () => {
    const placement = placed(macHost);
    expect(routeOf({ ok: true, placement }, ctx)).toEqual({ kind: "remote", placement });
  });

  test("placed on a machine out of reach holds, naming it", () => {
    const decision: PlacementDecision = {
      ok: true,
      placement: placed(macHost),
      wait: { status: "unreachable", alternatives: [] },
    };
    expect(routeOf(decision, ctx)).toEqual({
      kind: "hold",
      reason: { code: "machine_offline", detail: "macbook" },
    });
  });

  test("a stacked child does not leave this machine", () => {
    expect(routeOf({ ok: true, placement: placed(macHost) }, { ...ctx, stacked: true })).toEqual({
      kind: "hold",
      reason: { code: "machine_stacked", detail: "macbook" },
    });
  });

  test("no machine fits: holds with the missing requirements", () => {
    const decision: PlacementDecision = {
      ok: false,
      refusal: { code: "no_suitable_machine", missing: ["xcode"], together: false },
    };
    expect(routeOf(decision, ctx)).toEqual({
      kind: "hold",
      reason: { code: "no_suitable_machine", detail: "xcode" },
    });
  });

  test("the named machine lacks a capability: unfit, naming it", () => {
    const decision: PlacementDecision = {
      ok: false,
      refusal: {
        code: "missing_capabilities",
        host: selfHost,
        missing: [{ capability: "xcode", reason: "other_platform" }],
      },
    };
    expect(routeOf(decision, { ...ctx, machine: SELF })).toEqual({
      kind: "hold",
      reason: { code: "machine_unfit", detail: "moes-tavern" },
    });
  });

  test("the named machine is not connected: offline", () => {
    const decision: PlacementDecision = {
      ok: false,
      refusal: { code: "remote_target_unavailable", host: macHost, reason: "unreachable" },
    };
    expect(routeOf(decision, { ...ctx, machine: MAC })).toEqual({
      kind: "hold",
      reason: { code: "machine_offline", detail: "macbook" },
    });
  });

  test("an unknown named machine is unfit, named by its ID", () => {
    const decision: PlacementDecision = {
      ok: false,
      refusal: { code: "remote_target_unknown", host: null, reason: null },
    };
    expect(routeOf(decision, { ...ctx, machine: MAC })).toEqual({
      kind: "hold",
      reason: { code: "machine_unfit", detail: MAC },
    });
  });
});
