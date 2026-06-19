# Managing learnings at scale — auto-pruning, decay, dedup & effectiveness-based retirement

**Scope:** the _systemic lifecycle_ of Shepherd "learnings" (house-rules) as they accumulate across
many repos — capture → distill → inject → flag → optimize/promote. This is a **research/design
document; no product code changes**. It complements [`learnings-pane-ux.md`](./learnings-pane-ux.md),
which redesigns the _drawer UX_ (triage band, sticky headers). That doc makes the existing pile easier
to triage **by hand**; this one proposes the **machinery that keeps the pile small** so there is less to
triage in the first place.

**Commission:** the operator is "accumulating a massive number of learnings across many repos." Three
distinct pains, all currently manual:

1. **Processing burden** — every proposed learning needs a manual approve/dismiss; there is no ranking,
   batching, or auto-acceptance, so volume scales linearly with operator attention.
2. **Acting on "not working" rules** — `ineffectiveCount` is tracked, but the only response is a manual
   one-click **Optimize** (by design, the optimizer "NEVER runs on a timer"). A rule that keeps failing
   sits flagged until a human notices.
3. **Cap / trim pressure** — the 4000-char injection budget silently drops the lowest-priority rules
   ("OVER BY N · M dropped"), but nothing ever **retires** a rule, so the dropped set grows forever and
   the cap keeps biting. There is no decay, no expiry, no merge.

**Bottom line.** Shepherd already has the _plumbing_ (signals → distiller → learnings FSM → budgeted
injection → optimizer → promoter). What it lacks is a **lifecycle**: every rule, once `active`, lives
forever and is treated as equally valid. The fix is to make learnings **earn their place continuously**
— measure whether each injected rule actually helps, let unproven/stale rules **decay out of the budget
automatically**, **merge** near-duplicates at capture time, and **soft-retire** (never hard-delete)
rules that demonstrably don't work. Every leading agent-memory system converged on this shape; Shepherd
is missing the feedback edge that closes the loop.

---

## 1. Current state (grounded)

The full technical map is in the appendix; the load-bearing facts:

| Stage        | Where                                                 | Behaviour today                                                                                                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capture**  | `src/signals.ts`, `src/review.ts`, `src/plan-gate.ts` | Raw signals (`block`/`stall`/`critic`/`reply`) stored in `signals` table, scoped by `repoPath`. Pruned at **60 days** (`store.pruneSignals`, daily sweep `src/index.ts`).                                                                                                                                             |
| **Distill**  | `src/distiller.ts`                                    | Daily, for repos with ≥5 signals/60d, an LLM agent proposes `<=240`-char rules. Dedup = **exact normalized-text** match only (`normalizeRule`: trim/lowercase/collapse-ws). Also flags `ineffective` active rules.                                                                                                    |
| **State**    | `src/store.ts` (`learnings` table)                    | FSM `proposed → active/dismissed`, `active → promoted/dismissed`. Columns include `evidenceCount`, `ineffectiveCount`, `lastEvidenceAt`, `ineffectiveSignalIds`.                                                                                                                                                      |
| **Approve**  | UI `LearningsDrawer.svelte`                           | Operator manually approves (→`active`) or dismisses (→`dismissed`, **hard semantics**) each proposal.                                                                                                                                                                                                                 |
| **Inject**   | `src/house-rules.ts`                                  | `planHouseRulesInjection`: prioritize by `lastEvidenceAt` desc then `updatedAt` desc, **greedy-pack** into 4000 chars (`SHEPHERD_HOUSE_RULES_BUDGET_CHARS`). Over-budget rules dropped silently. **Always-on blob** — every `active`/`promoted` rule is a candidate for every spawn in that repo, regardless of task. |
| **Flag**     | `src/distiller.ts` `applyIneffective`                 | Distiller's LLM marks active rules that recent failure signals show didn't help → `incrementLearningIneffective` (deduped by `ineffectiveSignalIds`).                                                                                                                                                                 |
| **Optimize** | `src/optimizer.ts`                                    | **Manual only.** One-click rewrite of a flagged rule (or all-flagged per repo). Clears `ineffectiveCount`. Never auto-runs.                                                                                                                                                                                           |
| **Promote**  | `src/promote.ts`                                      | Manual. `active → promoted`; opens a PR writing the rule into `CLAUDE.md` between `shepherd:learnings` markers.                                                                                                                                                                                                       |

