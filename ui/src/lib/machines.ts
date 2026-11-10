import { formatReadAt } from "#lib/components/heavy-slot/heavy-slot.js";
import { m } from "#lib/paraglide/messages.js";
import type { CapabilityReport, RemoteInstanceStatus } from "#lib/types.js";

// Copy for Settings → Machines (#2759). The server reports machine codes (status, reason, connect
// error); this module is the one place they become words, so the panel, its rows and the connect
// form cannot drift apart.

const STATUS_LABEL: Record<RemoteInstanceStatus, () => string> = {
  checking: m.settings_machines_status_checking,
  connected: m.settings_machines_status_connected,
  unreachable: m.settings_machines_status_unreachable,
  unauthorized: m.settings_machines_status_unauthorized,
  incompatible: m.settings_machines_status_incompatible,
  identity_mismatch: m.settings_machines_status_identity_mismatch,
};

/** What the operator should know or do, per reason code. */
const REASON_HINT: Record<string, () => string> = {
  timeout: m.settings_machines_hint_timeout,
  network: m.settings_machines_hint_network,
  redirect: m.settings_machines_hint_redirect,
  bad_response: m.settings_machines_hint_bad_response,
  token_rejected: m.settings_machines_hint_token_rejected,
  token_scope: m.settings_machines_hint_token_scope,
  token_restricted: m.settings_machines_hint_token_restricted,
  api_missing: m.settings_machines_hint_api_missing,
  api_version: m.settings_machines_hint_api_version,
  not_shepherd: m.settings_machines_hint_not_shepherd,
  battery_pause: m.settings_machines_hint_battery_pause,
};

const CONNECT_ERROR: Record<string, () => string> = {
  invalid_url: m.settings_machines_error_invalid_url,
  invalid_token: m.settings_machines_error_invalid_token,
  invalid_label: m.settings_machines_error_invalid_label,
  self_connection: m.settings_machines_error_self_connection,
  already_connected: m.settings_machines_error_already_connected,
};

const PLATFORM: Record<string, () => string> = {
  linux: m.settings_machines_platform_linux,
  macos: m.settings_machines_platform_macos,
  windows: m.settings_machines_platform_windows,
};

/** A status a newer server might add reads as its raw code rather than breaking the row. */
export function machineStatusLabel(status: string): string {
  return STATUS_LABEL[status as RemoteInstanceStatus]?.() ?? status;
}

/** Badge colour family: connected is live, unreachable may heal itself, the rest need you. */
export function machineStatusTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (status === "connected") return "ok";
  if (status === "unreachable") return "warn";
  if (status === "checking") return "idle";
  return "bad";
}

/** Enough of a machine to say how it stands (a `RemoteInstance` or a `MachineUpdate`). */
interface MachineState {
  status: string;
  reason?: string | null;
  batteryPauseSince?: number | null;
}

/** Out of reach because its Mac app paused it on battery — on purpose, and it comes back. */
export const batteryPaused = (machine: MachineState): boolean =>
  machine.status === "unreachable" && machine.reason === "battery_pause";

/** How a machine stands, in words: its status, or "Battery pause · since 14:32" while paused. */
export function machineStateLabel(machine: MachineState): string {
  if (!batteryPaused(machine)) return machineStatusLabel(machine.status);
  return machine.batteryPauseSince != null
    ? m.settings_machines_battery_pause_since({ time: formatReadAt(machine.batteryPauseSince) })
    : m.settings_machines_status_battery_pause();
}

/** Badge colour family of `machineStateLabel`: a battery pause is quiet, nothing to fix. */
export function machineStateTone(machine: MachineState): "ok" | "warn" | "bad" | "idle" {
  return batteryPaused(machine) ? "idle" : machineStatusTone(machine.status);
}

/** The next step for a non-connected machine, or null when there is nothing to say. */
export function machineHint(status: string, reason: string | null): string | null {
  if (status === "identity_mismatch") return m.settings_machines_hint_identity_mismatch();
  return (reason && REASON_HINT[reason]?.()) || null;
}

