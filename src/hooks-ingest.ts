// Phase 0 ingest path for Claude Code push hooks (issue #704).
//
// Observe-only: the spawned agent's PostToolUse / PostToolUseFailure / Notification
// hooks POST here; we validate the untrusted body, normalize it, drop it into a
// bounded per-session ring buffer, and log a structured line. NOTHING here feeds the
// signal pipeline yet — `onSignal` is wired by Task 3 (Phase 1) when `hooksSignals`
// is on. The whole point of the spike is to MEASURE (latency, correlation, the exact
// upstream strings) before trusting the channel, so anything unrecognized is recorded
// and flagged loudly rather than silently dropped.

/** A normalized hook event after validation — the spike's observable unit. */
export type HookEvent = {
  /** Recognized lifecycle event; an unrecognized `hook_event_name` is still kept,
   *  passed through verbatim, and flagged via `unknown`. */
  event: "PostToolUse" | "PostToolUseFailure" | "Notification" | string;
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

/** Max events retained per session before the oldest is evicted. */
const RING_CAP = 50;

// Defensive readers — the body is untrusted JSON; never assume a shape.
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

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

  if (eventName === "Notification") {
    const notificationType = str(b.notification_type);
    const message = str(b.message);
    // The `notification_type` strings are spike-validated, not assumed: flag an
    // absent/unknown type so it's logged + recorded but never silently disables a signal.
    return { event: eventName, sessionId, notificationType, message, unknown: !notificationType };
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

  constructor(onSignal?: (sessionId: string, ev: HookEvent) => void) {
    this.#onSignal = onSignal;
  }

  /** Push an event, log it, and (only on a matched session) forward to signals. */
  record(sessionId: string, ev: HookEvent): void {
    try {
      const buf = this.#buffers.get(sessionId) ?? [];
      buf.push(ev);
      if (buf.length > RING_CAP) buf.splice(0, buf.length - RING_CAP);
      this.#buffers.set(sessionId, buf);

      const latencyMs = Date.now() - ev.receivedAt;
      console.log(
        `[hooks] ${ev.event} session=${sessionId} match=${ev.match === false ? "mismatch" : "ok"} ` +
          `latencyMs=${latencyMs} tool=${ev.toolName ?? "-"} status=${ev.status ?? "-"} ` +
          `ntype=${ev.notificationType ?? "-"} exit=${ev.exitCode ?? "-"}`,
      );
      if (ev.unknown) {
        console.warn(
          `[hooks] unknown event/notification type — event=${ev.event} ntype=${ev.notificationType ?? "-"} session=${sessionId}`,
        );
      }

      // Fail-closed on the untrusted session_id: a mismatch is observe-only.
      if (ev.match !== false) this.#onSignal?.(sessionId, ev);
    } catch (err) {
      // Never let a logging/forward fault escape into the request loop.
      console.warn(`[hooks] record failed for session=${sessionId}: ${String(err)}`);
    }
  }

  /** A copy of the session's ring buffer (or `[]`), safe to hand to a JSON response. */
  snapshot(sessionId: string): HookEvent[] {
    const buf = this.#buffers.get(sessionId);
    return buf ? [...buf] : [];
  }

  /** Drop ring-buffer entries for sessions no longer active (called from the poller's prune). */
  prune(activeIds: Set<string>): void {
    for (const id of this.#buffers.keys()) {
      if (!activeIds.has(id)) this.#buffers.delete(id);
    }
  }
}