**What is missing, precisely:**

- **No positive effectiveness signal.** `ineffectiveCount` is a _harm_ counter. There is no
  _help_ counter — nothing records "this rule was injected and the session then went well." So a rule
  that has never demonstrably helped is indistinguishable from one that constantly helps.
- **No decay / expiry.** `lastEvidenceAt` _orders_ the budget but never _retires_ anything. A rule with
  no evidence for a year still occupies a budget slot ahead of a brand-new unproven rule only by
  `updatedAt`.
- **No semantic dedup / merge.** Two rules saying the same thing in different words both persist and
  both consume budget; the only guard is exact-text normalization.
- **No auto-action on flagged rules.** Flagging is detection without a default remediation.
- **Always-on injection.** Relevance to the current task is never considered — a UI-only rule is
  injected when the agent is editing a migration.

---

## 2. What the field does (condensed survey)

Three research streams (production memory systems; the scoring/decay/bandit literature; coding-agent
rules conventions). Full citations in the appendix; the transferable mechanisms:

### 2.1 Capture-time merge — the single highest-leverage borrow (mem0)

mem0's pipeline is the closest analogue to Shepherd's "accumulating faster than review." For each new
fact it retrieves the **top-k semantically similar existing memories** and runs **one LLM call** that
emits, per candidate, an **ADD / UPDATE / DELETE / NOOP** event:

- **ADD** — genuinely new.
- **UPDATE** — same topic, richer info → merge into the existing id, _"keep the fact with the most
  information."_
- **DELETE** — the new fact _contradicts_ an existing one → retire the old.
- **NOOP** — already covered → drop the new one.

The decisions are **LLM-judged**, with embedding similarity used only as a cheap pre-filter to gather
candidates. mem0's graph variant adds a **multi-valued guard**: _don't_ delete a same-category fact with
a different object ("likes pizza" AND "likes burgers" coexist) — critical so consolidation doesn't eat
legitimately-coexisting rules.

> **Transfer:** most captures should resolve to UPDATE/NOOP, not ADD. This attacks accumulation _at the
> source_ and shrinks the review queue.

### 2.2 Soft retirement, never delete (Zep / Graphiti)

Graphiti keeps **bi-temporal** timestamps per fact (`created_at`/`expired_at` system-time,
`valid_at`/`invalid_at` world-time). A superseded fact is **never deleted** — it is stamped
`invalid_at`/`expired_at` and drops out of the default ("currently true") query but stays auditable for
"as-of" history. Rule: _never_ mark items as duplicates if they differ on numeric values, dates, or key
qualifiers.

> **Transfer:** retiring a rule should be a **soft state**, not a row delete — so the operator's
> curation history, and the help/harm record, survive. Shepherd's FSM `dismissed` is currently a
> dead-end hard semantic; a `retired`/`superseded` state with provenance is better.

### 2.3 Three-factor ranking + decay (Generative Agents, Park et al. 2023)

The canonical retrieval score every later system cites:

```
score = recency + importance + relevance        (all three min-max normalized to [0,1])
recency   = decay ^ (time since last access)     # exp decay; refreshed on USE, not creation
importance = LLM-rated 1–10 at creation
relevance  = cosine(query, memory)
```

Top-scoring memories that fit the budget are injected. **Decay is on last _use_, not creation** — a
proven rule that keeps firing stays hot; an unused one self-fades below the budget line. **Reflection**:
when accumulated importance crosses a threshold, synthesize several specifics into one higher-level
memory **with citations to the records it subsumes** — so the leaves can be dropped from the active
budget while the abstraction is retained.

> **Transfer:** replace Shepherd's two-key sort (`lastEvidenceAt`, `updatedAt`) with a composite score,
> and decay on _use_ so the budget ranks by demonstrated value, not recency of edit. Soft pruning
> emerges for free: an unproven rule sinks below the cap and stops being injected without anyone
> deciding to delete it.

### 2.4 Effectiveness as a bandit (ACE counters + Wilson-bounded pruning)

