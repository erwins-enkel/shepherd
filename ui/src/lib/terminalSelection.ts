// xterm's `term.getSelection()` preserves the padding spaces a TUI paints into a
// row: its per-row right-trim only drops never-written cells (codepoint 0), while
// a real space (0x20) counts as content (`getTrimmedLength` in @xterm/xterm keeps
// it). Claude Code redraws full-width rows padded with real spaces, so a copied
// multi-line block — e.g. a backslash-continued command — arrives with trailing
// whitespace on every line, which the user then has to strip by hand after paste.
//
// xterm joins the selected rows with "\r\n" on Windows and "\n" elsewhere
// (SelectionService), so we match either line terminator (or end-of-string) and
// keep it — a `$`/`\n`-only pass would miss the trailing run before a "\r\n".
export function trimTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+(\r?\n|$)/g, "$1");
}
