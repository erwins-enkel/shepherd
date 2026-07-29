import type { SessionStore } from "./store";
import type { LivenessState, Session } from "./types";
import {
  classifyLiveness,
  deriveHerdrState,
  isAutoRevivable,
  mapState,
  matchAgents,
  needsAccountRedrive,
  sanitizeHerdrAgentName,
  type HerdrDriver,
  type HerdrAgent,
  type PushableAgentState,
} from "./herdr";
import type { SandboxProfile } from "./sandbox";
import { herdrUsesExternalRegistrationSpawn } from "./herdr-capabilities";
import {
  classifyBlocked,
  hasActiveSpinner,
  quotaBlockReason,
  tailLines,
  type BlockReason,
} from "./blocked";
import { DEFAULT_STALL } from "./stall";
import { jsonlPathFor } from "./usage";
import { readTranscriptSignals, STRIP_WINDOW_MS, type SessionActivity } from "./activity-signal";
import { readTranscriptTail } from "./activity";
import { detectAuthUrl, detectPendingAuthUrl, detectLoginAuthUrl } from "./auth-url";
import { statSync } from "node:fs";
import { classifyHalt, assistantSideText } from "./usage-halt";
import type { UsageLimits } from "./usage-limits";
import { maintenance } from "./maintenance";
import { scanListeningPortsByWorktree, scanClaudeAliveByWorktree } from "./process-reaper";
import { resolveDevPort } from "./preview";
import { config } from "./config";
import { SessionLiveness, type LivenessOutcome, type TranscriptSignals } from "./session-liveness";

const STALL_SIG = "stall"; // fixed signature → a stall fires once per episode
const AUTH_SIG = "auth"; // fixed signature → a resting MCP-auth block fires once per episode
const QUOTA_SIG = "quota"; // fixed signature → a quota block fires once per episode

/**
 * Notification `notification_type`s that assert an awaiting-input edge (Phase 1,
 * issue #704). Deliberately a small, named constant because under
 * `--dangerously-skip-permissions` (how Shepherd spawns every agent) tool-permission
 * prompts are suppressed, so it was unclear whether the real pausing cases emit a
 * usable edge. CONFIRMED by the Phase-0 live spike (2026-06-15): BOTH interactive-pause
 * cases — an `AskUserQuestion` pause AND an `ExitPlanMode`/plan-approval prompt — fire
 * `Notification(permission_prompt)` even under skip-permissions, so this single type
 * covers them. If some future pausing case emitted a different type, the block trigger
 * would simply stay dormant for it and detection would cleanly degrade to the
 * existing `herdr-blocked → classifyBlocked` fallback — the intended no-regression
 * path. `idle_prompt` is deliberately NOT here (idle is handled
 * by herdr mapping).
 */
const BLOCK_NOTIFICATION_TYPES = new Set(["permission_prompt"]);

/** Pairing horizon for the observe-only Stop↔herdr-done window (issue #713): a Stop and a
 *  done-flip more than this apart are treated as unrelated turns and never paired. */
const STOP_WINDOW_MAX_MS = 30_000;

/** Codex session-id capture back-off: after a missed rescan, wait `BASE << misses` (capped) before the
 *  next scan. A rollout normally appears within seconds of spawn, so early retries stay quick; a
 *  never-matching session widens to one scan per ~2 min instead of every 1 s tick. */
const CODEX_CAPTURE_BACKOFF_BASE_MS = 2_000;
const CODEX_CAPTURE_BACKOFF_MAX_MS = 120_000;

/**
 * Injectable preview wiring: service + throttle cadence + scan/pick overrides.
 * Defaults to the real implementations; tests inject fakes to avoid /proc + network.
 */
export interface PreviewWiring {
  service: {
    ensure(sessionId: string, devPort: number): number | null;
    release(sessionId: string): void;
    converge(active: Array<{ sessionId: string; devPort: number }>): void;
    snapshot(): Record<string, { previewPort: number | null }>;
    /** Ms since last proxy activity for a bound session, null if unbound.
     *  Optional so existing fake `service` literals in tests still compile. */
    idleSince?(sessionId: string, now: number): number | null;
  };
  sweepMs: number;
  /** Refresh the probe snapshot cell before a sweep reads it (darwin; no-op on
   *  Linux/fakes). Drives BOTH sweeps: called (coalesced) from `tick()` on the
   *  union filter, so the liveness sweep — which has no wiring of its own — is
   *  covered too. Defaults to `deps.reaper`-backed refresh in index.ts. */
  refresh?: (opts?: { force?: boolean }) => Promise<void>;
  /** Batched /proc scan: builds the inode→port map ONCE and resolves all worktrees.
   *  Defaults to the real `scanListeningPortsByWorktree`. Returns `null` when the
   *  snapshot backend cannot support a negative verdict (darwin, stale/none cell) —
   *  the sweep must then leave bound listeners untouched, not tear them down. */
  scan: (worktrees: string[]) => Map<string, number[]> | null;
  /** Pick the primary dev port from a set of listening ports for a given worktree.
   *  Defaults to `resolveDevPort`, which honors the agent-declared `.shepherd-preview`
   *  hint (if listening + HTTP-live) and otherwise falls back to the primary-port heuristic. */
  pick: (ports: number[], worktreePath: string) => Promise<number | null>;
  /** Opt-in idle-stop. idleMs > 0 enables it; `stop` signals a session's dev-server
   *  process (wired to SessionService.stopPreview in index.ts). Returns the stop
   *  outcome; `"unsupported"` (darwin, no signal authority) must NOT advance the
   *  escalation ladder. Absent = disabled. */
  idleStop?: {
    idleMs: number;
    stop: (sessionId: string, signal: NodeJS.Signals) => StopPreviewOutcome | void;
  };
}

/** Outcome of a preview-stop attempt, folded from `SessionService.stopPreview`. The
 *  poller only distinguishes `"unsupported"` (no signal authority — do not advance
 *  the ladder) from everything else. */
export type StopPreviewOutcome = {
  result: "stopped" | "not_bound" | "not_found" | "unsupported";
  killed: number;
} | void;

/**
 * Injectable claude-liveness wiring: emits when a session's worktree gains/loses
 * a live `claude` process. Defaults to the real /proc scan; tests inject fakes.
 */
export interface LivenessWiring {
  /** Single /proc pass answering "does a claude process live in this worktree?".
   *  Returns `null` when the snapshot backend cannot support a negative verdict
   *  (darwin, stale/none cell): a false here DRIVES husk/stranded + auto-revive, so
   *  `null` means "unknown", and the sweep must skip rather than coerce to false. */
  scan: (worktrees: string[]) => Map<string, boolean> | null;
  sweepMs: number;
  /** Emitted on a liveness change. `alive` is the raw /proc bit (retained for old clients across an
   *  update); `liveness` is the folded 3-state (alive/husk/stranded) the new UI consumes. */
  onChange: (id: string, alive: boolean, liveness: LivenessState) => void;
}

/** The push-hook signal pipeline (activity / notification / session-start) must be active whenever
 *  herdr can't advance `agent_status` for us. On the 0.7.5 external-registration path it never does
 *  (sandboxed agents it can't observe; trusted agents defer to the client-pinned state), AND claude's
 *  real session id is unknown there (#1889) so the transcript-based activity probe can't run either.
 *  The hooks are then the ONLY source of working/idle/blocked edges Shepherd pushes back. ≤0.7.4
 *  keeps herdr's own detection + the transcript probe, so this stays behind the opt-in `hooksSignals`
 *  flag there (no behaviour change). */
function hookSignalsActive(): boolean {
  return config.hooksSignals || herdrUsesExternalRegistrationSpawn();
}

/** A genuinely sandboxed session — a non-`trusted` profile actually applied AND not degraded to
 *  unconfined. Only these run behind the `bwrap` membrane, so only these are externally REGISTERED
 *  on 0.7.5 (herdr can't observe them) and have their state owned+pushed by Shepherd (#1891). A
 *  trusted 0.7.5 spawn is NOT registered — herdr auto-detects it and owns its status — so Shepherd
 *  must never push for it (a push would claim authority and freeze herdr's own detection). */
function isSandboxedSession(s: {
  sandboxApplied: SandboxProfile | null;
  sandboxDegraded: boolean;
}): boolean {
  return s.sandboxApplied != null && s.sandboxApplied !== "trusted" && !s.sandboxDegraded;
}

/** Bounded tail read + auth-URL detection for a session's transcript; the default
 *  `detectAuth` wiring. Missing/unreadable transcript (or no claude session yet) ⇒ null. */
function readAuthUrl(s: Session): string | null {
  if (!s.claudeSessionId) return null;
  try {
    return detectAuthUrl(
      readTranscriptTail(jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir)),
    );
  } catch {
    return null;
  }
}

/** Transcript mtime for the resting-auth probe (default `authMtime` seam). Missing/unreadable
 *  transcript (or no claude session yet) ⇒ null. Used to gate the (bounded) resting read to
 *  ticks where the transcript actually changed. */
function readRestingAuthMtime(s: Session): number | null {
  if (!s.claudeSessionId) return null;
  try {
    return statSync(jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir)).mtimeMs;
  } catch {
    return null;
  }
}

/** Single bounded tail read → freshness-gated auth URL + context tail (default `detectRestingAuth`
 *  seam). One read serves both the URL and the block's tail lines. */
function readRestingAuth(s: Session): { url: string | null; tail: string[] } {
  if (!s.claudeSessionId) return { url: null, tail: [] };
  try {
    const raw = readTranscriptTail(
      jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir),
    );
    return { url: detectPendingAuthUrl(raw), tail: tailLines(assistantSideText(raw)) };
  } catch {
    return { url: null, tail: [] };
  }
}

export class StatusPoller {
  /** Fire-and-forget re-drive of a herdr-restored account pane (wired to service.reDriveAccount in
   *  index.ts). Left undefined in tests that don't exercise it. */
  reDrive?: (id: string) => void;

  /** Fire-and-forget autonomous auto-revive of a STRANDED default-account session (wired to
   *  service.reviveStranded in index.ts). Resolves "revived" on success, "failed" for a retryable
   *  attempt, "gaveup" once the service's bounded cap is reached (the poller then stops dispatching +
   *  counting that id). Left undefined in tests that don't exercise it; a no-op when
   *  `config.autoReviveEnabled` is off. */
  revive?: (id: string) => Promise<"revived" | "failed" | "gaveup">;
  /** Coalesced daemon-restart signal — fired with the current stranded count when the stranded set
   *  grows (a session newly enters it). Wired in index.ts to emit `app:sessions-stranded`. */
  onStrandedGrew?: (count: number) => void;
  /** Fired after each autonomous auto-revive completes, carrying the running default-account
   *  revived/failed totals for the current restart episode. Wired to emit `app:auto-revived`. */
  onAutoRevived?: (revived: number, failed: number) => void;

  /** Fire-and-forget best-effort seed of a running Codex session's provider-native id (wired to
   *  service.captureCodexSessionId in index.ts). No-op for non-Codex / non-isolated / already-seeded
   *  sessions. Returns `true` when it was an applicable attempt that still missed (used to back off the
   *  per-session rescan cadence below). Left undefined in tests that don't exercise it. */
  captureCodexSessionId?: (s: Session) => boolean;

