// Deterministic security-watch rules. Pure: normalization, grouping, filters, holds, eligibility.

import type {
  PluginCodeScanningAlert,
  PluginDependabotAlert,
  PluginRepoVisibility,
  PluginUntrustedSection,
} from "../../types";
import {
  groupKey,
  SEVERITIES,
  type AlertRecord,
  type GroupRecord,
  type RepoConfig,
  type Severity,
  type Source,
} from "./state";

/** Issues filed per repo per UTC day. */
export const DAILY_CAP = 3;
/** Triages started per poll: the agents are the costly step and capped per plugin. */
export const MAX_TRIAGES_PER_POLL = 3;
/** Dependabot's own security-update PR gets this long to appear before a fix is filed. */
const GRACE_MS = 24 * 60 * 60_000;

const NON_PRODUCTION = new Set(["test", "generated", "library", "documentation"]);
const TEXT_MAX = 1000;
const SECTION_BUDGET = 24_000;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toSeverity(v: string | null): Severity | null {
  return SEVERITIES.find((s) => s === v) ?? null;
}

/** Higher = worse; unknown severity sorts last. */
function severityRank(s: Severity | null): number {
  return s ? SEVERITIES.length - SEVERITIES.indexOf(s) : 0;
}

/** One group's share of a read, before it is folded into state. */
export type GroupRead = Pick<
  GroupRecord,
  "key" | "repo" | "source" | "subject" | "location" | "tool" | "description" | "openAlerts"
>;

function addToGroup(
  groups: Map<string, GroupRead>,
  head: Omit<GroupRead, "key" | "openAlerts">,
  alert: AlertRecord,
): void {
  const key = groupKey(head.repo, head.source, head.subject, head.location);
  const group = groups.get(key) ?? { ...head, key, openAlerts: [] };
  group.openAlerts.push(alert);
  groups.set(key, group);
}

/** Code scanning alerts by rule + file. */
export function groupCodeScanning(repo: string, alerts: PluginCodeScanningAlert[]): GroupRead[] {
  const groups = new Map<string, GroupRead>();
  for (const a of alerts) {
    addToGroup(
      groups,
      {
        repo,
        source: "cs",
        subject: a.ruleId,
        location: a.path,
        tool: a.tool,
        description: truncate(a.ruleDescription, TEXT_MAX),
      },
      {
        number: a.number,
        url: a.url,
        severity: toSeverity(a.securitySeverity),
        nonProduction: a.classifications.some((c) => NON_PRODUCTION.has(c)),
        createdAt: a.createdAt,
        patched: null,
        line: a.line,
        text: truncate(a.message, TEXT_MAX),
        ref: "",
        cwes: a.cwes,
      },
    );
  }
  return [...groups.values()];
}

/** Dependabot alerts by package + manifest. */
export function groupDependabot(repo: string, alerts: PluginDependabotAlert[]): GroupRead[] {
  const groups = new Map<string, GroupRead>();
  for (const a of alerts) {
    addToGroup(
      groups,
      {
        repo,
        source: "dep",
        subject: `${a.ecosystem}/${a.package}`,
        location: a.manifest,
        tool: "Dependabot",
        description: "",
      },
      {
        number: a.number,
        url: a.url,
        severity: toSeverity(a.severity),
        nonProduction: a.scope === "development",
        createdAt: a.createdAt,
        patched: a.patchedVersion,
        line: null,
        text: truncate(a.summary, TEXT_MAX),
        ref: a.ghsaId,
        cwes: a.cwes,
      },
    );
  }
  return [...groups.values()];
}

export type FilterReason = "no-severity" | "below-severity" | "non-production";
export type HoldReason = "grace" | "no-patch";

/** Operator filter: settings the operator chose. */
export function alertFilter(a: AlertRecord, cfg: RepoConfig): FilterReason | null {
  if (!a.severity) return "no-severity";
  if (severityRank(a.severity) < severityRank(cfg.minSeverity)) return "below-severity";
  if (a.nonProduction && !cfg.includeNonProduction) return "non-production";
  return null;
}

