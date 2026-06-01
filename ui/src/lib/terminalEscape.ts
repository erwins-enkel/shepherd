// Desktop focus can drift off xterm's hidden textarea onto <body> — clicking
// header chrome, a re-render re-attaching the terminal, or the browser's own
// focus handling (Arc was the reported case). xterm only emits the Escape byte
// while its textarea is focused, so a drifted-focus Esc is silently dropped:
// the window receives the `keydown` but nothing routes it into the PTY, and
// Claude Code never sees the Escape. Even with the textarea focused, a browser
// quirk can swallow the byte. This predicate decides whether a stray Escape
// should be re-routed into the terminal — the caller then sends \x1b itself and
// suppresses xterm's own handling so the agent gets exactly one Escape.
//
// It fires ONLY for a bare Escape on the desktop hardware-keyboard layout while
// the terminal tab is the live, active pane and the keyboard belongs to the
// terminal: focus is on <body>/nothing, or inside the terminal element itself.
// When a sibling control owns focus — the compose/steer fields or a dialog
// input — those live outside the terminal element, so we defer and they keep
// their native Escape; likewise we stand down whenever an overlay is open.
export interface ForwardEscapeInput {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  desktopKeyboard: boolean; // !mobile && !touch — the only layout lacking an Esc button
  termTabActive: boolean;
  live: boolean; // session attached, not parked/ended
  overlayOpen: boolean; // a modal/drawer is up and owns Escape
  active: Element | null; // document.activeElement
  body: Element | null; // document.body
  terminalEl: { contains(node: Element | null): boolean } | null; // the xterm mount
}

export function shouldForwardEscape(i: ForwardEscapeInput): boolean {
  const focusOwnedByTerminal =
    i.active === null ||
    i.active === i.body ||
    (i.terminalEl !== null && i.terminalEl.contains(i.active));

  return (
    i.key === "Escape" &&
    !i.ctrlKey &&
    !i.altKey &&
    !i.metaKey &&
    i.desktopKeyboard &&
    i.termTabActive &&
    i.live &&
    !i.overlayOpen &&
    focusOwnedByTerminal
  );
}
