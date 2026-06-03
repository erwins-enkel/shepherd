# Bound the injected house-rules block (prompt-growth cap) — Design

**Issue:** #253 (follow-up from #249 learnings-flywheel PR2a review). Refs #228, #224.
**Date:** 2026-06-03

## Problem

`SessionService.houseRules()` prepends **all** `active`+`promoted` rules for a repo into
every new agent prompt, unbounded. Like `issueRef`/images, it bypasses the 8000-char
human-prompt guard (which only gates the stored human `prompt`, not the augmented argv).
A repo that accumulates many approved rules steadily grows every spawn's prompt.

A **silent** truncate is the wrong fix: it would drop operator-**approved** rules, breaking
the feature's core promise (approve → injected) and the "operator stays in control" constraint.
So the cap must be **visible and curatable**, not quiet.

The repo's own curated house rules already encode the intended fix:
> "Bound content injected into agent/critic prompts that accumulates over spawns or rounds
> (house rules, prior findings, author notes): cap count/length, scope to the latest head,
> and don't bypass existing input-size guards."

## Decision

Implement issue Option 1 in full: a **soft character budget** on the injected block plus
**operator visibility** in the Learnings drawer, so the cap becomes a curation prompt rather
than silent loss.

- **Budget unit:** character budget with greedy fill (faithful proxy for prompt growth;
  rules vary from a few words up to 160 chars).
- **Priority when over budget:** most-recently-effective — `lastEvidenceAt` desc (nulls last),
  tie-break `updatedAt` desc. Stale rules with no recent evidence drop first.
- **Default budget:** 4000 chars, env-overridable. Today's ~13-rule repo (~2 KB) sits well
  under; only an unusually large curated set gets capped.

## Architecture

### 1. Shared injection planner — `src/house-rules.ts` (new)

The single source of truth for header, ordering, and fill logic. Consumed by **both** the
prompt-injection path (`service.ts`) and the new API (`server.ts`), so they cannot diverge
(repo rule: never mirror a server constant/logic in two places).

```ts
import type { Learning } from "./types";

export const HOUSE_RULES_HEADER = "## Project house rules (curated by Shepherd)";

export interface HouseRulesPlan {
  injected: Learning[];   // priority order, fit within budget
  dropped:  Learning[];   // over budget, priority order
  budgetChars: number;
  usedChars:  number;     // exact rendered length of the block (header + bullets)
}

/** Priority: lastEvidenceAt desc (nulls last) → updatedAt desc. Greedy fill: add a rule
 *  when used + cost ≤ budget, else mark it dropped and keep checking later (shorter) rules. */
export function planHouseRulesInjection(rules: Learning[], budgetChars: number): HouseRulesPlan;

/** Renders the injected rules into the prompt block, or null when none. */
export function renderHouseRulesBlock(injected: Learning[]): string | null;
```

**Cost accounting** matches the rendered string byte-for-byte so the drawer meter is truthful.
Rendered block = `${HEADER}\n${injected.map(r => "- " + r.rule).join("\n")}`. The planner seeds
`used = HEADER.length` and adds `("- " + rule + "\n").length` per kept rule; this sum equals the
rendered length exactly (header newline + per-rule bullets + inter-bullet newlines reconcile).

**Greedy continues past the first overflow** (the approved behavior): a later shorter rule may
still fit after a larger high-priority one is skipped, so `injected` is not necessarily a
contiguous prefix of priority order. Drawer badges are per-rule, so this stays clear.

Edge cases: empty input → `injected:[]`, block `null`. Header alone exceeds budget (tiny cap)
→ `injected:[]`, block `null`. Exact fit → included.

`HOUSE_RULES_HEADER` moves here from `service.ts`; `service.ts` imports it.

### 2. Config — `src/config.ts`

```ts
// Char budget for the Shepherd house-rules block prepended to every agent prompt. Active+
// promoted rules fill greedily by most-recently-effective priority until this cap; the rest
// stay visible-but-uninjected in the Learnings drawer for the operator to prune. Default 4000
// (~25 max-length rules); only an unusually large curated set is capped.
houseRulesBudgetChars: Number(process.env.SHEPHERD_HOUSE_RULES_BUDGET_CHARS ?? 4000),
```

### 3. Service — `src/service.ts` `houseRules()`

```ts
private houseRules(repoPath: string): string | null {
  if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return null;
  const { injected } = planHouseRulesInjection(
    this.deps.store.listActiveLearnings(repoPath),
    config.houseRulesBudgetChars,
  );
  return renderHouseRulesBlock(injected);
}
```

Behavior unchanged for small sets; bounded for large ones. The block now lists rules
most-recently-effective first (existing tests are order-agnostic except that user text stays last).

