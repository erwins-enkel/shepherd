# Session reattach after herdr restart

## Problem

When the herdr daemon restarts (notably a `herdr update`), herdr faithfully restores
every agent at its correct `cwd` (the session worktree) — but assigns each a **new**
`terminal_id`. Shepherd pairs a session row to its herdr agent **solely** by
`terminalId === session.herdrAgentId`. So after a herdr restart every session's stored
id goes stale at once, and shepherd can no longer find any of its live agents.

Consequences:

- `reconcile()` (boot) marks every active session `done` — they're alive in herdr but
  shepherd shows them dead.
- `poller.tick()` never recovers: it also keys on the stale terminalId, so `reapGone()`
  keeps them `done`.
- `service.resume()` (UI "Resume") checks liveness by terminalId too, so it spawns a
  **duplicate** `claude --resume` even though the agent is already live.

The earlier "resumes in the wrong folder" hypothesis is a red herring: verified that DB
`worktreePath`s are correct, the Claude `*.jsonl` session files live in the matching
`~/.claude/projects/<encoded-worktree>/` folders, `claude --resume <id>` from the
worktree works, and live herdr agents have the correct cwd. The folder is right; only
the session↔agent mapping is lost.

### Live evidence (at time of investigation)

| session | live `terminal_id` | DB `herdrAgentId` | DB status |
|---|---|---|---|
| session-resume-folder-bug | `term_653680b4248d09` | `term_65367fd8ef91914` | done |
| session-activity-heartbeats | `term_653680b4248cd8` | `term_653674fa21acb23` | done |
| herdr-shepherd-502 | `term_653680b4248c37` | `term_65367380add9c1c` | done |

All three alive + working in herdr at the right cwd; DB holds the old ids, all `done`.

## Goal

Re-pair a session with its live herdr agent using a **stable** key, and adopt the new
terminalId — so a herdr restart self-heals instead of orphaning every session. No
duplicate `claude --resume` when the agent is already live.

Non-goals: changing how worktrees/cwd are computed, changing the resume command itself,
changing herdr.

## Design

### Stable matcher

`terminalId` is volatile across herdr restarts. `worktreePath` (== herdr agent `cwd`) is
**immutable** for the session's life and is preserved by herdr on resume — the most
robust key. The agent `name` can drift (LLM renamer; `relabel` is best-effort), so it is
only a tiebreaker.

Add a matcher (in `herdr.ts`) that resolves a session to a live agent:

```
matchAgent(session, agents):
  1. terminalId fast path: agent.terminalId === session.herdrAgentId  → that agent
  2. cwd fallback: agents where agent.cwd === session.worktreePath
       - exactly one        → that agent
       - 2+ (non-isolated same-repo): narrow to name === session.name
            - exactly one   → that agent
            - else          → null  (ambiguous; do not risk mis-pairing)
  3. none                   → null
```

Pure function over `(session, HerdrAgent[])` — trivially unit-testable, no I/O.

### Adoption

When the matcher resolves a session via the **cwd fallback** (terminalId differs),
"adopt": persist `herdrAgentId = agent.terminalId`. This is the one-line re-pairing that
makes everything downstream key on the fresh id again.

### Call-site changes

1. **`reconcile.ts` (boot).** For each active session, `matchAgent` against the live
   list. On match: `store.update(status: mapState(agent.agentStatus),
   lastState: agent.agentStatus, herdrAgentId: agent.terminalId)`. On no match: mark
   `done` (unchanged). This alone fixes the mass-`done` after a herdr update. (Runs
   before the event bus / server start, so no event emit here — boot state is the source
   of truth for the first client load.)

2. **`poller.ts` (`tick`).** Replace the `byTerm.get(s.herdrAgentId)` lookup with
   `matchAgent(s, agents)`. When matched via cwd fallback (id changed), update
   `herdrAgentId` and emit `session:status` (via existing `onChange`) so connected
   clients re-attach their PTY to the new terminal. When matched (any path), proceed to
   `reconcileAgent` as today. Only `reapGone()` when the matcher returns null. Build the
   agent list once per tick (as now) and pass it to the matcher; keep the existing
   single `herdr.list()` call.

3. **`service.resume()` (`service.ts`).** Replace the terminalId-only liveness check
   (`list().some(a => a.terminalId === s.herdrAgentId)`) with `matchAgent`. If a live
   agent is found:
     - adopt its terminalId if changed (`store.update`),
     - return the (updated) session — no respawn.
   Only build + run the `claude --resume` argv when the matcher returns null.

### Edge cases

- **Non-isolated sessions sharing a repoPath cwd.** Disambiguated by name; if still
  ambiguous, left as-is (no adoption) rather than risk pairing the wrong session.
- **Archived sessions.** Not iterated (callers use `activeOnly` / skip archived) and
  their worktrees are removed, so their cwd can't collide with an active session's.
- **Helper agents** (`__usage_probe__`, review husks) have unrelated cwds, so a
  worktreePath match can't accidentally grab them.
- **terminalId still valid** (shepherd restart, herdr did NOT restart): fast path hits,
  behavior identical to today.

## Testing

- `matchAgent` unit tests: terminalId fast path; cwd fallback single match; cwd
  ambiguous → name tiebreak; cwd ambiguous + name ambiguous → null; no match → null.
- `reconcile`: stale terminalId but live agent at same cwd → status synced from live
  agent AND `herdrAgentId` re-pointed (regression for the mass-`done` bug). No live agent
  → `done`.
- `poller.tick`: terminalId miss + cwd hit → adopts new id, emits `session:status`, does
  NOT `reapGone`. terminalId+cwd both miss → `reapGone` → `done`.
- `service.resume`: live agent under a *new* terminalId → adopts, returns session, does
  NOT call `herdr.start` (no duplicate spawn). Truly dead → spawns `claude --resume` as
  today.

## Out of scope

Worktree/cwd computation, the resume command, herdr internals, UI changes beyond the
already-emitted `session:status` event.
