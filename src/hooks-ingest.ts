// Hook ingest path for Claude Code push hooks (issues #704 / #709).
//
// The spawned agent's PostToolUse / PostToolUseFailure / Notification / SessionStart /
// Stop / SessionEnd hooks POST here; we validate the untrusted body, normalize it, drop
// it into a bounded per-session ring buffer, and log a structured line.
//
// Phase 1 (#704): when `hooksSignals` is on, matched events are forwarded to the poller
// signal pipeline via `onSignal` (wired post-construction by setSink). PostToolUse feeds
// activity signals; Notification(permission_prompt) feeds block detection.
//
// Phase 2 (#709): SessionStart is consumed to flip claude-liveness to true (fast-path
// before the poller's liveness sweep). Stop / SessionEnd are recorded + logged only —
// observe-only, no signal consumption this phase (deferred to #713).
//
// Phase 3 (#710): SubagentStart / SubagentStop maintain a per-session sub-agent roster
// (agentId → entry; live until a matching Stop). The roster is its own state — gated only
// by `match !== false` (fail-closed on session mismatch), independent of the signal path.
//
// Anything unrecognized is recorded and flagged loudly rather than silently dropped.

/** A normalized hook event after validation — the spike's observable unit. */
export type HookEvent = {
  /** Recognized lifecycle event; an unrecognized `hook_event_name` is still kept,
   *  passed through verbatim, and flagged via `unknown`. */
  event:
    | "PostToolUse"
    | "PostToolUseFailure"
    | "Notification"
    | "SessionStart"
    | "Stop"
    | "SessionEnd"
    | "SubagentStart"
    | "SubagentStop"
    | string;
  /** The hook payload's `session_id` (== `claude --session-id` == `claudeSessionId`). */
  sessionId: string;
  /** PostToolUse(/Failure): the tool that ran. */
  toolName?: string;
  /** PostToolUse(/Failure): derived from exit_code / the *Failure event. */
  status?: "ok" | "error";
  /** PostToolUse(/Failure): tool exit code when present (logging aid). */
  exitCode?: number;
  /** Notification: the `notification_type` string (e.g. permission_prompt / idle_prompt). */
  notificationType?: string;
  /** Notification: the human-readable message string. */
  message?: string;
  /** SessionStart: the `source` (startup/resume/clear/compact). */
  source?: string;
  /** Stop: the `stop_hook_active` boolean (whether a Stop hook is already active). */
  stopHookActive?: boolean;
  /** SessionEnd: the termination `reason` (clear/logout/prompt_input_exit/other). */
  reason?: string;
  /** SubagentStart/Stop: the spawned sub-agent's stable `agent_id` (same id in both). */
  agentId?: string;
  /** SubagentStart/Stop: the sub-agent's `agent_type` (e.g. "general-purpose", "Explore"). */
  agentType?: string;
  /** True when `hook_event_name` or `notification_type` was unrecognized — recorded,
   *  flagged, and `console.warn`-ed so a wrong upstream string surfaces in the spike. */
  unknown?: boolean;
  /** Server receive time (ms). CC's payload carries no reliable client timestamp, so
   *  end-to-end latency is measured externally; this anchors per-event ordering + logs. */
  receivedAt: number;
  /** Route-decided cross-check of the body's `session_id` against the resolved
   *  session's `claudeSessionId`. `false` ⇒ observe-only (never forwarded to signals). */
  match?: boolean;
};

/** Validated-but-not-yet-normalized event — the shape `validateHookEvent` returns. It
 *  carries everything the route needs; the route stamps `match` + `receivedAt`. */
export type RawHookEvent = Omit<HookEvent, "receivedAt" | "match">;

/** One sub-agent in a session's fan-out roster (Phase 3, #710). `endedAt` absent ⇒ the
 *  sub-agent is still live (a SubagentStart was seen with no matching SubagentStop yet). */
export type SubagentEntry = {
  /** The sub-agent's stable `agent_id` (the roster key). */
  agentId: string;
  /** The sub-agent's `agent_type` (e.g. "general-purpose", "Explore"). */
  agentType: string;
  /** Server receive time (ms) of the SubagentStart (or the Stop, for a fail-open entry). */
  startedAt: number;
  /** Server receive time (ms) of the SubagentStop; absent while the sub-agent is live. */
  endedAt?: number;
};

/** Max events retained per session before the oldest is evicted. */
const RING_CAP = 50;

// Defensive readers — the body is untrusted JSON; never assume a shape.
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

/**
 * Normalize a PostToolUse / PostToolUseFailure body. Reads the tool name and derives the
 * ok/error status: the field is `tool_output` (doc-corrected) with a defensive fallback to
 * `tool_response`; a non-zero `exit_code` is an error, and the *Failure event is itself an
 * error regardless of code. Extracted from `validateHookEvent` to keep that dispatcher flat.
 */
