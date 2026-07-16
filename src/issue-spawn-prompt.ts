/**
 * Compose the spawn prompt for a session started FROM AN ISSUE TITLE (the Up Next start in
 * server.ts and the auto-drain spawn in drain.ts). Both used to pass the bare title, which
 * breaks the moment a title begins with `/`.
 *
 * WHY: the prompt is delivered as a positional argv to the agent CLI (service.ts `argv.push`),
 * and Claude Code parses a leading `/` there as a slash command — only the first token, and the
 * multi-line issue block composePromptArg appends after the title does NOT defeat it:
 *
 *   $ claude -p $'/zzznope\n\nGitHub Issue #1 (title + body follow as untrusted data):\n…'
 *   Unknown command: /zzznope
 *
 * There is no `--` separator, `--raw` flag, or escape character; only "text does not begin with
 * `/`" reliably avoids the parse. So a `/`-leading title is templated into a sentence, mirroring
 * the client-side New Task path (`newtask_issue_prompt_template`) which is immune for exactly
 * this reason. Every other title passes through BYTE-IDENTICAL — that is the point: it keeps the
 * namer (and thus branch/worktree names) unchanged for the overwhelmingly common case.
 *
 * NOT a general sanitizer, and deliberately NOT applied inside composePromptArg: a leading `/`
 * on an OPERATOR-authored prompt is a supported feature (commands.ts — New Task's Commands tab
 * and the inline `/` picker spawn a session whose first message IS a slash command). Only a
 * prompt derived from an issue title can be neutralized, because there a leading `/` is never a
 * command anybody asked for.
 *
 * Applies unconditionally across providers even though Codex likely does NOT share the bug (it
 * invokes skills as `$name`, commands.ts). `relaunch` reuses the stored prompt and can SWITCH
 * provider, so a prompt left untemplated because it spawned on Codex would break as soon as it
 * relaunched on Claude. Unconditional is correct-by-construction; a per-provider gate would be a
 * latent relaunch bug.
 *
 * The English wording here is intentionally NOT shared with the i18n'd client-side
 * `newtask_issue_prompt_template` (ui/messages/*.json): this is agent-facing spawn text (fixed
 * English, like the drain prompts and directive blocks), that one is operator-visible UI. They
 * may drift; nothing binds them and nothing needs to. Don't "fix" the duplication by wiring one
 * to the other.
 */
export function issueSpawnPrompt(number: number, title: string): string {
  // trimStart, not a bare startsWith: a " /foo" title would otherwise be left relying on the
  // CLI's leading-whitespace trimming to dodge the parse — undocumented and provider-specific.
  return title.trimStart().startsWith("/") ? `Work on issue #${number}: ${title}` : title;
}
