# Learnings Flywheel — Design

> Status: approved 2026-06-02. Next: implementation plan (writing-plans).

## Problem

Shepherd has systematically attacked the operator's O(N) attention problem from every
angle except one. It **routes** attention (triage, status lights, naming), **reviews**
output (PR critic, diff panel, activity feed), and lets you **steer** in-flight
(broadcast, steers, reply). All of that makes a _fixed-quality_ agent easier to
supervise. None of it makes the agents themselves get better.

Every agent spawns cold and dumb in the same ways. When one trips on a project quirk —
wrong test runner, forgets the i18n DE-key gate, branches off a stale main — you correct
it by hand, in that one worktree. Then the worktree is archived
(`SessionService.archive`) and the correction **evaporates**. The next agent makes the
identical mistake. Teaching is O(N), forever.

Shepherd is the only thing watching all N agents at once, so it is the only thing that
can notice "agents keep getting _this_ wrong here." This feature closes the loop:
observed mistakes → distilled rules → injected into every future agent → fewer repeat
mistakes. It is the one feature with a compounding flywheel — each correction makes all
future agents better.

## Constraints

- **ToS-clean / subscription-spawn only.** The distiller is a transient _interactive_
  `claude` spawn (the critic pattern), never `claude -p` and never a local model. It runs
  read-only: `--permission-mode dontAsk` with a scoped `--allowedTools` allowlist, **never**
  `--dangerously-skip-permissions`. It ingests untrusted repo content and agent output, so
  it must not be able to mutate anything outside its own scratch space.
- **Operator stays in control.** The distiller _proposes_; nothing reaches a live agent
  without one-click operator approval. No auto-activation.
- **No silent repo mutation.** DB-side injection is invisible and reversible. Writing a
  rule into the repo's `CLAUDE.md` only ever happens via an explicit "promote" action that
  opens a PR — the operator merges it like any other change.
- **Spawn gotchas (already burned us).** Use a bare `Write` tool (scoped `Write(path)` is
  denied under `dontAsk`); pass the prompt before, not after, a variadic `--allowedTools`;
  use `--settings disableAllHooks` rather than `--bare` so sub-OAuth keeps working.

## Existing substrate (reused, not rebuilt)

- `SessionService.reply` (`src/service.ts`) — operator text typed into a running agent.
  The highest-intent teaching signal; currently passes through unrecorded.
- `ReviewService` (`src/review.ts`) + `reviews` table (`src/store.ts`) — critic verdicts,
  including `changes_requested`. The recurring-defect signal; already persisted.
- `classifyBlocked` (`src/blocked.ts`) — block shape classification. The "what agents get
  stuck on here" signal.
- `stall.ts` — 8m no-tool-use / 20m hung-tool detection. The silent-failure signal.
- `ReviewService` spawn plumbing — read-only `claude` spawn, JSON verdict file written to
  a scratch path, claim/finalize guard against restart double-runs. The distiller mirrors
  this shape exactly.
- `SessionService.create` (`src/service.ts`) — the single choke point every task prompt
  flows through. The injection seam.
- `EventHub.emit` (`src/events.ts`) + `/events` WS — live push to the UI.
- Forge branch/openPR mechanics (`src/forge/`) — reused for the promote-to-`CLAUDE.md` PR.

## Design

### 1. Signal capture — `signals` table (new)

The three high-intent signals are not currently persisted (only critic verdicts are). A
lightweight append-only log is the foundation:

```
signals(
  id        TEXT PRIMARY KEY,
  repoPath  TEXT NOT NULL,
  sessionId TEXT,
  kind      TEXT NOT NULL,   -- 'reply' | 'critic' | 'block' | 'stall'
  payload   TEXT NOT NULL,   -- kind-specific text (the reply, the critic summary, the block tail, …)
  ts        INTEGER NOT NULL
)
```

Emit points are one-line writes at existing seams — no new control flow:

| kind     | seam                          | payload                              |
| -------- | ----------------------------- | ------------------------------------ |
| `reply`  | `SessionService.reply`        | the operator text                    |
| `critic` | `ReviewService` on `changes_requested` | verdict summary + body        |
| `block`  | `blocked.ts` on classification | block shape + terminal tail          |
| `stall`  | `stall.ts` on detection       | stall kind + last tool               |

Retention: a rolling window pruned on the distiller tick (default last 60 days, capped at
N rows per repo). Adjustable.

### 2. Distiller — `src/distiller.ts` (new)

A periodic read-only interactive `claude` spawn (the critic contract from
**Constraints**). It reads the repo's recent `signals` window, clusters related signals,
and emits proposed rules as a JSON verdict file (parse/normalize mirrors `review.ts`):

```json
{
  "rules": [
    {
      "rule": "<=160 char imperative house rule",
      "rationale": "why — what keeps going wrong",
      "evidence": ["signal-id", "signal-id", ...]
    }
  ]
}
```

Triggers (any of):

- **Daily tick** — a `setInterval` in `index.ts` beside `ReviewService`/`BacklogPoller`.
- **Threshold** — ≥ N new signals for a repo since last run.
- **Manual** — a "distill now" button → `POST /api/repos/:repo/distill`.