  /**
   * Resting-session (done/idle) MCP-auth detection seams, public + assignable (mirrors `reDrive`)
   * so tests can drive the mtime/URL sequence deterministically without touching disk:
   *  - `authMtime`: the transcript's current mtime — a change gates the bounded read below.
   *  - `detectRestingAuth`: one bounded tail read → freshness-gated URL + context tail.
   * Production leaves the real-file defaults.
   */
  authMtime: (s: Session) => number | null = readRestingAuthMtime;
  detectRestingAuth: (s: Session) => { url: string | null; tail: string[] } = readRestingAuth;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard for `tick()`: async since `listAsync()` goes over the socket,
   *  so a slow read could otherwise overlap the next 1s fire. */
  private ticking = false;
  private lastReadAt = new Map<string, number>();
  private lastSig = new Map<string, string>();
  /** Last-emitted block reason per session (parallel to `lastActivity`), for client
   *  bootstrap via `blockSnapshot()`. Maintained by `emitBlock`; blocks are otherwise
   *  edge-emitted and would be absent on a fresh page load / push-then-open. */
  private lastBlockReason = new Map<string, BlockReason>();
  /** #1891: last lifecycle state pushed to herdr per session, for push-on-change dedup. */
  private lastPushedState = new Map<string, PushableAgentState>();
  /** #1891: ms of the last detected active turn (an `emitActivity` this probe) — the terminal-scrape
   *  half of the working↔idle signal, so the boundary works on the frozen-`working` route where
   *  `maybeClassify` never runs and hooks may be off. */
  private lastActiveTurnAt = new Map<string, number>();
  /** #1891: sessions with an in-flight `reportAgentState` push — serialize per session so two pushes
   *  can't reorder on herdr; the push's `finally` re-evaluates to catch a state change mid-flight. */
  private pushInFlight = new Set<string>();
  /** Transcript mtime at the last resting-auth probe per session — gates `maybeAuthAtRest`'s
   *  bounded read to ticks where the transcript actually changed (see AUTH_SIG). */
  private lastAuthMtime = new Map<string, number | null>();
  /** Resting-auth (done/idle) caches — see `maybeAuthAtRest`. Two independent sources feed one
   *  AUTH_SIG banner; each keeps its own cost gate and neither cross-clears the other. All pruned
   *  in `pruneInactive`; the detection caches are additionally dropped on the leave-resting edge.
   *   - `restAuthTxn`: last transcript `{url,tail}` (MCP-at-rest), refreshed only on mtime change.
   *   - `restAuthPtyObserved`: last resolved PTY reconstruction url — the stability comparand.
   *   - `restAuthPtyConfirmed`: a PTY reconstruction confirmed by two consecutive equal reads
   *     (absent ⇒ none). The `/login` URL is PTY-only; the two-read gate stops a still-painting
   *     partial (that happens to pass isAuthUrl) from latching past the value-blind AUTH_SIG.
   *   - `lastAuthPtyAt`: throttle stamp for the async PTY visible-buffer probe.
   *   - `lastAuthUrlEmitted`: the authUrl currently shown, for value-aware AUTH re-emit (AUTH_SIG
   *     itself is value-blind, so a corrected URL would otherwise be suppressed). */
  private restAuthTxn = new Map<string, { url: string | null; tail: string[] }>();
  private restAuthPtyObserved = new Map<string, string | null>();
  private restAuthPtyConfirmed = new Map<string, { url: string; tail: string[] }>();
  private lastAuthPtyAt = new Map<string, number>();
  private lastAuthUrlEmitted = new Map<string, string>();
  private lastProbeAt = new Map<string, number>();
  /** Per-session Codex session-id capture back-off: earliest next-attempt time + consecutive misses.
   *  Bounds a never-matching running session (rollout GC'd / no `source=cli` header) to a widening
   *  rescan of `$CODEX_HOME/sessions` instead of a full scan every tick. Dropped on seed/prune. */
  private codexCaptureBackoff = new Map<string, { nextAt: number; misses: number }>();
  private lastActivitySig = new Map<string, string>();
  private lastActivity = new Map<string, SessionActivity>();
  /** Per-session liveness state machine (transcript-vs-interim routing, both
   *  liveness diffs, the interim heat-strip) — see `src/session-liveness.ts`.
   *  Lazily constructed on first touch via `livenessFor`. */
  private liveness = new Map<string, SessionLiveness>();

  /** Timestamp of the last completed preview sweep start (0 = never). */
  private lastPreviewSweepAt = 0;
  /** True while an async preview sweep is in flight (re-entrancy guard). */
  private previewSweeping = false;
  /** Per-session idle-stop escalation state: which devPort we've signalled and how
   *  far we've escalated. Reset when the server dies, the session is viewed again,
   *  or the agent resumes. */
  private previewStopState = new Map<
    string,
    { devPort: number; level: "term" | "kill"; gaveUp: boolean }
  >();
  /** Sessions for which idle-stop has already logged an "unsupported on this host"
   *  line this episode, so the warn fires once rather than every sweep. Pruned
   *  alongside `previewStopState`. */
  private idleStopUnsupportedLogged = new Set<string>();
  /** The resolved preview wiring (with real defaults filled in). */
  private readonly previewWiring: PreviewWiring;

  /** Sessions herdr reports "blocked" whose TUI shows a live turn spinner —
   *  the working-while-blocked suppression episode (herdr latches blocked after
   *  an answered dialog). Membership drives the `onWorkingBlocked` display flag:
   *  added (emit true) once per episode in `maybeClassify`'s suppression branch;
   *  removed with an emit (false) on re-arm — a spinner-free tail OR the
   *  freshness gate tripping on a frozen buffer (see `lastSuppressVisible`) —
   *  on leaving herdr-blocked (`reconcileAgent`), and on reap; dropped SILENTLY
   *  on prune (the session was archived — no client cares about its flag
   *  anymore). */
  private workingWhileBlocked = new Set<string>();
  /** Per-session previous classify-read visible buffer while in a spinner-
   *  suppression episode — the freshness gate. A spinner LINE match alone is
   *  necessary but not sufficient to keep suppressing: a live spinner ticks its
   *  elapsed/token counters, so the buffer always advances across the
   *  reclassify cadence, while a wedged turn or a static buffer quoting a
   *  spinner-like line (`* Done… (3s)` as a markdown bullet) stays frozen —
   *  those must re-arm the block, not be suppressed forever. Deliberately
   *  separate from the `SessionLiveness` module's own transcript/interim
   *  liveness diffs so the diffs never trample each other. Retained across a
   *  frozen re-arm (it IS the episode memory
   *  that stops the same static buffer from re-earning first-sighting grace);
   *  dropped when the suppression context ends (non-spinner classify, leaving
   *  herdr-blocked, `clearBlock`, reap, prune). */
  private lastSuppressVisible = new Map<string, string>();

  /** Phase-1/2 push-hook state (issue #704), all gated by `config.hooksSignals`.
   *  Fed via HookIngest.onSignal → ingestActivity / ingestNotification / ingestSessionStart;
   *  the poller stays the single owner of per-session signal dedup + the working-while-blocked
   *  state machine, so push events funnel through `emitActivity`/`maybeClassify`
   *  rather than emitting directly (which would bypass dedup + oscillate with poll).
   *  Every map is pruned in `pruneInactive` and inert when the flag is off. */
  /** Per-session ms of the last PostToolUse(/Failure) push activity — the freshness
   *  baseline that lets `maybeProbe` suppress its now-redundant transcript activity
   *  emit while the (fresher, real-summary) push path is carrying the session. */
  private lastHookActivityAt = new Map<string, number>();
  /** Per-session windowed heat-strip ticks accrued from push activity (mirrors
   *  `interimTicks`, windowed to STRIP_WINDOW_MS). */
  private hookTicks = new Map<string, number[]>();
  /** Sessions for which a Notification reported an awaiting-input edge; consumed by
   *  `reconcileAgent` to trigger a classify THIS tick (≤ ~1 tick), independent of
   *  herdr's latchy `blocked` status. */
  private hookAwaitingInput = new Set<string>();

  /** Observe-only Stop↔herdr-done pairing markers (issue #713), flag-gated, NO behaviour
   *  change. They measure the offset between a Claude Code `Stop` hook and herdr's `done`
   *  flip per turn; polling stays authoritative. The two sides of the same pairing:
   *  `pendingStopAt` holds a Stop seen before its done-flip (stop-wins side); `pendingDoneAt`
   *  holds a done-flip seen before its Stop (herdr-wins side). Whichever arrives first parks
   *  here; the other side pairs it (emitting the signed window) or it expires unpaired. Both
   *  are reaped on gone/prune and inert when `config.hooksSignals` is off. */
  private pendingStopAt = new Map<string, number>();
  private pendingDoneAt = new Map<string, number>();

  /** Timestamp of the last claude-liveness sweep (0 = never). */
  private lastLivenessSweepAt = 0;
  /** Last-swept per-session claude liveness; onChange fires on flips only. */
  private lastClaudeAlive = new Map<string, boolean>();
  /** Session ids whose claude-liveness is UNKNOWN because the last sweep's scan
   *  returned `null` (darwin snapshot stale/none). While an id is in here,
   *  `updateLiveness` is fed `undefined` (goes silent) at both call sites — the
   *  throttled sweep and the per-tick `reconcileAgent` re-apply — so a retained
   *  `lastClaudeAlive` value can't manufacture a husk/stranded verdict. Cleared on
   *  the next successful (non-null) sweep. */
  private livenessUnknown = new Set<string>();
  /** Last-emitted folded 3-state liveness per session (alive/husk/stranded); the dedup baseline for
   *  `updateLiveness`. */
  private lastLiveness = new Map<string, LivenessState>();
  /** This tick's session→agent match result (`matchAgents`), stashed so the throttled liveness sweep
   *  — which has no agent in scope — can evaluate the stranded fingerprint. Rebuilt every tick. */
  private lastMatched = new Map<string, HerdrAgent | null>();
  /** Consecutive liveness sweeps a session has been observed `stranded` — the 2-sweep debounce for
   *  the AUTONOMOUS auto-revive path (blunts a transient /proc false-negative). Reset when not
   *  stranded. */
  private strandedSweeps = new Map<string, number>();
  /** Sessions with an auto-revive dispatch in flight — coalesces repeated sweep dispatches. */
  private reviveInFlight = new Set<string>();
  /** Sessions the service has permanently GIVEN UP auto-reviving (its bounded cap reached). A
   *  terminal per-session state: no further dispatch or outcome-tally re-emit for these while they
   *  stay stranded, so a permanently-failing session can't grow `reviveOutcome.failed` unbounded or
   *  re-fire the outcome toast every sweep. Cleared when the session leaves the stranded set (healed /
   *  concluded / archived), which also frees a fresh anchor for a later strand. */
  private reviveGaveUp = new Set<string>();
  /** `config.autoReviveEnabled` as of the last sweep — the rising-edge detector for sweep-on-arm. */
  private lastAutoReviveEnabled = config.autoReviveEnabled;
  /** Running default-account auto-revive tally for the current restart episode; reset when no
   *  stranded sessions remain and no revive is in flight. */
  private reviveOutcome = { revived: 0, failed: 0 };
  /** The resolved liveness wiring (with real defaults filled in). */
  private readonly livenessWiring: LivenessWiring;
  /** Emitted when a session's halt state changes: a usage-limit halt is detected
   *  (non-null reason), or the flag is cleared when the session resumes work (null). */
  private readonly onHaltCb: (
    id: string,
    haltReason: Session["haltReason"],
    haltedAt: number | null,
  ) => void;
  /** Usage-limits service for corroboration in classifyHalt. */
  private readonly usageLimitsSvc: { limits(now: number): UsageLimits };