function parseToolUseEvent(
  eventName: string,
  b: Record<string, unknown>,
  sessionId: string,
): RawHookEvent {
  const toolName = str(b.tool_name);
  // Doc-corrected: the field is `tool_output`; defensively fall back to `tool_response`.
  const output = obj(b.tool_output) ?? obj(b.tool_response);
  const exitCode = num(output?.exit_code);
  // exit_code !== 0 ⇒ error; the *Failure event is itself an error regardless of code.
  const status: "ok" | "error" =
    eventName === "PostToolUseFailure" || (exitCode !== undefined && exitCode !== 0)
      ? "error"
      : "ok";
  return { event: eventName, sessionId, toolName, status, exitCode };
}

/**
 * Normalize a Notification body. The `notification_type` strings are spike-validated, not
 * assumed: an absent/unknown type is flagged `unknown` so it's logged + recorded but never
 * silently disables a signal. Extracted from `validateHookEvent` to keep it flat.
 */
function parseNotificationEvent(
  eventName: string,
  b: Record<string, unknown>,
  sessionId: string,
): RawHookEvent {
  const notificationType = str(b.notification_type);
  const message = str(b.message);
  return { event: eventName, sessionId, notificationType, message, unknown: !notificationType };
}

/**
 * Pure, total validator over an untrusted hook body. Returns null for non-objects or a
 * missing/non-string `session_id` (the only hard requirement). Reads `hook_event_name`
 * and derives a normalized event. UNKNOWN event/notification types are NOT dropped —
 * they're accepted and flagged `unknown: true` so the spike surfaces a wrong upstream
 * string instead of silently disabling a signal.
 */
export function validateHookEvent(body: unknown): RawHookEvent | null {
  const b = obj(body);
  if (!b) return null;
  const sessionId = str(b.session_id);
  if (!sessionId) return null;

  const eventName = str(b.hook_event_name) ?? "";

  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
    return parseToolUseEvent(eventName, b, sessionId);
  }

  if (eventName === "Notification") {
    return parseNotificationEvent(eventName, b, sessionId);
  }

  if (eventName === "SessionStart") {
    return { event: eventName, sessionId, source: str(b.source) };
  }

  if (eventName === "Stop") {
    return { event: eventName, sessionId, stopHookActive: bool(b.stop_hook_active) };
  }

  if (eventName === "SessionEnd") {
    return { event: eventName, sessionId, reason: str(b.reason) };
  }

  if (eventName === "SubagentStart" || eventName === "SubagentStop") {
    // The fan-out lifecycle: both carry the stable `agent_id` + the `agent_type`.
    return {
      event: eventName,
      sessionId,
      agentId: str(b.agent_id),
      agentType: str(b.agent_type),
    };
  }

  // Unrecognized hook_event_name — keep it, pass it through verbatim, flag it.
  return { event: eventName || "unknown", sessionId, unknown: true };
}

/**
 * Bounded in-memory ring buffer + structured logging for ingested hook events. The
 * single owner of the Phase-0 observable surface. `record` never throws — a malformed
 * forward must never crash the request loop.
 */
export class HookIngest {
  // sessionId → ring buffer (oldest-first; capped at RING_CAP).
  #buffers = new Map<string, HookEvent[]>();
  // Set only by Task 3 (Phase 1) when `hooksSignals` is on; forwards matched events
  // to the poller. Left undefined here ⇒ observe-only.
  #onSignal?: (sessionId: string, ev: HookEvent) => void;
  // Phase 3 (#710): per-session sub-agent roster — sessionId → agentId → entry. Its own
  // state, independent of the signal path; mutated only by matched Subagent* events.
  #subagents = new Map<string, Map<string, SubagentEntry>>();
  // Notified with the session's updated roster array on every roster mutation; wired
  // post-construction by setSubagentSink (mirror of setSink). Undefined ⇒ no push.
  #onSubagents?: (sessionId: string, roster: SubagentEntry[]) => void;

  constructor(onSignal?: (sessionId: string, ev: HookEvent) => void) {
    this.#onSignal = onSignal;
  }

  /**
   * Set (or clear) the Phase-1 signal sink AFTER construction. index.ts constructs the
   * HookIngest before the poller (the poller's prune callback needs it), then wires the
   * sink once the poller exists — resolving the circular construction order without a
   * forward-declared `let`. The ctor `onSignal` arg still works (Task 2 tests use it);
   * this just lets the wiring happen post-construction when `config.hooksSignals` is on.
   */
  setSink(onSignal: (sessionId: string, ev: HookEvent) => void): void {
    this.#onSignal = onSignal;
  }

  /**
   * Set (or clear) the Phase-3 sub-agent roster sink AFTER construction — mirror of
   * setSink. A later task wires this so a roster change pushes the updated array (e.g. to
   * the UI). Left unwired here ⇒ the roster is tracked but not pushed.
   */
  setSubagentSink(cb: (sessionId: string, roster: SubagentEntry[]) => void): void {
    this.#onSubagents = cb;
  }