/** Hold: a temporary fact about the alert; it lifts by itself. */
export function alertHold(source: Source, a: AlertRecord, now: number): HoldReason | null {
  if (source !== "dep") return null;
  if (a.patched === null) return "no-patch";
  return now - a.createdAt < GRACE_MS ? "grace" : null;
}

type Group = Pick<GroupRecord, "source" | "openAlerts">;

export function candidatesOf(g: Group, cfg: RepoConfig, now: number): AlertRecord[] {
  return g.openAlerts.filter((a) => !alertFilter(a, cfg) && !alertHold(g.source, a, now));
}

/** The alerts a filing made now accounts for: every open alert except those held back ONLY by a
 *  hold, which must still count as new once the hold lifts. */
export function coveredAlerts(g: Group, cfg: RepoConfig, now: number): number[] {
  return g.openAlerts
    .filter((a) => alertFilter(a, cfg) || !alertHold(g.source, a, now))
    .map((a) => a.number);
}

/** An unticked source isn't read, so its records are frozen and may already be gone. */
export function sourceEnabled(cfg: RepoConfig, source: Source): boolean {
  return source === "cs" ? cfg.codeScanning : cfg.dependabot;
}

/** The opt-in gate: a non-private repo stays untouched until the operator accepted the risk. */
export function needsAck(visibility: PluginRepoVisibility, cfg: RepoConfig): boolean {
  return visibility !== "private" && !cfg.publicRiskAck;
}

export type GroupSkip = "filed" | "triage-pending" | "closed-still-open" | "triaged" | "cap";

/** A closed filing only lets the group file again on evidence: a candidate the filing didn't
 *  account for, or its alerts seen gone since. */
export function refileTriggered(g: GroupRecord, candidates: AlertRecord[]): boolean {
  const f = g.filing;
  if (!f) return true;
  if ((g.observedResolvedAt ?? 0) > f.filedAt) return true;
  return candidates.some((a) => !f.coveredAlerts.includes(a.number));
}

/** Decide one group with candidates; null = send it to triage. */
export function evaluateGroup(
  g: GroupRecord,
  candidates: AlertRecord[],
  c: { filedToday: number },
): GroupSkip | null {
  if (g.filing?.sync === "open") return "filed";
  const t = g.triage;
  if (t?.outcome === "pending" || (t?.outcome === "accepted" && !t.filing)) return "triage-pending";
  if (!refileTriggered(g, candidates)) return "closed-still-open";
  if (t && candidates.every((a) => t.alerts.includes(a.number))) return "triaged";
  return c.filedToday >= DAILY_CAP ? "cap" : null;
}

/** Worst first, then oldest. */
export function compareUrgency(
  a: { severity: number; oldest: number },
  b: { severity: number; oldest: number },
): number {
  return b.severity - a.severity || a.oldest - b.oldest;
}

export function urgency(candidates: AlertRecord[]): { severity: number; oldest: number } {
  return {
    severity: Math.max(0, ...candidates.map((a) => severityRank(a.severity))),
    oldest: Math.min(...candidates.map((a) => a.createdAt)),
  };
}

/** The worst severity among `alerts`. */
export function worstSeverity(alerts: AlertRecord[]): Severity | null {
  return alerts.reduce<Severity | null>(
    (worst, a) => (severityRank(a.severity) > severityRank(worst) ? a.severity : worst),
    null,
  );
}

function alertLine(g: Pick<GroupRecord, "location">, a: AlertRecord): string {
  const where = a.line === null ? g.location : `${g.location}:${a.line}`;
  return `#${a.number} ${a.ref ? `${a.ref} ` : ""}${where}: ${a.text}`;
}

/** Alert text as untrusted sections for triage and for full issues. */
export function alertSections(g: GroupRecord, alerts: AlertRecord[]): PluginUntrustedSection[] {
  const out: PluginUntrustedSection[] = [
    { label: "finding", content: `${g.subject} in ${g.location}` },
  ];
  if (g.description) out.push({ label: "rule description", content: g.description });
  const lines = alerts.map((a) => alertLine(g, a)).join("\n");
  out.push({
    label: g.source === "cs" ? "alert messages" : "advisories",
    content: lines.slice(0, SECTION_BUDGET),
  });
  return out;
}
