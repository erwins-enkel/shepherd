import { m } from "#lib/paraglide/messages.js";
import type { JudgeConnectionStatus } from "#lib/types.js";

// Settings → Decision model (#3071): what the status strip and the mobile section list say, derived
// from the connection status and the three feature switches. Kept out of the component so the
// precedence is tested once and both surfaces read the same answer.

export type DecisionModelState =
  "notConnected" | "keyRejected" | "limitReached" | "active" | "ready";

/** The switches that put the decision model to work. Up Next readiness only counts while the stop
 *  classifier is on — it rides on it, so on its own it does nothing. */
export interface DecisionModelFeatures {
  judgeEnabled: boolean;
  upNextReadiness: boolean;
  blockJudgeMode: "off" | "shadow" | "armed";
}

export const DECISION_MODEL_FEATURE_COUNT = 3;

export function activeFeatureCount(f: DecisionModelFeatures): number {
  return (
    (f.judgeEnabled ? 1 : 0) +
    (f.judgeEnabled && f.upNextReadiness ? 1 : 0) +
    (f.blockJudgeMode !== "off" ? 1 : 0)
  );
}

/** The newest refusal of the key in force — by a real call or by a check — unless something has
 *  succeeded since; null when the key is fine as far as anyone knows. */
export function keyRejection(
  s: JudgeConnectionStatus,
): { at: number; status: number | null } | null {
  const refusals = [
    s.authFailure ? { at: s.authFailure.at, status: s.authFailure.status } : null,
    s.lastVerify?.result === "rejected"
      ? { at: s.lastVerify.at, status: s.lastVerify.status }
      : null,
  ].filter((r) => r !== null);
  if (refusals.length === 0) return null;
  const newest = refusals.reduce((a, b) => (b.at > a.at ? b : a));
  const okAt = Math.max(
    s.lastOkAt ?? -Infinity,
    s.lastVerify?.result === "ok" ? s.lastVerify.at : -Infinity,
  );
  return newest.at > okAt ? newest : null;
}

export function decisionModelState(
  s: JudgeConnectionStatus | null,
  f: DecisionModelFeatures,
): DecisionModelState {
  if (!s || s.keySource === "none") return "notConnected";
  if (keyRejection(s) !== null) return "keyRejected";
  const on = activeFeatureCount(f);
  // A ceiling only matters while something would spend against it.
  if (on > 0 && s.today && s.today.usd >= s.today.ceilingUsd) return "limitReached";
  return on > 0 ? "active" : "ready";
}

/** Today's spend reads in cents once there is any, and keeps the sub-cent figures visible before. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** The line under "Decision model" on the mobile section list. */
export function decisionModelSummary(
  s: JudgeConnectionStatus | null,
  f: DecisionModelFeatures,
): string {
  switch (decisionModelState(s, f)) {
    case "notConnected":
      return m.settings_dm_summary_not_connected();
    case "keyRejected":
      return m.settings_dm_summary_rejected();
    case "limitReached":
      return m.settings_dm_summary_limit();
    case "active":
      return m.settings_dm_summary_active({ spent: formatUsd(s?.today?.usd ?? 0) });
    case "ready":
      return m.settings_dm_summary_ready();
  }
}