  constructor(
    private store: SessionStore,
    private herdr: Pick<HerdrDriver, "listAsync" | "read" | "readAsync" | "reportAgentState">,
    private onChange: (id: string, status: string) => void,
    private onBlock: (id: string, block: BlockReason | null) => void,
    private intervalMs = 1000,
    private reclassifyMs = 3000,
    private classify: (text: string) => BlockReason = classifyBlocked,
    private now: () => number = Date.now,
    /**
     * Both transcript-derived signals (stall snapshot + activity) for a running
     * session, from a SINGLE read+parse of its JSONL. Defaults to reading the file;
     * injectable in tests. One read feeds both the stall decision and the activity
     * emit, so the transcript is no longer parsed twice per running agent per tick.
     */
    private probe: (s: Session) => TranscriptSignals = (s) =>
      s.claudeSessionId
        ? readTranscriptSignals(jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir))
        : { snapshot: null, activity: null },
    private stallCfg = DEFAULT_STALL,
    private probeCheckMs = 7000,
    /** Pushed when a session's manual readyToMerge flag is auto-cleared on resume. */
    private onReady: (id: string, ready: boolean) => void = () => {},
    /** Pushed when a running session's heartbeat or current activity changes. */
    private onActivity: (id: string, activity: SessionActivity) => void = () => {},
    /**
     * Preview wiring: injectable for tests; defaults to real PreviewService +
     * real scan/pick + config.previewSweepMs. Omit to leave preview disabled
     * (existing poller tests that don't pass this still work).
     */
    preview?: Partial<PreviewWiring>,
    /**
     * Claude-liveness wiring: injectable for tests; defaults to the real /proc scan
     * with a no-op onChange. Drives `session:claude-alive` so the UI only offers
     * Resume when the claude process is actually gone (husk shell).
     */
    liveness?: Partial<LivenessWiring>,
    /**
     * Pushed when a session enters/leaves the working-while-blocked display state
     * (herdr latched "blocked" but the TUI shows a live turn spinner). `true` fires
     * once per suppression episode, `false` when the episode ends — same tick as
     * (and before) any re-armed block emission.
     */
    private onWorkingBlocked: (id: string, working: boolean) => void = () => {},
    /**
     * Phase-1 (issue #704): prune the HookIngest ring buffers for sessions no longer
     * active, called from `pruneInactive` so dead sessions' buffers don't grow
     * unbounded by session count (Task-2 reviewer flag). Undefined ⇒ no-op (the
     * ingest module isn't wired, e.g. in tests / flag off).
     */
    private pruneHooks?: (activeIds: Set<string>) => void,
    /**
     * Observe-only Stop↔herdr-done window emitter (issue #713), flag-gated. Called once per
     * resolved pairing with the SIGNED offset between a `Stop` hook and herdr's `done` flip:
     * `windowMs > 0` ⇒ Stop arrived first (stop-wins); `windowMs <= 0` ⇒ herdr flipped first
     * (herdr-wins); `windowMs === null` ⇒ a done-flip never paired (no Stop within the
     * horizon). Pure measurement — never mutates status/routing. Defaults to a single
     * greppable `[hooks]` log line; tests inject a capturer.
     */
    private onStopWindow: ((id: string, windowMs: number | null) => void) | undefined = (
      id,
      windowMs,
    ) => {
      const kind = windowMs === null ? "no-stop" : windowMs > 0 ? "stop-wins" : "herdr-wins";
      console.log(`[hooks] stop-window session=${id} windowMs=${windowMs ?? "null"} case=${kind}`);
    },
    /**
     * Pushed when a session's transcript signals a usage-limit halt at the
     * done transition. Wired in src/index.ts to emit `session:halt`.
     * Defaults to a no-op so existing tests that omit it still compile.
     * Optional (undefined ⇒ no-op) so callers can skip it with a positional
     * `undefined` after `onStopWindow`.
     */
    onHalt?: (id: string, haltReason: Session["haltReason"], haltedAt: number | null) => void,
    /**
     * Usage-limits service — provides the latest window percentages for the
     * corroboration check in `classifyHalt`. Injectable for tests; defaults to
     * a stub that returns fully-null limits (uncalibrated fallback).
     * Optional (undefined ⇒ stub) so callers can skip it.
     */
    usageLimits?: { limits(now: number): UsageLimits },
    /**
     * Detects the pending OAuth authorization URL in a session's transcript, attached to
     * an awaiting-input block so the UI can offer a clickable "open in browser" affordance
     * (MCP auth flows print a URL Claude word-wraps un-clickably across terminal lines).
     * Injectable for tests; defaults to a bounded tail read + `detectAuthUrl`.
     */
    private detectAuth: (s: Session) => string | null = readAuthUrl,
  ) {
    // Merge supplied overrides with real defaults. When preview is omitted entirely
    // we create a no-op wiring so tick() never throws on undefined access.
    this.previewWiring = {
      service: preview?.service ?? {
        ensure: () => null,
        release: () => {},
        converge: () => {},
        snapshot: () => ({}),
        idleSince: () => null,
      },
      sweepMs: preview?.sweepMs ?? config.previewSweepMs,
      refresh: preview?.refresh,
      scan: preview?.scan ?? ((worktrees) => scanListeningPortsByWorktree(worktrees)),
      pick: preview?.pick ?? ((ports, worktreePath) => resolveDevPort(ports, worktreePath)),
      idleStop: preview?.idleStop,
    };
    this.livenessWiring = {
      scan: liveness?.scan ?? ((worktrees) => scanClaudeAliveByWorktree(worktrees)),
      sweepMs: liveness?.sweepMs ?? config.previewSweepMs,
      onChange: liveness?.onChange ?? (() => {}),
    };
    this.onHaltCb = onHalt ?? (() => {});
    this.usageLimitsSvc = usageLimits ?? {
      limits: () => ({
        session5h: null,
        week: null,
        perModelWeek: [],
        credits: null,
        stale: false,
        calibratedAt: null,
        subscriptionOnly: false,
      }),
    };
  }

  /** Lazily construct (first-touch) a session's `SessionLiveness` instance, wired
   *  onto the poller's herdr port + stall config. Matches the prior per-map
   *  miss semantics: a fresh instance behaves as a fresh first sighting. */
  private livenessFor(id: string): SessionLiveness {
    let ep = this.liveness.get(id);
    if (!ep) {
      ep = new SessionLiveness({
        read: (term) => this.herdr.read(term, "visible"),
        readAsync: (term) => this.herdr.readAsync(term, "visible"),
        stallCfg: () => this.stallCfg,
      });
      this.liveness.set(id, ep);
    }
    return ep;
  }

  async tick(): Promise<void> {
    // herdr is mid-update: don't poll — a list() here would resurrect the herdr
    // server and (seeing no agents) wrongly reap every live session.
    if (maintenance.active) return;
    // tick() is async (listAsync() goes over the socket) and fires every intervalMs
    // via setInterval, so a slow read could otherwise overlap the next fire. Skip
    // this fire entirely while a prior tick is still in flight.
    if (this.ticking) return;
    this.ticking = true;
    try {
      // `herdr list` now carries a hard timeout (HERDR_TIMEOUT_MS), so an
      // unresponsive herdr THROWS rather than blocking. This runs on a 1s interval
      // with no surrounding try/catch, so an unhandled throw would crash shepherd
      // (→ a restart-502, the very thing this design removes). Skip the tick on any
      // herdr failure and retry next cadence — same best-effort stance as the
      // read-based maybeStall/maybeClassify paths below. Probe herdr before the
      // store so a failure bails without touching session state.
      let agents: HerdrAgent[];
      try {
        agents = await this.herdr.listAsync();
      } catch (err) {
        console.warn("[poller] herdr list failed; skipping tick:", err);
        return;
      }
      const sessions = this.store.list({ activeOnly: true });
      const matched = matchAgents(sessions, agents);
      this.lastMatched = matched; // stash for the throttled liveness sweep (has no agent in scope)
      const activeIds = new Set<string>();
      for (const s of sessions) {
        activeIds.add(s.id);
        const agent = matched.get(s.id) ?? null;
        if (!agent) this.reapGone(s);
        else this.reconcileAgent(s, agent);
        // Best-effort seed of a live Codex session's provider-native id (no-op unless it's an isolated
        // Codex session that hasn't been seeded yet). Rescanning $CODEX_HOME every tick for a session
        // that never matches is wasteful, so an applicable miss backs off exponentially (see below).
        // tick() runs on a bare setInterval — never throw.
        if (agent && this.captureCodexSessionId) {
          this.maybeCaptureCodexSessionId(s);
        }
      }
      this.pruneInactive(activeIds);
      // Observe-only Stop↔herdr-done window (issue #713): expire markers that never paired
      // within the horizon (no-stop emit / silent stale-Stop drop). Gated; no behaviour change.
      if (config.hooksSignals) this.expireStaleStopWindows();
      // Refresh the probe snapshot cell (darwin; no-op on Linux/fakes) before the
      // sweeps read it. Driven here — not from a sweep — because the liveness sweep
      // has no wiring of its own and the preview sweep short-circuits when no
      // session is isolated; the union filter (any worktreePath) covers both.
      // Coalesced + fire-and-forget: never blocks tick, and this tick's sweeps read
      // whatever the cell holds (a prior refresh's data), which is the same
      // one-cadence-stale freshness the Linux inode map already gives.
      if (sessions.some((s) => s.worktreePath)) {
        void this.previewWiring.refresh?.().catch((err) => {
          console.warn("[poller] probe snapshot refresh failed:", err);
        });
      }
      // preview sweep: throttled + re-entrancy guarded; fire-and-forget (never blocks tick)
      this.maybeRunPreviewSweep(sessions);
      // claude-liveness sweep: throttled; synchronous (one cheap /proc pass)
      this.maybeRunLivenessSweep(sessions);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Back-off wrapper around the injected `captureCodexSessionId`: skip the (tree-scanning) attempt while
   * a prior miss's cooldown is unelapsed, and widen the cooldown exponentially per consecutive miss so a
   * never-matching running Codex session can't rescan `$CODEX_HOME` every tick. A hit / non-applicable
   * session clears the entry (subsequent ticks are cheap no-ops guarded by `providerSessionId`).
   */
  private maybeCaptureCodexSessionId(s: Session): void {
    const bo = this.codexCaptureBackoff.get(s.id);
    const t = this.now();
    if (bo && t < bo.nextAt) return;
    let missed: boolean;
    try {
      missed = this.captureCodexSessionId!(s);
    } catch (err) {
      console.warn("[poller] codex session-id capture failed:", err);
      return;
    }
    if (missed) {
      const misses = (bo?.misses ?? 0) + 1;
      const delay = Math.min(
        CODEX_CAPTURE_BACKOFF_BASE_MS * 2 ** (misses - 1),
        CODEX_CAPTURE_BACKOFF_MAX_MS,
      );
      this.codexCaptureBackoff.set(s.id, { nextAt: t + delay, misses });
    } else {
      this.codexCaptureBackoff.delete(s.id);
    }
  }

  /**
   * Throttled sweep: does each session's worktree still host a live `claude`
   * process? Detects the husk case herdr's agent_status can't (claude exited to a
   * bare shell keeps the agent listed as idle). Emits onChange on flips only;
   * tracking for sessions no longer active is pruned in place.
   */
  private maybeRunLivenessSweep(sessions: Session[]): void {
    const t = this.now();
    if (t - this.lastLivenessSweepAt < this.livenessWiring.sweepMs) return;
    this.lastLivenessSweepAt = t;
    const candidates = sessions.filter((s) => s.worktreePath);
    let byWorktree: Map<string, boolean> | null;
    try {
      byWorktree = this.livenessWiring.scan(candidates.map((s) => s.worktreePath));
    } catch (err) {
      // tick() runs on a bare setInterval — a throw here would crash shepherd.
      // Skip the sweep and retry next cadence, same stance as the preview sweep.
      console.warn("[poller] claude-liveness sweep failed:", err);
      return;
    }
    // `null` = the snapshot backend can't support a negative verdict (darwin, no
    // recent lsof). A `false` here would DRIVE husk/stranded + auto-revive, so we
    // must NOT coerce to false. Mark every candidate unknown so the per-tick
    // `reconcileAgent` re-apply (which reads `lastClaudeAlive`) also stays silent,
    // and skip the sweep entirely. `lastClaudeAlive` is deliberately NOT cleared —
    // `restingPtyAuth` and `claudeAliveSnapshot` read the last-known values, the
    // former conservatively (a retained `false` suppresses a PTY read, never
    // manufactures one), the latter with the unknown ids filtered out.
    if (byWorktree === null) {
      this.livenessUnknown = new Set(candidates.map((s) => s.id));
      return;
    }
    this.livenessUnknown.clear();
    const known = byWorktree;
    // Sweep-on-arm: the operator just flipped auto-revive ON → dispatch for the CURRENT stranded set
    // this sweep (operator-initiated, so it bypasses the 2-sweep debounce, matching manual Resume).
    const armed = config.autoReviveEnabled && !this.lastAutoReviveEnabled;
    this.lastAutoReviveEnabled = config.autoReviveEnabled;
    const activeIds = new Set<string>();
    for (const s of candidates) {
      activeIds.add(s.id);
      const alive = known.get(s.worktreePath) ?? false;
      this.lastClaudeAlive.set(s.id, alive);
      this.updateLiveness(s, alive);
      this.maybeAutoRevive(s, armed);
    }
    for (const id of [...this.lastClaudeAlive.keys()]) {
      if (!activeIds.has(id)) {
        this.lastClaudeAlive.delete(id);
        this.lastLiveness.delete(id);
        this.strandedSweeps.delete(id);
        this.reviveGaveUp.delete(id);
      }
    }
    // Restart episode over (nothing stranded, nothing landing) → reset the outcome tally so the next
    // restart starts from zero.
    if (this.strandedCount() === 0 && this.reviveInFlight.size === 0)
      this.reviveOutcome = { revived: 0, failed: 0 };
  }

  /**
   * Autonomous auto-revive gate for one swept session. A default-account strand auto-revives once the
   * husk is stable across two consecutive sweeps (debounce) — OR immediately on `armed` (the operator
   * just flipped the toggle ON, an operator-initiated single-sweep action). Non-stranded/ineligible
   * sessions reset the debounce counter.
   */
  private maybeAutoRevive(s: Session, armed: boolean): void {
    if (this.lastLiveness.get(s.id) !== "stranded" || !isAutoRevivable(s)) {
      this.strandedSweeps.delete(s.id);
      this.reviveGaveUp.delete(s.id); // left the stranded set → a later strand starts fresh
      return;
    }
    if (this.reviveGaveUp.has(s.id)) return; // service gave up → stop re-dispatching this husk
    const n = (this.strandedSweeps.get(s.id) ?? 0) + 1;
    this.strandedSweeps.set(s.id, n);
    if (config.autoReviveEnabled && (armed || n >= 2)) this.dispatchRevive(s.id);
  }

  /**
   * Fold this session's match result (`lastMatched`) + `/proc` bit into the 3-state liveness and emit
   * on change. Called from BOTH cadences — `reconcileAgent` each tick (agent just matched) and the
   * sweep after a `/proc` flip — so the value re-emits when either input changes. A still-unknown
   * `/proc` bit (pre-first-sweep) stays silent, matching the prior emit-nothing-until-swept behavior.
   */
  private updateLiveness(s: Session, alive: boolean | undefined): void {
    if (alive === undefined) return;
    const agent = this.lastMatched.get(s.id) ?? null;
    const state = classifyLiveness(s, agent, alive);
    const prev = this.lastLiveness.get(s.id);
    if (prev === state) return;
    this.lastLiveness.set(s.id, state);
    this.livenessWiring.onChange(s.id, alive, state);
    // The stranded set grew (this session newly entered it) → coalesced daemon-restart toast.
    if (state === "stranded" && prev !== "stranded") this.onStrandedGrew?.(this.strandedCount());
  }

  /** Number of sessions currently classified `stranded`. */
  private strandedCount(): number {
    let n = 0;
    for (const v of this.lastLiveness.values()) if (v === "stranded") n++;
    return n;
  }

  /** Fire-and-forget one autonomous auto-revive, tallying the outcome PER SESSION (not per attempt):
   *  `revived` counts a healed session, `failed` counts a session the service permanently gave up on
   *  ("gaveup", also marked terminal in `reviveGaveUp` so `maybeAutoRevive` stops re-dispatching it).
   *  A plain "failed" is a retryable attempt — no tally, no emit; a later sweep re-dispatches (still
   *  capped by the service), so the counts stay aligned with distinct sessions and don't overcount. */
  private dispatchRevive(id: string): void {
    if (!this.revive || this.reviveInFlight.has(id)) return;
    this.reviveInFlight.add(id);
    this.revive(id)
      .then((result) => {
        if (result === "revived") this.reviveOutcome.revived++;
        else if (result === "gaveup") {
          this.reviveGaveUp.add(id);
          this.reviveOutcome.failed++;
        } else return; // "failed": retryable, no terminal outcome yet → don't tally or emit
        this.onAutoRevived?.(this.reviveOutcome.revived, this.reviveOutcome.failed);
      })
      .catch((err) => {
        // Unexpected throw (the service normally resolves a status, never rejects) → retryable, so it
        // is not tallied; a later sweep re-dispatches. Just surface it.
        console.warn(`[poller] auto-revive dispatch failed for ${id}:`, err);
      })
      .finally(() => this.reviveInFlight.delete(id));
  }

  /** Ids currently classified `stranded` — the set the batch "revive all" endpoint acts on. */
  strandedIds(): string[] {
    const out: string[] = [];
    for (const [id, v] of this.lastLiveness) if (v === "stranded") out.push(id);
    return out;
  }

  /** Last-swept claude-process liveness per session, for client bootstrap. Kept as the raw boolean
   *  (`/api/claude-alive` wire-format is unchanged); the new client seeds its liveness map from this
   *  and self-heals to the precise 3-state on the next `session:claude-alive` emit. */
  claudeAliveSnapshot(): Record<string, boolean> {
    // Omit ids whose liveness is currently UNKNOWN (darwin, stale/none cell). A
    // reloading client would otherwise render every retained `false` as a husk
    // badge — a negative verdict served as fact. Omission matches what a
    // pre-first-sweep client already sees.
    const out: Record<string, boolean> = {};
    for (const [id, alive] of this.lastClaudeAlive) {
      if (!this.livenessUnknown.has(id)) out[id] = alive;
    }
    return out;
  }

  /** Sessions currently in the working-while-blocked display state, for client bootstrap. */
  workingBlockedSnapshot(): Record<string, boolean> {
    return Object.fromEntries([...this.workingWhileBlocked].map((id) => [id, true]));
  }

  /**
   * The herdr agent is gone (claude exited / user ctrl-c'd the session).
   * Mirror reconcile()'s startup behavior, but live — otherwise the session
   * stays "running" forever and the pty client keeps re-attaching a dead
   * terminal (herdr replies agent_not_found in a tight reconnect loop).
   */
  private reapGone(s: Session): void {
    if (this.workingWhileBlocked.delete(s.id)) this.onWorkingBlocked(s.id, false);
    this.clearBlock(s.id);
    // Observe-only Stop↔herdr-done markers (issue #713): the agent's gone — drop both
    // without an emit (a reap is not a measurable done-flip pairing).
    this.pendingStopAt.delete(s.id);
    this.pendingDoneAt.delete(s.id);
    if (s.status !== "done") {
      this.detectUsageHalt(s);
      this.store.update(s.id, { status: "done", lastState: "done" });
      this.onChange(s.id, "done");
    }
  }

  /** Sync a live agent's status into the store and route its block/stall handling. */
  /**
   * A herdr-restored account pane (its terminalId is not the one Shepherd spawned on the owning
   * account) → fire a proactive re-drive so onSpawn re-applies the account. reDriveAccount is guarded
   * (coalesces with any concurrent resume) and bounded (gives up after CAP). Non-blocking + swallows
   * throws: tick() runs on a bare setInterval and must never throw.
   */
  private maybeReDriveRestoredAccount(s: Session, agent: HerdrAgent): void {
    if (!needsAccountRedrive(s, agent) || !this.reDrive) return;
    try {
      this.reDrive(s.id);
    } catch (err) {
      console.warn(`[poller] account re-drive dispatch failed for ${s.id}:`, err);
    }
  }

  private reconcileAgent(s: Session, agent: HerdrAgent): void {
    this.maybeReDriveRestoredAccount(s, agent);
    // Re-fold liveness against this tick's fresh match (`lastMatched`) so a herdr-restored pane's
    // strand surfaces on the match change too, not only on the next throttled /proc sweep.
    // Feed `undefined` (silent) while liveness is unknown, so a retained
    // `lastClaudeAlive` value can't drive a husk/stranded verdict every tick.
    this.updateLiveness(
      s,
      this.livenessUnknown.has(s.id) ? undefined : this.lastClaudeAlive.get(s.id),
    );
    const status = mapState(agent.agentStatus);
    const idChanged = agent.terminalId !== s.herdrAgentId;
    if (idChanged || status !== s.status || agent.agentStatus !== s.lastState) {
      this.store.update(s.id, {
        status,
        lastState: agent.agentStatus,
        ...(idChanged ? { herdrAgentId: agent.terminalId } : {}),
      });
      this.onChange(s.id, status); // nudge clients to re-attach the PTY to the fresh terminal
    }
    if (idChanged) s = { ...s, herdrAgentId: agent.terminalId };
    // Observe-only Stop↔herdr-done measurement + usage-halt detection on the done-EDGE.
    // Placed BEFORE the tryHookAwaitingBlock early-return below so a stale
    // `hookAwaitingInput` short-circuit can never swallow the measurement.
    this.handleStatusEdge(s, status);
    this.dropReadyToMergeIfActionable(s, status);
    // Left herdr-blocked (running/idle/done alike) → the working-while-blocked
    // display flag must drop in the SAME tick, not via the throttled probe paths.
    // The suppression-episode baseline goes with it (flag or not — a frozen
    // episode that already re-armed still holds one).
    if (status !== "blocked") {
      this.lastSuppressVisible.delete(s.id);
      if (this.workingWhileBlocked.delete(s.id)) this.onWorkingBlocked(s.id, false);
    }
    this.onLeaveResting(s.id, s.status, status);
    // Phase-1 push block-trigger (issue #704): a Notification awaiting-input edge
    // can classify THIS tick even before herdr latches "blocked". When it handles the
    // session (announced a block), short-circuit so the normal routing below doesn't
    // immediately wipe the just-emitted block. See tryHookAwaitingBlock.
    if (status !== "blocked" && this.tryHookAwaitingBlock(s)) return;

    if (status === "blocked") this.maybeClassify(s, s.herdrAgentId);
    else if (status === "running") this.maybeProbe(s);
    else this.maybeQuota(s, status);
    // #1891: catch the working→idle timeout (a pure absence of activity — no emission sink fires for
    // it) and seed the state after a fresh match. Block/working EDGES already pushed via
    // emitBlock/emitActivity. Skipped on the tryHookAwaitingBlock early-return above — that path is a
    // blocked edge emitBlock already handled.
    this.maybePushAgentState(s.id);
  }

  /**
   * There's a next action again → drop the manual "ready to merge" parking so the row
   * rejoins the active group. Sticky otherwise (idle/done keep it).
   */
  private dropReadyToMergeIfActionable(s: Session, status: Session["status"]): void {
    if ((status === "running" || status === "blocked") && s.readyToMerge) {
      this.store.update(s.id, { readyToMerge: false });
      this.onReady(s.id, false);
    }
  }

  /**
   * On the done-EDGE (prior status ≠ "done", new status === "done") in reconcileAgent:
   * record the Stop↔herdr-done measurement window (when hooks are enabled) and detect
   * a usage-limit halt. Extracted to keep reconcileAgent under the complexity gate.
   */
  private handleDoneEdge(s: Session): void {
    if (config.hooksSignals) this.measureStopWindow(s.id, this.now());
    this.detectUsageHalt(s);
  }

  /**
   * Halt-flag transitions at the status edge, dispatched from reconcileAgent (kept as one
   * call so that method stays under the complexity gate):
   *  - entering done  → detect a usage-limit halt (+ Stop-window measurement);
   *  - resuming work (running, by retry / resume() / drain / autopilot) → clear the flag,
   *    the single authoritative clear so a resumed session stops being badged "halted".
   */
  private handleStatusEdge(s: Session, status: Session["status"]): void {
    if (status === "done" && s.status !== "done") this.handleDoneEdge(s);
    else if (status === "running" && s.haltReason) this.clearHaltOnResume(s);
  }

  /**
   * Clear a session's usage-halt flag once it is working again. Persists null and emits
   * the clearing onHalt(null) so the delta-driven UI (the ⟳ chip, the "halted" badge,
   * RetryDialog preselect) drops it live. Gated by `s.haltReason` in the caller, so it
   * fires once — the next tick reads a null flag.
   */
  private clearHaltOnResume(s: Session): void {
    this.store.setHaltReason(s.id, null, null);
    this.onHaltCb(s.id, null, null);
  }

  /**
   * Detect a usage-limit halt at the done transition.
   *
   * Called at BOTH done-entry points (reapGone + reconcileAgent done-edge),
   * gated by `s.haltReason` being null so it only runs once per session.
   * Reads the transcript tail synchronously (bounded read — see readTranscriptTail),
   * wrapped in try/catch so a missing or unreadable file never throws into the
   * tick loop. On a confirmed halt: persists via setHaltReason and emits
   * onHalt so the UI can patch the live row.
   */
  private detectUsageHalt(s: Session): void {
    if (s.haltReason) return; // already set; skip
    try {
      const tail = readTranscriptTail(
        jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir),
      );
      // Match only NON-user transcript content: a user prompt mentioning usage-limit
      // phrasing must never be read as Claude's own halt notice (false positive on the
      // uncalibrated degrade path, where the usage corroboration is bypassed).
      const reason = classifyHalt(
        assistantSideText(tail),
        this.usageLimitsSvc.limits(this.now()),
        config.usageHoldPct,
      );
      if (reason) {
        const haltedAt = this.now();
        this.store.setHaltReason(s.id, reason, haltedAt);
        this.onHaltCb(s.id, reason, haltedAt);
      }
    } catch {
      // file may not exist for a never-run session; degrade silently
    }
  }

  /**
   * Phase-1 push block-trigger (issue #704): a Notification reported an awaiting-input
   * edge. Classify THIS tick even if herdr hasn't latched "blocked" yet, so the block
   * surfaces ≤ ~1 tick after the agent asks — independent of herdr's latchy status +
   * the PTY-regex *detection* heuristics. classifyBlocked still supplies the menu/yes-no
   * options + tail (the Notification payload has none). The PTY read stays on the TICK
   * (maybeClassify), never in the route (single-loop-no-sync-exec). Callers skip this
   * when status==="blocked" already (the normal branch classifies), to avoid a double
   * read. The marker is consumed only once a classify ACTUALLY runs (maybeClassify
   * returns true): if its reclassifyMs throttle skips this tick, we KEEP the marker and
   * retry next tick — still faster/more reliable than waiting on herdr's latchy
   * "blocked" fallback. When the type never arrives (the common skip-permissions case),
   * this is dormant and detection stays on the herdr-blocked fallback — no regression.
   *
   * Returns true when it announced an awaiting-input/menu/yes-no block (lastSig set to a
   * non-stall reason) → the caller must short-circuit: running the normal running/idle
   * routing this tick (`maybeProbe`→`applyOutcome`→`clearBlock`, or the idle-branch
   * `clearBlock`) would immediately wipe the just-emitted block. The next tick (no
   * marker) routes normally, so a resolved prompt clears via the usual path. A non-block
   * classify (e.g. a working spinner suppressed it) returns false → normal routing runs.
   */
  private tryHookAwaitingBlock(s: Session): boolean {
    if (!hookSignalsActive() || !this.hookAwaitingInput.has(s.id)) return false;
    // Consume the marker only when the classify actually ran (throttle didn't skip);
    // a throttled tick keeps the marker so the next tick retries the surface.
    if (this.maybeClassify(s, s.herdrAgentId)) this.hookAwaitingInput.delete(s.id);
    const sig = this.lastSig.get(s.id);
    return sig !== undefined && sig !== STALL_SIG;
  }

  /** Prune tracking state for sessions no longer active (archived/removed). */
  private pruneInactive(activeIds: Set<string>): void {
    const tracked = new Set([
      ...this.lastSig.keys(),
      ...this.lastReadAt.keys(),
      ...this.lastAuthMtime.keys(),
      ...this.restAuthTxn.keys(),
      ...this.restAuthPtyObserved.keys(),
      ...this.restAuthPtyConfirmed.keys(),
      ...this.lastAuthPtyAt.keys(),
      ...this.lastAuthUrlEmitted.keys(),
      ...this.lastProbeAt.keys(),
      ...this.codexCaptureBackoff.keys(),
      ...this.lastActivitySig.keys(),
      ...this.lastActivity.keys(),
      ...this.lastPushedState.keys(),
      ...this.lastActiveTurnAt.keys(),
      ...this.pushInFlight,
      ...this.liveness.keys(),
      ...this.previewStopState.keys(),
      ...this.workingWhileBlocked,
      ...this.lastSuppressVisible.keys(),
      ...this.lastHookActivityAt.keys(),
      ...this.hookTicks.keys(),
      ...this.hookAwaitingInput,
      ...this.pendingStopAt.keys(),
      ...this.pendingDoneAt.keys(),
      ...this.lastClaudeAlive.keys(),
      ...this.lastLiveness.keys(),
      ...this.strandedSweeps.keys(),
      ...this.reviveInFlight,
      ...this.reviveGaveUp,
    ]);
    for (const id of tracked) {
      if (!activeIds.has(id)) {
        this.lastReadAt.delete(id);
        this.lastSig.delete(id);
        this.lastAuthMtime.delete(id);
        this.restAuthTxn.delete(id);
        this.restAuthPtyObserved.delete(id);
        this.restAuthPtyConfirmed.delete(id);
        this.lastAuthPtyAt.delete(id);
        this.lastAuthUrlEmitted.delete(id);
        this.lastBlockReason.delete(id);
        this.lastProbeAt.delete(id);
        this.codexCaptureBackoff.delete(id);
        this.lastActivitySig.delete(id);
        this.lastActivity.delete(id);
        // #1891: lifecycle-state push tracking
        this.lastPushedState.delete(id);
        this.lastActiveTurnAt.delete(id);
        this.pushInFlight.delete(id);
        this.liveness.delete(id);
        this.previewStopState.delete(id);
        this.idleStopUnsupportedLogged.delete(id);
        this.livenessUnknown.delete(id);
        // archived/removed → no client cares anymore; drop without an emit
        this.workingWhileBlocked.delete(id);
        this.lastSuppressVisible.delete(id);
        // Phase-1 push-hook tracking (issue #704)
        this.lastHookActivityAt.delete(id);
        this.hookTicks.delete(id);
        this.hookAwaitingInput.delete(id);
        // Observe-only Stop↔herdr-done markers (issue #713)
        this.pendingStopAt.delete(id);
        this.pendingDoneAt.delete(id);
        // Liveness / auto-revive tracking (#1630)
        this.lastClaudeAlive.delete(id);
        this.lastLiveness.delete(id);
        this.strandedSweeps.delete(id);
        this.reviveInFlight.delete(id);
        this.reviveGaveUp.delete(id);
      }
    }
    // Phase-1 (issue #704): drop the HookIngest ring buffers for dead sessions too
    // (so they don't grow unbounded by session count). No-op when unwired.
    this.pruneHooks?.(activeIds);
  }

  /** Last-emitted activity signal per running session, for client bootstrap. */
  activitySnapshot(): Record<string, SessionActivity> {
    return Object.fromEntries(this.lastActivity);
  }

  /**
   * Phase-1 push activity (issue #704), fed by HookIngest.onSignal for both
   * `PostToolUse` (`status:"ok"`) and `PostToolUseFailure` (`status:"error"`). Builds
   * a `SessionActivity` from the tool name + a windowed heat-strip tick and routes it
   * through the existing dedup `emitActivity` — the SAME sink the poll path uses, so
   * push + poll never bypass the dedup or oscillate. A `PostToolUse` push carries a
   * REAL tool summary (vs. the interim heartbeat's `summary:null`), so it beats the
   * interim emit on the freshness guard below.
   *
   * No-op when `config.hooksSignals` is off (the sink is never wired in that case, so
   * this is belt-and-suspenders for direct callers/tests). Records `lastHookActivityAt`
   * so `maybeProbe` knows the push path is fresh.
   */
  ingestActivity(
    id: string,
    ev: { toolName?: string; status?: "ok" | "error"; ts?: number },
  ): void {
    if (!hookSignalsActive()) return;
    const t = ev.ts ?? this.now();
    // heat-strip: append this tick, window to STRIP_WINDOW_MS (mirrors SessionLiveness's interim heat-strip).
    // Skip a duplicate same-ms tick so two events stamped identically dedupe through
    // `emitActivity` (the strip would otherwise differ → spurious re-emit).
    const ticks = this.hookTicks.get(id) ?? [];
    if (ticks[ticks.length - 1] !== t) ticks.push(t);
    const cutoff = t - STRIP_WINDOW_MS;
    const windowed = ticks.filter((ts) => ts >= cutoff);
    this.hookTicks.set(id, windowed);
    // recentErrTs: only the error ticks within the window (a failure feeds error heat
    // via the push path so the freshness guard below can safely suppress the probe's
    // redundant emit without dropping error signal — Finding 3). We don't retain a
    // separate error-tick list across calls (the strip is coarse + windowed), so a
    // single push contributes its own `t` to recentErrTs when it's an error.
    const recentErrTs = ev.status === "error" ? [t] : [];
    this.emitActivity(id, {
      lastActivityTs: t,
      // A real tool name — non-null so it beats the interim `summary:null` heartbeat.
      // We don't have rich tool_input here; the bare tool name is the available summary.
      summary: ev.toolName ?? null,
      recentTs: windowed,
      recentErrTs,
    });
    this.lastHookActivityAt.set(id, t);
  }

  /**
   * Phase-1 push notification (issue #704), fed by HookIngest.onSignal for
   * `Notification` events. An awaiting-input type (see BLOCK_NOTIFICATION_TYPES) sets a
   * marker consumed by `reconcileAgent` to classify THIS tick — surfacing the block
   * ≤ ~1 tick after the agent asks, independent of herdr's latchy `blocked` status.
   * `idle_prompt` clears the marker (idle is handled by herdr mapping; never force a
   * block). Any other type is a no-op here — unknown types are already logged upstream,
   * and an awaiting-input edge we haven't confirmed simply stays on the existing
   * `herdr-blocked → classifyBlocked` fallback (no regression).
   *
   * No-op when `config.hooksSignals` is off.
   */
  ingestNotification(id: string, type: string): void {
    if (!hookSignalsActive()) return;
    if (BLOCK_NOTIFICATION_TYPES.has(type)) this.hookAwaitingInput.add(id);
    else if (type === "idle_prompt") this.hookAwaitingInput.delete(id);
    // else: unknown/other type → no-op (dormant; fallback detection unchanged).
  }

  /**
   * Phase-2 push lifecycle (issue #709): a SessionStart hook confirms the agent booted.
   * Flips claude-liveness → true immediately (ahead of the throttled liveness sweep),
   * reusing the sweep's own map + flip-dedup so push + poll never double-emit. Boot
   * liveness is monotonic (true until exit), so this cannot oscillate with the sweep,
   * which will agree (the process is alive — the hook fired from inside it). No-op when
   * `config.hooksSignals` is off.
   * (Stop/SessionEnd consumption is deferred to #713 — observe-only this phase.)
   */
  ingestSessionStart(id: string): void {
    if (!hookSignalsActive()) return;
    // A live SessionStart hook fired from inside the process → it's alive (liveness is always "alive"
    // when the /proc bit is true). Keep both maps in sync and emit the additive 3-arg signal.
    if (this.lastLiveness.get(id) !== "alive") {
      this.lastClaudeAlive.set(id, true);
      this.lastLiveness.set(id, "alive");
      this.livenessWiring.onChange(id, true, "alive");
    }
  }

  /**
   * Observe-only Stop measurement (issue #713), fed by HookIngest.onSignal for `Stop`
   * events. Records the Stop's receive time as one half of the Stop↔herdr-done pairing.
   * If a done-flip is already pending within the horizon, herdr won this turn's race —
   * emit the (≤0) window immediately and clear the pending done. Otherwise park the Stop
   * so the next done-flip in `measureStopWindow` can pair it (a stale prior pending stop
   * is silently overwritten — Stop is a per-turn edge, only the latest matters).
   *
   * Pure measurement: never touches status, routing, or any block/activity state — polling
   * stays authoritative. No-op when `config.hooksSignals` is off.
   */
  ingestStopMeasure(id: string, stopAt: number): void {
    if (!config.hooksSignals) return;
    const d = this.pendingDoneAt.get(id);
    if (d !== undefined && stopAt - d <= STOP_WINDOW_MAX_MS) {
      // herdr-wins: the done-flip preceded this Stop (window ≤ 0).
      this.onStopWindow?.(id, d - stopAt);
      this.pendingDoneAt.delete(id);
    } else {
      this.pendingStopAt.set(id, stopAt);
    }
  }

  /**
   * Observe-only done-edge half of the Stop↔herdr-done pairing (issue #713), called from
   * `reconcileAgent` on a done-flip. If a Stop is already pending within the horizon, Stop
   * won this turn's race — emit the (≥0) window and clear it. Otherwise park the done as
   * pending so a later `ingestStopMeasure` can pair it; if a prior pending done is being
   * superseded (it never paired) emit a `null` for it first, then record this one.
   *
   * Pure measurement: never touches status, onChange, or routing — emit + marker
   * bookkeeping only.
   */
  private measureStopWindow(id: string, doneAt: number): void {
    const st = this.pendingStopAt.get(id);
    if (st !== undefined && doneAt - st <= STOP_WINDOW_MAX_MS) {
      // stop-wins: the Stop preceded this done-flip (window ≥ 0).
      this.onStopWindow?.(id, doneAt - st);
      this.pendingStopAt.delete(id);
    } else {
      // No pairable Stop. A prior pending done is being superseded by this fresh one and
      // never paired → emit null for it before overwriting.
      if (this.pendingDoneAt.has(id)) this.onStopWindow?.(id, null);
      this.pendingDoneAt.set(id, doneAt);
    }
  }

  /**
   * Per-tick expiry sweep for the observe-only Stop↔done markers (issue #713). A pending
   * done that aged past the horizon never paired with a Stop → emit `null` (no-stop) and
   * drop it. A pending Stop that aged out is dropped SILENTLY — a Stop with no done-flip is
   * not a done-flip and emits nothing. Inert when `config.hooksSignals` is off (callers gate).
   */
  private expireStaleStopWindows(): void {
    const now = this.now();
    for (const [id, doneAt] of this.pendingDoneAt) {
      if (now - doneAt > STOP_WINDOW_MAX_MS) {
        this.onStopWindow?.(id, null);
        this.pendingDoneAt.delete(id);
      }
    }
    for (const [id, stopAt] of this.pendingStopAt) {
      if (now - stopAt > STOP_WINDOW_MAX_MS) this.pendingStopAt.delete(id);
    }
  }

  /**
   * Unified per-tick probe for a *running* agent: a SINGLE read+parse of its
   * transcript feeds BOTH the activity signal and the stall decision, replacing
   * the two redundant whole-file reads we used to do per poll. Throttled to
   * `probeCheckMs` per session via one `lastProbeAt` map; best-effort (a throwing
   * probe is logged and skipped until the next cadence).
   *
   * Delegates the transcript-vs-interim liveness routing + both liveness diffs +
   * the interim heat-strip to this session's `SessionLiveness` instance (see
   * `src/session-liveness.ts`) — the module returns a verdict (`step`), which
   * `applyOutcome` maps onto the poller's unchanged fire/clear emitters. The
   * transcript path resolves synchronously ({outcome}); the interim path returns
   * a module-owned Promise ({pending}) resolved fire-and-forget.
   *
   * Stall: a working agent whose transcript has gone silent past the stall
   * window (no new tool-use; a running tool is excluded until the hung-command
   * ceiling) is only a *candidate*, confirmed with a live-terminal liveness diff
   * (module-owned) — only a frozen buffer + a silent transcript is a real stall.
   * Surfaces as a "needs you" reason; fires once per episode (guarded by
   * `lastSig === STALL_SIG`, still owned by the poller) until the turn
   * progresses, then re-arms.
   */
  private maybeProbe(s: Session): void {
    const t = this.now();
    if (t - (this.lastProbeAt.get(s.id) ?? 0) < this.probeCheckMs) return;
    this.lastProbeAt.set(s.id, t);
    let signals: TranscriptSignals;
    try {
      signals = this.probe(s);
    } catch (err) {
      console.warn(`[poller] transcript probe failed for ${s.id}:`, err);
      return; // best-effort; retry next cadence
    }
    const hookFresh = this.hookActivityFresh(s.id, t);
    const step = this.livenessFor(s.id).step(s.herdrAgentId, signals, t, hookFresh);
    if ("outcome" in step) {
      // transcript path: poller owns the transcript activity emit (unchanged gating), then
      // the verdict. Phase-1 freshness guard (issue #704, Finding 3): when push activity is
      // fresh, the push path already carries this session with a REAL tool summary (vs. the
      // transcript probe's), so skip the probe's redundant *non-error* activity emit. Error
      // heat is NEVER dropped: `PostToolUseFailure` feeds `recentErrTs` via the push path, so
      // suppression is safe — and as a belt-and-suspenders guard, if the probe carries error
      // heat the push hasn't emitted, we still emit it.
      if (signals.activity && !(hookFresh && signals.activity.recentErrTs.length === 0)) {
        this.emitActivity(s.id, signals.activity);
      }
      this.applyOutcome(s, step.outcome);
    } else {
      void step.pending.then((o) => this.applyOutcome(s, o));
    }
  }

  /**
   * Map a `SessionLiveness` verdict onto the poller's unchanged fire/clear
   * emitters, preserving today's exact ordering (stale-sig guard → heartbeat →
   * stall). `clearStaleBlock` mirrors the old `probeTerminalInterim`'s guard: a
   * running agent must not carry a stale *non-stall* block sig left over from a
   * prior blocked state.
   */
  private applyOutcome(s: Session, o: LivenessOutcome): void {
    if (o.clearStaleBlock) {
      if (this.lastSig.has(s.id) && this.lastSig.get(s.id) !== STALL_SIG) this.clearBlock(s.id);
    }
    if (o.activity) this.emitActivity(s.id, o.activity);
    switch (o.verdict) {
      case "fire":
        this.fireStall(s.id, o.visible!);
        break;
      case "clearStall":
        this.clearStall(s.id);
        break;
      case "clearBroad":
        this.clearBlock(s.id);
        break;
      case "none":
        break;
    }
  }

  /**
   * Phase-1 (issue #704): is the push (PostToolUse) activity for this session fresh
   * enough that the transcript/interim probe should defer its redundant activity emit?
   * Fresh = a push landed within `2 × probeCheckMs` (two probe cadences — long enough
   * to bridge the gap between two pushes, short enough that a gone-quiet push hands the
   * active path back to the probe). Always false when `hooksSignals` is off (the map
   * stays empty), so the probe emits exactly as today — the fallback.
   */
  private hookActivityFresh(id: string, now: number): boolean {
    if (!config.hooksSignals) return false;
    const at = this.lastHookActivityAt.get(id);
    return at !== undefined && now - at < 2 * this.probeCheckMs;
  }

  /** Single sink for block emissions: keep the `lastBlockReason` snapshot map in step
   *  (set on a reason, delete on clear) and forward to the injected `onBlock`. All block
   *  fire/clear paths route through here so a fresh client can bootstrap current blocks. */
  private emitBlock(id: string, block: BlockReason | null): void {
    if (block) this.lastBlockReason.set(id, block);
    else this.lastBlockReason.delete(id);
    this.onBlock(id, block);
    // #1891: mirror the block/unblock EDGE to herdr on the same tick. Driven from this sink (not a
    // post-routing call in reconcileAgent) so a hook-driven awaiting-input block that early-returns at
    // `tryHookAwaitingBlock` still pushes `blocked` immediately, not a tick late.
    this.maybePushAgentState(id);
  }

  /** Last-emitted block reason per session, for client bootstrap. */
  blockSnapshot(): Record<string, BlockReason> {
    return Object.fromEntries(this.lastBlockReason);
  }

  /** Emit an activity signal, deduped by content so clients see only real changes. */
  private emitActivity(id: string, activity: SessionActivity): void {
    // #1891: any activity detected this probe refreshes the working-signal stamp — even a
    // content-deduped repeat, since the turn is still live (the client emit is deduped, the stamp
    // is not).
    this.lastActiveTurnAt.set(id, this.now());
    const sig = JSON.stringify(activity);
    if (sig !== this.lastActivitySig.get(id)) {
      this.lastActivitySig.set(id, sig);
      this.lastActivity.set(id, activity);
      this.onActivity(id, activity);
    }
    this.maybePushAgentState(id);
  }

  /** True when the session shows a FRESH active turn — a hook activity OR a probe/transcript activity
   *  emit within the last two probe cadences. The `lastActiveTurnAt` half is set in `emitActivity`,
   *  which runs on the `maybeProbe` path that drives the frozen-`working` route, so this does not
   *  depend on hooks being on. A session we have NEVER observed a turn for reads working (not idle):
   *  it was just registered `working`, and a spawning agent works before it rests — so this avoids a
   *  spurious `working→idle→working` flap at startup, before the first probe/activity lands. */
  private isActiveTurnFresh(id: string, now: number): boolean {
    if (this.hookActivityFresh(id, now)) return true;
    const at = this.lastActiveTurnAt.get(id);
    if (at === undefined) return true;
    return now - at < 2 * this.probeCheckMs;
  }

  /**
   * Push Shepherd's own derived lifecycle state to herdr for an externally-registered SANDBOXED 0.7.5
   * session (issue #1891). herdr can't observe a `bwrap`'d agent, so it freezes `agent_status` at the
   * value the spawn pinned; Shepherd owns the lifecycle and reports it here. Idempotent + push-on-
   * change from the block + active-turn signals; best-effort + fire-and-forget (a report failure must
   * never throw in the 1s tick). The pane target comes from THIS tick's match.
   *
   * Gated to sandboxed only. A TRUSTED 0.7.5 agent is NOT registered — herdr auto-detects and owns
   * its status (≤0.7.4 parity), so a push here would claim authority and freeze herdr's detection.
   *
   * KNOWN LIMITATION (herdr 0.7.5): herdr accepts a working/blocked report but REFUSES to let a
   * client de-escalate an authority-held agent back to `idle` (verified: correct label + matching
   * agent-session-id + max seq all fail to move it). So a sandboxed agent's `idle` is not reportable —
   * it reads `working` until it blocks or exits. Closing this needs an herdr-side change (accept a
   * client de-escalation, or let a client hand a wrapped pane to herdr's own detection).
   */
  private maybePushAgentState(id: string): void {
    if (!herdrUsesExternalRegistrationSpawn()) return;
    const agent = this.lastMatched.get(id);
    if (!agent || !agent.paneId) return;
    const s = this.store.get(id);
    // Only sandboxed sessions are Shepherd-owned. Trusted 0.7.5 agents are unregistered and
    // herdr-detected — pushing would claim authority and freeze them (see isSandboxedSession).
    if (!s || !isSandboxedSession(s)) return;
    const state = deriveHerdrState({
      blocked: this.lastBlockReason.has(id),
      working: this.isActiveTurnFresh(id, this.now()),
    });
    if (this.lastPushedState.get(id) === state) return;
    if (this.pushInFlight.has(id)) return; // a push is serializing; its resolution re-evaluates
    this.pushInFlight.add(id);
    this.lastPushedState.set(id, state);
    // herdr stores the registered label in its `agent` field; the list's `name` is null for
    // externally-registered agents, so `agent.name` was empty — every push failed on `--agent `
    // (issue #1891 was inert against real herdr). Report under the SAME label spawn registered
    // (`sanitizeHerdrAgentName(session.name)`), which `report-agent` matches to update the state.
    void this.herdr.reportAgentState(agent.paneId, sanitizeHerdrAgentName(s.name), state).then(
      () => {
        this.pushInFlight.delete(id);
        // Re-evaluate: the derived state may have changed while this push was in flight (pushes are
        // serialized so they can't reorder on herdr). Converges — a no-op once the state is stable.
        this.maybePushAgentState(id);
      },
      (err) => {
        // Roll back so a LATER tick retries rather than sticking on a value herdr never received. Do
        // NOT re-invoke here — a persistently failing report would otherwise spin as fast as each
        // call settles; the next 1s tick paces the retry.
        this.lastPushedState.delete(id);
        this.pushInFlight.delete(id);
        console.warn(`[poller] report-agent state push failed for ${id}:`, err);
      },
    );
  }

  /** Clear a live stall flag (no-op if none); leaves the terminal baseline intact. */
  private clearStall(id: string): void {
    if (this.lastSig.get(id) !== STALL_SIG) return;
    this.lastSig.delete(id);
    this.lastReadAt.delete(id);
    this.emitBlock(id, null);
  }

  /** Emit a stall block once per episode (guarded by `lastSig === STALL_SIG`). */
  private fireStall(id: string, visible: string): void {
    if (this.lastSig.get(id) === STALL_SIG) return; // already announced this episode
    this.lastSig.set(id, STALL_SIG);
    this.emitBlock(id, { shape: "stall", options: [], tail: tailLines(visible) });
  }

  /**
   * Read + classify a blocked agent at most every `reclassifyMs`; emit only on change.
   * An `awaiting-input` fallback is suppressed (and any announced block cleared once)
   * while the TUI shows an active turn spinner — herdr can latch "blocked" after an
   * answered dialog even though the agent resumed working. Continued suppression
   * additionally requires FRESHNESS: a live spinner ticks its elapsed/token counters,
   * so the visible buffer advances between classify reads — an identical buffer means
   * a wedged turn (or a static tail merely quoting a spinner-like line) and falls
   * through to the normal emit, re-arming the block instead of suppressing forever.
   * The first sighting of an episode gets a one-cadence grace (nothing to compare
   * yet; the common case is a genuinely working spinner). The suppression episode
   * is surfaced as the working-while-blocked display flag: `onWorkingBlocked(id, true)`
   * once on entry; on re-arm (any block that will be emitted) `onWorkingBlocked(id,
   * false)` fires first, then `onBlock`, in the same tick — clients see the flag drop
   * and the block land together.
   */
  private maybeClassify(s: Session, term: string): boolean {
    const id = s.id;
    const t = this.now();
    // Throttled this tick → did NOT look (caller may keep an awaiting marker to retry).
    if (t - (this.lastReadAt.get(id) ?? 0) < this.reclassifyMs) return false;
    this.lastReadAt.set(id, t);
    let visible: string;
    let reason: BlockReason;
    try {
      visible = this.herdr.read(term, "visible");
      reason = this.classify(visible);
    } catch (err) {
      console.warn(`[poller] classify failed for ${id}:`, err);
      return false; // best-effort; retry next cadence (didn't classify → didn't look)
    }
    if (reason.shape === "awaiting-input" && hasActiveSpinner(visible)) {
      // herdr can latch "blocked" after an answered dialog; a live spinner means the
      // agent resumed working — clear any announced block instead of emitting the
      // no-evidence fallback. (suppression scoped to awaiting-input only: a genuine
      // menu/y-n dialog must always surface, spinner or not)
      if (this.trySuppressSpinner(id, visible)) return true; // looked this tick (suppressed emit)
      // Freshness gate tripped: the buffer did NOT advance since the last classify
      // read — a wedged turn or a static buffer quoting a spinner-like line, not a
      // live spinner. Fall through to the normal emit so the block re-arms (flag-off
      // before the block, below). `lastSuppressVisible` is deliberately KEPT: while
      // the buffer stays frozen, every subsequent read lands here and dedupes on
      // `lastSig` — deleting it would re-grant first-sighting grace each cadence
      // (suppress/re-arm oscillation).
    } else {
      // Suppression context over (spinner gone, or a genuine menu/y-n dialog) →
      // drop the episode memory so the next spinner sighting gets a fresh grace.
      this.lastSuppressVisible.delete(id);
    }
    // Awaiting-input blocks may be an MCP OAuth prompt: attach the full authorize URL from
    // the transcript (Claude word-wraps it un-clickably in the PTY). Gated to awaiting-input
    // so a menu/y-n block never triggers the read; the read is bounded + throttled by the
    // reclassifyMs gate above. `authUrl` is part of `reason`, so it rides the lastSig dedup
    // and the block snapshot for free; null ⇒ field omitted (not an auth prompt).
    if (reason.shape === "awaiting-input") {
      // Transcript first (MCP OAuth). If none, fall back to reconstructing a `/login` account URL
      // from the visible buffer we already read — covers a login modal herdr happens to classify
      // as `blocked`. Run it through the SAME two-read stability gate as the resting path
      // (`confirmLoginUrl`) so a mid-paint truncated authorize URL never surfaces for a cadence.
      // Cache the REAL tail (`reason.tail`, i.e. `tailLines(visible)`), not a placeholder: the
      // confirmed cache is shared with the resting path, and a `blocked → idle` transition (not a
      // leave-resting edge, so caches persist) inherits this entry — an empty tail would surface a
      // context-less banner that the URL-keyed re-emit gate never corrects.
      const authUrl =
        this.detectAuth(s) ??
        this.confirmLoginUrl(id, { url: detectLoginAuthUrl(visible), tail: reason.tail })?.url;
      if (authUrl) reason.authUrl = authUrl;
    }
    const sig = JSON.stringify(reason);
    if (sig === this.lastSig.get(id)) return true; // looked this tick (dedup short-circuit)
    // Re-arm: a block is about to be emitted → end the suppression episode FIRST so
    // the flag-off and the block reach clients in the same tick, in that order.
    if (this.workingWhileBlocked.delete(id)) this.onWorkingBlocked(id, false);
    this.lastSig.set(id, sig);
    this.emitBlock(id, reason);
    return true; // looked + classified this tick
  }

  /**
   * Freshness-gated spinner suppression for `maybeClassify`. Records `visible`
   * as the episode baseline and returns true when the buffer is FRESH — first
   * sighting (one-cadence grace; nothing to compare yet) or advanced since the
   * previous read (a live spinner ticking its counters) — having suppressed the
   * fallback: any announced block is cleared once and the working-while-blocked
   * flag turned on (a re-entry after a frozen re-arm lands here too). Returns
   * false when the buffer is FROZEN (identical to the previous read — a wedged
   * turn or a static tail quoting a spinner-like line): no suppression, the
   * caller falls through to the normal emit and re-arms the block.
   */
  private trySuppressSpinner(id: string, visible: string): boolean {
    const prev = this.lastSuppressVisible.get(id);
    this.lastSuppressVisible.set(id, visible);
    if (prev !== undefined && prev === visible) return false; // frozen → re-arm
    if (this.lastSig.has(id)) {
      this.lastSig.delete(id);
      this.emitBlock(id, null);
    }
    if (!this.workingWhileBlocked.has(id)) {
      this.workingWhileBlocked.add(id);
      this.onWorkingBlocked(id, true); // once per episode, not per cadence
    }
    return true;
  }

  /**
   * Manually clear a *stall* flag without re-arming it: broadcasts the clear but
   * keeps `lastSig` so `maybeProbe`'s once-per-episode guard suppresses an
   * immediate re-fire. The episode re-arms on its own when activity resumes
   * (a `clearBroad`/`clearStall` verdict from `SessionLiveness` routes through
   * `applyOutcome` to `clearBlock`), so a later genuine stall still surfaces.
   * No-op (returns false) unless a stall is live.
   */
  acknowledgeStall(id: string): boolean {
    if (this.lastSig.get(id) !== STALL_SIG) return false;
    this.emitBlock(id, null);
    return true;
  }

  private clearBlock(id: string): void {
    this.liveness.get(id)?.clearTranscriptBaseline(); // reset the stall liveness baseline regardless of block state
    this.lastSuppressVisible.delete(id); // and the spinner-suppression episode baseline
    // The shown-auth-URL marker follows the block (not the detection caches, which the
    // leave-resting edge owns) — drop it so the next auth block re-emits cleanly.
    this.lastAuthUrlEmitted.delete(id);
    if (!this.lastSig.has(id)) return;
    this.lastSig.delete(id);
    this.lastReadAt.delete(id);
    this.emitBlock(id, null);
  }

  /**
   * Idle/done branch: evaluate quota exhaustion. Emits a quota block once per episode
   * (deduped via QUOTA_SIG in lastSig) and clears it when the exhaustion resolves.
   * When a quota-carrying session transitions to running, the running-path
   * `clearStaleBlock` guard (applyOutcome, sourced from the interim path's stale-sig
   * check) clears the now-stale nudge (that guard is deliberately NOT exempted for
   * QUOTA_SIG — see brief for rationale).
   */
  private maybeQuota(s: Session, status: Session["status"]): void {
    const reason = quotaBlockReason(
      { ...s, status },
      this.store.getReview(s.id),
      this.store.getPlanGate(s.id),
      this.now(),
    );
    if (reason) {
      if (this.lastSig.get(s.id) !== QUOTA_SIG) {
        this.lastSig.set(s.id, QUOTA_SIG);
        this.emitBlock(s.id, reason);
      }
    } else if (!this.maybeAuthAtRest(s)) {
      this.clearBlock(s.id);
    }
  }

  /**
   * A resting (done/idle) session can be sitting on an MCP OAuth prompt: the agent printed an
   * `…/authorize?…` URL and ended its turn, so herdr reports `done`/`idle` (never `blocked`) and
   * the normal `maybeClassify` auth-detection path never runs. Surface it as an `awaiting-input`
   * block carrying `authUrl` so the banner + attention-lens row appear (feat #1436).
   *
   * Returns true when an auth block stands (freshly emitted or preserved) so `maybeQuota` skips
   * its `clearBlock`. Bounded + throttled: the (512 KB) tail read fires only when the transcript
   * mtime CHANGED since the last probe — a static parked transcript costs one `stat`, no read.
   *
   *  - transcript unchanged ⇒ preserve whatever stands (no read);
   *  - a fresh read with a pending URL ⇒ emit once (AUTH_SIG) and hold;
   *  - a fresh read with NO URL ⇒ return false so the caller clears (self-clears AT REST when the
   *    operator's paste appends a record and bumps mtime — no `running` transition required);
   *  - a first-tick miss (URL not flushed yet) does NOT latch: the next append re-probes.
   */
  private maybeAuthAtRest(s: Session): boolean {
    const id = s.id;
    // Transcript source (MCP-at-rest) takes precedence; the PTY source (`/login`) is consulted
    // only when the transcript has no URL. Each helper owns its own cost gate.
    const txn = this.restingTxnAuth(s);
    const src = txn.url ? txn : this.restingPtyAuth(id, s.herdrAgentId);
    if (!src.url) return false; // neither source pending → caller (maybeQuota) clears the block

    // Emit on first stand OR when the URL changed (AUTH_SIG is value-blind, so track the shown
    // URL and re-emit on a correction). A standing, unchanged URL dedupes to a no-op.
    if (this.lastSig.get(id) !== AUTH_SIG || this.lastAuthUrlEmitted.get(id) !== src.url) {
      this.lastSig.set(id, AUTH_SIG);
      this.lastAuthUrlEmitted.set(id, src.url);
      this.emitBlock(id, {
        shape: "awaiting-input",
        options: [],
        tail: src.tail,
        authUrl: src.url,
      });
    }
    return true;
  }

  /** Transcript (MCP-at-rest) auth source: re-read only on transcript-mtime change; cached. */
  private restingTxnAuth(s: Session): { url: string | null; tail: string[] } {
    const id = s.id;
    const mtime = this.authMtime(s);
    if (!this.lastAuthMtime.has(id) || mtime !== this.lastAuthMtime.get(id)) {
      this.lastAuthMtime.set(id, mtime);
      this.restAuthTxn.set(id, this.detectRestingAuth(s));
    }
    return this.restAuthTxn.get(id) ?? { url: null, tail: [] };
  }

  /**
   * PTY (`/login`) auth source: the URL is PTY-only and never bumps the transcript mtime, so probe
   * the visible buffer on its own throttle (`reclassifyMs`). The read is ASYNC (`readAsync` — the
   * poll-loop convention; a sync read under the resting-session fan-out would freeze the live web
   * terminal) and fire-and-forget: `probePtyAuth` resolves into the observed/confirmed caches, and
   * this returns the currently CONFIRMED reconstruction (two equal reads) for the tick to consume.
   */
  private restingPtyAuth(id: string, term: string): { url: string | null; tail: string[] } {
    // Cheap pre-guard: a `/login` modal requires a LIVE claude process, so skip the read (and drop
    // any stale confirmation) for a husk session whose claude has exited — bounds the added
    // per-cadence herdr reads to resting sessions that could actually be at a prompt. `undefined`
    // (not yet swept) is treated as maybe-alive so detection isn't missed before the first sweep.
    if (this.lastClaudeAlive.get(id) === false) {
      this.restAuthPtyObserved.delete(id);
      this.restAuthPtyConfirmed.delete(id);
      return { url: null, tail: [] };
    }
    const t = this.now();
    if (t - (this.lastAuthPtyAt.get(id) ?? 0) >= this.reclassifyMs) {
      this.lastAuthPtyAt.set(id, t);
      void this.probePtyAuth(id, term);
    }
    return this.restAuthPtyConfirmed.get(id) ?? { url: null, tail: [] };
  }

  /**
   * Async PTY probe for `maybeAuthAtRest`'s login source: read the visible buffer, reconstruct a
   * word-wrapped `/login` authorize URL, and run it through the shared stability gate. Fire-and-
   * forget (mirrors `maybeProbe`'s interim `readAsync().then()`); `confirmLoginUrl` resolves it
   * into the observed/confirmed caches the tick consumes.
   */
  private async probePtyAuth(id: string, term: string): Promise<void> {
    try {
      const v = await this.herdr.readAsync(term, "visible");
      this.confirmLoginUrl(id, { url: detectLoginAuthUrl(v), tail: tailLines(v) });
    } catch {
      // best-effort; retry next cadence
    }
  }

  /**
   * Two-read stability gate for a reconstructed `/login` URL, shared by the resting (async) and
   * blocked (sync) paths so NEITHER surfaces a still-painting partial. Records `recon` as the
   * latest observation and returns/caches a confirmed URL only once it equals the immediately-
   * preceding reconstruction (two consecutive equal reads — a first, still-painting URL that
   * passes `isAuthUrl` while truncated never latches). A NULL reconstruction (panel gone) clears
   * the confirmation IMMEDIATELY (no second read): the real completion path, since a finished
   * `/login` commonly returns to idle/done without a running/blocked edge. While unstable it
   * returns any PRIOR confirmation (value-aware correction still lands once the new URL confirms).
   */
  private confirmLoginUrl(
    id: string,
    recon: { url: string | null; tail: string[] },
  ): { url: string; tail: string[] } | null {
    const prev = this.restAuthPtyObserved.get(id);
    this.restAuthPtyObserved.set(id, recon.url);
    if (recon.url === null) {
      this.restAuthPtyConfirmed.delete(id);
      return null;
    }
    if (prev === recon.url) {
      const confirmed = { url: recon.url, tail: recon.tail };
      this.restAuthPtyConfirmed.set(id, confirmed);
      return confirmed;
    }
    return this.restAuthPtyConfirmed.get(id) ?? null;
  }

  /**
   * Leave-resting edge (idle/done → running/blocked): drop the resting-auth DETECTION caches so a
   * resumed-then-re-rested session re-probes fresh and never re-emits a stale confirmed `/login`
   * URL. Hygiene only — the banner CLEAR itself is driven by a null PTY read (a completed `/login`
   * often returns to idle/done without ever flipping to running/blocked, so this edge would not
   * fire for it). Kept OUT of `clearBlock` on purpose: `maybeQuota` calls `clearBlock` every
   * resting tick with no auth, and resetting the throttle/stability there would defeat the
   * two-read gate (see `maybeAuthAtRest`).
   */
  private onLeaveResting(id: string, prev: Session["status"], next: Session["status"]): void {
    const leaving =
      (next === "running" || next === "blocked") && (prev === "idle" || prev === "done");
    if (leaving) this.clearRestingAuthState(id);
  }

  /** Drop the resting-auth DETECTION caches for a session (leave-resting edge + prune). Does NOT
   *  touch the standing block or `lastAuthUrlEmitted` — those follow the block via `clearBlock`. */
  private clearRestingAuthState(id: string): void {
    this.restAuthTxn.delete(id);
    this.restAuthPtyObserved.delete(id);
    this.restAuthPtyConfirmed.delete(id);
    this.lastAuthPtyAt.delete(id);
    this.lastAuthMtime.delete(id);
  }

  /**
   * Throttle + re-entrancy gate for the async preview sweep.
   * Called from tick() after the session loop with the already-fetched sessions list
   * (no second store.list()). Fire-and-forget — never awaited, never throws to the caller.
   */
  private maybeRunPreviewSweep(sessions: Session[]): void {
    const t = this.now();
    if (t - this.lastPreviewSweepAt < this.previewWiring.sweepMs) return;
    if (this.previewSweeping) return;

    // Isolated sessions with a worktreePath are the candidates.
    const isolated = sessions.filter((s) => s.isolated && s.worktreePath);

    if (isolated.length === 0) {
      // No candidates: converge([]) cheap-tears-down any stale listeners.
      // No /proc scan needed.
      this.lastPreviewSweepAt = t;
      this.previewWiring.service.converge([]);
      return;
    }

    this.lastPreviewSweepAt = t;
    this.previewSweeping = true;
    void this.runPreviewSweep(isolated)
      .catch((err) => {
        console.warn("[poller] preview sweep failed:", err);
      })
      .finally(() => {
        this.previewSweeping = false;
      });
  }

  /**
   * Async core of the preview sweep. Builds the /proc map ONCE, picks a primary
   * port per session, then calls converge() on the full active set. The PreviewService
   * handles bind/teardown transitions and fires onChange on real changes — the poller
   * does NOT dedupe or emit directly.
   */
  private async runPreviewSweep(isolated: Session[]): Promise<void> {
    const now = this.now();
    const worktrees = isolated.map((s) => s.worktreePath);
    // Single /proc scan for ALL sessions — never once per session.
    const portsMap = this.previewWiring.scan(worktrees);

    // `null` = the snapshot backend can't support a negative verdict (darwin,
    // stale/none cell). An empty/partial map here would drive `converge` to tear
    // down bound previews, so return WITHOUT converging: leave every bound listener
    // in place until the cell is fresh again.
    if (portsMap === null) return;

    const active: Array<{ sessionId: string; devPort: number }> = [];
    for (const s of isolated) {
      const ports = portsMap.get(s.worktreePath) ?? [];
      const devPort = await this.previewWiring.pick(ports, s.worktreePath);
      if (devPort === null) {
        // Server is gone — clear any escalation state and skip (converge will release it).
        this.previewStopState.delete(s.id);
        this.idleStopUnsupportedLogged.delete(s.id);
        continue;
      }

      const idleMs = this.previewWiring.idleStop?.idleMs ?? 0;
      if (idleMs > 0) {
        // FRESH read from store — NOT s.status (stale: store.update doesn't mutate the hydrated object)
        const status = this.store.get(s.id)?.status;
        const idle = this.previewWiring.service.idleSince?.(s.id, now) ?? null;
        if ((status === "idle" || status === "done") && idle !== null && idle >= idleMs) {
          this.escalateIdleStop(s.id, devPort);
          // Keep the session in `active` so the next sweep can observe whether the port
          // died and escalate; the preview clears only when the port actually disappears.
        } else {
          this.previewStopState.delete(s.id); // recovered: viewed again / resumed / not stale → reset episode
          this.idleStopUnsupportedLogged.delete(s.id);
        }
      }

      active.push({ sessionId: s.id, devPort });
    }

    // converge releases sessions absent from `active` and ensures those present.
    // onChange (wired in index.ts) emits session:preview on real transitions only.
    this.previewWiring.service.converge(active);
  }

  /** Advance the SIGTERM→SIGKILL→give-up escalation for an idle, no-viewer preview.
   *  First sighting (or a changed devPort) → SIGTERM. Still up after SIGTERM → SIGKILL.
   *  Still up after SIGKILL → log once and stop signalling (leave it bound/viewable).
   *  `idleStop` is guaranteed present (caller checks idleMs > 0, which requires it).
   *
   *  GRACE WINDOW: one step advances per preview sweep, so the gap between SIGTERM
   *  and SIGKILL is ~one sweep cadence (`previewSweepMs`, default 4s) — the dev
   *  server's window to exit gracefully. That's ample for typical dev servers
   *  (Vite/Next/webpack exit promptly on SIGTERM; the SIGKILL is a safety net for
   *  ones that ignore it). The window is coupled to the sweep cadence by design —
   *  lowering `previewSweepMs` shrinks it; if a future caller needs a fixed grace
   *  independent of the cadence, stamp the SIGTERM time in `previewStopState` and
   *  gate the SIGKILL on elapsed-ms instead of next-sweep. */
  private escalateIdleStop(sessionId: string, devPort: number): void {
    const idleStop = this.previewWiring.idleStop!;
    const st = this.previewStopState.get(sessionId);
    const nextSignal: NodeJS.Signals =
      st && st.devPort === devPort && st.level === "term" ? "SIGKILL" : "SIGTERM";
    // The "give up" rung sends nothing; short-circuit before calling stop.
    if (st && st.devPort === devPort && st.level === "kill") {
      if (!st.gaveUp) {
        console.warn(
          `[preview] idle-stop could not reclaim ${sessionId} on :${devPort} after SIGKILL`,
        );
        st.gaveUp = true;
      }
      return;
    }
    const outcome = idleStop.stop(sessionId, nextSignal);
    // No signal authority on this host (darwin): NOTHING was signalled, so the
    // ladder must NOT advance — otherwise three sweeps would burn SIGTERM→SIGKILL→
    // gaveUp and log "could not reclaim" without ever having sent a signal. Log the
    // reason once per episode and leave `previewStopState` untouched, so a later
    // sweep on a host that regains authority still starts the ladder cleanly.
    if (outcome && typeof outcome === "object" && outcome.result === "unsupported") {
      if (!this.idleStopUnsupportedLogged.has(sessionId)) {
        this.idleStopUnsupportedLogged.add(sessionId);
        console.warn(
          `[preview] idle-stop unsupported on this host — cannot reclaim ${sessionId} on :${devPort}`,
        );
      }
      return;
    }
    this.idleStopUnsupportedLogged.delete(sessionId);
    if (st && st.devPort === devPort && st.level === "term") {
      st.level = "kill";
    } else {
      this.previewStopState.set(sessionId, { devPort, level: "term", gaveUp: false });
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.warn("[poller] tick failed:", err));
    }, this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
