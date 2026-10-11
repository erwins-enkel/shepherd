import { m } from "#lib/paraglide/messages.js";
import type { RemoteInstanceStatus } from "#lib/types.js";

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
