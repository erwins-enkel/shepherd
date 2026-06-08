// Decides whether the terminal's jump-to-bottom button should show — i.e. the
// reader is parked above the latest output. There are two scroll regimes (see
// `agentOwnsScroll` in Viewport.svelte) and the signal differs between them:
//
//  • xterm owns the scrollback (plain shell, mouse-tracking off): the normal
//    buffer carries scrollback and xterm's viewport actually moves, so we read
//    its line offset directly. xterm fires `onScroll` on every write, so this
//    stays accurate as new content streams in — any whole-line offset shows it.
//
//  • the agent owns the scroll (alternate screen, or mouse-tracking on the
//    normal buffer like Claude Code): the app grabs the wheel and repaints its
//    own scrolled view, so xterm's viewport never moves and we have no position
//    to read — only the user's gesture accumulator (`scrollDepth`). A deliberate
//    scroll past the threshold shows the button immediately. But a sub-threshold
//    nudge ("scrolled up just a hair") moves the viewport nowhere we can see, so
//    if the agent then prints new output below the reader — common while the
//    pane is backgrounded — the gesture total alone never reveals it. The caller
//    watches the write stream and sets `contentBelowScroll` once content lands
//    while the reader is scrolled up at all, which surfaces the button too.
export const SCROLL_UP_PX = 30; // small swipe / one wheel notch before the button shows

export interface ScrollAffordanceState {
  agentOwnsScroll: boolean;
  // agent-owned regime: px-ish accumulator of net upward scrolling
  scrollDepth: number;
  // agent-owned regime: new output arrived while the reader was scrolled up
  // (any amount), so they're now parked above the latest even if the gesture
  // never crossed SCROLL_UP_PX
  contentBelowScroll: boolean;
  // xterm-owned regime: viewport line offset from the latest row (baseY - viewportY)
  viewportOffsetLines: number;
}

export function isScrolledAwayFromBottom(s: ScrollAffordanceState): boolean {
  if (s.agentOwnsScroll) {
    return s.scrollDepth > SCROLL_UP_PX || s.contentBelowScroll;
  }
  return s.viewportOffsetLines > 0;
}
