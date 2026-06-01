/** Parse a JSONL blob, yielding each well-formed object. Blank and malformed
 *  lines are skipped — the same lenient contract Claude Code's transcripts need. */
export function* eachJsonlObject(text: string): Iterable<any> {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      /* skip malformed line */
    }
  }
}
