# Dirge (Rust coding agent) — what's worth stealing for Shepherd

**Source:** [`dirge-code/dirge`](https://github.com/dirge-code/dirge) · [landing](https://dirge-code.github.io/) · [author's design rationale](https://yogthos.net/posts/2026-06-08-dirge-code.html). Adapted from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code).

**This is a research/inspiration scan — no product code changes.** It reads dirge's design against Shepherd's _current_ implementation (paths verified in this repo) and ranks what is genuinely borrowable vs. what we already do.

> A note on framing: dirge is a **single coding agent** (a Claude-Code peer) optimised to make _cheap/open_ models reliable. Shepherd is an **orchestration layer over Claude Code subscription spawns**. So roughly half of dirge's cleverness is aimed at a problem we deliberately don't have (keeping DeepSeek/Qwen on the rails). The inspiration is in the _harness ideas_, not the model-thrift.

## TL;DR

The single most useful thing dirge offers Shepherd is **independent convergence**: a second, unrelated harness arrived at the same memory architecture we built (SQLite + full-text search + salience scoring + decay/tombstoning, explicitly rejecting both vector embeddings _and_ markdown), and the same role-separated model routing and settled-idle auto-curation. That's a strong signal our learnings flywheel and LLM-routing direction are right, not idiosyncratic.

Beyond validation, **two ideas are genuinely novel for us and worth an issue each**, and one is a narrow extension of work we've already scoped:

| #   | Idea (from dirge)                                                                             | Verdict                          | Shepherd gap                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`/why` — explain why the policy/gate decided as it did**                                    | **Adopt-candidate**              | We have no operator-facing trace for _why_ a session is parked/blocked/gate-held. `BlockReason` is inferred from the terminal tail, not from the gate that actually holds it.                   |
| 2   | **Pre-finalization gate — don't take the model's word that it's "done"**                      | **Adopt-candidate**              | A session archives on the agent's `haltReason:'completed'` with **no** check that a diff exists or the build is green.                                                                          |
| 3   | **Escalation _role_ — bump a stuck session to a stronger model before escalating to a human** | **Worth a spike**                | Our round-caps escalate stuck work straight to a human; there's no "try a stronger model first" rung. Partly covered by [`llm-touchpoint-routing-audit.md`](./llm-touchpoint-routing-audit.md). |
| 4   | Salience-scored, decaying, FTS-searchable learnings memory                                    | **Already built** (validates us) | See [`learnings-management-at-scale.md`](./learnings-management-at-scale.md). One small slice — letting the agent _search_ the cold tier — may be a minor gap.                                  |
| 5   | Role-based per-model routing (main / review / summarize / subagent)                           | **Already built** (validates us) | `reviewer-argv.ts`, `default-model.ts`, distiller model param.                                                                                                                                  |
| 6   | Proactive structured checkpoint at fixed window-cadence                                       | **Mostly covered**               | Recap fires on settled-idle + pre-archive; no _mid-session restart-state_ checkpoint, which is the residual `adoptOrphans` gap.                                                                 |

---

## What dirge is (one paragraph)

A ~36 MB single Rust binary, ~8–15 MB RAM, terminal coding agent. Batteries-included: MCP/LSP/ACP, tree-sitter code intelligence, a Janet plugin runtime, and a persistent memory system, all on by default. Its explicit thesis (from the author's post): _"much of what makes an agent effective in practice lies in how well the harness meets the expectations of the model"_ — i.e. invest in the harness so **budget models punch above their weight**, rather than paying for a frontier model. It organises its design around failures at **three time-scales** — per-turn (seconds), session-length (hours), cross-session (days) — and builds one layer against each. That three-layer lens is a genuinely useful framing and the rest of this doc borrows it.

---

## Idea 1 — `/why`: explain the gate decision · **Adopt-candidate**

**Dirge.** Every authorization flows through a single **Policy Decision Point**. `/why <tool> [input]` runs a _dry-run policy trace_ that shows exactly which rule decided and why. There are four modes (`standard`/`restrictive`/`accept`/`yolo`) but the interesting part isn't the modes — it's that the decision is **explainable on demand** instead of being an opaque allow/deny.

**Shepherd today (verified).** A session's held/parked state is spread across several orthogonal fields — `planPhase` (`planning`→`executing`, `src/types.ts`), `mergingSince`/`mergingTrainId`, `readyToMerge`, `haltReason` (`usage_limit`|`completed`|`operator`|`error`), and a `BlockReason` (`src/blocked.ts`) whose _shape_ (menu / yes-no / awaiting-input / stall / quota) is **inferred from the terminal tail**, not reported by the subsystem that's actually holding the session. There is **no single "why is this session not moving?" trace.** When a PR sits in the merge train, or a plan is parked at the gate, or a release-please PR is approval-blocked (see the recurring release-please / CI-approval pain), the operator has to reconstruct the reason by hand from logs and tabs.

**Why it fits.** This is Shepherd's _exact_ domain pain — the whole product is "what needs a human now," and the answer is currently legible only to someone who already knows the state machine. A per-session **decision trace** ("blocked because: plan gate round 3/3 returned REWORK and is awaiting your call" / "in merge train T-42, behind base, rebasing" / "halted: usage*limit, resumes at HH:MM" / "critic posted request-changes, steered back to agent") would collapse a lot of operator archaeology. It also dovetails with the Herd rundown ("what needs a human now") — the rundown says \_that* a session needs attention; `/why` would say _why_.

**Shape of the work.** Give each gating subsystem (plan gate, critic/review, merge train, automerge, drain/autopilot, halt) a small structured "hold reason" it _writes_ when it parks a session, instead of leaving the UI to infer it. Surface it as a per-session "Why parked?" affordance and feed the one-liner into the rundown + push summary. This is additive and mostly server-side; the hard part is discipline (every park site must set a reason), not mechanism.

---

## Idea 2 — Pre-finalization gate: don't trust "done" · **Adopt-candidate**

**Dirge.** Its per-turn layer includes a **pre-finalization gate**: _"doesn't just take the model's word that it has finished"_ — it verifies the build passes and that code actually changed before accepting completion. Paired with **circuit breakers on non-progressing loops** and a **thinking-stall watchdog**.

**Shepherd today (verified).** A session transitions to done via `haltReason:'completed'` (set from the agent's halt signal), then archives deterministically: stop agent → `beforeArchive()` recap hook (15s budget) → remove worktree → archive row (`src/service.ts`). There is **no barrier asserting "this session produced a diff / opened a PR / has green CI" before it's treated as complete.** We lean entirely on downstream gates (automerge, merge-train) to catch a no-op — which they do _eventually_, but only after the session is already filed as done. This is the mechanism behind the "agent declared done with nothing to show" failure class (cf. the _drive-home / don't-declare-impossible_ and _verification-before-completion_ learnings) and the non-isolated-session-never-links-a-PR trap.

**Why it fits.** For **autopilot/drain** sessions especially, a cheap completion check — "halt says completed; is there a non-empty diff vs. base / an associated PR? if not, re-prompt once, then mark needs-human instead of done" — turns a silent false-complete into an early, actionable flag. It's the orchestration-layer analogue of dirge's build-and-diff check, and it's squarely in our wheelhouse because we already track branch/PR association per session.

**Caveat / scope.** Keep it a _completion verifier_, not a quality judge — that's the critic's job. The gate only answers "did anything happen," cheaply and deterministically (git diff stat + PR-association lookup), no LLM. Respect the existing lightweight-repo completion barrier rather than duplicating it.

---

## Idea 3 — An escalation _role_: stronger model before a human · **Worth a spike**

**Dirge.** Routing assigns separate models to **main loop / review / escalation / summarization / subagent** roles, and on _repeated failure_ it **escalates to a stronger model** automatically. The escalation role is the novel bit: the cheap model drives, and only a stuck turn pays for the expensive one.

**Shepherd today (verified).** We already do per-role routing — critic/plan-reviewer via `readonlyReviewerArgv()`, distiller has its own model param, the main agent uses the operator/drain default (`default-model.ts`). But escalation on non-progress is **to a human** (round caps: critic 3, plan gate 5), never to a stronger model. The Fable→Opus fallback is availability-only, not a quality-escalation rung.

**Why it's only a spike, not an adopt.** Our cost model is the inverse of dirge's: we run **subscription** spawns, not metered budget models, so "save money by defaulting to a cheap model and escalating" doesn't transfer cleanly. The transferable slice is narrower and human-cost-driven: when a drain/autopilot session on a lighter default (e.g. Fable/Haiku) trips a non-progress circuit breaker, **try one rung up (Opus) before pinging a human.** That could cut human interrupts on the long tail. Whether it actually does is an empirical question — hence a spike, with a pre-registered "interrupts avoided per escalation" threshold, not a build. Note also we have **no main-loop non-progress circuit breaker** today (only the per-gate round caps); dirge's stall watchdog is the prerequisite, and `BlockReason`'s existing `stall` shape is a starting point.

---

## What dirge independently validates (already built — don't re-do)

This is the most reassuring part of the scan. Two harnesses, no shared lineage, same conclusions:

- **Memory = SQLite + FTS, salience-scored, decaying, tombstoned — _not_ vectors, _not_ markdown.** Dirge: per-project SQLite, hot entries inline + the rest behind FTS5, _"use of an entry boosts its salience, while disuse causes it to drop,"_ tombstoning for recoverability, and an explicit rejection of vector search (citing _"inline grep beat vector retrieval for every harness/model pair"_ and _"weaker models degraded the most under vector search"_) and of markdown (_"every byte rides along in the prompt whether it's relevant or not… easy to get out of sync"_). **Shepherd already does all of this**: `learnings` table in `src/store.ts` with `helpfulCount`/`injectedCount`/`ineffectiveCount`/`lastUsedAt`, Wilson-score retirement + trial-reaping + proposed-expiry in `src/learnings-lifecycle.ts`. We also evaluated and **parked** a graph/vector layer ([`graphify-evaluation.md`](./graphify-evaluation.md)) on the same reasoning. Convergence ⇒ keep going; see [`learnings-management-at-scale.md`](./learnings-management-at-scale.md) for the open lifecycle work.
  - _Possible minor gap:_ dirge lets the **agent search the cold FTS tier on demand**; we inject a hotset but it's worth confirming the spawned agent can _query_ cold learnings rather than only receiving the curated top-N. Small, optional.
- **Role-separated model routing.** We adopted the philosophy independently — every in-app LLM call is a transient interactive subscription spawn, classification touchpoints already run on Haiku, readiness is fully deterministic. See [`llm-touchpoint-routing-audit.md`](./llm-touchpoint-routing-audit.md). Dirge's contribution here is only the escalation rung (Idea 3).
- **Phased explore→plan→implement→review, context-isolated.** Our plan gate + subagent-driven execution already embody this.
- **Settled-idle / proactive curation.** Dirge folds history into a structured summary _while the model is still competent_ (not emergency compaction); we fire recap and learnings curation on **settled idle** (the house rule: settle, don't fire on the first idle tick). Same instinct.
- **Worktree isolation per session.** Both do it.

---

## Not a fit (noted, so we don't chase them)

- **Native Rust / 8 MB footprint.** Dirge's headline is irrelevant to us — Shepherd orchestrates Claude Code; we're not rewriting the agent, and our resource story is fine.
- **Janet plugin runtime + lifecycle hooks (`on-prompt`/`on-tool-start`/…).** This is dirge being _its own_ extensible agent. Shepherd's extension surface is Claude Code's own hooks (we already ingest them — see [`claude-code-hooks-ingestion.md`](./claude-code-hooks-ingestion.md)); adding a second plugin runtime would be duplicative.
- **`dirge mcp` (expose the agent as an MCP server so a planner delegates to it).** Architecturally the _opposite_ of Shepherd — and our spawns run `--safe-mode`, which blocks MCP anyway.
- **Tree-sitter validate-before-write / minified skeleton reads / LSP-inline.** These live _inside_ the coding agent's edit loop. Shepherd doesn't author edits — the spawned Claude does — so they're Claude Code's concern, not ours.
- **Living specs as SQLite rows vs. markdown.** Interesting, but our build-queue (agent-authored, self-revising) already occupies this slot; not worth a parallel mechanism.

---

## Recommendation

Three candidate follow-up issues, ranked:

1. **`/why` session-state trace** (Idea 1) — highest leverage, dead-centre in Shepherd's "what needs a human / why" mission, additive, no spawn-isolation impact. Strongest candidate.
2. **Pre-completion verification gate for autopilot/drain** (Idea 2) — small, deterministic (git-diff + PR-association, no LLM), directly attacks the silent-false-complete failure class.
3. **Spike: stronger-model escalation rung before human escalation** (Idea 3) — empirical, pre-registered threshold; only worthwhile if it measurably cuts human interrupts. Lower priority given our subscription cost model.

Everything else dirge does is either already in Shepherd (and now independently validated) or architecturally out of scope. No code changes proposed here.
