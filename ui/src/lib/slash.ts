import type { SlashCommand } from "./types";

/**
 * Detect a slash-command trigger from the text up to the caret. Claude only treats
 * a leading `/` as a command, so we trigger ONLY at the very start of the prompt:
 * the text before the caret must be `/` followed by zero or more non-space chars.
 * Returns the typed query (without the slash), or null when no trigger is active.
 *
 *   matchSlashTrigger("/cre", 4)      → { query: "cre" }
 *   matchSlashTrigger("/", 1)         → { query: "" }
 *   matchSlashTrigger("fix /foo", 8)  → null   (not at start)
 *   matchSlashTrigger("/foo bar", 8)  → null   (space ends the token)
 */
export function matchSlashTrigger(text: string, caret: number): { query: string } | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /^\/(\S*)$/.exec(before);
  return m ? { query: m[1]! } : null;
}

/**
 * Filter commands by the typed query (case-insensitive). Empty query → all.
 * Prefix matches rank above mid-name substring matches; ties keep input order
 * (the list arrives already sorted by name).
 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const prefix: SlashCommand[] = [];
  const substr: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) substr.push(c);
  }
  return [...prefix, ...substr];
}
