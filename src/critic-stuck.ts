import { classifyBlocked, type BlockShape } from "./blocked";

/**
 * Is an unattended agent's pane WEDGED on an interactive prompt it can never answer?
 *
 * A transient agent runs with no operator, so any dialog the CLI renders — a permission menu, a
 * y/n confirm, or a product upsell like the fullscreen-renderer prompt — parks the pane until its
 * caller's deadline fires, tens of minutes later, and surfaces as an unexplained `error` verdict.
 * Detecting it turns that into seconds.
 *
 * TWO conditions, both required:
 *   1. `classifyBlocked` reports a `menu` or `yes-no` shape, and
 *   2. the pane buffer is BYTE-IDENTICAL to the previous read.
 *
 * (2) is what makes this safe to act on. Critics routinely PRINT numbered lists — findings are
 * written as "1. … 2. …" — and `classifyBlocked` cannot tell a rendered menu from prose that looks
 * like one. The discriminator is motion, not shape: a working agent's buffer advances between
 * reads, a wedged one's cannot. Same freshness idea the poller applies to spinner suppression.
 *
 * `awaiting-input` / `stall` / `quota` shapes are deliberately NOT treated as stuck: they are
 * either legitimately mid-turn or already have their own dedicated handling, and killing a run on
 * them would cost a real review.
 *
 * ── The input MUST be the raw pane buffer ────────────────────────────────────────────────────────
 * Pass `herdr.readAsync(terminalId, "visible")` VERBATIM — the same shape src/poller.ts feeds its
 * own classifyBlocked call. `classifyBlocked` splits on newlines and its option regex is
 * line-anchored, so a pre-flattened string can never match.
 *
 * In particular do NOT pass `ReviewService.readPaneTail()`: it reads "recent", collapses runs of
 * whitespace to single spaces, truncates to ~300 chars and sanitizes. Feeding that here yields a
 * detector that SILENTLY NEVER FIRES — the failure is invisible to this module's own unit tests,
 * which supply raw captured buffers, so the caller-side wiring is asserted separately.
 */
export function stuckOnPrompt(visible: string, prevVisible: string | null): BlockShape | null {
  if (prevVisible === null || visible !== prevVisible) return null;
  if (visible.trim() === "") return null; // an empty/unreadable pane is not evidence of a prompt
  const shape = classifyBlocked(visible).shape;
  return shape === "menu" || shape === "yes-no" ? shape : null;
}
