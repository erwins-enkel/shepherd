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
| `SHEPHERD_AGENT_INGRESS_PORT` | `SHEPHERD_PORT + 1` (e.g. `7331`) | Pinned loopback port for the auth-exempt agent-ingress listener (agent hook callbacks). Stable so the URL baked into a live agent's `--settings` survives restarts/deploys; validated at startup against collisions with the main port, served port, or preview range. Set `0` for an ephemeral port (the pre-pinning behavior) |
| `SHEPHERD_DB` | `~/.shepherd/shepherd.db` | SQLite session store path |
| `SHEPHERD_BACKUP_DIR` | `~/.shepherd/backups` (next to the DB) | Destination dir for the automated hourly SQLite backups (Linux backup timer); see [Operating Shepherd](/operating/) |
| `SHEPHERD_REPO_ROOT` | `~` (home) | Repos must live under this root (spawn is confined to it) |
| `SHEPHERD_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1,[::1]` | Comma-separated origin hostnames allowed for writes + WS (CSRF/CSWSH guard). The Shepherd Capture extension's fixed ID is **always appended** to the effective allowlist — even when you set a custom value — so a stock install accepts captures with no pairing step and this var is no longer fully authoritative over the allowlist |
| `SHEPHERD_PASSWORD` | _(auto-generated)_ | Single-operator login password. When set it's authoritative — argon2id-hashed and re-seeded into the persisted hash every boot. Unset → the persisted hash is reused, or (first boot) a strong password is generated, hashed, persisted, and printed to the log **once**. The browser exchanges it for an HMAC-signed session cookie that gates every HTTP route plus the `/events` + `/pty` WebSocket channels |
| `SHEPHERD_COOKIE_SECRET` | _(generated + persisted)_ | HMAC secret that signs the session cookie. Set it to pin a stable secret across DB resets; rotating it invalidates every outstanding session (the all-sessions kill-switch) |
| `SHEPHERD_TOKEN` | _(none)_ | Optional operator bearer for CLI/curl/machine clients: when set, `Authorization: Bearer <token>` is accepted as an alternative to the session cookie. Browser operators use the password login instead; spawned agents don't use this (they reach the server over the loopback ingress) |
| `HERDR_BIN` | `herdr` | Path to the herdr binary |
| `HERDR_SESSION` | `default` | herdr session name |
| `SHEPHERD_FORGES` | `~/.shepherd/forges.json` | Path to the git-host config |
| `SHEPHERD_PLUGINS_DIR` | `~/.shepherd/plugins` (next to the DB) | Directory scanned at boot for server-side plugins (private/out-of-repo extensions). Lives alongside the state DB so plugins survive `bun run update` and never leak into the public repo; a missing/empty dir loads nothing. See [Server-side plugins](https://github.com/erwins-enkel/shepherd/blob/main/docs/plugins.md) |
| `SHEPHERD_SANDBOX_DEFAULT_PROFILE` | `trusted` | Default sandbox profile for every spawned agent (`trusted` / `standard` / `autonomous`) — see below |
| `SHEPHERD_TRIM_AUTO_CONTEXT` | `true` | Trim the per-turn context of auto-spawned (drain) agents (skill catalog + optional plugins disabled per-spawn). Interactive sessions untouched. Set `false`/`0`/`off` if drain quality regresses |
| `SHEPHERD_USAGE_HOLD_ENABLED` | `true` | Queue newly submitted tasks instead of spawning them while account usage is high (auto-released as usage falls). Set `0`/`false` to always spawn immediately |
| `SHEPHERD_USAGE_HOLD_PCT` | `80` | Hold threshold: when the higher of the 5-hour / weekly usage window reaches this percent, new tasks are held. Range `0`–`100` |
| `SHEPHERD_USAGE_HOLD_AUTO_RELEASE` | `true` | When on, the ~30 s sweeper auto-starts held tasks once usage drops back below the threshold. Set `0`/`false` to keep held tasks queued until the operator starts (or discards) each one manually from the held-tasks popover. Turning the gate off entirely (`SHEPHERD_USAGE_HOLD_ENABLED=0`) still flushes everything regardless of this flag |
| `SHEPHERD_USAGE_DOWNGRADE_ENABLED` | `false` | Companion to the usage hold: when on, every newly spawned agent (main task agents **and** the role agents) runs on `SHEPHERD_USAGE_DOWNGRADE_MODEL` instead of its configured model once usage reaches the downgrade threshold — work keeps flowing, just cheaper. Opt-in (no behavior change when off); set `1`/`true` to enable |
| `SHEPHERD_USAGE_DOWNGRADE_PCT` | `70` | Downgrade threshold: when the higher of the 5-hour / weekly usage window reaches this percent, new spawns are downgraded. Range `0`–`100`; default `70` is deliberately **below** `SHEPHERD_USAGE_HOLD_PCT` (`80`) so usage downgrades first and only later holds |
| `SHEPHERD_USAGE_DOWNGRADE_MODEL` | `haiku` | Model the downgrade routes spawns to while active — a default-model setting (`auto` / `default` / `<alias>`) |

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

## Main agent terminal renderer (research preview)

Every spawned `claude` runs on Claude Code's **classic** renderer by default —
Shepherd's poller/blocked classifier scrape the rendered viewport and the web
terminal forwards xterm keystrokes, both of which assume the classic prompt.
The operator can opt the **main agent session** (satellites always stay classic)
into Claude Code's opt-in fullscreen renderer. The choice applies to newly
spawned/resumed sessions only and is also configurable from the Settings panel
(persisted in the SQLite `settings` table); the env vars below seed a fresh DB.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_TUI_FULLSCREEN` | `0` (off) | Set `1` to opt the main agent session into Claude Code's fullscreen renderer (research preview). Implies `SHEPHERD_TUI_DISABLE_MOUSE`. |
| `SHEPHERD_TUI_DISABLE_MOUSE` | `0` (off) | Set `1` to disable Claude Code mouse capture for the main agent session, so fullscreen mouse-capture escape sequences don't leak into the web terminal's keystroke stream. |

## Documentation automation (PR-gated doc agent)

Opt-in, default-off. When enabled, a manual trigger (`POST /api/doc-agent?repo=<path>`)
spawns a tightly-scoped Claude Code agent that diffs recent source changes against the
hand-written docs and edits the enumerated prose pages in place. It is granted read-only
git (`git diff`/`log`/`show`/`status`) for grounding plus file edits, but has **no git
mutation, `gh`, or network access**, so it can neither commit nor push; the trusted server
stages the in-scope doc files, commits, and publishes them for human review (never an
auto-merge) — either by **folding the doc commit into an already-open code PR** or by
opening a standalone doc-update **pull request** (see _Automated cadence_ below).

**Phased soak (`observe → act`, mirroring `SHEPHERD_HOOKS_INGEST` → `SHEPHERD_HOOKS_SIGNALS`).**
Roll the feature out in two stages so you can watch what it _would_ do before it touches a
remote:

1. **Observe** — set `SHEPHERD_DOC_AGENT=1` alone. The agent runs and edits on every trigger,
   and the server computes the staged doc diff, but **finalize is log-only**: it opens **no
   PR** and runs no `push`. Each would-be publish is logged as a one-line
   `[doc-agent] OBSERVE: <repo> would …  (<n> files): …` — either _would open a doc-update PR_
   (fresh path) or _would push docs onto PR #<n> …_ (pre-merge re-target). Soak here until the
   logged diffs look correct.
2. **Act** — additionally set `SHEPHERD_DOC_AGENT_ACT=1` to escalate to actually opening PRs.
   This flag is meaningful **only** when Phase-0 (`SHEPHERD_DOC_AGENT`) is also on. A fresh
   enable therefore opens no PR until you explicitly opt into act.

Each spawn is recorded as a durable `reviewer_spawns` row (`kind: "doc_agent"`) for cost
attribution, and the boot reconcile **re-adopts** a run interrupted by a restart (a surviving
worktree whose summary is already written is finalized rather than discarded) and reaps any
orphaned remote `shepherd/docs-update-*` branch left by a crash between `push` and PR-open.

**Automated cadence.** With the same flag on, three triggers run in addition to the manual
one (a per-repo in-flight guard means at most one run per repo at a time):

- **Pre-merge re-target** (the default — _one PR carries both code and docs_). A settled-idle
  sweep watches every Shepherd-managed session whose code PR is **open, CI-green, and has a
  doc-relevant (`feat`/`config`) title**. Once such a PR has stayed idle long enough (a
  ~120 s debounce, so a still-churning PR is never touched), the doc agent checks a worktree
  out at the PR's head, edits the in-scope docs, and — in act mode — pushes the doc commit
  straight onto **that PR's own head branch** (never a force-push) instead of opening a second
  `shepherd/docs-update-*` PR. If the code PR merges/closes mid-run or the push can't
  fast-forward, it falls back to a single standalone PR, so the docs land exactly once.
- **Nightly** — once per local day per repo that has the docs tree, at/after
  `SHEPHERD_DOC_AGENT_NIGHTLY_HOUR` (default `3`). It first freshens the repo's default
  branch from `origin`, then spawns a run **only if the branch advanced** since the last
  doc-agent run — quiet days cost a cheap fetch but no agent spawn. This is the reliable
  catch-all: it picks up **any** landed change, including `fix:` commits, config-only
  changes, and human/non-session or non-conventional merges (e.g. epic-landing PRs).
- **Merge-triggered** — a fallback fast-path for when no pre-merge re-target ran: when a
  Shepherd-managed session's PR merges to the default branch **and its title is a
  `feat`/`config` conventional-commit subject**, a standalone doc-update run is considered
  immediately. If a pre-merge re-target already claimed (and pushed docs onto) that PR, this
  trigger **defers** so no duplicate PR is opened. A doc-relevant `fix:` is intentionally
  **not** caught here — it's covered by the nightly sweep instead. `config` (type or scope)
  is a forward-looking allowance and may not yet appear in a given repo's history.
  Non-conventional or untitled merges simply fall through to nightly.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_DOC_AGENT` | `0` (off) | Set `1` to enable the doc agent (**Phase-0 observe**): manual trigger, nightly + merge-triggered cadence, and the boot reconcile. Finalize is **log-only** (no PR) until `SHEPHERD_DOC_AGENT_ACT` is also set |
| `SHEPHERD_DOC_AGENT_ACT` | `0` (off) | **Phase-1 act.** Set `1` to escalate finalize to actually commit, push, and open the **pull request**. Meaningful only when `SHEPHERD_DOC_AGENT` is also on |
| `SHEPHERD_DOC_AGENT_CLI` | `inherit` | Agent CLI for the doc-agent spawn: `inherit` follows the global default provider, or pin `claude` / `codex`. Seeds a fresh DB; persisted + UI-configurable |
| `SHEPHERD_DOC_AGENT_MODEL` | `default` | Model for the doc-agent spawn: `default` follows the global default model, or pin a `<model alias>`. Seeds a fresh DB; persisted + UI-configurable |
| `SHEPHERD_DOC_AGENT_NIGHTLY_HOUR` | `3` | Local hour (0–23) at/after which the nightly sweep evaluates each repo; invalid values fall back to `3` |

## Anonymous usage telemetry

Off until you opt in. Shepherd can emit **anonymous, privacy-first** usage
telemetry (OS, version, arch, locale, engine, and which features are used — never
code, file paths, repo names, or personal data) to an [Aptabase](https://aptabase.com)
endpoint, to help prioritise the roadmap. It is server-side and best-effort: a
failed send is dropped silently and never surfaces to the operator.

Nothing is sent unless **all** of these hold: consent is `granted`, `DO_NOT_TRACK`
is unset, and an App-Key is configured (so the ingestion host resolves). Consent
defaults to `unset`, which surfaces a one-time first-run prompt in the HUD; the
per-operator consent state is persisted in the SQLite `settings` table and is also
toggleable any time from the Settings panel. The env vars below seed a fresh DB
(`SHEPHERD_TELEMETRY_CONSENT`) or override the endpoint.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_APTABASE_APP_KEY` | `A-EU-2837516646` (Shepherd's public Aptabase Cloud EU key) | Master enable. An Aptabase App-Key is write-only and safe to ship in the client (like a GA measurement ID), so the default lets ordinary installs report **once the operator opts in**. Forks/self-hosters override with their own key, or set it **blank to disable** telemetry entirely |
| `SHEPHERD_APTABASE_HOST` | _(derived from the App-Key region)_ | Ingestion host override for self-hosted Aptabase. When unset, the host is derived from the App-Key region prefix: `A-EU-…` → `https://eu.aptabase.com`, `A-US-…` → `https://us.aptabase.com`. A self-hosted (`A-SH-…`) or unknown-region key **requires** this override, else telemetry no-ops |
| `DO_NOT_TRACK` | _(unset)_ | The [console DNT standard](https://consoledonottrack.com). Truthy (`1`/`true`) **hard-disables** telemetry **and** suppresses the first-run consent prompt, regardless of the persisted consent state |
| `SHEPHERD_TELEMETRY_CONSENT` | `unset` | Seeds the persisted consent for a fresh DB: `unset` (prompt on first run), `granted`, or `denied`. A UI-set consent in the DB overrides this env seed at boot; unrecognised values are ignored |

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