ACE ("Agentic Context Engineering," 2025) gives each context **bullet a unique id + counters of how
often it was marked helpful or harmful**, and curates via **deterministic delta edits** (append id,
increment counter, retire) — explicitly _never_ a monolithic LLM rewrite, to avoid **"context
collapse"** (their example: a full-rewrite compressed 18,282 tokens → 122 tokens, accuracy 66.7% →
57.1%). Combine with the bandit framing: each rule = an arm, a "pull" = a run where it was injected,
reward = the run succeeded (CI green / PR merged / review passed).

**Prune conservatively** — never on raw mean (a rule injected twice that failed both times looks awful
by luck). Use the **Wilson score lower bound** on help-rate and prune only when it falls below the
global base rate **and** `n ≥ n_min`:

```
w⁻ = [ p̂ + z²/2n − z·√( p̂(1−p̂)/n + z²/4n² ) ] / (1 + z²/n)     # z=1.96, p̂ = helps/n
prune when  w⁻ < base_rate  AND  n ≥ n_min
```

> **Transfer:** Shepherd already has the _harm_ half (`ineffectiveCount`). Add a _help_ counter and a
> Wilson-gated auto-retire so "not working" rules are acted on **automatically and safely**, not left
> for a human to click Optimize. The hard part is **credit assignment** (rules co-occur) — see §4.5.

### 2.5 Scoped / conditional injection (Cursor, Copilot, Windsurf, Claude Code)

The strongest _structural_ finding: **every mature coding-agent rules system abandoned the always-on
blob** for per-rule **activation policies**:

| Policy                | Selected when                                                                                 | Precedent                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Always**            | every task                                                                                    | Cursor `alwaysApply`, Windsurf `always_on`                                                   |
| **Glob-scoped**       | an in-context file matches a glob                                                             | Claude `.claude/rules` `paths:`, Copilot `applyTo:`, Cursor _Auto-Attached_, Windsurf `glob` |
| **Description-gated** | only a one-line description is in-prompt; the agent pulls the body when it judges it relevant | Cursor _Agent Requested_, Windsurf `model_decision`                                          |
| **Manual**            | explicit `@mention` only                                                                      | all of them                                                                                  |

Thoughtworks names the disease — **"agent instruction bloat"**: long instruction sets _conflict_, models
_attend less to the middle of long contexts_, and important rules get _ignored_. Official Claude Code
guidance: **target < 200 lines**, _"if two rules contradict, Claude may pick one arbitrarily."_ Windsurf
hard-caps rule files (6K/12K chars). The audit framing from practitioners: a rule that is already
enforced by linter/`tsconfig`/CI should be **deleted or moved to tooling, not stored as a rule**.

> **Transfer:** Shepherd's biggest long-term win is replacing the always-on 4000-char blob with
> **glob-scoped injection** keyed on the files the session is touching, plus a description-gated tier for
> non-file rules. The budget then caps _within the relevant set_, not across the whole repo — far better
> signal-to-noise, and it makes the cap stop biting because most rules aren't candidates for most tasks.

---

## 3. Gap → mechanism map

| Operator pain                       | Root cause in code                                        | Recommended mechanism                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Too many proposals to review        | Distiller ADDs anything not exact-text-dupe; no ranking   | **Capture-time LLM merge** (§2.1) + **confidence-ranked triage queue** + optional **auto-approve** above a threshold                      |
| "Not working" rules linger          | Flagging has no default action; optimizer manual-only     | **Help/harm counters** + **Wilson-gated auto-retire** + **opt-in auto-optimize** before retire (§2.4)                                     |
| Cap keeps biting; dropped set grows | No decay/expiry; always-on blob; greedy sort by edit-time | **Composite score with use-decay** (§2.3) → soft-fade; **scoped injection** (§2.5) → fewer candidates; **soft-retire** stale rules (§2.2) |
| Duplicates pile up                  | Exact-text dedup only                                     | **Semantic dedup** at capture + **background merge-suggestion pass** (§2.1, §2.3 reflection)                                              |
| No cross-repo leverage              | Learnings strictly per-`repoPath`                         | **Cross-repo merge suggestions** for rules that recur everywhere → candidate for a global/user-level rule                                 |

---

## 4. Recommendation — phased

Ordered by **leverage ÷ effort**. Each phase is independently shippable and reuses existing services
(distiller, optimizer, promoter, house-rules planner). The first two phases require **no UI rebuild** and
attack the volume problem directly.

### Phase 1 — Effectiveness loop + auto-retire (the keystone)

