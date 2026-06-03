import type { EventHub } from "./events";
import type { SessionStore } from "./store";
import type { BlockReason } from "./blocked";

/**
 * Capture `block` and `stall` learning signals off the `session:block` event.
 * Reply signals are captured in SessionService.reply; critic signals in ReviewService.
 * A `stall`-shaped block becomes a "stall" signal; every other shape a "block" signal.
 * Cleared blocks (block: null) and unknown sessions are ignored.
 */
export function attachSignalCapture(
  events: Pick<EventHub, "subscribe">,
  store: Pick<SessionStore, "get" | "addSignal">,
): () => void {
  return events.subscribe((event, data) => {
    if (event !== "session:block") return;
    const { id, block } = data as { id: string; block: BlockReason | null };
    if (!block) return;
    const s = store.get(id);
    if (!s) return;
    store.addSignal({
      repoPath: s.repoPath,
      sessionId: s.id,
      kind: block.shape === "stall" ? "stall" : "block",
      payload: block.tail.join("\n"),
    });
  });
}
