import { describe, expect, it } from "vitest";
import { unresolvedFixKey } from "./diagnostics-copy";

// The unresolved-toast copy used to be selected by an inline if/else inside SettingsDiagnosePanel,
// which has no test of any kind — so every branch here (including the pre-existing host_capacity
// one) was uncovered. Extracting the selection is what makes these assertions possible.
describe("unresolvedFixKey", () => {
  it("host_capacity gets its take-effect wording", () => {
    expect(unresolvedFixKey({ fixActionKey: "diagnostics_fix_action_host_capacity" })).toBe(
      "diagnostics_fix_unresolved_host_capacity",
    );
  });

  it("tmp_inodes gets its own copy, never the generic 'restart Claude Code' one", () => {
    // Load-bearing: a SUCCESSFUL forced sweep commonly leaves this row non-ok, because the largest
    // consumers aren't reclaimed yet. Falling through to the code copy would tell the operator to
    // restart Claude Code on what is the expected outcome.
    const key = unresolvedFixKey({ fixActionKey: "diagnostics_fix_action_tmp_inodes" });
    expect(key).toBe("diagnostics_fix_unresolved_tmp_inodes");
    expect(key).not.toBe("diagnostics_fix_unresolved_code");
  });

  it("any other code fix falls back to the code copy", () => {
    expect(unresolvedFixKey({ fixActionKey: "diagnostics_fix_action_claude_trust" })).toBe(
      "diagnostics_fix_unresolved_code",
    );
  });

  it("a shell remediation (no fixActionKey) gets the generic copy", () => {
    expect(unresolvedFixKey({})).toBe("diagnostics_fix_unresolved");
    expect(unresolvedFixKey(undefined)).toBe("diagnostics_fix_unresolved");
  });
});
