import type { EventHub } from "./events";
import type { SessionStore } from "./store";
import type { BlockReason } from "./blocked";
import type { SignalKind } from "./types";

/**
 * How long after an observed block event the same session+kind stays inside one EPISODE (#2242).
 *
 * The poller re-emits `session:block` on every terminal repaint of a waiting dialog: its dedup key
 * is `JSON.stringify(reason)` and `reason.tail` is the last 15 visible lines, so a scrolled
 * context, an advancing checkbox row or a live counter yields a different signature and a fresh
 * emit every `reclassifyMs` (default 3s). Measured on a live install: 181 `block` rows across 32
 * sessions in 7 days, of which 103 landed within 30s of the previous row in the same session and
 * 40 within 5s. Deduping on the payload is near-useless (181 → 169) precisely because the repaints
 * DIFFER; time adjacency is the signature that separates repaints from distinct episodes.
 */
const EPISODE_DEBOUNCE_MS = 60_000;

/**
 * Capture `block` and `stall` learning signals off the `session:block` event.
 * Reply signals are captured in SessionService.reply; critic signals in ReviewService.
 * A `stall`-shaped block becomes a "stall" signal; every other shape a "block" signal.
 * Cleared blocks (block: null) and unknown sessions are ignored.
 *
 * DEDUPED PER EPISODE (#2242): repeated block events for the same session+kind collapse into one
 * signal row. The dedup lives HERE and not in the poller on purpose — `session:block` also drives
 * the UI block card's tail, the herdr state push and the working-while-blocked flag, all of which
 * want per-repaint accuracy; the `signals` table is the only consumer that over-counts. Keyed by
 * kind as well as session so a `stall` and a `block` in the same session never share a window
 * (`stall` is already once-per-episode via the poller's fixed `STALL_SIG`, so the window is inert
 * there — it is applied uniformly rather than special-cased).
 *
 * The window SLIDES: every observed event re-stamps the key, so an episode that keeps repainting
 * stays one episode however long it runs, and a new row needs a real `debounceMs` lull in the
 * event stream. A `block: null` clear deliberately does NOT reset it — the poller drops `lastSig`
 * in both `trySuppressSpinner` and `clearBlock`, so an episode keyed on clear events would still
 * write a fresh row on every spinner-suppression or leave-blocked flap, which is the amplifier
 * this is here to neutralise.
 */
export function attachSignalCapture(
  events: Pick<EventHub, "subscribe">,
  store: Pick<SessionStore, "get" | "addSignal">,
  opts?: { now?: () => number; debounceMs?: number },
): () => void {
  const now = opts?.now ?? (() => Date.now());
  const debounceMs = opts?.debounceMs ?? EPISODE_DEBOUNCE_MS;
  /** session+kind → when that key was last OBSERVED (not last written). */
  const lastSeenAt = new Map<string, number>();
  return events.subscribe((event, data) => {
    if (event !== "session:block") return;
    const { id, block } = data as { id: string; block: BlockReason | null };
    if (!block) return;
    const s = store.get(id);
    if (!s) return;
    const kind: SignalKind = block.shape === "stall" ? "stall" : "block";
    const t = now();
    // Bound the map by the sessions currently blocking: anything past the window can no longer
    // suppress a write, so it is dead weight. Cheap — the map only ever holds blocked sessions.
    for (const [k, at] of lastSeenAt) if (t - at >= debounceMs) lastSeenAt.delete(k);
    // NUL-joined so no session id / kind pair can collide into another key.
    const key = `${s.id}\u0000${kind}`;
    const seen = lastSeenAt.has(key);
    lastSeenAt.set(key, t); // slide the window on every event, written or not
    if (seen) return; // still inside the episode → a repaint, not a new incident
    store.addSignal({
      repoPath: s.repoPath,
      sessionId: s.id,
      kind,
      payload: block.tail.join("\n"),
    });
  });
}
