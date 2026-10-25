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

// The structural slice of xterm's IBuffer that bufferText reads.
interface TextBuffer {
  readonly length: number;
  getLine(
    y: number,
  ): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

// The whole buffer (scrollback + screen) as plain text, for the touch select
// sheet: touch has no xterm selection, so the text goes into a native-selectable
// element instead. A soft-wrapped row continues its predecessor's logical line
// (no newline), each line loses its TUI padding, and the blank rows below the
// last output are dropped so the sheet opens on content, not empty screen.
export function bufferText(buffer: TextBuffer): string {
  let out = "";
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (y > 0 && !line.isWrapped) out += "\n";
    // trim only a logical line's last row: a row the next one continues keeps
    // its wrap-column cell, so a space there can't fuse two words
    out += line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
  }
  return trimTrailingWhitespace(out).replace(/\n+$/, "");
}
