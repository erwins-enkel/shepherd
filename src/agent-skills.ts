import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Shepherd's own agent skills (issue #2002) — the progressive-disclosure home for guidance that is
 * relevant to a subset of sessions and used to ride the standing prompt of all of them.
 *
 * They ship inside this install (`agent-skills/.claude/skills/<name>/SKILL.md`) rather than in the
 * session's repo or the operator's `~/.claude/skills`, and reach a session through `--add-dir`:
 * Claude Code loads `.claude/skills/` from an added directory (the one configuration-discovery
 * exception to `--add-dir`, which otherwise only grants file access — the
 * `permissions.additionalDirectories` SETTING does not load skills, so the flag is required).
 * That works in any repo without writing to the operator's tree or the user's checkout.
 *
 * Codex spawns get none of this (no `--add-dir`, no skill loading), which is why
 * composeSystemPromptBlocks keeps the corresponding blocks resident for that provider.
 */

/** The directory passed to `--add-dir`; its `.claude/skills/` children are what Claude Code loads. */
export const AGENT_SKILLS_DIR = resolve(import.meta.dir, "..", "agent-skills");

/** Skill names shipped here. Kept as a literal (not a directory listing) because it is read on the
 *  spawn path: the single Bun event loop also pumps the live web terminal, so no sync fs there. The
 *  `test/agent-skills.test.ts` pin asserts it matches what is actually on disk. */
export const AGENT_SKILL_NAMES = ["shepherd-pull-requests", "shepherd-preview"] as const;

let availableCache: boolean | null = null;

/**
 * Whether the skills directory exists in this install. Checked once per process (a deploy restarts
 * the server), so the sync `existsSync` never lands on a spawn's hot path.
 *
 * FAIL-SAFE: a false answer keeps the corresponding notices in the composed prompt rather than
 * dropping guidance a session can no longer load.
 */
export function agentSkillsAvailable(probe: (p: string) => boolean = existsSync): boolean {
  return (availableCache ??= probe(AGENT_SKILLS_DIR));
}

/** Test seam: forget the memoized probe result. */
export function resetAgentSkillsCache(): void {
  availableCache = null;
}

/** `--add-dir` args for a Claude spawn/resume, or `[]` when the directory is missing.
 *  MUST be appended AFTER any positional prompt argument: `--add-dir` is variadic and swallows a
 *  following positional as another directory. */
export function agentSkillsArgs(): string[] {
  return agentSkillsAvailable() ? ["--add-dir", AGENT_SKILLS_DIR] : [];
}

/** Host paths a bwrap membrane must bind for the `--add-dir` above to resolve inside the sandbox. */
export function agentSkillsMembranePaths(): string[] {
  return agentSkillsAvailable() ? [AGENT_SKILLS_DIR] : [];
}
