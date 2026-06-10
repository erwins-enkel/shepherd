export type HerdrState = "idle" | "working" | "blocked" | "done" | "unknown";
export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";

export interface Session {
  id: string;
  desig: string; // "TASK-07"
  name: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  branch: string | null; // null when cwd fallback
  worktreePath: string;
  isolated: boolean;
  herdrSession: string;
  herdrAgentId: string; // herdr terminal_id (attach target)
  claudeSessionId: string; // pinned via `claude --session-id`; "" for pre-feature sessions

  model: string | null; // claude --model alias; null = claude's own default (no flag)
  readyToMerge: boolean; // manually-toggled "parked / done" flag; orthogonal to status
  /** Epoch ms when a launched merge train marked this PR-session as in-flight;
   *  null when not in a train. Transient: cleared on merge/close, train archive,
   *  or the TTL sweep. */
  mergingSince: number | null;
  /** Id of the merge-train session that owns this mark (clears the whole set when
   *  that session is archived). Null when not merging. */
  mergingTrainId: string | null;
  /** Autopilot opt-in: true/false override, or null to inherit the repo default. */
  autopilotEnabled: boolean | null;
  /** Count of auto-steers autopilot has spent on this session (runaway guard; reset on PR-open / operator reply). */
  autopilotStepCount: number;
  /** True when autopilot handed control back for a genuine question / step-cap. */
  autopilotPaused: boolean;
  /** True when autopilot judged the task done with a non-PR deliverable (research / issue
   *  creation / one-off answer) — a clean terminal "completed", distinct from a pause. */
  autopilotComplete: boolean;
  /** The classifier's 1–2 sentence hand-back summary — what the agent is waiting for (paused)
   *  or what it delivered (complete); null in neither state. */
  autopilotQuestion: string | null;
  /** Plan-gate opt-in: true/false override, or null to inherit the repo default. */
  planGateEnabled: boolean | null;
  /** Plan-gate phase: "planning" (grill+review) → "executing" (gate passed); null = gate off. */
  planPhase: "planning" | "executing" | null;
  /** Full-auto merge opt-in: true/false override, or null to inherit the repo default. */
  autoMergeEnabled: boolean | null;
  /** Consecutive auto-rebase attempts the merge train has spent on this session
   *  (runaway guard; reset on operator reply). */
  autoMergeRebaseCount: number;
  /** The head SHA the merge train last steered a rebase for; null when none outstanding.
   *  Guards against re-steering / re-bumping while a rebase for the same head is in flight. */
  autoMergeRebaseHead: string | null;
  /** True when this session was auto-spawned by the drain queue. */
  auto: boolean;
  /** Backlog issue number this session was spawned for; null for manual/non-issue sessions. */
  issueNumber: number | null;
  status: SessionStatus;
  lastState: HerdrState;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/**
 * A GitHub/Gitea issue attached to a task by reference. The body rides along
 * out-of-band into the agent's prompt argv (like images) so it never counts
 * against the 8000-char human-prompt guard.
 */
export interface IssueRef {
  number: number;
  url: string;
  title: string;
  body: string;
}

export interface CreateSessionInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null; // null = claude default (no --model flag)
  images: string[]; // absolute paths to staged uploads (may be empty)
  issueRef?: IssueRef; // optional attached issue; body appended out-of-band
  /** True when this session is auto-spawned by the drain queue (default false). The
   *  persisted `issueNumber` is NOT an input here — the service derives it from
   *  `issueRef.number`, so an attached issue is mapped for drain dedupe automatically. */
  auto?: boolean;
  /** Per-task plan-gate override; absent → inherit repo default. */
  planGateEnabled?: boolean | null;
}

/** Selectable claude model aliases; absent/"default" means no --model flag.
 *  Ordered most- to least-powerful so the picker leads with the top tier. */
export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;

export interface Steer {
  id: string;
  label: string;
  text: string;
  /** Optional emoji shown on the chip/button; lets tight layouts collapse to icon-only. */
  emoji?: string;
  /** Surface as a chip in the session steer bar. */
  inSteerBar: boolean;
  /** Surface as a quick-action button on backlog issues (spawns a session with this prompt + the issue). */
  onIssues: boolean;
}

