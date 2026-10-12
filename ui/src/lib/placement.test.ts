import { describe, expect, it } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import { capabilityList, placementReason, placementRefusalText } from "./placement";
import type { Placement } from "#lib/types.js";

// The automatic machine choice (#2772) in words: the reason a task runs where it runs, and why a
// create would be refused.

const mac = { instanceId: "m1", name: "MacBook", platform: "macos" };
const linux = { instanceId: "l1", name: "moes-tavern", platform: "linux" };

function placement(over: Partial<Placement> = {}): Placement {
  return {
    mode: "auto",
    target: linux,
    requirements: [],
    basis: "preference",
    preferred: "linux",
    by: { instanceId: "l1", name: "moes-tavern" },
    decidedAt: 1,
    ...over,
  };
}

describe("placementReason", () => {
  it("names what decided", () => {
    expect(placementReason(placement())).toBe(
      m.placement_basis_preference_none({ platform: m.settings_machines_platform_linux() }),
    );
    const xcode = placement({
      target: mac,
      requirements: ["platform:macos", "xcode"],
      basis: "requirements",
      preferred: null,
    });
    expect(placementReason(xcode)).toBe(
      m.placement_basis_requirements({ list: capabilityList(["platform:macos", "xcode"]) }),
    );
    expect(placementReason(placement({ requirements: ["agent:claude"] }))).toBe(
      m.placement_basis_preference({
        list: capabilityList(["agent:claude"]),
        platform: m.settings_machines_platform_linux(),
      }),
    );
    expect(placementReason(placement({ basis: "only_candidate", preferred: null }))).toBe(
      m.placement_basis_only(),
    );
    expect(placementReason(placement({ mode: "manual", basis: "manual", preferred: null }))).toBe(
      m.placement_basis_manual(),
    );
  });

  it("joins capabilities as a list in the UI's language", () => {
    expect(capabilityList(["xcode"])).toBe(m.settings_machines_cap_xcode());
    expect(capabilityList(["platform:macos", "xcode"])).toContain(m.settings_machines_cap_xcode());
  });
});

describe("placementRefusalText", () => {
  it("names the missing capability when no machine fits", () => {
    const base = { code: "no_suitable_machine", error: "x", together: false, elsewhere: [] };
    expect(placementRefusalText({ ...base, missing: ["xcode"] })).toBe(
      m.placement_refusal_none({ list: capabilityList(["xcode"]) }),
    );
    expect(
      placementRefusalText({ ...base, missing: ["platform:linux", "xcode"], together: true }),
    ).toBe(
      m.placement_refusal_none_together({ list: capabilityList(["platform:linux", "xcode"]) }),
    );
    expect(placementRefusalText({ ...base, missing: ["xcode"], elsewhere: [mac] })).toBe(
      `${m.placement_refusal_none({ list: capabilityList(["xcode"]) })} ${m.placement_refusal_elsewhere({ machines: "MacBook" })}`,
    );
  });

  it("explains an offline machine and offers the alternatives", () => {
    expect(
      placementRefusalText({
        code: "preferred_machine_offline",
        error: "x",
        host: mac,
        status: "timeout",
        alternatives: [linux],
      }),
    ).toBe(
      `${m.placement_refusal_offline({ machine: "MacBook" })} ${m.placement_refusal_alternatives({ machines: "moes-tavern" })}`,
    );
  });

  it("names what a named machine — or this one — lacks, and why", () => {
    const missing = [{ capability: "xcode", reason: "not_verified" }];
    const list = `${m.settings_machines_cap_xcode()} (${m.settings_machines_cap_reason_not_verified()})`;
    expect(
      placementRefusalText({ code: "missing_capabilities", error: "x", host: mac, missing }),
    ).toBe(m.placement_refusal_missing({ machine: "MacBook", list }));
    expect(placementRefusalText({ code: "missing_capabilities", error: "x", missing })).toBe(
      m.placement_refusal_missing_here({ list }),
    );
  });

  it("falls back to the server's sentence for a code it does not know", () => {
    expect(placementRefusalText({ code: "something_new", error: "the server says so" })).toBe(
      "the server says so",
    );
  });
});
