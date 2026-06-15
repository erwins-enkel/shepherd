/**
 * Pure helpers for the Herd Rundown feature — no I/O, no DB, no spawn.
 * Mirrors recap-core.ts (classify / assemble / prompt / parse + clamp).
 *
 * The Rundown synthesizes a cross-session attention digest answering "what needs a
 * human right now?" across the whole live agent herd, keyed by calendar day.
 */
import type { Session, ReviewVerdict, PlanGate, Recap, RundownItem, RundownVerdict } from "./types";
import type { GitState } from "./forge/types";

export const RUNDOWN_VERDICT_FILE = ".shepherd-rundown.json";

// Clamp bounds for the parsed verdict (also encoded in the prompt's length guidance).
export const RUNDOWN_OVERNIGHT_MAX = 280;
export const RUNDOWN_TRAIN_MAX = 200;
export const RUNDOWN_LABEL_MAX = 140;
export const RUNDOWN_DECISIONS_CAP = 6;
export const RUNDOWN_CIREWORK_CAP = 6;
export const RUNDOWN_FOCUSNEXT_CAP = 3;
export const RUNDOWN_DEFAULT_TOPN = 40;

// DRIFT: keep in sync with ui/src/lib/components/merge-train.ts (MERGE_MARK_BACKSTOP_MS).
// Re-implemented server-side so the rundown can classify merging sessions without
// importing UI code; a parity test in rundown-core.test.ts locks the two literals together.
export const MERGE_MARK_BACKSTOP_MS = 24 * 60 * 60_000;

/** True when a session is in a currently-running merge train: marked and still within the
 *  safety backstop. Mirrors isMerging() in ui/src/lib/components/merge-train.ts. */
export function isMerging(s: Pick<Session, "mergingSince">, now: number = Date.now()): boolean {
  return s.mergingSince !== null && now - s.mergingSince < MERGE_MARK_BACKSTOP_MS;
}

// ── attention tiers + signal classification ──────────────────────────────────
export type AttentionTier = 1 | 2 | 3;

export type SignalCode =
  | "blocked-decision"
  | "plan-rework"
  | "critic-rework"
  | "ci-red"
  | "awaiting-merge"
  | "stalled"
  | "recap-attention"
  | "train-error"
  | "ready-merge"
  | "in-flight"
  | "merging";

/** Most-urgent (lowest) tier each signal belongs to. A session's tier is the min over
 *  its signals. Tier 1 = CRITICAL (blocked on operator), 2 = HIGH (needs a look soon),
 *  3 = NORMAL (routine in-flight / queued). */
const SIGNAL_TIER: Record<SignalCode, AttentionTier> = {
  "blocked-decision": 1,
  "plan-rework": 1,
  "critic-rework": 1,
  "ci-red": 1,
  "awaiting-merge": 2,
  stalled: 2,
  "recap-attention": 2,
  "train-error": 2,
  "ready-merge": 3,
  "in-flight": 3,
  merging: 3,
};

export interface ClassifyCaches {
  git?: GitState;
  review?: ReviewVerdict;
  gate?: PlanGate;
  recap?: Recap;
  /** Merge-train state for this session, when known (e.g. an errored train run). */
  train?: { error?: boolean };
  /** Precomputed stall flag — kept as input so classifyAttention stays pure (stall
   *  detection reads terminal buffers / files, which belongs to the caller). */
  stalled?: boolean;
}

/** Classify a single session's attention demand into a tier + its raw signal codes.
 *  Pure: every input is already-derived state, no I/O. A session may carry multiple
 *  signals; its tier is the most urgent (lowest) of them. Returns `tier: null` when the
 *  session bears no attention signal at all (filtered out of fingerprints/assembly). */
