/**
 * Server-side source of truth for the persisted telemetry consent setting
 * value space.
 *
 * The setting space is: "unset" | "granted" | "denied".
 *   - "unset" (default) — user has not yet provided consent.
 *   - "granted" — user has explicitly granted telemetry consent.
 *   - "denied" — user has explicitly denied telemetry consent.
 */

export type TelemetryConsent = "unset" | "granted" | "denied";

export const TELEMETRY_CONSENTS: readonly TelemetryConsent[] = [
  "unset",
  "granted",
  "denied",
] as const;

export function isTelemetryConsent(v: unknown): v is TelemetryConsent {
  return typeof v === "string" && (TELEMETRY_CONSENTS as readonly string[]).includes(v);
}

/**
 * Normalize an arbitrary value (env var, DB row, request body) to a valid
 * TelemetryConsent, or null if unrecognised / wrong type.
 */
export function normalizeTelemetryConsent(value: unknown): TelemetryConsent | null {
  return isTelemetryConsent(value) ? value : null;
}
