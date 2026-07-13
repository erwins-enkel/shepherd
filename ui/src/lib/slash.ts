import type { SlashCommand } from "./types";

export type CommandTrigger = "/" | "$" | "@";

export function commandProviders(command: SlashCommand): Array<"claude" | "codex"> {
  return command.providers && command.providers.length > 0 ? command.providers : ["claude"];
}

export function commandInvocation(command: SlashCommand, provider: "claude" | "codex"): string {
  return (
    command.invocations?.[provider] ??
    (provider === "codex" ? `$${command.name}` : `/${command.name}`)
  );
}

export function commandInsertable(command: SlashCommand, provider: "claude" | "codex"): boolean {
  if (command.invocations) return Boolean(command.invocations[provider]);
  return commandProviders(command).includes(provider);
}

export function commandInvocationProvider(
  command: SlashCommand,
  preferred?: "claude" | "codex",
): "claude" | "codex" {
  const providers = commandProviders(command);
  if (preferred && providers.includes(preferred)) return preferred;
  return providers[0] ?? "claude";
}

export function commandInvocationName(command: SlashCommand): string {
  return command.invocationName ?? command.name;
}

/**
 * Detect a command/skill trigger from the text up to the caret. `/` and `$` trigger the
 * picker when it begins a new token — at the very start of the prompt, or right after
 * whitespace/newline — followed by zero or more non-space chars up to the caret.
 * Bare `@` opens Shepherd's Codex alias picker, but any non-empty `@...` token is
 * left untouched for Codex native mentions.
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
): { query: string; start: number; trigger: CommandTrigger } | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(^|\s)([/$@])(\S*)$/.exec(before);
  if (!m) return null;
  const trigger = m[2] as CommandTrigger;
  const query = m[3]!;
  if (trigger === "@" && query !== "") return null;
  if (trigger === "$" && isShellVariableToken(query)) return null;
  return { query, start: m.index + m[1]!.length, trigger };
}

function isShellVariableToken(query: string): boolean {
  if (query === "") return false;
  if (query.startsWith("{")) return true;
  if (/^[0-9?@$*#!-]/.test(query)) return true;
  return /^[A-Z_][A-Z0-9_]*/.test(query);
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

/** Replace a `$query` or bare `@` trigger token in place with a Codex `$name` mention. */
export function applyMentionPick(
  text: string,
  start: number,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const lead = text.slice(0, start);
  const tail = text.slice(caret);
  const token = `$${name} `;
  return { value: lead + token + tail.replace(/^\s+/, ""), caret: lead.length + token.length };
}

/**
 * Filter commands by the typed query (case-insensitive). Empty query → all.
 * Prefix matches rank above mid-name substring matches; ties keep input order
 * (the list arrives already sorted by name).
 */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
  provider?: "claude" | "codex",
): SlashCommand[] {
  const q = query.toLowerCase();
  const filtered = provider
    ? commands.filter(
        (c) => commandProviders(c).includes(provider) && commandInsertable(c, provider),
      )
    : commands;
  if (!q) return filtered;
  const prefix: SlashCommand[] = [];
  const substr: SlashCommand[] = [];
  for (const c of filtered) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) substr.push(c);
  }
  return [...prefix, ...substr];
}
