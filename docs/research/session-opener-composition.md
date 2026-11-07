# Session opener composition — what every turn re-reads

**Issue:** [#3778](https://github.com/erwins-enkel/shepherd/issues/3778) · **Measured:** 2026-11-07
· **Claude Code:** 2.1.301–2.1.319 · **Window:** spawns created 2026-10-25 → 2026-11-07

Follow-up to [`plan-execute-phase-cost.md`](./plan-execute-phase-cost.md) (#1951), which found that a
fresh session's first request already carries ~74k tokens (p50) of context, re-read on every turn.
This document breaks that opener down by spawn kind and block, ranks the blocks by what they cost
in re-reads, and records the trims shipped with it.

**Result.** About half of all opener re-reads (46.2% of Σ tokens × requests) come from six Claude Code
built-in tools that Shepherd sessions almost never call: Artifact, Workflow, SendFeedback,
ScheduleWakeup, ReportFindings and ListAgents. Satellites also carry AskUserQuestion (3.1%), which
an unattended role can't use. Shepherd's own injected directives are 1.9%. Two trims remove the dead
tools: a `permissions.deny` overlay on every task spawn, and `--tools` set to exactly what each
transient role can run. Live spawns with the real argv builders measured **−30%** (task session),
**−73%** (critic/plan reviewer) and **−61%** (recap and other writer roles) per turn.

## Method

Claude Code 2.1.3xx records every API request in the transcript. `api-request-shape` holds the
system blocks and tool schemas, `api-request-blob` holds the message bodies, and `api-request` says
which shape and blobs one request used. The first main-thread request is the opener.
[`scripts/opener-blocks.ts`](../../scripts/opener-blocks.ts) attributes every character of it to a
named block. A unit test pins that each character lands in exactly one block.

Characters become tokens through a least-squares fit against the API's own count, the first
assistant record's `input + cache_read + cache_creation`. Tool schemas and prose get separate
rates: **2.89 chars/token for tool JSON, 2.59 for text**. Per transcript, the fitted estimate sits
at **p10 −1.0% / p50 +0.1% / p90 +0.9%** of the measured opener (n = 3,881). That is well inside
the issue's 10% bar, so the block figures below are calibrated tokens, not chars/4 guesses.

Spawn kinds come from the DB: `sessions` for task sessions, `reviewer_spawns` for satellites.
"Requests" counts unique main-thread request ids per transcript, which is how often the opener is
paid.

**prompt-budget reconciliation.** `src/prompt-budget.ts` (`GET /api/prompt-budget`) measures only
Shepherd's appended payload. Its character counts match the transcript's `shepherd:*` blocks
exactly (ratio **1.000**, n = 258). Its `chars/4` token estimate undercounts real tokens by
**1.54×**, because this tokenizer averages ~2.6 chars/token on that prose. The constant stays, since
the instrument is used for ratios. Read its absolute token figures × ~1.5.

## Opener by spawn kind

| Kind                                            | n     | Σ requests | Opener p10 / p50 / p90   |
| ----------------------------------------------- | ----- | ---------- | ------------------------ |
| sat:review (PR critic)                          | 1,276 | 19,640     | 49,149 / 51,853 / 54,878 |
| sat:plan_gate (reviewer)                        | 909   | 7,701      | 46,416 / 48,398 / 50,747 |
| attended + plan gate                            | 136   | 7,490      | 59,641 / 74,372 / 85,875 |
| drain (auto)                                    | 75    | 4,028      | 61,831 / 67,711 / 76,651 |
| sat:recap                                       | 1,236 | 2,355      | 50,483 / 54,268 / 57,932 |
| attended (no gate)                              | 31    | 1,104      | 51,924 / 66,037 / 78,831 |
| sat:doc_agent                                   | 156   | 750        | 43,086 / 43,854 / 44,030 |
| plugin / assistant / epic / research / maintain | 62    | 389        | 43–73k p50               |

Satellites dominate the frequency: critic and plan-gate reviewers alone make 2,185 spawns and
27k requests, against 7.5k for attended plan-gated sessions.

## Composition per kind (median calibrated tokens)

| Kind                 | 6 unused tools | AskUserQuestion | Other CC tools | CC prompt¹ | CLAUDE.md + memory | Skills + plugins² | Shepherd | Task prompt |
| -------------------- | -------------- | --------------- | -------------- | ---------- | ------------------ | ----------------- | -------- | ----------- |
| sat:review           | 29.0k          | 1.8k            | 6.1k           | 5.9k       | —                  | 0.1k              | —        | 9.5k        |
| sat:plan_gate        | 28.9k          | 1.7k            | 6.1k           | 5.4k       | —                  | 0.1k              | —        | 5.7k        |
| attended + plan gate | 19.6k          | 1.8k            | 5.4k           | 9.3k       | 14.8k              | 15.4k             | 4.0k     | 0.6k        |
| drain                | 25.5k          | 1.8k            | 5.4k           | 8.8k       | 15.9k              | 4.8k              | 4.0k     | 0.8k        |
| sat:recap            | 29.0k          | 1.8k            | 4.7k           | 8.3k       | 2.6k               | 0.1k              | —        | 8.1k        |
| attended             | 19.6k          | 1.8k            | 5.4k           | 9.5k       | 11.5k              | 14.1k             | 1.7k     | 0.3k        |
| sat:doc_agent        | 29.0k          | 1.8k            | 6.1k           | 6.0k       | —                  | 0.1k              | —        | 1.0k        |

¹ System prompt, environment, agent listing, built-in deferred-tool names, git-status/attribution
reminders. ² Skill catalogs, plugin hooks (superpowers), MCP instructions and deferred MCP tool
names. Medians per column, so rows don't sum exactly to the opener. Reviewer and doc satellites run
`--safe-mode`, which is why CLAUDE.md and plugins are absent there. The "6 unused" column differs by
kind because the schemas do: Workflow is 7.7k in drain and satellites but 1.9k in attended
sessions, and Artifact is 16.6k in satellites but 13.1k in task sessions.

## Ranking: Σ tokens × requests, all kinds (2,515M)

| Block                                                                        | Share | Verdict                                                                                   |
| ---------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| Artifact, Workflow, SendFeedback, ScheduleWakeup, ReportFindings, ListAgents | 46.2% | **removable** — shipped                                                                   |
| CC system prompt + per-session sections                                      | 12.2% | required                                                                                  |
| Task prompt (critic diff, plan, recap transcript, issue)                     | 10.8% | required                                                                                  |
| Other CC tools (Bash, Read, Edit, Write, Agent, …)                           | 10.0% | required (satellites: trimmed to their allowlist — shipped)                               |
| CLAUDE.md chain + MEMORY.md index                                            | 9.0%  | operator/repo content — trimmable by its owner (see below)                                |
| Skills, plugins, MCP (attended + drain)                                      | 6.8%  | used in attended sessions → [#3780](https://github.com/erwins-enkel/shepherd/issues/3780) |
| AskUserQuestion                                                              | 3.1%  | **removable in satellites** — shipped; required in task sessions                          |
| Shepherd directives                                                          | 1.9%  | already trimmed (#2002); required                                                         |

Usage, counted over every tool call in every transcript the DB still references (spawns from
2026-10-19 on):

- Artifact: 3 calls, in 3 of 191 attended sessions. None in drain or satellites.
- Workflow: 0.
- ReportFindings: 0.
- SendFeedback: 1 (drain).
- ScheduleWakeup: 1 (attended).
- ListAgents: 2 (critic).
- Satellites never called AskUserQuestion.
- Critics and plan reviewers did launch `Agent` subagents successfully (17 critic and 9 plan-gate
  sessions), so `Agent` stays in the reviewer tool set.

## What shipped

1. **Task sessions** (attended, plan-gated, drain, Operator Assistant; spawn and resume).
   `spawnSettingsOverlay()` adds `UNUSED_BUILTIN_TOOLS` to `permissions.deny`. A blanket deny removes
   the tool from the request, not only the call. That holds under `--dangerously-skip-permissions`,
   verified on 2.1.319.

   One exception keeps Shepherd's own picker working: a session whose task text invokes `/design`
   (Artifact), `/workflow-authoring` (Workflow) or `/loop` (ScheduleWakeup, for dynamic pacing) keeps
   that tool. The exception is computed from `sessions.prompt`, so a resume offers the same tool list.

2. **Transient roles.** `buildTransientAgentArgv()` passes `--tools` with the built-ins each kind's
   allowlist can run. The prompt recommender passes `--tools Write`.

   | Kind          | `--tools`                       | Used by                                        |
   | ------------- | ------------------------------- | ---------------------------------------------- |
   | `reviewer`    | Read,Grep,Glob,Bash,Write,Agent | critic, plan reviewer, maintain, plugin agents |
   | `doc`         | Read,Grep,Glob,Bash,Write,Edit  | doc agent                                      |
   | `writer-ro`   | Read,Grep,Glob,Write            | task-shape                                     |
   | `writer-only` | Write                           | recap, namer, autopilot classifier, verify-key |

   Tools off the allowlist were already denied at call time under `dontAsk`. They now also stop
   riding the request. In the sampled transcripts the critic made 286 denied `Edit` attempts and
   recap 452 denied `Bash` attempts.

3. **One escape hatch.** `SHEPHERD_TRIM_BUILTIN_TOOLS=false` (or `0`/`off`) restores the full tool set
   for both trims. The default is on.

## Verification

The real builders' output (`spawnSettingsOverlay()`, `buildTransientAgentArgv()`) was fed to an
interactive `claude` 2.1.319 in a PTY, in this repo, with the trim off and then on:

| Spawn shape   | Off    | On     | Δ              | Tools offered with the trim on                                                      |
| ------------- | ------ | ------ | -------------- | ----------------------------------------------------------------------------------- |
| task session  | 62,932 | 44,091 | −18,841 (−30%) | Agent, AskUserQuestion, Bash, Edit, Read, Skill, ToolSearch, Write (+ CC internals) |
| `reviewer`    | 43,219 | 11,601 | −31,618 (−73%) | Agent, Bash, Glob, Grep, Read, Write (+ CC internals)                               |
| `writer-only` | 60,021 | 23,339 | −36,682 (−61%) | Write (+ CC internals)                                                              |

"CC internals" are `DeferredToolPlaceholder`, `advisor` and `EndConversation`, each under 100 tokens.

Projected medians from the composition table:

| Kind                 | Projected median opener |
| -------------------- | ----------------------- |
| sat:review           | ~20k                    |
| sat:plan_gate        | ~17k                    |
| attended + plan gate | ~55k                    |
| drain                | ~42k                    |
| sat:recap            | ~18k                    |
| sat:doc_agent        | ~10k                    |

Across the window, that removes roughly half of all opener re-reads. Re-measure on real spawns
after deploy:

```sh
bun run scripts/opener-composition.ts --since <deploy date>
```

## Not trimmed here

- **Attended plugins and skills.** These cost ~13–15k per attended turn, but attended sessions use
  them (superpowers 27 invocations, vercel MCP in 13 sessions, personal skills ~30), so trimming them
  isn't loss-free. A per-repo allowlist is filed as [#3780](https://github.com/erwins-enkel/shepherd/issues/3780).
- **The MEMORY.md index.** It costs ~4.6k per attended turn in this repo, and the index is already
  over Claude Code's own 24.4 KB load limit, so it is truncated. It is operator content: shortening
  its entries is the lever.
- **Project CLAUDE.md files.** They cost ~13k per turn in the repo most drain sessions run in. That
  is repo content, so the trim belongs to the repo's owner.
- **Drain's claude.ai skill catalog** (`anthropic-skills:*`, ~3.7k per drain turn). `trimDecision()`
  disables plugins, bundled skills and personal skills, but not these, and with the rest of the
  catalog gone Claude Code lists them with full descriptions. Candidate for a later `trimDecision`
  pass.
- **The plan-gate directive** (~2k). Claude Code snapshots the system prompt at the first request,
  so the directive stays past Go until a compaction. Dropping it mid-session would rewrite the
  prompt cache.

## Caveats

- **Machine- and CLI-specific.** Tool schemas differ by spawn shape and Claude Code release (Artifact
  is 13.1k in task sessions, 16.6k under `--safe-mode`). Plugin and skill loads are this operator's.
  Re-run the script after a CLI bump rather than quoting these figures.
- **A renamed tool.** A deny entry for a tool a newer CLI renames is a no-op, never a broken spawn.
  A renamed `--tools` name, however, silently drops that capability from a satellite. The allowlist⊆tools
  test catches drift inside Shepherd, not drift in the CLI.
- **Prompt-cache scope.** Claude Code marks the tools + base system prefix as globally cacheable.
  Shepherd's trimmed tool list is a different prefix, so the first spawn after an idle hour writes it
  instead of reading Claude Code's shared one. At Shepherd's spawn rate that's a rounding error
  against the per-turn saving.
- **Sessions spawned before the deploy** see the tool list change on their next resume and re-cache
  once.
- **Coverage.** Transcripts older than the request-recording CLI, and transcripts already removed with
  their worktree, are skipped. The window holds 3,881 openers.

## Reproduce

```sh
bun run scripts/opener-composition.ts --since 2026-10-25 --md          # this document's window
bun run scripts/opener-composition.ts --since <deploy date> --top 20   # after a change
```