Closes the missing feedback edge. _This is the highest-value change_ — it turns flagging into action.

1. **Add a help counter.** New `learnings` columns `helpfulCount`, `injectedCount`, `lastUsedAt`
   (mirroring the existing `ineffectiveCount`). On session spawn, `houseRules()` already computes the
   injected set — record `injectedCount += 1` per injected rule and stamp `lastUsedAt`.
2. **Derive the reward.** When a session reaches a terminal-good outcome (PR merged, critic
   `approved`, no blocking signal), increment `helpfulCount` for the rules that were injected into it.
   Persist the injected-rule-id set per session (a small `session_injected_learnings` table) so the
   credit is attributable. (Weak signal — see §4.5.)
3. **Auto-retire safely.** A daily pass computes the Wilson lower bound on `helpfulCount /
(helpfulCount+ineffectiveCount)`; when it falls below the repo's base success rate **and**
   `injectedCount ≥ n_min` (start `n_min = 8`), transition the rule to a new **`retired`** state
   (soft — keeps the row + counters). Surface "N rules auto-retired (why)" in the drawer for one-click
   undo.
4. **Opt-in auto-optimize before retire.** Per-repo flag `autoOptimizeFlagged`: when a rule first
   crosses the harm threshold, run the _existing_ `OptimizerService.optimizeOne` automatically once; only
   if it re-fails does it become eligible for retire. (Respects the current "optimizer never on a timer"
   stance by gating behind an explicit opt-in.)

_Why first:_ reuses the optimizer/distiller wholesale, needs only schema + a reward hook, and directly
answers "act on the not-working learnings" without operator clicks.

### Phase 2 — Capture-time merge + composite ranking (shrink the pile)

5. **Semantic dedup at distill.** Before `applyProposals` ADDs a proposed rule, embed it and the
   repo's existing rules (cheap local embedding or a one-shot LLM call), gather top-k similar, and run
   the **ADD/UPDATE/DELETE/NOOP** decision (§2.1). UPDATE merges into the existing rule (keep
   highest-information text, preserve its counters); NOOP drops the proposal silently. Apply the
   **multi-valued guard** so same-category/different-target rules coexist.
6. **Composite injection score.** Replace `prioritize()` in `house-rules.ts` with
   `recency_decay·w + normalized_help_rate·w + relevance·w`. Without task context yet, relevance can be
   omitted (Phase 3 adds it); even `recency_decay + help_rate` is a strict improvement over
   `lastEvidenceAt, updatedAt`. Decay on `lastUsedAt`, not `updatedAt`.

_Why second:_ attacks accumulation at the source (fewer ADDs) and makes the budget rank by demonstrated
value, so the soft-fade in Phase 1 has a sensible ordering.

### Phase 3 — Scoped injection (structural fix for the cap)