export function classifyAttention(
  session: Session,
  caches: ClassifyCaches,
  now: number = Date.now(),
): { tier: AttentionTier | null; signals: SignalCode[] } {
  const signals: SignalCode[] = [];
  const { git, review, gate, recap, train, stalled } = caches;

  // ── Tier 1: CRITICAL — forward progress blocked on the operator ──
  if (session.status === "blocked" || (session.autopilotPaused && session.autopilotQuestion)) {
    signals.push("blocked-decision");
  }
  if (gate?.decision === "changes_requested") signals.push("plan-rework");
  if (review?.decision === "changes_requested") signals.push("critic-rework");
  if (git?.checks === "failure") signals.push("ci-red");

  // ── Tier 2: HIGH — needs a look soon, not yet a hard stop ──
  // Operator's turn: the server has handed the PR off to a merger.
  if (git?.handoff === "merger") signals.push("awaiting-merge");
  if (stalled) signals.push("stalled");
  if (recap?.verdict === "needs_attention") signals.push("recap-attention");
  if (train?.error) signals.push("train-error");

  // ── Tier 3: NORMAL — routine in-flight / queued work ──
  // Informational: PR is ready but not yet handed to a merger (Tier 2 takes over once it is).
  if (session.readyToMerge && git?.handoff !== "merger") signals.push("ready-merge");
  if (session.status === "running" || session.status === "idle") signals.push("in-flight");
  if (isMerging(session, now)) signals.push("merging");

  if (signals.length === 0) return { tier: null, signals: [] };
  const tier = signals.reduce<AttentionTier>(
    (acc, s) => (SIGNAL_TIER[s] < acc ? SIGNAL_TIER[s] : acc),
    3,
  );
  return { tier, signals };
}

/** Map sessionId → sorted signal codes, for the attention-bearing sessions only. The
 *  digest stores this so a later pass can measure how far the herd has drifted. */
export function attentionFingerprint(
  classified: Array<{ sessionId: string; signals: SignalCode[] }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of classified) {
    if (c.signals.length === 0) continue;
    out[c.sessionId] = [...c.signals].sort();
  }
  return out;
}

/** Count sessionIds whose sorted signal set differs between two fingerprints — a signal
 *  added, removed, or changed each counts as one. Identical fingerprints → 0. */
export function fingerprintDiffCount(
  prev: Record<string, string[]>,
  current: Record<string, string[]>,
): number {
  const ids = new Set([...Object.keys(prev), ...Object.keys(current)]);
  let n = 0;
  for (const id of ids) {
    const a = prev[id];
    const b = current[id];
    if (!a || !b || a.length !== b.length || a.some((s, i) => s !== b[i])) n++;
  }
  return n;
}

// ── assembled herd state (data-only, fed to the prompt) ──────────────────────
export interface AssembledSession {
  desig: string;
  sessionId: string;
  repo: string;
  tier: AttentionTier;
  signals: SignalCode[];
  ageMs: number;
  prNumber?: number;
  prUrl?: string;
  findings?: string[];
  planRound?: number;
}

export interface AssembledHerdState {
  generatedFor: string;
  overnightDelta: { mergedPrs: number[]; archivedSessions: { id: string; desig: string }[] };
  sessions: AssembledSession[];
  /** Count of Tier-2 sessions elided by the topN budget (0 when none dropped). Tier-1 is
   *  never dropped, so a positive count here means a HIGH-attention session is hidden. */
  truncatedTier2: number;
  /** Count of Tier-3 sessions elided by the topN budget (0 when none dropped). */
  truncatedTier3: number;
}

export interface AssembleInput {
  sessions: Session[];
  git?: Record<string, GitState>;
  reviews?: Record<string, ReviewVerdict>;
  gates?: Record<string, PlanGate>;
  recaps?: Record<string, Recap>;
  stalled?: Set<string>;
  /** Merge-train state by sessionId (e.g. errored train runs). */
  trains?: Record<string, { error?: boolean }>;
  overnightDelta: { mergedPrs: number[]; archivedSessions: { id: string; desig: string }[] };
  generatedFor: string;
  now?: number;
  topN?: number;
}

