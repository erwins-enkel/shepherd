# Should Shepherd use `@earendil-works/pi-durable`?

**Verdict: NO.** pi-durable is a durable _in-process agent harness_: it calls model APIs itself
(through `pi-ai`) and runs its own tool loop. Shepherd's architecture is the opposite: it drives
the **real `claude` / `codex` CLIs** in herdr panes and never links a model library. To adopt
pi-durable, Shepherd would have to replace Claude Code as the agent runtime. That breaks the
subscription/ToS footing, the skills/hooks/MCP surface, and the HUD terminal. A few of its
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

| Shepherd constraint                                                                                                                                                         | pi-durable                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents are the real `claude` / `codex` CLIs (`AGENT_PROVIDERS = ["claude","codex"]`, `src/types.ts:20`). Shepherd only builds the argv and steers the PTY (`src/herdr.ts`). | It _is_ the agent loop. Using it means dropping Claude Code: no skills, plugins, hooks ingestion, MCP config, plan mode, `AskUserQuestion`, or CC's own compaction and permissions.                                                                                   |
| All LLM work runs on the subscription through a spawned interactive CLI, never `claude -p` or the raw API (`src/autopilot-llm.ts:287`).                                     | API keys are billed per token. Its Anthropic Pro/Max OAuth path is a third-party client using subscription credentials, which is exactly the footing Shepherd avoids by driving the official CLI. Treat it as **not allowed** unless Anthropic's terms say otherwise. |
| The operator watches and types into a live terminal (the HUD).                                                                                                              | It has no terminal. Shepherd would need a new UI built on its watch/event APIs.                                                                                                                                                                                       |
| Server runs on one Bun event loop that must never block (memory: single-loop).                                                                                              | The portable SQLite/JSONL cores run on Bun. But it is a second stateful runtime with its own storage next to `~/.shepherd/shepherd.db`, and it allows only one process per storage.                                                                                   |
| Durability today comes from the CLI's own session persistence plus Shepherd's reconcilers (`src/reconcile.ts`, reviewer `reapOrphans`, plan-gate `adoptOrphans`).           | It only makes durable the turns _it_ runs. It can't checkpoint inside a Claude Code process, so it does nothing for the crashes Shepherd actually sees: orphaned reviewers, name-squats, and wedged dialogs.                                                          |

The small helpers (namer, judge, critic) don't make a good entry point either. They are already
fixed to the transient-subscription-spawn pattern, and moving them to pi-durable would bring
back API billing.

## 3. When the answer would change

- Shepherd gains a **third, API-keyed, in-process provider** (for example a cheap non-Anthropic
  model for classification), and the operator accepts per-token billing for it. pi-ai (not
  necessarily pi-durable) would then be a candidate. That should wait until pi-durable drops the
  "Experimental" label, given that 1.4.0 already shipped a schema migration with no rollback.
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
