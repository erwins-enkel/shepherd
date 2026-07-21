/**
 * Detect a `#issue` search trigger from the text up to the caret — the New Task prompt's
 * inline issue search. Deliberately its own module with its own state in the consumer:
 * the command-trigger machinery in slash.ts is untouched, and the two menus are mutually
 * exclusive by construction (a token starts with exactly one of `/ $ @ #`).
 *
 * `#` must start a token (start of prompt or right after whitespace), followed by zero or
 * more non-space, non-`#` chars up to the caret. A token that matches no issue stays as
 * typed — `#` is common in prose and must never block typing.
 *
 *   matchIssueTrigger("#", 1)          → { query: "", start: 0 }
 *   matchIssueTrigger("#18", 3)        → { query: "18", start: 0 }
 *   matchIssueTrigger("fix #re", 7)    → { query: "re", start: 4 }
 *   matchIssueTrigger("a#1", 3)        → null   (mid-word, e.g. an anchor or color)
 *   matchIssueTrigger("#18 now", 7)    → null   (space ended the token)
 */
export function matchIssueTrigger(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(^|\s)#([^\s#]*)$/.exec(before);
  if (!m) return null;
  return { query: m[2]!, start: m.index + m[1]!.length };
}