/** Pure builder: classify every session, order by tier then age (older first within a
 *  tier), and trim to `topN` — but with a HARD GUARANTEE that every Tier-1 session is
 *  included unconditionally; remaining budget is filled with Tier-2 then Tier-3 by
 *  tier/age. Any Tier-2/Tier-3 dropped is reported via `truncatedTier2`/`truncatedTier3`
 *  (Tier-1 is never dropped). Data-only (no prose). */
export function assembleHerdState(input: AssembleInput): AssembledHerdState {
  const now = input.now ?? Date.now();
  const topN = input.topN ?? RUNDOWN_DEFAULT_TOPN;

  const ranked: AssembledSession[] = [];
  for (const s of input.sessions) {
    if (s.status === "archived") continue;
    const git = input.git?.[s.id];
    const review = input.reviews?.[s.id];
    const gate = input.gates?.[s.id];
    const recap = input.recaps?.[s.id];
    const { tier, signals } = classifyAttention(
      s,
      { git, review, gate, recap, train: input.trains?.[s.id], stalled: input.stalled?.has(s.id) },
      now,
    );
    if (tier === null) continue;
    const item: AssembledSession = {
      desig: s.desig,
      sessionId: s.id,
      repo: s.repoPath,
      tier,
      signals,
      ageMs: Math.max(0, now - s.createdAt),
    };
    if (git?.number != null) item.prNumber = git.number;
    if (git?.url) item.prUrl = git.url;
    if (review?.findings?.length) item.findings = review.findings;
    if (gate && gate.decision === "changes_requested") item.planRound = gate.round;
    ranked.push(item);
  }

  // Order: tier asc, then oldest first within a tier.
  ranked.sort((a, b) => a.tier - b.tier || b.ageMs - a.ageMs);

  // Tier-1 always survives; fill the rest of the budget with tier 2 then 3 in order.
  const tier1 = ranked.filter((s) => s.tier === 1);
  const rest = ranked.filter((s) => s.tier !== 1);
  const budget = Math.max(0, topN - tier1.length);
  const kept = [...tier1, ...rest.slice(0, budget)];
  const dropped = rest.slice(budget);
  const truncatedTier2 = dropped.filter((s) => s.tier === 2).length;
  const truncatedTier3 = dropped.filter((s) => s.tier === 3).length;
  // Re-sort the kept set so output is uniformly tier/age ordered.
  kept.sort((a, b) => a.tier - b.tier || b.ageMs - a.ageMs);

  return {
    generatedFor: input.generatedFor,
    overnightDelta: input.overnightDelta,
    sessions: kept,
    truncatedTier2,
    truncatedTier3,
  };
}

// ── prompt ───────────────────────────────────────────────────────────────────
/** The instruction prompt for the rundown spawn. Encodes the triage contract and tells
 *  the agent to Write `.shepherd-rundown.json` as its final action, then stop. */
