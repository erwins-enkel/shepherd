// Detects Claude Code's "press n to add notes" affordance shown inside its
// interactive multi-select prompts. The hint surfaces both inline ("Notes:
// press n to add notes") and in the footer ("… · n to add notes · …").
//
// Why scrape the rendered screen: the PTY stream is opaque bytes and the UI
// never models the prompt — the only place this affordance exists is the
// painted text. On a phone there's no keyboard to press the key, so we turn the
// detected key into a tappable control. Callers pass only the *visible* viewport
// rows (not scrollback) so a prompt that has scrolled off doesn't keep it lit.

// One letter, immediately followed by " to add notes". Anchored on a word
// boundary so the leading "press " / "Notes: press " context can't smear the
// capture. Case-insensitive for robustness; the key is returned verbatim so we
// inject exactly what the prompt told the operator to press.
const NOTES_HINT = /\b([a-z]) to add notes\b/i;

/** The key to send (verbatim) when the notes affordance is visible, else null. */
export function detectNotesKey(visibleText: string): string | null {
  const match = NOTES_HINT.exec(visibleText);
  return match ? match[1] : null;
}