7. **Glob-scoped rules.** Add an optional `scopeGlobs` to learnings (the distiller can infer it from
   the originating signal's touched files, or the operator sets it). At spawn, inject Always-rules plus
   rules whose globs match the session's target files. The 4000-char budget then caps _within the
   matched set_. This is the change that makes the cap **stop biting** for large repos — most rules stop
   being candidates for most tasks.
8. **Description-gated tier** (stretch): store a one-line summary in-prompt for non-file rules and let
   the agent request the body. Higher effort (needs a tool/hook); defer unless Phase 3a proves
   insufficient.

### Phase 4 — Consolidation & cross-repo (polish)

9. **Background merge-suggestion pass** (reflection-style): periodically cluster a repo's rules by
   embedding and surface merge groups for one-click consolidation, retaining citations to the rules a
   merged rule subsumes (§2.3). Runs off the hot path, triggered by an accumulation threshold (count of
   un-reviewed rules), not a clock.
10. **Cross-repo suggestions:** detect rules that recur (semantically) across many repos and suggest
    promoting them to a user/global `CLAUDE.md` — the only cross-repo leverage in the design, kept as a
    _suggestion_ (operator decides), since global rules contradict the per-repo scoping discipline.

---

## 5. Key risks & open questions

- **Credit assignment is the genuine hard problem.** Rules co-occur in a spawn, so "this rule caused the
  good outcome" is confounded. Phase 1's reward is a _weak_ correlational signal; treat `helpfulCount` as
  evidence, not proof, and keep `n_min` conservative. The rigorous fix (occasional **exclusion
  experiments** — drop a rule and observe) is real but invasive; recommend deferring unless naive
  counting proves too noisy. **Q: is weak correlational credit acceptable for auto-retire, or must
  retire stay suggestion-only until exclusion experiments exist?**
- **Auto-retire vs. operator trust.** Soft-retire + visible undo mitigates, but auto-removing a rule the
  operator approved is a trust boundary. **Q: default auto-retire ON, or ship as suggest-only ("3 rules
  recommended for retirement") first?**
- **Embedding dependency.** Semantic dedup/scoping needs embeddings. Per house rules, in-app LLM work
  must be a transient subscription spawn, not an API call — a local embedding model or a one-shot LLM
  similarity judgment fits; a hosted embedding API does not. **Q: local embedding model vs. LLM-judged
  similarity in the distiller spawn?**
- **Reward hook surface.** Phase 1 needs a clean "session ended well/badly" signal. Shepherd has critic
  verdicts, merge events, and blocking signals — **Q: which terminal events define the reward, and where
  is the chokepoint to attribute it back to the injected set?**
- **Don't double-count with the existing UX work.** [`learnings-pane-ux.md`](./learnings-pane-ux.md)
  already covers the triage band / sticky headers / "over budget as a state." The auto-retire and
  merge-suggestion surfaces here should _land in that redesigned drawer_, not a parallel one.

---

## Appendix A — Shepherd learnings subsystem map (as of this research)

Data model (`src/store.ts`):

```
signals(id, repoPath, sessionId, kind, payload, ts)             -- kind: reply|critic|block|stall|egress_drop
learnings(id, repoPath, rule, rationale, evidence, status,
          evidenceCount, ineffectiveCount, createdAt, updatedAt,
          lastEvidenceAt, promotedPrUrl, ineffectiveSignalIds)  -- status: proposed|active|promoted|dismissed
```

Lifecycle services: `src/distiller.ts` (signals→proposals, +flag ineffective), `src/optimizer.ts`
(rewrite flagged, manual-only), `src/promote.ts` (active→CLAUDE.md PR), `src/house-rules.ts`
(`planHouseRulesInjection` greedy-pack into `SHEPHERD_HOUSE_RULES_BUDGET_CHARS`=4000), injection point
`src/service.ts` `houseRules(repoPath)`. UI: `ui/src/lib/components/LearningsDrawer.svelte` +
`learnings-drawer.ts` + `learnings.svelte.ts`; routes in `src/server.ts`
(`/api/learnings/*`). Signals pruned at 60 days; **learnings never pruned.**

## Appendix B — Sources

**Production memory systems**

- MemGPT / Letta — paper https://arxiv.org/abs/2310.08560 · context hierarchy
  https://docs.letta.com/guides/core-concepts/memory/context-hierarchy · sleep-time agents
  https://docs.letta.com/guides/agents/architectures/sleeptime/
- mem0 — paper https://arxiv.org/html/2504.19413v1 · decision prompt
  https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py
- Zep / Graphiti — paper https://arxiv.org/abs/2501.13956 · invalidation
  https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py
- Cognee — https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory

**Scoring / decay / consolidation / bandits**

- Generative Agents (Park et al. 2023) — https://arxiv.org/abs/2304.03442
- Reflexion (Shinn et al. 2023) — https://arxiv.org/abs/2303.11366
- ACE — Agentic Context Engineering (2025) — https://arxiv.org/abs/2510.04618
- Dynamic Cheatsheet (Suzgun et al. 2025) — https://arxiv.org/abs/2504.07952
- SemDeDup — https://arxiv.org/abs/2303.09540 · UCB1 (Auer et al. 2002) · Wilson interval
  https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval

**Coding-agent rules conventions**

- Claude Code memory — https://code.claude.com/docs/en/memory · best practices
  https://code.claude.com/docs/en/best-practices
- Cursor Rules — https://cursor.com/docs/rules
- GitHub Copilot custom instructions —
  https://docs.github.com/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot
- Windsurf rules/memories — https://docs.windsurf.com/windsurf/cascade/memories
- Cline Memory Bank — https://docs.cline.bot/best-practices/memory-bank
- Thoughtworks "agent instruction bloat" —
  https://www.thoughtworks.com/radar/techniques/agent-instruction-bloat
