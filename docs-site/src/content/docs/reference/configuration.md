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
spawns a read-only-scoped Claude Code agent that diffs recent source changes against the
hand-written docs and proposes edits. The agent **never** commits or pushes — the trusted
server stages the in-scope doc files, commits, and opens a **pull request** for human
review (never an auto-merge). Off by default; flip on per deployment to soak it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_DOC_AGENT` | `0` (off) | Set `1` to enable the manual doc-agent trigger + its boot orphan-sweep |
| `SHEPHERD_DOC_AGENT_MODEL` | _(none)_ | Model alias for the doc-agent spawn; unset uses the spawn default |

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