Model is per-repo configurable, default `sonnet` (cost vs. opus; the task is
summarization, not deep reasoning). The spawn is claimed/finalized via a scratch verdict
file so a Shepherd restart mid-distill never double-proposes.

### 3. Rule lifecycle — `learnings` table (new)

```
learnings(
  id              TEXT PRIMARY KEY,
  repoPath        TEXT NOT NULL,
  rule            TEXT NOT NULL,
  rationale       TEXT,
  evidence        TEXT,            -- JSON array of signal ids
  status          TEXT NOT NULL,   -- 'proposed' | 'active' | 'promoted' | 'dismissed'
  evidenceCount   INTEGER NOT NULL DEFAULT 0,
  ineffectiveCount INTEGER NOT NULL DEFAULT 0,
  createdAt       INTEGER NOT NULL,
  updatedAt       INTEGER NOT NULL,
  lastEvidenceAt  INTEGER
)
```

State machine:

```
proposed ──approve──▶ active ──promote(PR merged)──▶ promoted
   │                    │
 dismiss              disable
   ▼                    ▼
dismissed           dismissed
```

Approval may edit the rule text first. Scope is **per-repo** — lessons are repo-specific
(test runner, i18n gate, branch hygiene). Cross-repo/global rules are out of scope (§9).

### 4. Injection — the "both"

**a. DB → prompt (instant, default path).** At `SessionService.create`, the `active` +
`promoted` rules for the task's repo are prepended to the prompt as a delimited block:

```
## Project house rules (curated by Shepherd)
- <rule>
- <rule>
```

Zero repo mutation, effective on the very next spawn, reversible by disabling a rule.
Applies to manual _and_ auto-spawned agents (the work-queue drain, issue #222).

**b. Promote → CLAUDE.md (proven path).** An explicit operator action opens a PR
inserting the rule into a managed block in the repo's `CLAUDE.md`, between markers:

```
<!-- shepherd:learnings:start -->
...
<!-- shepherd:learnings:end -->
```

Reuses forge branch/openPR mechanics. Once merged the rule is portable to any tool/agent
and Shepherd marks it `promoted`; it stays injected until the PR merges, then injection
can defer to the in-repo copy to avoid duplication.

### 5. Self-audit — keeping the brief honest

When the distiller encounters a `critic` or `block` signal that an existing `active` rule
was meant to prevent, it increments that rule's `ineffectiveCount` and surfaces it
("not working — reword, strengthen, or drop?"). Match is made by the distiller at propose
time (it already has both the rule set and the new signals in context). The brief audits
itself instead of accreting dead rules.

### 6. UI — Learnings drawer

A per-repo drawer, sibling to the Triage drawer:

- **Pending** — proposed rules with evidence preview; **approve** / **edit-then-approve**
  / **dismiss**.
- **Active** — **edit** / **disable** / **promote**; an ineffective-flag badge when
  `ineffectiveCount > 0`.
- **Promoted** — links to the rule's `CLAUDE.md` PR.

A pending-count badge in the top bar. New WS event `learnings:update` (pending count +
per-rule status) drives live refresh.

### 7. API

- `GET /api/repos/:repo/learnings` — list rules by status.
- `POST /api/repos/:repo/learnings/:id/approve` (optional edited text) → `active`.
- `POST /api/repos/:repo/learnings/:id/dismiss` → `dismissed`.
- `POST /api/repos/:repo/learnings/:id/disable` → `dismissed`.
- `POST /api/repos/:repo/learnings/:id/promote` → opens CLAUDE.md PR, → `promoted`.
- `POST /api/repos/:repo/distill` — manual distill trigger.
- Per-repo distiller config (enabled, model, threshold) extends `repo_config`.

### 8. i18n

EN + DE keys for the drawer, the four states, every action, the injected-block header,
and the ineffective-flag copy — enforced by `cd ui && bun run check:i18n`.

## Edge cases

- **Untrusted input** — distiller ingests repo + agent output; strictly read-only spawn
  (see Constraints). No exception.
- **Low/empty signal** — distiller no-ops, proposes nothing.
- **Rule contradicts existing CLAUDE.md** — surfaced as a proposal to reconcile, never
  auto-applied.
- **Restart mid-distill** — claim/finalize verdict-file guard (critic pattern); no
  double-proposal.
- **Promote PR conflict** — treated like any PR; rule stays `active` until merged.
- **Prompt bloat** — only `active`/`promoted` rules inject; dismissed/proposed never do;
  the per-repo set is operator-curated and small by construction.

## Out of scope (YAGNI)

Cross-repo / global rules, auto-promotion to CLAUDE.md without approval, rule version
history beyond `status`, semantic dedup across rules (the distiller dedups at propose
time), a learnings analytics dashboard.

## Testing

- **Unit** — signal-capture writes at each of the four seams; `learnings` lifecycle
  transitions; distiller JSON parse/normalize (mirror the critic verdict tests).
- **Integration** — `SessionService.create` prepends `active` rules to the prompt;
  `promote` opens a PR against a fake forge; restart mid-distill does not double-propose.

## Suggested split (optional, two PRs)

1. **Capture + distill + approve** — `signals` table + emit points, `distiller.ts`,
   `learnings` table + lifecycle, Pending/Active drawer.
2. **Inject + promote + self-audit** — prompt injection at `create`, CLAUDE.md promote PR,
   ineffective detection.