// ── git diff review panel ──────────────────────────────────────────────────
export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  content: string; // line text WITHOUT the leading +/-/space marker
  oldNo?: number; // 1-based line number on the old side (absent for adds)
  newNo?: number; // 1-based line number on the new side (absent for dels)
}

export interface DiffHunk {
  header: string; // the raw "@@ -a,b +c,d @@ …" line
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string; // new path ("/dev/null" side resolved away)
  oldPath?: string; // set only when renamed
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated?: boolean; // hunks dropped because the file exceeded the line cap
  hunks: DiffHunk[]; // empty when binary or truncated
}

export interface DiffResult {
  base: string; // logical base branch, e.g. "main"
  baseRef: string; // ref actually diffed against, e.g. "origin/main" or "main"
  head: string | null; // session branch; null for non-isolated sessions
  fetchFailed: boolean; // true when `git fetch` failed and we fell back to local base
  truncated: boolean; // true when any file was truncated
  files: DiffFile[];
}

// ── herdr version update check (informational only) ─────────────────────────
export interface HerdrUpdateStatus {
  /** installed herdr version (from `herdr --version`); null if unknown */
  current: string | null;
  /** latest published version from herdr.dev; null on error */
  latest: string | null;
  /** true when latest > current; never true on error */
  updateAvailable: boolean;
  /** release notes (markdown-ish) for the latest version; null on error/none */
  notes: string | null;
  checkedAt: number;
  /** set when the check itself failed (binary missing / network); badge stays hidden */
  error?: string;
}

// ── pre-execution plan gate ──────────────────────────────────────────────────
export type PlanDecision = "approved" | "changes_requested" | "error";

export interface PlanGate {
  sessionId: string;
  planHash: string; // sha256 of the reviewed plan text; dedups re-reviews of an unchanged plan
  decision: PlanDecision;
  summary: string; // <=100 char one-liner for the badge tooltip
  body: string; // full markdown reviewer write-up
  findings: string[]; // discrete actionable items; [] = nothing to address
  round: number; // adversarial rounds spent on the current plan streak (0 = reset)
  cap: number; // the round cap this run used — surfaced so the UI badge need not mirror it
  approved: boolean; // load-bearing gate flag: execution allowed only when true
  plan: string; // snapshot of the reviewed plan text (surfaced in the UI panel)
  updatedAt: number;
}

// ── critic-on-PR review verdict ─────────────────────────────────────────────
export type ReviewDecision = "changes_requested" | "commented" | "error";

export interface ReviewVerdict {
  sessionId: string;
  headSha: string; // PR head this verdict applies to
  patchId: string; // git patch-id of `git diff base...HEAD`; dedups re-reviews across rebases (a pure rebase keeps it stable, so the head can change without re-reviewing). '' = unknown (always reviews)
  decision: ReviewDecision;
  summary: string; // <=100 char one-liner for the badge tooltip
  body: string; // full markdown findings (seeds the steer-back)
  findings: string[]; // discrete actionable items; [] = nothing to address (loop terminates)
  addressRound: number; // auto-address steers spent on the current findings streak (0 = clean/reset)
  addressCap: number; // the streak cap this run used — surfaced so the UI badge math need not mirror it
  errorRound: number; // consecutive critic error/timeout verdicts (separate no-progress counter; 0 on any real verdict)
  finalRoundPending: boolean; // cap-th steer just delivered, no re-review yet → dimmed FINAL badge
  finalRoundTimeoutMs: number; // live abandonment timeout; surfaced so the UI never hardcodes it
  seenNoteIds: string[]; // ids of author notes already fed to the critic, so each is injected only once
  url?: string; // posted PR-review URL, when the host returns one
  updatedAt: number;
}

// ── reviewer spawn cost-attribution record ──────────────────────────────────
/** Append-only, archive-decoupled record of one spawned critic/plan-gate reviewer
 *  session and its token total. Keyed by the *reviewer* session id (NOT the task) and
 *  deliberately carries no FK to `sessions`, so it outlives task archive + prune —
 *  letting post-hoc cost reports attribute reviewer token burn the task row can't. */
export interface ReviewerSpawnRow {
  reviewerSessionId: string;
  taskSessionId: string;
  kind: "review" | "plan_gate";
  worktreePath: string;
  model: string | null;
  spawnedAt: number;
  completedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}