### 4. API — `GET /api/learnings/injectable` (new, cross-repo)

Mirrors the existing `/api/learnings/pending` shape (all repos, grouped client-side). Drives the
drawer's injected view. The **budget value flows from here** — the UI never hardcodes it.

```jsonc
// 200 → array, one entry per repo that has ≥1 active/promoted rule
[
  {
    "repoPath": "/home/user/acme",
    "enabled": true,            // repoConfig.learningsEnabled
    "budgetChars": 4000,
    "usedChars": 1980,
    "rules": [                  // active + promoted, priority order
      { /* ...Learning */ "injected": true },
      { /* ...Learning */ "injected": false }   // over budget
    ]
  }
]
```

The handler applies the same `learningsEnabled` gate as `service.houseRules()`: when `enabled`
is `false`, it skips the planner and returns every rule as `injected:false` with `usedChars:0`,
so the drawer can show an "injection disabled" state distinct from "over budget". When enabled,
the `injected` flags and `usedChars` come straight from `planHouseRulesInjection` — no parallel logic.

Store: reuse `listLearnings(repo, { status })` per status, or add a thin
`listInjectableLearnings(repo)` returning `status IN ('active','promoted')` (same predicate as
`listActiveLearnings`, exposed for the cross-repo sweep). Repos enumerated from distinct
`repoPath`s having active/promoted rules.

### 5. UI — Learnings drawer gains an "Injected" view

`ui/src/lib/components/LearningsDrawer.svelte` (+ `learnings-drawer.ts`, `learnings.svelte.ts`).

Each per-repo group adds a section **below** the existing *proposed* rules (shown only when the
repo has ≥1 active/promoted rule):

- **Budget meter** from the API: `{used}/{budget} chars · {injected}/{total} injected`.
- Each active/promoted rule: read-only text + a status chip (`active`/`promoted`) + an injection
  badge: **✓ Injected** or **⊘ Over budget** (over-budget titled with a prune hint). When the
  repo's injection is disabled, badge reads **⊘ Injection disabled**.
- **Prune affordance:** a **Dismiss** action on *active* rules (reuses
  `POST /api/learnings/:id/dismiss`; `active→dismissed` is already a legal transition). Promoted
  rules are terminal — visibility only, no dismiss.
- Repos with injected rules but zero proposals now appear in the drawer (exactly the case #253
  is about).

Data flow: a second fetch to `/api/learnings/injectable` alongside the existing `/pending`,
merged by `repoPath` in `learnings.svelte.ts`. Live refresh piggybacks the existing
`learnings:update` websocket event.

**i18n** (new keys in **both** `en.json` + `de.json`, `learnings_` prefix; reuse `learnings_dismiss`):
`learnings_injected_section`, `learnings_budget_meter` (`{used}`,`{budget}`,`{injected}`,`{total}`),
`learnings_injected_badge`, `learnings_overbudget_badge`, `learnings_injection_disabled_badge`,
`learnings_status_active`, `learnings_status_promoted`, `learnings_overbudget_title`.

## Testing

- **`test/house-rules.test.ts`** (new, pure): priority ordering (incl. null `lastEvidenceAt`),
  greedy fill, exact-fit boundary, header-exceeds-budget, empty, `usedChars` matches rendered length.
- **`test/service.test.ts`**: an over-budget active set injects only the planned rules and drops
  the right ones; the 3 existing house-rules tests stay green.
- **API test**: `/api/learnings/injectable` shape, `injected` flags, budget numbers, `enabled:false`.
- **UI** (`ui`, vitest): drawer renders badges + meter from the payload; dismiss prunes an active
  rule (if a drawer test harness exists; otherwise cover the merge/derive logic in `learnings-drawer.ts`).

## Out of scope / deferred

- **#228 PR2b** (promote → CLAUDE.md offload that naturally shrinks the injected set) — separate.
- Widening the state machine so **promoted** rules can be pruned — left terminal.
- Token-accurate budgeting (we bound chars, a stable and sufficient proxy).
- Editing active/promoted rule text in the drawer (proposed-only stays editable).

## Decisions locked

| Decision | Choice |
| --- | --- |
| Budget unit | Character budget, greedy fill |
| Default budget | 4000 chars, `SHEPHERD_HOUSE_RULES_BUDGET_CHARS` override |
| Priority | `lastEvidenceAt` desc (nulls last) → `updatedAt` desc |
| Drawer presentation | New section under proposed, per repo |
| Prune verb | Reuse `dismiss` (active→dismissed); promoted terminal |
| Source of truth | `src/house-rules.ts`, shared by service + API |
