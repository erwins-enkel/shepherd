# Drain context trim, re-decided: keep progressive disclosure

**Issue:** #2001 (epic #2005) · **Decided:** 2026-08-03 · **Measured on:** Claude Code 2.1.220

**Decision.** Auto (drain) spawns no longer pass `--disable-slash-commands`. They keep the Skill
tool and the session checkout's own `.claude/skills/`, and instead disable the catalogs an
unattended coding run cannot use: every operator plugin (as before), Claude Code's bundled skills,
and the operator's personal `~/.claude/skills`.

**Net ≈ +1,107 tokens/turn** versus the previous trim: +1,059 measured in Claude Code's resident
prefix, plus ≈ 48 estimated for the 192 characters this change adds to the context-trim notice
(which now has to say _which_ skills are gone rather than "all of them"). Still a sixth of the
+6,012 that simply dropping the flag would have cost.

## Why it was re-decided

Issue #499 traded the skill catalog for tokens when nothing invoked skills, and the flag is blunt:
Claude Code documents `--disable-slash-commands` as _"Disable all skills."_ That deleted progressive
disclosure — the loading mechanism — for exactly the sessions that run unattended, while ~5.5 KB of
resident notices stayed in the prompt. It also propagated: the onboarding skill told operators never
to reference a skill in a repo's agent instructions, because drain could not load one.

## Measurements

Method: `scripts/measure-spawn-prefix.sh`, one `claude -p` round-trip per variant with a trivial
prompt, run in a Shepherd worktree so CLAUDE.md and project context match a drain session. "Prefix"
is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` — everything resident
before the turn's work. n=3 per variant; every repetition returned the identical figure.

Environment: 6 enabled plugins (240 plugin skills), 30 user-level skills, 3 project skills.

| Variant                                                              | Prefix tokens | Δ vs previous trim |
| -------------------------------------------------------------------- | ------------- | ------------------ |
| previous trim — `--disable-slash-commands` + plugins off             | 34,175        | —                  |
| **shipped** — plugins off + `disableBundledSkills` + user skills off | **35,234**    | **+1,059**         |
| naive re-enable — drop the flag, plugins still off                   | 40,187        | +6,012             |
| no trim at all                                                       | 46,448        | +12,288            |

What the flag's 6,012 tokens actually bought: bundled skills ≈ 1,790 · the operator's personal
skills ≈ 3,163 · the Skill tool plus this repo's own 3 skills ≈ 1,059. In an empty directory (no
`.claude/skills`, no CLAUDE.md) the same comparison is 20,743 → 21,366, so **≈ 623 tokens is the
mechanism itself** and the rest scales with the skills a repo chooses to ship.

Functional check under the shipped overlay — the model lists exactly
`merge-train, shepherd-epic-authoring, shepherd-onboarding`: the repo's own skills, and nothing else.

## The other side of the ledger

The resident text this unblocks, measured with the #1999 prompt-budget instrument over a drain-shaped
payload as this PR leaves it (`composeSystemPromptBlocks(null, true, {trimmed: true})`), which totals
2,492 est. tokens / 9,968 chars:

| Block                   | chars | est. tokens |
| ----------------------- | ----- | ----------- |
| `single-pr-invariant`   | 1,685 | 422         |
| `tmpfs-worktree-notice` | 1,307 | 327         |
| `manual-steps-notice`   | 1,189 | 298         |
| `worktree-stash-notice` | 942   | 236         |
| `context-trim-notice`   | 619   | 155         |
| **deletable subtotal**  | 5,742 | **1,438**   |

`context-trim-notice` is 619 chars because this PR reworded it (427 before); that growth is the
≈ 48 tokens already counted in the net delta above.

Those are on-demand guidance, not per-turn law — the next slice of the epic can move them behind the
mechanism this decision restores, at which point the two slices together land at roughly break-even
(≈ +1,107 now, up to −1,438 later). Nothing in this PR deletes a block.

Token figures in the two tables are **not** the same kind of number: prefix figures are what the API
reported; block figures are the instrument's chars/4 estimate.

## Rejected alternatives

- **Drop the flag as-is** (+6,012/turn) — pays for 240 plugin skills, 30 personal skills and Claude
  Code's built-ins that no drain session invokes.
- **An alternative disclosure channel** (a single always-on pointer, or hook-delivered guidance) —
  would reimplement lazy loading Claude Code already does, for more than the 1,059 tokens the real
  mechanism costs once the irrelevant catalogs are excluded.

## Caveats

- **Machine-specific.** The deltas scale with the operator's own plugins and skills; a machine with
  more personal skills saves _more_ from the override, not less. Re-run the script rather than
  quoting these figures.
- **CLI-version-specific.** `disableBundledSkills` and `skillOverrides` are Claude Code 2.1.220
  settings keys. An older CLI that doesn't know them ignores them (verified: a spawn carrying an
  unknown settings key completes normally), degrading to "skills on, catalog bigger" — never to a
  broken spawn.
- **`skillOverrides` is keyed by skill name, not source**, so the trim subtracts the session's own
  skill names from the override set. Those are enumerated in the **worktree** — the agent's cwd, and
  therefore where Claude Code resolves project skills from; a skill added on the branch exists only
  there. Both sides resolve the name the way Claude Code does — front-matter `name`, directory entry
  as fallback (`skillNameFrom`, src/commands.ts) — because entries under `~/.claude/skills` are
  commonly symlinks and front-matter may rename a skill.
- **Behavioral, not only numeric.** Drain agents can now load a repo's skills mid-run.
  `SHEPHERD_TRIM_AUTO_CONTEXT=false` remains the unchanged escape hatch, and attended sessions were
  never trimmed.
