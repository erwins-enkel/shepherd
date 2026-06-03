export const LEARNINGS_START = "<!-- shepherd:learnings:start -->";
export const LEARNINGS_END = "<!-- shepherd:learnings:end -->";

/** Insert or replace the managed shepherd:learnings block in CLAUDE.md content.
 *  Idempotent: replaces the existing block's contents rather than appending a
 *  duplicate; appends a fresh block when no markers are present. Each rule is one
 *  `- <rule>` bullet. */
export function upsertLearningsBlock(content: string, rules: string[]): string {
  const body = [LEARNINGS_START, ...rules.map((r) => `- ${r}`), LEARNINGS_END].join("\n");
  const start = content.indexOf(LEARNINGS_START);
  const end = content.indexOf(LEARNINGS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + body + content.slice(end + LEARNINGS_END.length);
  }
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + body + "\n";
}
