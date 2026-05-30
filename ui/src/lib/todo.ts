// Pure helpers for the per-repo TODO.md markdown list.
// Items: `- [ ] text` (open) / `- [x] text` (done), optionally indented.
// Checking an item moves its line into the `## Done` section (created if absent);
// unchecking moves it to the top of the list (after a leading H1 title).

export const ITEM_RE = /^(\s*)-\s\[( |x|X)\]\s+(.*)$/;
const DONE_HEADING_RE = /^#{1,6}\s+done\b/i;

export function isItem(line: string): boolean {
  return ITEM_RE.test(line);
}

export function isDone(line: string): boolean {
  const m = ITEM_RE.exec(line);
  return m ? m[2] !== " " : false;
}

/** Index where a reactivated (unchecked) item belongs: after a leading H1 title. */
function topOfListIndex(lines: string[]): number {
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  // Keep a single leading level-1 document title at the very top.
  if (i < lines.length && /^#\s/.test(lines[i]!)) return i + 1;
  return i;
}

/**
 * Toggle the checkbox at `index` and rearrange the list by status:
 * - open → done: mark `[x]`, move into the `## Done` section (created if missing).
 * - done → open: mark `[ ]`, move to the top of the list.
 * Returns the new markdown content. No-op (returns input) if the line isn't an item.
 */
export function toggleItem(content: string, index: number): string {
  const lines = content.split("\n");
  const line = lines[index];
  if (line === undefined || !isItem(line)) return content;

  if (isDone(line)) {
    // Unchecking: move to the top of the list.
    const reopened = line.replace(/\[[xX]\]/, "[ ]");
    lines.splice(index, 1);
    lines.splice(topOfListIndex(lines), 0, reopened);
  } else {
    // Checking: move into the Done section.
    const checked = line.replace("[ ]", "[x]");
    lines.splice(index, 1);
    const doneAt = lines.findIndex((l) => DONE_HEADING_RE.test(l));
    if (doneAt >= 0) {
      lines.splice(doneAt + 1, 0, checked);
    } else {
      lines.splice(topOfListIndex(lines), 0, "## Done", checked);
    }
  }

  return lines.join("\n");
}
