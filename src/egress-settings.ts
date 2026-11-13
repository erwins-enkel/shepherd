/**
 * Global egress settings: the standard allowed hosts repos opt into, and the muted hosts the
 * firewall still blocks but never reports. Single source for the setting keys, the seeded mute
 * defaults and how a repo's `egressIncludeStandard` resolves.
 */

import { hostMatchesAllowlist, normalizeEgressEntry } from "./egress";

export const EGRESS_STANDARD_HOSTS_SETTING = "egressStandardHosts";
export const EGRESS_STANDARD_DEFAULT_SETTING = "egressStandardDefault";
export const EGRESS_MUTED_HOSTS_SETTING = "egressMutedHosts";

/** How a repo uses the standard allowed hosts: follow the global default, or pin on/off. */
export type EgressIncludeStandard = "inherit" | "on" | "off";
export const EGRESS_INCLUDE_STANDARD_VALUES: readonly EgressIncludeStandard[] = [
  "inherit",
  "on",
  "off",
];

export function isEgressIncludeStandard(v: unknown): v is EgressIncludeStandard {
  return typeof v === "string" && (EGRESS_INCLUDE_STANDARD_VALUES as readonly string[]).includes(v);
}

/** Telemetry hosts muted out of the box; replaced by the operator's list once they edit it. */
export const EGRESS_MUTED_DEFAULTS: readonly string[] = [
  "*.datadoghq.com",
  "*.datadoghq.eu",
  "browser-intake-datadoghq.com",
  "browser-intake-us3-datadoghq.com",
  "browser-intake-us5-datadoghq.com",
  "browser-intake-ap1-datadoghq.com",
  "browser-intake-datadoghq.eu",
  "ph.varlock.dev",
  "telemetry.vercel.com",
];

export interface EgressGlobals {
  standardHosts: string[];
  standardDefault: boolean;
  mutedHosts: string[];
}

/** A muted entry: `[*.]host`, no port (a mute is about names, not ports). Null to reject. */
export function normalizeMutedEntry(raw: string): string | null {
  return raw.includes(":") ? null : normalizeEgressEntry(raw);
}

function parseList(raw: string | null, normalize: (h: string) => string | null): string[] | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v.flatMap((h) => {
      const n = typeof h === "string" ? normalize(h) : null;
      return n === null ? [] : [n];
    });
  } catch {
    return null;
  }
}

/** The effective global egress settings; absent or unreadable values fall back to defaults. */
export function readEgressGlobals(store: {
  getSetting(key: string): string | null;
}): EgressGlobals {
  return {
    standardHosts:
      parseList(store.getSetting(EGRESS_STANDARD_HOSTS_SETTING), normalizeEgressEntry) ?? [],
    standardDefault: store.getSetting(EGRESS_STANDARD_DEFAULT_SETTING) === "1",
    mutedHosts: parseList(store.getSetting(EGRESS_MUTED_HOSTS_SETTING), normalizeMutedEntry) ?? [
      ...EGRESS_MUTED_DEFAULTS,
    ],
  };
}

/** Whether a repo with `mode` includes the standard hosts under `globals`. */
function includesStandard(
  mode: EgressIncludeStandard | undefined,
  globals: Pick<EgressGlobals, "standardDefault">,
): boolean {
  return mode === "on" || ((mode ?? "inherit") === "inherit" && globals.standardDefault);
}

/** The standard hosts a repo with `mode` adds to its egress allowlist. */
export function standardHostsFor(
  mode: EgressIncludeStandard | undefined,
  globals: Pick<EgressGlobals, "standardDefault" | "standardHosts">,
): string[] {
  return includesStandard(mode, globals) ? globals.standardHosts : [];
}

/** Whether a blocked `host` is muted (still blocked, never reported). */
export function isEgressMuted(host: string, mutedHosts: string[]): boolean {
  return hostMatchesAllowlist(host, mutedHosts);
}
