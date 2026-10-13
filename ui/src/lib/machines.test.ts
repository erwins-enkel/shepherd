import { describe, expect, it } from "vitest";
import {
  availableCapabilities,
  connectErrorMessage,
  machineHint,
  machineStatusLabel,
  machineStatusTone,
  missingCapabilities,
  platformLabel,
} from "./machines";
import type { CapabilityCheck } from "./types";
import { m } from "#lib/paraglide/messages.js";

describe("machines copy", () => {
  it("labels every status distinctly and passes unknown ones through", () => {
    const statuses = [
      "checking",
      "connected",
      "unreachable",
      "unauthorized",
      "incompatible",
      "identity_mismatch",
    ];
    const labels = statuses.map(machineStatusLabel);
    expect(new Set(labels).size).toBe(statuses.length);
    expect(machineStatusLabel("brand_new")).toBe("brand_new");
  });

  it("tones: live, may heal, needs you", () => {
    expect(machineStatusTone("connected")).toBe("ok");
    expect(machineStatusTone("unreachable")).toBe("warn");
    expect(machineStatusTone("checking")).toBe("idle");
    for (const s of ["unauthorized", "incompatible", "identity_mismatch"]) {
      expect(machineStatusTone(s)).toBe("bad");
    }
  });

  it("hints name the next step per reason", () => {
    expect(machineHint("unauthorized", "token_restricted")).toBe(
      m.settings_machines_hint_token_restricted(),
    );
    expect(machineHint("identity_mismatch", null)).toBe(
      m.settings_machines_hint_identity_mismatch(),
    );
    expect(machineHint("connected", null)).toBeNull();
    expect(machineHint("unreachable", "unheard_of")).toBeNull();
  });

  it("connect errors map form codes directly and remote codes to status + hint", () => {
    expect(connectErrorMessage("self_connection", null)).toBe(
      m.settings_machines_error_self_connection(),
    );
    expect(connectErrorMessage("remote_unauthorized", "token_scope")).toBe(
      `${m.settings_machines_status_unauthorized()}: ${m.settings_machines_hint_token_scope()}`,
    );
    expect(connectErrorMessage("remote_unreachable", null)).toBe(
      m.settings_machines_status_unreachable(),
    );
    expect(connectErrorMessage("http_500", null)).toBe(m.settings_machines_error_generic());
  });

  it("capability chips carry the version the machine found; Xcode's reasons are named", () => {
    const report = (checks: CapabilityCheck[]) => ({
      vocabulary: 1,
      probedAt: 0,
      ageMs: 0,
      stale: false,
      checks,
    });
    expect(
      availableCapabilities(
        report([
          { id: "platform:macos", ok: true, reason: null, detail: "15.5 (24F74)" },
          { id: "xcode", ok: true, reason: null, detail: "16.4 (16F6)" },
          { id: "agent:claude", ok: true, reason: null },
        ]),
      ),
    ).toEqual([
      `${m.settings_machines_platform_macos()} 15.5 (24F74)`,
      `${m.settings_machines_cap_xcode()} 16.4 (16F6)`,
      m.settings_machines_cap_agent_claude(),
    ]);
    expect(
      missingCapabilities(
        report([
          { id: "xcode", ok: false, reason: "license_not_accepted", detail: "16.4 (16F6)" },
          { id: "sdk:ios", ok: false, reason: "command_line_tools_only" },
          { id: "ios-simulator", ok: false, reason: "no_simulator" },
        ]),
      ),
    ).toEqual([
      `${m.settings_machines_cap_xcode()} (${m.settings_machines_cap_reason_license_not_accepted()})`,
      `${m.settings_machines_cap_sdk_ios()} (${m.settings_machines_cap_reason_command_line_tools_only()})`,
      `${m.settings_machines_cap_ios_simulator()} (${m.settings_machines_cap_reason_no_simulator()})`,
    ]);
  });

  it("platform names", () => {
    expect(platformLabel("macos")).toBe(m.settings_machines_platform_macos());
    expect(platformLabel("freebsd")).toBe("freebsd");
  });
});
