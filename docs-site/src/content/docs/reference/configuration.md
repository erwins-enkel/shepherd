---
title: Configuration
description: Every environment variable and the per-agent sandbox profiles.
---

Shepherd is configured entirely through environment variables (read in
`src/config.ts`). Per-deployment overrides go in `~/.shepherd/env` (`KEY=value`
lines), read by the systemd unit if present.

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_PORT` | `7330` | HTTP/WS listen port |
| `SHEPHERD_HOST` | `127.0.0.1` | Bind address; loopback-only by default (set `0.0.0.0` to expose all NICs) |
| `SHEPHERD_DB` | `~/.shepherd/shepherd.db` | SQLite session store path |
| `SHEPHERD_REPO_ROOT` | `~` (home) | Repos must live under this root (spawn is confined to it) |
| `SHEPHERD_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1,[::1]` | Comma-separated origin hostnames allowed for writes + WS (CSRF/CSWSH guard) |
| `SHEPHERD_TOKEN` | _(none)_ | When set, require `Authorization: Bearer <token>` |
| `HERDR_BIN` | `herdr` | Path to the herdr binary |
| `HERDR_SESSION` | `default` | herdr session name |
| `SHEPHERD_FORGES` | `~/.shepherd/forges.json` | Path to the git-host config |
| `SHEPHERD_SANDBOX_DEFAULT_PROFILE` | `trusted` | Default sandbox profile for every spawned agent (`trusted` / `standard` / `autonomous`) — see below |
| `SHEPHERD_TRIM_AUTO_CONTEXT` | `true` | Trim the per-turn context of auto-spawned (drain) agents (skill catalog + optional plugins disabled per-spawn). Interactive sessions untouched. Set `false`/`0`/`off` if drain quality regresses |

## Live preview

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_PREVIEW_PORT_BASE` | `8001` | First port in the live-preview range (one port per agent preview) |
| `SHEPHERD_PREVIEW_PORT_COUNT` | `16` | Size of the preview range and max concurrent previews |
| `SHEPHERD_PREVIEW_SWEEP_MS` | `4000` | Cadence (ms) of the dev-port detection sweep across active sessions |
| `SHEPHERD_PREVIEW_AUTO_SERVE` | `true` | Dynamically register/unregister `tailscale serve` mappings as previews bind/tear down; set `0` to map the range manually |
| `SHEPHERD_PREVIEW_IDLE_STOP_MS` | `0` (disabled) | When > 0, an idle previewed dev server with no proxy traffic for this many ms is stopped to reclaim RAM (no auto-wake; suggested `1800000` = 30 min) |

## Host tuning (tmpfs inodes)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_NODE_COMPILE_CACHE` | _(disk dir)_ | Node compile-cache dir (kept off the `/tmp` tmpfs) |
| `SHEPHERD_TMP_INODE_PCT` | `80` | Inode-sweep threshold (% of `/tmp` inodes) |
| `SHEPHERD_TMP_STALE_HOURS` | `24` | Scratch staleness cutoff |
| `SHEPHERD_TMP_SWEEP_DIR` | _(default tmp root)_ | Override the swept tmp root |

See [Operating Shepherd](/operating/) for the host-level `/etc/fstab` belt.

## Documentation automation (PR-gated doc agent)

Opt-in, default-off. When enabled, a manual trigger (`POST /api/doc-agent?repo=<path>`)
spawns a tightly-scoped Claude Code agent that diffs recent source changes against the
hand-written docs and edits the enumerated prose pages in place. It is granted read-only
git (`git diff`/`log`/`show`/`status`) for grounding plus file edits, but has **no git
mutation, `gh`, or network access**, so it can neither commit nor push; the trusted server
stages the in-scope doc files, commits, and opens a **pull request** for human review
(never an auto-merge).

**Phased soak (`observe → act`, mirroring `SHEPHERD_HOOKS_INGEST` → `SHEPHERD_HOOKS_SIGNALS`).**
Roll the feature out in two stages so you can watch what it _would_ do before it touches a
remote:

1. **Observe** — set `SHEPHERD_DOC_AGENT=1` alone. The agent runs and edits on every trigger,
   and the server computes the staged doc diff, but **finalize is log-only**: it opens **no
   PR** and runs no `push`. Each would-be PR is logged as a one-line
   `[doc-agent] OBSERVE: <repo> would open a doc-update PR … (<n> files): …`. Soak here until
   the logged diffs look correct.