  /**
   * Emit the per-event structured log line (and the loud `unknown`-type warn). Pure
   * logging — no state, no forwarding. Extracted from `record()` so its many `?? "-"`
   * field renders don't dominate that method's complexity; identical output, relocated.
   */
  #logEvent(sessionId: string, ev: HookEvent): void {
    const latencyMs = Date.now() - ev.receivedAt;
    console.log(
      `[hooks] ${ev.event} session=${sessionId} match=${ev.match === false ? "mismatch" : "ok"} ` +
        `latencyMs=${latencyMs} tool=${ev.toolName ?? "-"} status=${ev.status ?? "-"} ` +
        `ntype=${ev.notificationType ?? "-"} exit=${ev.exitCode ?? "-"}` +
        ` src=${ev.source ?? "-"} reason=${ev.reason ?? "-"} stopActive=${ev.stopHookActive ?? "-"}` +
        ` agentId=${ev.agentId ?? "-"} agentType=${ev.agentType ?? "-"}`,
    );
    if (ev.unknown) {
      console.warn(
        `[hooks] unknown event/notification type — event=${ev.event} ntype=${ev.notificationType ?? "-"} session=${sessionId}`,
      );
    }
  }

  /** Push an event, log it, and (only on a matched session) forward to signals. */
  record(sessionId: string, ev: HookEvent): void {
    try {
      const buf = this.#buffers.get(sessionId) ?? [];
      buf.push(ev);
      if (buf.length > RING_CAP) buf.splice(0, buf.length - RING_CAP);
      this.#buffers.set(sessionId, buf);

      this.#logEvent(sessionId, ev);

      // Fail-closed on the untrusted session_id: a mismatch is observe-only.
      if (ev.match !== false) {
        this.#onSignal?.(sessionId, ev);
        // Phase 3 (#710): maintain the sub-agent roster (its own state, NOT the signal
        // path). Also gated by match !== false — a session mismatch must never mutate it.
        if (ev.event === "SubagentStart" || ev.event === "SubagentStop") {
          this.#recordSubagent(sessionId, ev);
        }
      }
    } catch (err) {
      // Never let a logging/forward fault escape into the request loop.
      console.warn(`[hooks] record failed for session=${sessionId}: ${String(err)}`);
    }
  }

  /**
   * Apply one matched Subagent* event to the roster (already match-gated by record()).
   * A SubagentStart upserts a live entry (idempotent — a duplicate keeps the original
   * startedAt). A SubagentStop marks the matching entry done; with no prior Start (lost
   * forward / restart) it creates a fail-open done entry (startedAt = endedAt = now) so
   * the sub-agent is still shown. A missing/empty agentId is a no-op. Pushes the updated
   * roster to #onSubagents after any mutation. Caller wraps this in record()'s try/catch.
   */
  #recordSubagent(sessionId: string, ev: HookEvent): void {
    const agentId = ev.agentId;
    if (!agentId) return; // can't key the roster without a stable id — skip.
    const roster = this.#subagents.get(sessionId) ?? new Map<string, SubagentEntry>();
    const agentType = ev.agentType ?? "";
    if (ev.event === "SubagentStart") {
      // Idempotent: keep the original startedAt if we already saw this Start.
      if (!roster.has(agentId)) {
        roster.set(agentId, { agentId, agentType, startedAt: ev.receivedAt });
      }
    } else {
      // SubagentStop: mark done, or fail open with a synthetic done entry.
      const existing = roster.get(agentId);
      if (existing) {
        existing.endedAt = ev.receivedAt;
      } else {
        roster.set(agentId, {
          agentId,
          agentType,
          startedAt: ev.receivedAt,
          endedAt: ev.receivedAt,
        });
      }
    }
    this.#subagents.set(sessionId, roster);
    this.#onSubagents?.(sessionId, [...roster.values()]);
  }

  /** A copy of the session's ring buffer (or `[]`), safe to hand to a JSON response. */
  snapshot(sessionId: string): HookEvent[] {
    const buf = this.#buffers.get(sessionId);
    return buf ? [...buf] : [];
  }

  /**
   * The session's sub-agent roster as an array (insertion order; `[]` if none).
   * The array is fresh, but the entries are the internal `SubagentEntry` references;
   * safe to hand to a JSON response because every field is a primitive (no nested
   * objects to alias), mirroring `snapshot()`.
   */
  subagentSnapshot(sessionId: string): SubagentEntry[] {
    const roster = this.#subagents.get(sessionId);
    return roster ? [...roster.values()] : [];
  }

  /**
   * Every tracked session's roster array, keyed by sessionId — for a global bootstrap.
   * As with `subagentSnapshot`, the entry objects are internal references but JSON-safe
   * since `SubagentEntry` fields are all primitives.
   */
  allSubagentsSnapshot(): Record<string, SubagentEntry[]> {
    const out: Record<string, SubagentEntry[]> = {};
    for (const [id, roster] of this.#subagents) out[id] = [...roster.values()];
    return out;
  }

  /** Drop ring-buffer + roster entries for sessions no longer active (called from the poller's prune). */
  prune(activeIds: Set<string>): void {
    for (const id of this.#buffers.keys()) {
      if (!activeIds.has(id)) this.#buffers.delete(id);
    }
    for (const id of this.#subagents.keys()) {
      if (!activeIds.has(id)) this.#subagents.delete(id);
    }
  }
}
