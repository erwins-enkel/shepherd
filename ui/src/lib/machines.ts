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
};

/** A capability a newer server might add reads as its raw id. */
const capabilityLabel = (id: string) => CAPABILITY[id]?.() ?? id;

/** Names of the capabilities the machine verified, in vocabulary order. */
export function availableCapabilities(report: CapabilityReport): string[] {
  return report.checks.filter((c) => c.ok).map((c) => capabilityLabel(c.id));
}

/** "Codex (not logged in)" per unavailable capability. Entries that belong to another platform
 *  (Xcode on Linux) are left out: they are not missing, just not there. */
export function missingCapabilities(report: CapabilityReport): string[] {
  return report.checks
    .filter((c) => !c.ok && c.reason !== "other_platform")
    .map((c) => {
      const reason = c.reason ? (CAPABILITY_REASON[c.reason]?.() ?? c.reason) : "";
      return reason ? `${capabilityLabel(c.id)} (${reason})` : capabilityLabel(c.id);
    });
}
