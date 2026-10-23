# Should Shepherd use `@earendil-works/pi-durable`?

**Verdict: NO.** pi-durable is a durable _in-process agent harness_: it calls model APIs itself
(through `pi-ai`) and runs its own tool loop. Shepherd's architecture is the opposite: it drives
the **real `claude` / `codex` CLIs** in herdr panes. The only model library it links is the
narrow `Judge` seam (`@typesafe-ai/sdk`, §2.1), a bounded decision primitive, not an agent loop. To
adopt pi-durable, Shepherd would have to replace Claude Code as the agent runtime. That breaks the
skills/hooks/MCP surface and the HUD terminal, and the Judge precedent doesn't cover it. A few of its
recovery _patterns_ are worth copying (§4); the library is not.

> Evaluation, **2026-10-23**, against `@earendil-works/pi-durable` **1.4.0** (released
> 2026-10-21, plus `[Unreleased]` on `main`). Read-only research task: this document is the
> entire diff.

## 1. What pi-durable is

- A library: `Harness.open(storage, { models, registry })`. Conversations, model turns, tool
  calls and app state are committed to storage (Memory, SQLite, JSONL, IndexedDB, Durable Object
  SQLite) **before** anything is shown. After a crash, reopening the storage and calling
  `resume()` continues the work.
- Every step is a durable task state machine (`pi.generation`, `pi.tool`, user tasks) that writes
  a checkpoint per phase. A tool interrupted mid-call reruns only if it is declared
  `replay: "safe"`; otherwise the model gets an `interrupted` result.
- Other features: idempotent `submit({ requestId })`, durable sleeps (`sleepUntil`), a crash-loop
  guard (a task is parked after `restartLimit` = 5 unclean restarts; `retryTask()` runs it
  again), child tasks, a task graph, forks, compaction, usage/cost, and telemetry.
- Model access goes through `pi-ai`: API keys for about 30 providers, plus OAuth flows, including
  Anthropic Claude Pro/Max.
- Labelled **"Experimental. The API changes without notice between releases."** 1.4.0 alone
  breaks `sleep()`, the task states and the SQLite schema (with no rollback), and `main` already
  breaks `Storage.commit` and the watch APIs again. One process per storage, with no
  cross-process locking.

## 2. Why it doesn't fit

| Shepherd constraint                                                                                                                                                                                                                                                        | pi-durable                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agents are the real `claude` / `codex` CLIs (`AGENT_PROVIDERS = ["claude","codex"]`, `src/types.ts:20`). Shepherd only builds the argv and steers the PTY (`src/herdr.ts`).                                                                                                | It _is_ the agent loop. Using it means dropping Claude Code: no skills, plugins, hooks ingestion, MCP config, plan mode, `AskUserQuestion`, or CC's own compaction and permissions.                                                                                                                    |
| _Agent_ work is billed through the official CLI: the subscription by default, or an Anthropic API key in `authMode: "api-key"` (`src/config.ts:1036`, `src/spawn-auth.ts:43`), which still runs the CLI. Metered in-process calls exist only behind the Judge seam (§2.1). | Running agents in-process bills per token with no CLI fallback. Its Anthropic Pro/Max OAuth path is a third-party client using subscription credentials, which is exactly the footing Shepherd avoids by driving the official CLI. Treat it as **not allowed** unless Anthropic's terms say otherwise. |
| The operator watches and types into a live terminal (the HUD).                                                                                                                                                                                                             | It has no terminal. Shepherd would need a new UI built on its watch/event APIs.                                                                                                                                                                                                                        |
| Server runs on one Bun event loop that must never block (memory: single-loop).                                                                                                                                                                                             | The portable SQLite/JSONL cores run on Bun. But it is a second stateful runtime with its own storage next to `~/.shepherd/shepherd.db`, and it allows only one process per storage.                                                                                                                    |
| Durability today comes from the CLI's own session persistence plus Shepherd's reconcilers (`src/reconcile.ts`, reviewer `reapOrphans`, plan-gate `adoptOrphans`).                                                                                                          | It only makes durable the turns _it_ runs. It can't checkpoint inside a Claude Code process, so it does nothing for the crashes Shepherd actually sees: orphaned reviewers, name-squats, and wedged dialogs.                                                                                           |

### 2.1 The Judge precedent

Shepherd already accepts **one** API-billed, in-process model call. `src/judge.ts` defines a
vendor-neutral `Judge` seam with two primitives, `choice` and `noul`. `src/judge-typesafe.ts`
implements it over `@typesafe-ai/sdk` (`package.json:77`), billed on TypeSafe's own key.
`classifyStop` asks the judge first and falls back to the `claude` spawn
(`src/autopilot-llm.ts:247`, `:323-326`, `:341`). `src/judge-spend.ts` caps daily spend as a runaway
guard. So "never the raw API" is false, but look at what made that case acceptable:

- **Narrow and typed.** A pick-one-of-N or yes/no answer, with raw probabilities crossing the seam.
  It is not a free-form agent with tools.
- **Strictly optional.** Every judge failure (unarmed, over the ceiling, deadline) returns null and
  falls back to the spawn, so arming it can never cost a capability.
- **Bounded cost.** A total wall-clock deadline per call, plus a persisted daily ceiling.
- **Different billing from Anthropic.** A separate vendor key, so the Anthropic subscription
  footing is untouched.

pi-durable fails all four: it is a full agent loop, it would _replace_ the CLI rather than sit
in front of it, its spend is open-ended per run, and its Anthropic path is either per-token API
billing or third-party subscription OAuth. The helpers (namer, critic) don't make a good entry
point either. The critic needs a full agent with repo access, which is what the CLI provides.
The namer and classifier, if they ever leave the spawn, have a home already: another `Judge`
implementation, not a harness.

## 3. When the answer would change

- **A narrow in-process call needs more than `choice`/`noul`** (for example a free-text session
  name), under the Judge's rules: optional, CLI fallback, bounded spend. `pi-ai` could then back
  a second implementation or a sibling seam, as a multi-provider transport. That is still `pi-ai`,
  not pi-durable.
- **Shepherd wants to run whole agents in-process**, for example a cheap non-Anthropic background
  agent with no terminal, and the operator accepts open-ended per-token billing for it. pi-durable
  would then be a real candidate, but only after it drops the "Experimental" label, given that 1.4.0
  already shipped a schema migration with no rollback.
- Anthropic explicitly allows subscription OAuth in third-party harnesses. That alone still
  wouldn't justify replacing Claude Code; it would only remove the billing blocker.

## 4. Patterns worth borrowing

These ideas map onto known Shepherd failure modes, without the dependency:

1. **Crash-loop parking.** Count unclean restarts per unit of work, reset the count on progress,
   and park the work at N with a one-click retry. Spawned roles that die and get re-spawned (the
   reviewer orphan and plan-gate restart issues in memory) would show up as "parked", not loop or
   sit silently in ERR.
2. **Idempotent submit by `requestId`.** Dedupe steers and spawns by a caller-supplied key, so a
   retried POST or a lost restart can't double-steer or double-spawn.
3. **Durable sleeps as stored state, not timers.** A deadline is written to the DB and reconciled
   on boot, which fits the "Bun SIGTERM lost, reclaim-on-next-start" rule.
4. **Intent committed before side effects**, with an explicit `replay: "safe"` flag per
   action. This is a useful way to decide which reconciler actions can safely run twice.

None of these need an issue right now. Pick them up when the matching failure mode comes back.