2. **Act** — additionally set `SHEPHERD_DOC_AGENT_ACT=1` to escalate to actually opening PRs.
   This flag is meaningful **only** when Phase-0 (`SHEPHERD_DOC_AGENT`) is also on. A fresh
   enable therefore opens no PR until you explicitly opt into act.

Each spawn is recorded as a durable `reviewer_spawns` row (`kind: "doc_agent"`) for cost
attribution, and the boot reconcile **re-adopts** a run interrupted by a restart (a surviving
worktree whose summary is already written is finalized rather than discarded) and reaps any
orphaned remote `shepherd/docs-update-*` branch left by a crash between `push` and PR-open.

**Automated cadence.** With the same flag on, two triggers run in addition to the manual
one (a per-repo in-flight guard means at most one run per repo at a time):

- **Nightly** — once per local day per repo that has the docs tree, at/after
  `SHEPHERD_DOC_AGENT_NIGHTLY_HOUR` (default `3`). It first freshens the repo's default
  branch from `origin`, then spawns a run **only if the branch advanced** since the last
  doc-agent run — quiet days cost a cheap fetch but no agent spawn. This is the reliable
  catch-all: it picks up **any** landed change, including `fix:` commits, config-only
  changes, and human/non-session or non-conventional merges (e.g. epic-landing PRs).
- **Merge-triggered** — when a Shepherd-managed session's PR merges to the default branch
  **and its title is a `feat`/`config` conventional-commit subject**, a run is considered
  immediately (the fast path). A doc-relevant `fix:` is intentionally **not** caught here —
  it's covered by the nightly sweep instead. `config` (type or scope) is a forward-looking
  allowance and may not yet appear in a given repo's history. Non-conventional or untitled
  merges simply fall through to nightly.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_DOC_AGENT` | `0` (off) | Set `1` to enable the doc agent (**Phase-0 observe**): manual trigger, nightly + merge-triggered cadence, and the boot reconcile. Finalize is **log-only** (no PR) until `SHEPHERD_DOC_AGENT_ACT` is also set |
| `SHEPHERD_DOC_AGENT_ACT` | `0` (off) | **Phase-1 act.** Set `1` to escalate finalize to actually commit, push, and open the **pull request**. Meaningful only when `SHEPHERD_DOC_AGENT` is also on |
| `SHEPHERD_DOC_AGENT_MODEL` | _(none)_ | Model alias for the doc-agent spawn; unset uses the spawn default |
| `SHEPHERD_DOC_AGENT_NIGHTLY_HOUR` | `3` | Local hour (0–23) at/after which the nightly sweep evaluates each repo; invalid values fall back to `3` |

## Per-agent sandbox / permission profiles

Shepherd can wrap each spawned `claude` process in an OS-level filesystem/process
sandbox via **bubblewrap (`bwrap`)**. Three profiles are selectable per-repo in the
repo's Settings panel or globally via `SHEPHERD_SANDBOX_DEFAULT_PROFILE`:

| Profile | Sandbox | Notes |
| --- | --- | --- |
| `trusted` | None | Default; today's behavior. Escape hatch when the membrane causes problems. |
| `standard` | bwrap membrane | Agent confined to its worktree + git object store + read-only `~/.claude`; blocks `~/.ssh`, `~/.aws`, sibling repos, other `$HOME` dotfiles; clears inherited env secrets. Does **not** restrict network egress. Opt-in for interactive sessions. |
| `autonomous` | bwrap membrane **+ egress allowlist** | Same membrane as `standard`, **plus** network-egress confinement (outbound restricted to an allowlist: Anthropic + the forge host + operator extras). **Required for `auto=true`** drain/autopilot sessions. |

Egress confinement is tied to the **profile**, not to `auto=true`. When no sandbox
backend is available, manually spawned sessions degrade to unconfined **with an
operator-visible banner**, and `auto=true` spawns are refused. The full residual
posture — the accepted in-membrane token-readability gap and the prompt-injection
posture — is documented on the [Security](/reference/security/) page.

**Backend requirements:** `bwrap` installed + unprivileged user namespaces enabled.
Shepherd self-tests at startup.

A few runtime toggles live in the SQLite `settings` table
(`~/.shepherd/shepherd.db`) rather than env — e.g. `branchPruneEnabled` (hourly
cleanup of merged local `shepherd/*` branches, on by default).