/** Why a connect attempt was refused, in words. */
export function connectErrorMessage(error: string, reason: string | null): string {
  const direct = CONNECT_ERROR[error]?.();
  if (direct) return direct;
  if (error.startsWith("remote_")) {
    const status = error.slice("remote_".length);
    const hint = machineHint(status, reason);
    return hint ? `${machineStatusLabel(status)}: ${hint}` : machineStatusLabel(status);
  }
  return m.settings_machines_error_generic();
}

/** Proper names for the three modelled platforms; anything else shows as reported. */
export function platformLabel(platform: string): string {
  return PLATFORM[platform]?.() ?? platform;
}

// ── capabilities (#2770) ──

const CAPABILITY: Record<string, () => string> = {
  "platform:linux": m.settings_machines_platform_linux,
  "platform:macos": m.settings_machines_platform_macos,
  "platform:windows": m.settings_machines_platform_windows,
  xcode: m.settings_machines_cap_xcode,
  "sdk:macos": m.settings_machines_cap_sdk_macos,
  "sdk:ios": m.settings_machines_cap_sdk_ios,
  "ios-simulator": m.settings_machines_cap_ios_simulator,
  "android-sdk": m.settings_machines_cap_android_sdk,
  "agent:claude": m.settings_machines_cap_agent_claude,
  "agent:codex": m.settings_machines_cap_agent_codex,
  "sandbox:trusted": m.settings_machines_cap_sandbox_trusted,
  "sandbox:standard": m.settings_machines_cap_sandbox_standard,
  "sandbox:autonomous": m.settings_machines_cap_sandbox_autonomous,
};

const CAPABILITY_REASON: Record<string, () => string> = {
  not_installed: m.settings_machines_cap_reason_not_installed,
  not_logged_in: m.settings_machines_cap_reason_not_logged_in,
  timeout: m.settings_machines_cap_reason_timeout,
  probe_failed: m.settings_machines_cap_reason_probe_failed,
  not_probed: m.settings_machines_cap_reason_not_probed,
  sdk_not_found: m.settings_machines_cap_reason_sdk_not_found,
  sdk_incomplete: m.settings_machines_cap_reason_sdk_incomplete,
  no_backend: m.settings_machines_cap_reason_no_backend,
  no_egress: m.settings_machines_cap_reason_no_egress,
  license_not_accepted: m.settings_machines_cap_reason_license_not_accepted,
  command_line_tools_only: m.settings_machines_cap_reason_command_line_tools_only,
  no_simulator: m.settings_machines_cap_reason_no_simulator,
};

/** A capability a newer server might add reads as its raw id. */
export const capabilityLabel = (id: string) => CAPABILITY[id]?.() ?? id;

/** Why a capability is unavailable, in words; a code a newer server might add reads as itself.
 *  `not_verified` (#2772): no fresh report confirms it. */
export const capabilityReasonLabel = (reason: string) =>
  reason === "not_verified"
    ? m.settings_machines_cap_reason_not_verified()
    : (CAPABILITY_REASON[reason]?.() ?? reason);

/** Names of the capabilities the machine verified, in vocabulary order, each with the version the
 *  machine found ("Xcode 16.4 (16F6)") when it reported one. */
export function availableCapabilities(report: CapabilityReport): string[] {
  return report.checks
    .filter((c) => c.ok)
    .map((c) => (c.detail ? `${capabilityLabel(c.id)} ${c.detail}` : capabilityLabel(c.id)));
}

/** "Codex (not logged in)" per unavailable capability. Entries that belong to another platform
 *  (Xcode on Linux) are left out: they are not missing, just not there. */
export function missingCapabilities(report: CapabilityReport): string[] {
  return report.checks
    .filter((c) => !c.ok && c.reason !== "other_platform")
    .map((c) => {
      const reason = c.reason ? capabilityReasonLabel(c.reason) : "";
      return reason ? `${capabilityLabel(c.id)} (${reason})` : capabilityLabel(c.id);
    });
}
