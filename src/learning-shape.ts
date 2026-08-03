/**
 * What the learnings flywheel is allowed to admit (issue #2004).
 *
 * The flywheel was built to manufacture imperative behavioral rules, distil them, rank them and
 * inject up to `SHEPHERD_HOUSE_RULES_BUDGET_CHARS` of them into every spawn's system prompt. That
 * made sense when models needed to be told how to work. It stopped making sense when the same
 * guidance began competing with the system prompt and the operator's actual request for attention —
 * the conflicting-instruction failure Anthropic describes in "The new rules of context engineering
 * for Claude 5 generation models" (they deleted over 80% of Claude Code's system prompt on the
 * strength of it).
 *
 * So the flywheel is re-targeted, at ADMISSION, from rules to gotchas: what is TRUE about this repo
 * that an agent cannot work out for itself, why getting it wrong hurts, and how to apply it. The
 * test below is the single source of truth for that, shared verbatim by the distiller prompt
 * (proposal + delete), the optimizer prompt (rewrite) and the sweep tooling (retire) so the three
 * cannot drift apart.
 *
 * It is INSTRUCTION, not a gate — no regex can tell a fact from a platitude. The corrective loops are
 * the distiller's fails-the-test DELETE criterion (which keeps sweeping the active set every run) and
 * the operator's approve click, which sees the same criterion restated in the drawer.
 */

/** Agent-facing prompt text, so fixed English — same precedent as the distiller/critic prompts. */
export const LEARNING_ADMISSION_TEST = [
  "ADMISSION TEST — a candidate qualifies only when ALL THREE hold:",
  "  1. NON-DERIVABLE — an agent could not learn it by reading the repo, its README/CLAUDE.md, or",
  "     `--help`, in the session where it needs it.",
  "  2. CONSEQUENTIAL AND QUIET — getting it wrong causes a concrete failure that is silent, delayed,",
  '     or expensive to undo. "the linter catches it" is a REJECT.',
  "  3. ATTACHED TO AN ARTIFACT — it names the file, flag, endpoint, table, field or invariant it",
  "     applies to, so a reviewer can check it against the code.",
  "",
  "REJECT outright — do not propose, and DELETE if already active — when the candidate is:",
  "  - general engineering judgement or process a capable model already follows unprompted:",
  "    scope discipline, verify-before-claiming, ask-before-destructive, deliver-findings-first,",
  "    don't-build-what-wasn't-asked, finish-what-you-started;",
  "  - a restatement of a directive the agent is already given every session (worktree/stash safety,",
  "    tmpfs, untrusted content, one-PR-per-session, plan gate, build queue) or of the repo's CLAUDE.md;",
  '  - a preference with no failure mode ("prefer X over Y");',
  "  - broad enough to apply to any repository — that is not a fact about THIS one.",
].join("\n");

/** How a qualifying finding must be written. The injected block renders the `rule` line ONLY
 *  (`renderHouseRulesBlock` in house-rules.ts) — the rationale never reaches the agent — so the
 *  fact, its consequence and its application all have to survive in that one line. */
export const LEARNING_FACT_SHAPE = [
  "SHAPE — write each qualifying finding as ONE self-contained line carrying all three parts:",
  "  <the fact — what is true, naming the artifact> — <why it bites — the failure it causes> ; <how to apply it>",
  "Only this line is ever shown to a future agent, so it must stand alone. State the fact, not an",
  'exhortation: prefer "`refs/stash` is one stack shared by every worktree of the repo, so a bare',
  "`git stash pop` can take another session's entry — use `git stash create` + `apply <sha>`\" over",
  '"never use git stash".',
].join("\n");

/** Hard cap on stored rule text — the width every entry point trims to. */
export const LEARNING_RULE_MAX_CHARS = 240;

/** Trim rule text to {@link LEARNING_RULE_MAX_CHARS} at a WORD boundary.
 *
 *  The blunt `slice(0, 240)` this replaces cut mid-word, and a fact line loses its point when the
 *  consequence is the part that falls off — the live corpus already carried "…leaks into execution
 *  across consumers when one site " as a truncated fragment. Fact-shaped entries run longer than the
 *  imperatives the flywheel used to emit, so the cut matters more, not less. Falls back to a hard
 *  slice when the overlong text has no space to break on. */
export function trimRuleToLimit(rule: string): string {
  const text = rule.trim();
  if (text.length <= LEARNING_RULE_MAX_CHARS) return text;
  const cut = text.slice(0, LEARNING_RULE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Stored in `retiredReason` by the sweep (issue #2004) so a retirement carries WHY it happened —
 *  distinct from `auto-retire` (Wilson-scored underperformance), `trial-expired`, `superseded` and
 *  `merged`. Reversible through `POST /api/learnings/:id/restore`. */
export const SWEEP_RETIRE_REASON = "not-a-gotcha";
