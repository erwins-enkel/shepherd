# Spike #1175 — Can Shepherd bring back (restore) a Codex session by id?

**Phase-0 go/no-go.** Follow-up to #1174 (Claude-only restore MVP). Restore must re-attach the
**exact** prior conversation of an archived session, never a sibling's. For Codex that means
resuming by a specific session id rather than `codex resume --last` (which is cwd-scoped and can
target a sibling in a shared cwd). This spike asks the load-bearing questions before the
store/guard/poller work is built on them.

> 1. Can the Codex session id be **pinned at spawn** (an analog to `claude --session-id`)?
> 2. Can it be **discovered post-spawn** — reliably, and scoped to the _interactive_ main agent (not
>    a headless `codex exec` role spawn that shares the worktree cwd)?
> 3. Does `codex resume <uuid>` re-attach the exact conversation in a **re-created** worktree, and
>    does the transcript survive worktree removal?

## Decision: **GO** ✅ (isolated Codex only)

The id **cannot** be pinned at spawn, but it **can** be discovered deterministically for an
**isolated** worktree from the rollout header (`session_meta.cwd` + `session_meta.source == "cli"`
→ `session_meta.session_id`). Restore derives it **fresh** at restore time (source of truth), so the
design is robust regardless of whether `codex resume` appends to the same rollout or forks a new one.
Non-isolated Codex (shared cwd) stays `cannot_restore` by design.

## Environment

|               |                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| codex         | `codex-cli 0.142.5`                                                                          |
| CODEX_HOME    | `~/.codex` (override: `$CODEX_HOME`)                                                         |
| Rollout store | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`                                  |
| Main spawn    | `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox …` (`buildCodexSpawnArgv`) |
| Resume form   | `codex resume [SESSION_ID] [PROMPT]` — positional UUID or session name                       |

## Findings (verified from the installed CLI + on-disk rollouts)

### 1. No pin-at-spawn — VERIFIED

`codex --help` exposes **no** `--session-id` / `--thread-id` flag (`grep -c -- --session-id` → `0`);
`-c/--config` sets `config.toml` keys, not the session id. Codex self-generates a UUIDv7 per session.
Upstream feature requests for a spawn-time id flag (openai/codex #15767, #13242, #15271, #8923) are
unshipped. ⇒ The id must be **discovered** after spawn.

### 2. Discovery is deterministic for an isolated worktree — VERIFIED

`codex resume --help`: `[SESSION_ID]` is a positional "Session id (UUID) or session name"; `--last`
and the picker are **cwd-filtered** (`--all` "disables cwd filtering") and interactive-only
(`--include-non-interactive` opts exec sessions in) — i.e. `--last` cannot disambiguate concurrent
sessions in one cwd, exactly the issue's failure mode.

Rollout header (line 1) carries everything needed, e.g.:

```json
{"type":"session_meta","payload":{
  "session_id":"019f364c-cb8f-74d2-8e4d-64864a1aecc9",
  "id":"019f364c-cb8f-74d2-8e4d-64864a1aecc9",
  "cwd":"/home/moe/projects/.shepherd-worktrees/shepherd-gauges-bar-usage-changed",
  "source":"cli","originator":"codex-tui","cli_version":"0.142.5", …}}
```

**The `source == "cli"` filter is load-bearing — VERIFIED.** On this machine, Shepherd's interactive
main agents and its headless `codex exec` role spawns (reviewers) both write rollouts in
`.shepherd-worktrees/…` cwds, distinguished only by `source`:

```
019f3669-… | source=cli  | /…/.shepherd-worktrees/shepherd-start-don-ask-which        (main agent)
019f364c-… | source=cli  | /…/.shepherd-worktrees/shepherd-gauges-bar-usage-changed    (main agent)
019f36a8-… | source=exec | /…/.shepherd-worktrees/shepherd-review-929b9cce             (role spawn)
```

So filtering to `source == "cli"` correctly targets the main conversation and excludes role spawns
that share a worktree cwd. Matching `cwd` as a **raw string** is safe: Shepherd's `worktreePath` is
already canonical (`safeRepoDir` realpath-resolves `repoPath`; the worktree `join`s from it) and
Codex records its canonical cwd — so no `realpath` is done on the (possibly-absent, at restore time)
candidate. The state DB (`~/.codex/state_5.sqlite`, `threads(id, rollout_path, cwd, …)`) carries the
same mapping but is a lag-prone cache with a version-drifting filename, so the rollout header is used
as ground truth.

### 3. Transcript survives worktree removal — VERIFIED (by construction)

Rollouts live under `$CODEX_HOME`, **outside** the worktree, so Shepherd's archive (which removes the
worktree) does not delete them. Shepherd's archive is unrelated to Codex's own `codex archive`
(Shepherd never calls it), so the session stays resumable.

## Implementation consequence (robust to resume semantics)

Because the id is derived **fresh at restore** (newest `source=cli` rollout whose cwd matches the
worktree), correctness does **not** depend on whether `codex resume` appends to the same rollout or
forks a new id: after any restore→work→archive cycle, the newest cwd-matching interactive rollout is
always the current conversation. Live resume (autopilot/automerge/manual) keeps `codex resume --last`
(cwd-scoped, interactive-only → the current conversation for an isolated cwd), so a pane-death mid-
restored-session re-attaches correctly without trusting a stored id.

## Remaining live checks (operator confirmation)

These runtime round-trips need an authenticated interactive Codex session and were **not** driven in
this headless spike; the design above does not hinge on their outcome (only on the CLI's documented
`codex resume [SESSION_ID]` contract + the verified discovery), but confirm during rollout:

- [ ] Archive an isolated Codex session, **Bring back** → `codex resume <uuid>` re-attaches the exact
      prior conversation in the re-created worktree.
- [ ] Multi-restore (restore → add work → archive → restore again) resumes the **latest** conversation.
- [ ] Pane-death during a restored session → live `resume()` (`--last`) re-attaches the restored
      conversation, not the pre-restore one.
