import type { SlashCommand } from "./types";

/**
 * Detect a slash-command trigger from the text up to the caret. A `/` triggers the
 * picker when it begins a new token — at the very start of the prompt, or right after
 * whitespace/newline — followed by zero or more non-space chars up to the caret.
 * Returns the typed query (without the slash) and the index of the `/`, or null when
 * no trigger is active.
 *
 * The `/` must start a token: `a/foo` (a path, a mid-word slash) does not trigger.
 * Claude only *runs* a slash command when it leads the prompt, so a command typed
 * mid-text won't dispatch as-is — picking one hoists it to the front (see
 * {@link applyCommandPick}).
 *
 *   matchSlashTrigger("/cre", 4)        → { query: "cre", start: 0 }
 *   matchSlashTrigger("/", 1)           → { query: "", start: 0 }
 *   matchSlashTrigger("fix /foo", 8)    → { query: "foo", start: 4 }
 *   matchSlashTrigger("ctx\n/sha", 8)   → { query: "sha", start: 4 }
 *   matchSlashTrigger("/foo bar", 8)    → null   (space ended the token)
 *   matchSlashTrigger("a/foo", 5)       → null   (slash mid-word, not a token start)
 */
export function matchSlashTrigger(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(^|\s)\/(\S*)$/.exec(before);
  if (!m) return null;
  return { query: m[2]!, start: m.index + m[1]!.length };
}

/**
 * Build the prompt after the user picks a command from the inline picker. Drops the
 * typed `/query` token at `[start, caret)` and hoists `/name ` to the front so the
 * command actually dispatches — Claude only runs a *leading* slash command. Any text
 * the user wrote around the token becomes the command's argument. Returns the new
 * text and the caret offset (just past the inserted `/name `, ready for args).
 *
 *   applyCommandPick("fix the bug /rev", 12, 16, "review")
 *     → { value: "/review fix the bug", caret: 8 }
 */
export function applyCommandPick(
  text: string,
  start: number,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const rest = (text.slice(0, start) + text.slice(caret)).trim();
  const lead = `/${name} `;
  return { value: lead + rest, caret: lead.length };
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