export function buildRundownPrompt(assembled: AssembledHerdState): string {
  const lines = [
    "You are triaging an autonomous-agent fleet for a SINGLE human operator. Your job is to",
    'answer one question: "what needs a human right now?" — across the whole live herd.',
    "Do NOT modify, build, commit, or run anything — this is read-only synthesis.",
    "",
    'A session "needs a human right now" when EITHER:',
    "  - forward progress is blocked on an operator action or decision, OR",
    "  - an autonomous loop has stalled or failed in a way it will NOT self-recover from",
    "    (CI red and unaddressed, REWORK over its retry budget, a stalled session, an",
    "    unanswered autopilot question).",
    "It does NOT include routine in-flight work, nor anything the merge-train or the critic",
    "handle automatically — do not surface those as if they need the operator.",
    "",
    "The `sessions` array below is ALREADY significance-ranked: Tier-1 (CRITICAL, blocked on",
    "the operator) come first, then Tier-2 (HIGH), then Tier-3 (NORMAL). Respect that order —",
    "lead with the most urgent.",
  ];

  if (assembled.truncatedTier2 > 0 || assembled.truncatedTier3 > 0) {
    const parts: string[] = [];
    if (assembled.truncatedTier2 > 0) parts.push(`${assembled.truncatedTier2} Tier-2 (HIGH)`);
    if (assembled.truncatedTier3 > 0) parts.push(`${assembled.truncatedTier3} Tier-3`);
    lines.push(
      `NOTE: ${parts.join(" and ")} lower-priority session(s) were elided to fit the budget —`,
      'do NOT claim "all clear" or that the herd is fully idle.',
    );
  }

  lines.push(
    "",
    "Write your synthesis as JSON to the file `" +
      RUNDOWN_VERDICT_FILE +
      "` in your CWD with EXACTLY this shape:",
    "{",
    '  "overnight": "<what changed while the operator was away — merged PRs, archived sessions; \\"\\" if nothing>",',
    '  "decisions": [{ "label": "<a decision/answer the operator must give>", "sessionId"?: "<id>", "pr"?: <n> }, ...],',
    '  "ciRework": [{ "label": "<a CI-red or over-budget REWORK that is stuck>", "sessionId"?: "<id>", "pr"?: <n> }, ...],',
    '  "train": "<one-line state of the merge train / ready-to-merge queue; \\"\\" if nothing>",',
    '  "focusNext": [{ "label": "<what the operator should look at next once blockers clear>", "sessionId"?: "<id>", "pr"?: <n> }, ...]',
    "}",
    "Length guidance (hard caps are enforced on parse, so stay under them):",
    `  - overnight ≤ ~${RUNDOWN_OVERNIGHT_MAX} chars; train ≤ ~${RUNDOWN_TRAIN_MAX} chars; each label ≤ ~${RUNDOWN_LABEL_MAX} chars`,
    `  - decisions ≤ ${RUNDOWN_DECISIONS_CAP}, ciRework ≤ ${RUNDOWN_CIREWORK_CAP}, focusNext ≤ ${RUNDOWN_FOCUSNEXT_CAP}`,
    "Set sessionId/pr on an item whenever the herd state names them, so the UI can deep-link.",
    "Write the file as your final action, then stop.",
    "",
    "Herd state (already significance-ranked):",
    JSON.stringify(assembled, null, 2),
  );

  return lines.join("\n");
}

// ── parse + clamp the spawn's verdict file ───────────────────────────────────
function clampItems(raw: unknown, cap: number): RundownItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RundownItem[] = [];
  for (const x of raw) {
    if (out.length >= cap) break;
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const o = x as Record<string, unknown>;
    if (typeof o.label !== "string" || o.label.trim() === "") continue;
    const item: RundownItem = { label: o.label.slice(0, RUNDOWN_LABEL_MAX) };
    if (typeof o.sessionId === "string") item.sessionId = o.sessionId;
    if (typeof o.pr === "number" && Number.isFinite(o.pr)) item.pr = o.pr;
    out.push(item);
  }
  return out;
}

/** Parse + validate + clamp the raw `.shepherd-rundown.json` the spawn wrote. Fail-closed:
 *  returns null when the top level is unparseable or not an object. Otherwise coerces every
 *  field to bounds (arrays sliced to caps, labels/strings clamped, malformed items dropped,
 *  missing fields defaulted). Mirrors parseRecapVerdict's tolerance. */
export function parseRundownVerdict(raw: string): RundownVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;

  return {
    overnight: typeof r.overnight === "string" ? r.overnight.slice(0, RUNDOWN_OVERNIGHT_MAX) : "",
    decisions: clampItems(r.decisions, RUNDOWN_DECISIONS_CAP),
    ciRework: clampItems(r.ciRework, RUNDOWN_CIREWORK_CAP),
    train: typeof r.train === "string" ? r.train.slice(0, RUNDOWN_TRAIN_MAX) : "",
    focusNext: clampItems(r.focusNext, RUNDOWN_FOCUSNEXT_CAP),
  };
}
