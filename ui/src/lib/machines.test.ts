import { describe, expect, it } from "vitest";
import {
  connectErrorMessage,
  machineHint,
  machineStatusLabel,
  machineStatusTone,
  platformLabel,
} from "./machines";
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

  it("platform names", () => {
    expect(platformLabel("macos")).toBe(m.settings_machines_platform_macos());
    expect(platformLabel("freebsd")).toBe("freebsd");
  });
});