// ── autopilot mode ──────────────────────────────────────────────────────────
export type AutopilotKind = "gate" | "question" | "finished" | "complete" | "unknown";

export interface AutopilotVerdict {
  kind: AutopilotKind;
  /** 1–2 sentence plain-English description of what the agent is waiting for (or, for
   *  "complete", what it delivered). */
  summary: string;
}

// ── agent-authored build queue ───────────────────────────────────────────────
export type BuildStepStatus = "pending" | "active" | "done" | "skipped";

/** One ordered step in a session's agent-authored build queue. */
export interface BuildStep {
  id: string;
  title: string;
  detail: string;
  status: BuildStepStatus;
  position: number; // 0-based order
}

/** A session's full build queue plus its human-curation-gate flag. */
export interface BuildQueue {
  sessionId: string;
  steps: BuildStep[];
  approved: boolean;
}

/** Input shape for replacing a queue. `id` present + matching an existing step
 *  preserves that step's status (unless `status` is given). New entries get a
 *  fresh id and default to "pending". */
export interface BuildStepInput {
  id?: string;
  title: string;
  detail?: string;
  status?: BuildStepStatus;
}

// ── live preview state ────────────────────────────────────────────────────────

/**
 * Payload for the `session:preview` WebSocket event.
 * Carries only the assigned preview port (or null when no preview is active).
 * The UI builds the full URL from `window.location` + this port so the URL
 * auto-adapts to Tailscale vs. local-dev access modes.
 *
 * NOTE: this is live-derived ephemeral state — NOT persisted to the DB.
 */
export interface SessionPreviewEvent {
  id: string;
  previewPort: number | null;
}

/**
 * Live preview state for one session — the per-session entry in the preview
 * snapshot map (parallel to the activity snapshot). Never persisted.
 */
export interface SessionPreviewState {
  previewPort: number | null;
  /** Tailscale serve registration status for this slot; absent when not managed
   *  (auto disabled / tailscale absent) or no mapping yet. "failed" → degraded. */
  serve?: "ok" | "failed";
}

/** Emitted by TailscaleServeService when a slot's `tailscale serve` mapping
 *  settles. Distinct from SessionPreviewEvent to avoid a register/emit feedback
 *  loop. serve: "ok"|"failed" after register, null after release. */
export interface SessionPreviewServeEvent {
  id: string;
  serve: "ok" | "failed" | null;
}

// ── learnings flywheel ────────────────────────────────────────────────────────
export type SignalKind = "reply" | "critic" | "block" | "stall";

export interface Signal {
  id: string;
  repoPath: string;
  sessionId: string | null;
  kind: SignalKind;
  payload: string;
  ts: number;
}

export type LearningStatus = "proposed" | "active" | "promoted" | "dismissed";

/** One resolved evidence signal behind a proposed rule, for the drawer's
 *  "where did this come from" view. `id` is the signal id (stable render key);
 *  `desig` is the source session's designation (e.g. "TASK-07"), or null when
 *  the session row is gone; `excerpt` is a short single-line preview of the
 *  captured payload. */
export interface EvidenceItem {
  id: string;
  kind: SignalKind;
  desig: string | null;
  excerpt: string;
  ts: number;
}

export interface Learning {
  id: string;
  repoPath: string;
  rule: string;
  rationale: string;
  evidence: string[]; // signal ids the distiller cited
  status: LearningStatus;
  evidenceCount: number;
  // Per-kind breakdown of the cited signals (so the drawer can show *where* the
  // evidence came from — corrections, review findings, blocks, stalls — not just
  // a bare count). Resolved from `evidence` against the signals table; only
  // attached to the pending-learnings payload, absent (undefined) elsewhere.
  // Pruned/unknown signal ids are simply omitted, so counts may sum below
  // evidenceCount.
  evidenceKinds?: Partial<Record<SignalKind, number>>;
  // The resolved evidence signals themselves (kind + source session + excerpt),
  // newest first. Same provenance, expandable in the drawer. Only on the pending
  // payload; pruned signals drop out.
  evidenceDetail?: EvidenceItem[];
  ineffectiveCount: number;
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
  /** URL of the CLAUDE.md promote PR, set when status becomes `promoted`. */
  promotedPrUrl: string | null;
}
