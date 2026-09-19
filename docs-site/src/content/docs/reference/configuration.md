---
title: Configuration
description: Every environment variable and the per-agent sandbox profiles.
---

Shepherd is configured entirely through environment variables (read in
`src/config.ts`). Per-deployment overrides go in `~/.shepherd/env` (`KEY=value`
lines), read by the systemd unit if present.

A numeric variable expects a bare number — `120000`, not `2m`. For most numeric knobs,
setting one to something non-numeric makes Shepherd log a warning naming the variable
and fall back to the documented default, rather than silently treating the limit as
absent; leaving such a variable empty is the same as leaving it unset. Ports are
stricter: a `SHEPHERD_PORT` that is not an integer in `[1, 65535]` aborts startup with a
message naming that variable. A few variables have their own clamping or fallback rules
— those are noted in the variable's own row below.

Every variable below is also declared in `.env.schema` at the repo root. A gate
(`bun run check:env-schema-docs`, run in CI and pre-push) fails when a `SHEPHERD_*`
variable is declared there and has no row here, so a new knob cannot ship
undocumented ([#2361](https://github.com/erwins-enkel/shepherd/issues/2361)). The
handful of genuinely contributor-only variables are marked `@docsExempt` in the
schema and deliberately absent from this page.

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_PORT` | `7330` | HTTP/WS listen port |
| `SHEPHERD_HOST` | `127.0.0.1` | Bind address; loopback-only by default (set `0.0.0.0` to expose all NICs) |
| `SHEPHERD_AGENT_INGRESS_PORT` | `SHEPHERD_PORT + 1` (e.g. `7331`) | Pinned loopback port for the auth-exempt agent-ingress listener (agent hook callbacks plus the agent control plane: the build-queue/epic-draft routes and the per-session MCP endpoint). Stable so the URL baked into a live agent's `--settings`/`--mcp-config` survives restarts/deploys; validated at startup against collisions with the main port, served port, or preview range. Set `0` for an ephemeral port (the pre-pinning behavior) |
| `SHEPHERD_DB` | `~/.shepherd/shepherd.db` | SQLite session store path |
| `SHEPHERD_BACKUP_DIR` | `~/.shepherd/backups` (next to the DB) | Destination dir for the automated hourly SQLite backups (Linux backup timer); see [Operating Shepherd](/operating/) |
| `SHEPHERD_REPO_ROOT` | `~` (home) | Repos must live under this root (spawn is confined to it) |
| `SHEPHERD_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1,[::1]` | Comma-separated origin hostnames allowed for writes + WS (CSRF/CSWSH guard). Two sets of hosts are **appended automatically** at boot, so this var is not fully authoritative over the effective allowlist: (1) the Shepherd Capture extension's two fixed IDs (the published Web Store item and the pinned unpacked dev build), so a stock install accepts captures with no pairing step; and (2) every **Tailscale-served host** that fronts this HUD's port — the node's own tailnet name (a direct `tailscale serve`) *and* any Tailscale **Service** front (e.g. `svc:shepherd` → `shepherd.ts.net`), discovered from `tailscale serve status` at startup ([#1645](https://github.com/erwins-enkel/shepherd/issues/1645)). Only a host that does **not** appear in `tailscale serve status` — a non-Tailscale reverse proxy or custom-DNS front — still needs a manual entry here. Preview-port origins stay rejected regardless (the guard's preview-range check runs before the hostname check) |
| `SHEPHERD_PASSWORD` | _(auto-generated)_ | Single-operator login password. When set it's authoritative — argon2id-hashed and re-seeded into the persisted hash every boot. Unset → the persisted hash is reused, or (first boot) a strong password is generated, hashed, persisted, and printed to the log **once**. The browser exchanges it for an HMAC-signed session cookie that gates every HTTP route plus the `/events` + `/pty` WebSocket channels |
| `SHEPHERD_COOKIE_SECRET` | _(generated + persisted)_ | HMAC secret that signs the session cookie. Set it to pin a stable secret across DB resets; rotating it invalidates every outstanding session (the all-sessions kill-switch) |
| `SHEPHERD_TOKEN` | _(none)_ | Optional operator bearer for CLI/curl/machine clients: when set, `Authorization: Bearer <token>` is accepted as an alternative to the session cookie. Browser operators use the password login instead; spawned agents don't use this (they reach the server over the loopback ingress). **This is the deployment-provisioned option** — for a client you *install* rather than deploy (a launcher extension, the Capture extension, a cron job), prefer minting a named token in the HUD under **Settings → Access**, which needs no restart and can be revoked one client at a time ([#2082](https://github.com/erwins-enkel/shepherd/issues/2082)). A minted token also carries a **scope** — `read`, `submit` or `full` — chosen when you create it and fixed afterwards, so a read-only client cannot spawn sessions or reach a terminal ([#2083](https://github.com/erwins-enkel/shepherd/issues/2083)). `SHEPHERD_TOKEN` itself is **unscoped**: it is the break-glass credential and always has full reach. Both are accepted at once |
| `HERDR_BIN` | `herdr` | Path to the herdr binary |
| `SHEPHERD_NODE_BIN` | _(resolved)_ | Explicit `node` binary for the PTY attach helper; when non-empty it wins over resolution outright. Resolution exists because a mise/nvm-managed node is usually absent from the launcher's `PATH`, and without a usable node **every session pane stays black** — so this is the escape hatch when the diagnosed node is the wrong one rather than a missing one |
| `HERDR_SESSION` | `default` | herdr session name |
| `HERDR_SOCKET_PATH` | _(derived from `HERDR_SESSION`)_ | Unix-socket path for herdr's native JSON-RPC API. When unset it's derived: a non-`default` `HERDR_SESSION` uses its own per-session socket (`~/.config/herdr/sessions/<name>/herdr.sock`); the `default` session uses herdr's top-level socket (`~/.config/herdr/herdr.sock`). An explicit value normally wins — **except** when Shepherd runs inside a herdr pane (`HERDR_ENV=1`) and the value was inherited from that pane while a non-`default` `HERDR_SESSION` is set: the explicit `HERDR_SESSION` then wins (Shepherd prefers its per-session socket and warns), so a dev/test instance can't silently attach to the parent pane's herd ([#1596](https://github.com/erwins-enkel/shepherd/issues/1596)). Set `SHEPHERD_HERDR_IGNORE_SESSION=1` to keep the inherited socket. Consulted by the socket driver and, via `process.env`, by every spawned `herdr` CLI |
| `SHEPHERD_HERDR_SOCKET` | `0` (off) | Opt-in: talk to herdr over its native Unix-socket JSON-RPC API instead of shelling out to the `herdr` CLI for every call (issues #1529, #1553, #1567). Covers the async read surface plus the entire async write surface — the spawn/teardown/rename writes (`start`/`stop`/`relabel`/`closeTab`) and `send` (writing text to an agent's PTY). Only the synchronous `list`/`read`/`tabs`/`panes` still shell out, because a sync call can't await a socket round-trip without blocking the event loop. It does **not** by itself move the browser terminal onto the socket — that is a separate, still-default-off sub-flag (`SHEPHERD_HERDR_SOCKET_TERMINAL`, below). Default-off because the socket protocol is still preview-unstable; the driver falls back to the CLI on any protocol mismatch, so enabling it is reversible |
| `SHEPHERD_HERDR_SOCKET_TERMINAL` | `0` (off) | Interim sub-flag of `SHEPHERD_HERDR_SOCKET`: set `1` to stream the **browser terminal** of agent sessions over herdr's socket `terminal session control` instead of the node-pty helper (each `/pty` connection attaches directly to the resolved pane; a per-terminal failure falls back to node-pty for a short cooldown so a bad attach doesn't strand the session). Default-off because that stream is a screen-diff/redraw protocol: xterm builds no scrollback and never sees the app's mouse mode, so mobile swipe + desktop wheel scrolling stop working. A live probe on herdr 0.7.3 ([#1639](https://github.com/erwins-enkel/shepherd/issues/1639)) found Claude Code honours `PageUp` but **Codex honours no scroll lever at all**, so flipping this on would make a Codex session's off-screen transcript unreachable. With it off, agent terminals stay on node-pty (scrollable for both providers) even while the socket driver runs everything else. **Clean-terminal sessions are the exception**: an agentless pane can't be attached with `herdr agent attach`, so those always ride the socket bridge regardless of this flag |
| `SHEPHERD_HERDR_IGNORE_SESSION` | `0` (off) | Escape hatch for the in-pane session/socket conflict ([#1596](https://github.com/erwins-enkel/shepherd/issues/1596)): when Shepherd runs inside a herdr pane and a non-`default` `HERDR_SESSION` disagrees with the pane-inherited `HERDR_SOCKET_PATH`, it normally prefers the session's own socket. Set to `1` to suppress that override and keep the inherited socket (attach to the parent pane's herd), ignoring the `HERDR_SESSION` hint |
| `SHEPHERD_FORGES` | `~/.shepherd/forges.json` | Path to the git-host config |
| `SHEPHERD_PLUGINS_DIR` | `~/.shepherd/plugins` (next to the DB) | Directory scanned at boot for server-side plugins (private/out-of-repo extensions). Lives alongside the state DB so plugins survive `bun run update` and never leak into the public repo; a missing/empty dir loads nothing. See [Server-side plugins](https://github.com/erwins-enkel/shepherd/blob/main/docs/plugins.md) |
| `SHEPHERD_HERDR_UPDATE_LOG` | `~/.shepherd/herdr-update.log` (next to the DB) | Audit log for `herdr update`. Written by the transient systemd update unit rather than the server, so the record survives the restart the update triggers — `cat` it when an update left herdr in an unexpected state |
| `SHEPHERD_CODEX_UPDATE_LOG` | `~/.shepherd/codex-update.log` (next to the DB) | The same, for `codex update` |
| `SHEPHERD_SANDBOX_DEFAULT_PROFILE` | `trusted` | Default sandbox profile for every spawned agent (`trusted` / `standard` / `autonomous`) — see below |
| `SHEPHERD_SANDBOX_EXTRA_HOSTS` | _(none)_ | Comma-separated extra hostnames always allowlisted by the **autonomous** profile's egress firewall, on top of the built-in Anthropic + forge hosts (e.g. `registry.corp.com,pypi.corp.io` for a private package registry). Operator escape hatch; no effect on `trusted`/`standard`, which are not network-confined |
| `SHEPHERD_TRUST_ISSUE_AUTHORS` | `0` (off) | Opt-in escape hatch for the fail-closed author-trust gate on autonomous (`auto=true`) drain. Set `1` to treat issue authors as trusted on forges that can't supply a GitHub-style `authorAssociation` (non-GitHub — Gitea/local), where autonomous drain would otherwise be silently disabled. Does **not** relax the gate on GitHub, where author trust is verifiable — a GitHub miss or untrusted author still refuses. See the [Security](/reference/security/) page |
| `SHEPHERD_TRIM_AUTO_CONTEXT` | `true` | Trim the per-turn context of auto-spawned (drain) agents (optional plugins, bundled skills and your personal `~/.claude/skills` disabled per-spawn; the repo's own skills stay available). Interactive sessions untouched. Set `false`/`0`/`off` if drain quality regresses |
| `SHEPHERD_REVIEW_TIMEOUT_MS` | `600000` (10 min) | Hard deadline for a single critic run (session critic **and** standalone PR critic) before it is abandoned with an `error` verdict. Clamped to `60000`–`3600000`; an unparseable value falls back to the default. Env-only, deliberately not a UI knob: raise it for a repo whose PRs genuinely outgrow 10 minutes, because the critic restarts from scratch on every retry — so a PR that can't finish inside the deadline is permanently un-reviewable rather than slowly reviewed |
| `SHEPHERD_USAGE_HOLD_ENABLED` | `true` | Queue newly submitted tasks instead of spawning them while account usage is high (auto-released as usage falls). Set `0`/`false` to always spawn immediately |
| `SHEPHERD_USAGE_HOLD_PCT` | `80` | Hold threshold: when the higher of the 5-hour / weekly usage window reaches this percent, new tasks are held. Range `0`–`100` |
| `SHEPHERD_USAGE_HOLD_AUTO_RELEASE` | `true` | When on, the ~30 s sweeper auto-starts held tasks once usage drops back below the threshold. Set `0`/`false` to keep held tasks queued until the operator starts (or discards) each one manually from the held-tasks popover. Turning the gate off entirely (`SHEPHERD_USAGE_HOLD_ENABLED=0`) still flushes everything regardless of this flag |
| `SHEPHERD_USAGE_DOWNGRADE_ENABLED` | `false` | Companion to the usage hold: when on, every newly spawned agent (main task agents **and** the role agents) runs on `SHEPHERD_USAGE_DOWNGRADE_MODEL` instead of its configured model once usage reaches the downgrade threshold — work keeps flowing, just cheaper. Opt-in (no behavior change when off); set `1`/`true` to enable |
| `SHEPHERD_USAGE_DOWNGRADE_PCT` | `70` | Downgrade threshold: when the higher of the 5-hour / weekly usage window reaches this percent, new spawns are downgraded. Range `0`–`100`; default `70` is deliberately **below** `SHEPHERD_USAGE_HOLD_PCT` (`80`) so usage downgrades first and only later holds |
| `SHEPHERD_USAGE_DOWNGRADE_MODEL` | `haiku` | Model the downgrade routes spawns to while active — a default-model setting (`auto` / `default` / `<alias>`) |
| `SHEPHERD_HOUSE_RULES_BUDGET_CHARS` | `4000` | Character budget for the house-rules block prepended to every agent prompt. Active and promoted rules fill it greedily by most-recently-effective priority until the cap is reached; the remainder stay visible-but-uninjected in the Learnings drawer for the operator to prune. Only an unusually large curated rule set ever reaches this |
| `SHEPHERD_STANDARD_COMMAND` | _(bundled German prompt)_ | Legacy seed for the backlog quick-launch **Standard** issue action. Quick-launch actions now live in the editable steers list, so this value only seeds (or migrates) that one default entry the first time the steers are read; a previously customized `standardCommand` setting takes precedence over it |
| `SHEPHERD_REMOTE_CONTROL_AT_STARTUP` | `0` (off) | Set `1` to inject `remoteControlAtStartup` into every spawned agent's `--settings`, which **overrides** the operator's own `~/.claude/settings.json`. Default off suppresses Claude Code Remote Control's auto-start and its notification noise for agent sessions; `/remote-control` (`/rc`) still enables it per session from the terminal. UI-configurable + persisted |
| `SHEPHERD_PROFILE_LOOP` | `0` (off) | Set `1` to enable event-loop-lag sampling and per-call timing. Diagnostic only, and zero-cost when unset — the instrumentation short-circuits rather than being compiled out, so it can be turned on for one restart without a rebuild |

## Operator authentication

The login password, cookie secret and break-glass bearer are in **Core** above — they gate
the *operator's* access to the HUD. The two variables here decide what credential the
*agents* bill against. The mode is UI-configurable (**Settings → Coding CLI**), and both
values are persisted in the `settings` table: the env only seeds a fresh DB, and a stored
value wins on every later boot.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_AUTH_MODE` | `subscription` | Auth footing for spawned agents: `subscription` runs them on Claude subscription OAuth; `api-key` bills them against an Anthropic API key instead. Unrecognised values fall back to `subscription` rather than failing the boot. Under `api-key` the raw key is **never** stored — Shepherd writes an `apiKeyHelper` script, hands the agent a credential-less config dir and lets the helper supply the key ([#660](https://github.com/erwins-enkel/shepherd/issues/660)) |
| `SHEPHERD_API_KEY_HELPER_PATH` | _(Shepherd writes one)_ | Point `api-key` mode at a pre-existing `apiKeyHelper` script instead of the one Shepherd manages — for an operator whose key already comes from a vault, keychain or `pass`. Unset, Shepherd owns the helper file. Only the path is ever persisted |

## Web push (VAPID)

A keypair is generated and persisted in the `settings` table on first use, so push works
with none of these set. Provide them to pin a stable pair across DB resets — a rotated
keypair invalidates every existing browser subscription, which then has to re-subscribe.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_VAPID_PUBLIC` | _(generated + persisted)_ | VAPID public key, handed to the browser when it subscribes |
| `SHEPHERD_VAPID_PRIVATE` | _(generated + persisted)_ | VAPID private key. Set it together with `SHEPHERD_VAPID_PUBLIC` or not at all — a half-configured pair cannot sign for the key the browser holds |
| `SHEPHERD_VAPID_SUBJECT` | `https://github.com/erwins-enkel/shepherd` | JWT `sub` claim sent with every push. Must be a routable `https:` or `mailto:` URL: Apple's push service rejects a non-routable one (`mailto:shepherd@localhost` and the like) with HTTP 403 `BadJwtToken`, which is why the default is a real URL rather than a local address |

## Model, effort and provider defaults

What a **new** session starts on. All five are persisted and UI-configurable; the env value
seeds a fresh DB and an absent or invalid value falls back to the default shown.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_DEFAULT_AGENT_PROVIDER` | `claude` | Coding CLI newly spawned task sessions use — `claude` or `codex`. Note this also reaches the **role agents**: every role seeded `inherit` (below) follows it, so flipping it globally re-points the critic, planner, distiller, optimizer and merge-suggest too |
| `SHEPHERD_DEFAULT_MODEL` | `auto` | Default Claude model. `auto` means "no stored preference": the New Task picker falls back to its client-side promo suggestion and drain spawns emit no `--model` at all. Any explicit alias applies to both the picker and drain/autopilot auto-spawns |
| `SHEPHERD_DEFAULT_CODEX_MODEL` | `gpt-5.6-sol` | Default model for Codex sessions, kept separate because the alias spaces do not overlap. `default` emits no `--model` flag and lets Codex choose |
| `SHEPHERD_DEFAULT_EFFORT` | `default` | Default reasoning effort. `default` emits no effort flag; the tiers are `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. There is no `auto` tier — unlike the model setting, effort has no promo fallback to defer to |
| `SHEPHERD_FABLE_AVAILABLE` | `true` | Kill switch for Fable. When off, a spawn asking for `--model fable` is transparently rerouted to `opus[1m]` at argv-assembly time **without** rewriting the stored session model, so cost accounting and replay still record the operator's actual intent. Turn it off while Fable is unavailable to your account rather than editing sessions |

## Role agents

Shepherd's background roles are ordinary agent spawns, each with its own **CLI / model /
effort** triple. The vocabulary is the same for every role:

- **CLI** — `inherit` follows the global `SHEPHERD_DEFAULT_AGENT_PROVIDER`; `claude` or
  `codex` pins the role to one provider regardless of what sessions use.
- **Model** — `default` emits no `--model` flag (with `inherit`, that means the operator's
  global default model); any alias pins it. Tokens are validated against the union of both
  providers' aliases.
- **Effort** — `default` emits no effort flag; otherwise a tier as above.

All are persisted and UI-configurable; the env values seed a fresh DB. The doc agent's and
maintain loop's own triples live with their features, further down this page.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_CRITIC_CLI` | `inherit` | **PR critic** — reviews a green PR and posts a verdict, driving both the session critic and the standalone PR critic |
| `SHEPHERD_CRITIC_MODEL` | `default` | Model the critic runs on |
| `SHEPHERD_CRITIC_EFFORT` | `high` | The one role seeded **above** the global default. The critic is a rigor role: a value resolving below `high` measurably weakens PR review, so Shepherd warns at boot (and on the Settings/PATCH paths) instead of silently accepting it. It still accepts the value — this is a warning, not a floor |
| `SHEPHERD_PLANNER_CLI` | `inherit` | **Plan-gate reviewer** — adversarially critiques a plan before execution is allowed to start |
| `SHEPHERD_PLANNER_MODEL` | `default` | Model the plan-gate reviewer runs on |
| `SHEPHERD_PLANNER_EFFORT` | `default` | Deliberately **not** seeded `high` like the critic. The planner has no independent spawn — it *is* the plan-gate reviewer, which inherits the session's own effort ([#1417](https://github.com/erwins-enkel/shepherd/issues/1417)), so `default` preserves that inheritance and a `max` session reviews its plan at `max`. An explicit tier here overrides that for every session, downgrading high-effort ones and surprising low-effort ones |
| `SHEPHERD_RECAP_CLI` | `claude` | **Recap writer** — summarises a session at the archive chokepoint, so the summary outlives the session |
| `SHEPHERD_RECAP_MODEL` | `sonnet` | Pinned rather than inherited, preserving the hardcoded default this role had before roles were configurable |
| `SHEPHERD_RECAP_EFFORT` | `low` | Summarising a finished transcript is not a reasoning-heavy job |
| `SHEPHERD_NAMER_CLI` | `claude` | **Namer** — reads the task prompt and renames the session from its instant heuristic name to a two-to-four-word one, in the background |
| `SHEPHERD_NAMER_MODEL` | `haiku` | Pinned cheap on purpose: this is a constant-cadence classifier that runs on *every* session, so following a heavy global default would inflate naming cost for no benefit |
| `SHEPHERD_NAMER_EFFORT` | `low` | As above — a slug is not a reasoning task |
| `SHEPHERD_LLM_NAMING` | `true` | Kill switch for that rename. `0` keeps the instant heuristic name and never spawns the namer |
| `SHEPHERD_AUTOPILOT_CLI` | `claude` | **Autopilot** — the transient stop-classifier that decides an unattended session's next move |
| `SHEPHERD_AUTOPILOT_MODEL` | `haiku` | Pinned cheap for the same reason as the namer: it runs on a fixed cadence for the life of every autonomous session |
| `SHEPHERD_AUTOPILOT_EFFORT` | `low` | As above |
| `SHEPHERD_AUTOPILOT_STEP_CAP` | `10` | Runaway guard: auto-steers autopilot may spend on one session before it stops and waits for the operator. It bounds cost on a session that is looping rather than progressing |
| `SHEPHERD_DISTILLER_CLI` | `inherit` | **Distiller** — turns captured session learnings into proposed house rules |
| `SHEPHERD_DISTILLER_MODEL` | `default` | Model the distiller runs on |
| `SHEPHERD_DISTILLER_EFFORT` | `default` | Effort tier for the distiller |
| `SHEPHERD_DISTILLER_INTERVAL_DAYS` | `1` | Per-repository throttle on **automatic** distiller runs; a manual run ignores it. Clamped to `1`–`14`: an out-of-range number snaps to the nearest bound (`30` gives you `14`, not the default), and only a non-numeric value falls back to `1` — the throttle cannot be turned off by setting a silly value |
| `SHEPHERD_OPTIMIZER_CLI` | `inherit` | **Optimizer** — the one-click improvement pass over a repo's own agent instructions |
| `SHEPHERD_OPTIMIZER_MODEL` | `default` | Model the optimizer runs on |
| `SHEPHERD_OPTIMIZER_EFFORT` | `default` | Effort tier for the optimizer |
| `SHEPHERD_MERGE_SUGGEST_CLI` | `inherit` | **Merge suggester** — proposes a merge order for the open PR queue |
| `SHEPHERD_MERGE_SUGGEST_MODEL` | `default` | Model the merge suggester runs on |
| `SHEPHERD_MERGE_SUGGEST_EFFORT` | `default` | Effort tier for the merge suggester |

## Review rounds, merge train and spend

`SHEPHERD_REVIEW_TIMEOUT_MS` (in **Core**) bounds a single critic *run*; the two cycle caps
here bound how many runs a piece of work gets before it stops being retried and waits for a
human. Both are clamped, UI-configurable and persisted, with the env seeding a fresh DB.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_REVIEW_CYCLES_CAP` | `3` | Critic → fix rounds a PR gets before the session escalates to the operator instead of re-reviewing. Clamped `1`–`8`: an out-of-range number snaps to the nearest bound (`20` gives you `8`, not the default `3`), and only a non-numeric value falls back to the default |
| `SHEPHERD_PLAN_REVIEW_CYCLES_CAP` | `5` | The same for plan-gate adversarial-review rounds, before the plan is escalated to the operator. Clamped `1`–`12`, and independent of the PR cap above |
| `SHEPHERD_AUTOMERGE_REBASE_CAP` | `5` | Consecutive auto-rebases the merge train spends on one PR whose base keeps moving under it, before it pauses that PR for the operator. It bounds a rebase loop against a busy `main`, not rebase failures |
| `SHEPHERD_EXTRA_CREDITS_DRAIN_CEILING` | `0` | Account-wide **extra-credit** (pay-as-you-go overage) ceiling, in account currency units, that autonomous drain and autopilot may run past; they pause once measured spend strictly exceeds it. The default `0` means pause on *any* overage spend, which is the conservative reading — raise it deliberately. Negative and unparseable values clamp to `0`. Persisted + UI-configurable |
| `SHEPHERD_PUSH_COOLDOWN_MS` | `120000` (2 min) | Collapses repeat web pushes from the same session inside this window, so one busy session cannot flood a phone. `0` disables the coalescing entirely |
| `SHEPHERD_REDUCED_PUSH_MODE` | `0` (off) | Set `1` for quieter devices: the push layer then sends only `ready` notifications plus cost alerts, dropping the rest. Global (not per-device); UI-configurable + persisted |

## Learnings lifecycle

The admission and retirement machinery behind distilled house rules, which move
**proposed → trial → active → retired** under a background sweep. Two conventions run
through the table: *N* is the number of observations backing a rule, and every
`MAX_…_PER_SWEEP` bounds one pass of the sweep, not the total — a large backlog drains over
several sweeps by design.

These knobs change **when** a rule moves, never what it says. All are env-only, and all are
read **once at startup** rather than per sweep, so a change needs a restart to take effect.
The injection-driven passes (trial, reap, retire) stay dormant for a repository with
learnings disabled; the proposed-prune below is the deliberate exception and runs regardless.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_LEARNINGS_AUTO_TRIAL` | `true` | Kill switch for promoting qualifying proposed learnings into active trials. `0` leaves promotion entirely manual — the admission gate the automation exists to unblock |
| `SHEPHERD_LEARNINGS_TRIAL_NMIN` | `4` | Strength gate: observations a proposed learning needs before it may enter trial at all |
| `SHEPHERD_LEARNINGS_TRIAL_SESSION_FLOOR` | `2` | Hard floor on distinct contributing sessions. No single-session rule is ever trialled, however much evidence one session produced — one session's quirk is not a house rule |
| `SHEPHERD_LEARNINGS_TRIAL_MIN_KINDS` | `2` | Breadth gate, first path: distinct *kinds* of evidence behind the rule |
| `SHEPHERD_LEARNINGS_TRIAL_MIN_SESSIONS` | `3` | Breadth gate, second path: distinct sessions. A candidate that clears the strength gate and the session floor qualifies on **either** breadth path — enough kinds, or enough sessions — so raising one alone does not tighten admission |
| `SHEPHERD_LEARNINGS_MAX_TRIAL_PER_SWEEP` | `3` | Promotions per sweep |
| `SHEPHERD_LEARNINGS_TRIAL_REAP_NMIN` | `8` | Trial reaper, evidence branch: injections a trial must have had before it can be judged inert |
| `SHEPHERD_LEARNINGS_TRIAL_REAP_DAYS` | `21` | Trial age, in days, that the same evidence branch also requires. Both conditions must hold |
| `SHEPHERD_LEARNINGS_TRIAL_REAP_MAX_DAYS` | `60` | Time branch: a trial older than this is reaped regardless of how rarely it was injected. It is the anti-zombie fallback for a rule that never got its chance because the house-rules budget kept crowding it out. A trial that was ever marked helpful is exempt from **both** branches |
| `SHEPHERD_LEARNINGS_MAX_REAP_PER_SWEEP` | `5` | Trial reaps per sweep |
| `SHEPHERD_LEARNINGS_PRUNE_DAYS` | `3` | Permanently deletes **proposed** learnings whose newest evidence is older than this. Applied in full each sweep — no cap and no exemption — and it ignores the repository's learnings toggle, because it is status- and age-based rather than injection-driven. Zero, negative and unparseable values are refused with a warning and the default is used, so the prune cannot be silently disabled by a typo ([#1794](https://github.com/erwins-enkel/shepherd/issues/1794)) |
| `SHEPHERD_LEARNINGS_WILSON_Z` | `1.96` | *z* for the Wilson lower bound used to score a rule's help rate; `1.96` is the conventional 95% value. The bound is a confidence-discounted rate rather than the raw ratio — the fewer injections a rule has, the further below its observed ratio it scores, which is why the low-evidence case is guarded separately by `SHEPHERD_LEARNINGS_RETIRE_NMIN`. Raising *z* widens the interval and pushes the bound down, so rules retire **more** readily; lowering it moves the score back toward the observed ratio |
| `SHEPHERD_LEARNINGS_RETIRE_NMIN` | `8` | Injections an active rule needs before auto-retire considers it at all. A rule with no recorded ineffective outcome is never retired regardless of this |
| `SHEPHERD_LEARNINGS_BASE_RATE` | `0.5` | The bar a rule's Wilson lower bound is compared against while the repository has too little history to measure one — retirement means "demonstrably worse than its peers", so a bar is needed before peers exist |
| `SHEPHERD_LEARNINGS_BASE_RATE_MIN_N` | `20` | Injections across the repository's proven rules before that measured peer rate replaces the assumed `SHEPHERD_LEARNINGS_BASE_RATE` |
| `SHEPHERD_LEARNINGS_MAX_RETIRE_PER_SWEEP` | `3` | Auto-retirements per sweep |

## Live preview

Detecting the dev servers agents start is platform-specific
([#1912](https://github.com/erwins-enkel/shepherd/issues/1912)). On **Linux**
Shepherd reads `/proc` live. On **macOS** it runs one `lsof` call per refresh and
serves every probe from that short-lived snapshot; previews there stay
**loopback-only**, and stopping one from the UI works but is bounded — the
snapshot must be within `SHEPHERD_PREVIEW_KILL_MAX_AGE_MS` and the candidate
process is re-checked live before any signal, otherwise the stop is refused and
reported as such (see the platform table in
[Getting started](/getting-started/)). On any other platform there is no
detection backend, so previews never bind. The **Preview detection** row in
Settings → Diagnose reports which case a host is in — see
[Operating Shepherd](/operating/).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_PREVIEW_PORT_BASE` | `8001` | First port in the live-preview range (one port per agent preview) |
| `SHEPHERD_PREVIEW_PORT_COUNT` | `16` | Size of the preview range and max concurrent previews |
| `SHEPHERD_PREVIEW_SWEEP_MS` | `4000` | Cadence (ms) of the dev-port detection sweep across active sessions. On macOS it also paces the `lsof` snapshot refresh (coalescing window: half the cadence) and sets how old that snapshot may get before it stops being allowed to prove a port is *gone* — `2 × cadence + 4 s`; past that, sweeps skip rather than tear a bound preview down |
| `SHEPHERD_PREVIEW_KILL_MAX_AGE_MS` | `10000` | How old the macOS `lsof` snapshot may be and still authorize a preview-stop *signal*. Deliberately independent of the sweep cadence: reusing that bound would let a tuned-up cadence widen the window in which stale data may authorize a `SIGKILL`. Past it, a stop is refused (and reported as such) rather than sent. No effect on Linux, which reads live `/proc` |
| `SHEPHERD_PREVIEW_AUTO_SERVE` | `true` | Dynamically register/unregister `tailscale serve` mappings as previews bind/tear down; set `0` to map the range manually |
| `SHEPHERD_PREVIEW_IDLE_STOP_MS` | `0` (disabled) | When > 0, an idle previewed dev server with no proxy traffic for this many ms is stopped to reclaim RAM (no auto-wake; suggested `1800000` = 30 min). On macOS each signal is gated on `SHEPHERD_PREVIEW_KILL_MAX_AGE_MS` plus a live re-check of the candidate process; when either fails nothing is signalled — the escalation ladder stays put and logs once per session instead of burning SIGTERM → SIGKILL |

## Host tuning (tmpfs inodes)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_NODE_COMPILE_CACHE` | _(disk dir)_ | Node compile-cache dir (kept off the `/tmp` tmpfs) |
| `SHEPHERD_TMP_INODE_PCT` | `80` | Inode-sweep threshold (% of `/tmp` inodes) — also the warning band of the **Temp filesystem inodes** Diagnose row (row bands stay ordered: >95 raises the error band too; outside `(0, 100]` the row falls back to 80, the sweep still honours it) |
| `SHEPHERD_TMP_ENTRY_LIMIT` | `1000` | Entry-count sweep threshold, used where the filesystem allocates inodes on demand (btrfs/XFS/ZFS) and a percentage is meaningless — also the warning band of the **Temp filesystem inodes** row for that signal (error band: 10x) |
| `SHEPHERD_TMP_STALE_HOURS` | `24` | Scratch staleness cutoff |
| `SHEPHERD_TMP_SWEEP_DIR` | _(default tmp root)_ | Override the swept tmp root |
| `SHEPHERD_AGENT_TMPDIR` | `~/.cache/shepherd/tmp` | Disk-backed `TMPDIR` handed to spawned (trusted) agents, so **all** of their temp I/O — per-session scratch trees, git worktrees, dependency installs and bare-`$TMPDIR` tool caches — lands on a real filesystem instead of the `/tmp` tmpfs, whose *inode* table it otherwise exhausts (ENOSPC with bytes to spare) ([#1875](https://github.com/erwins-enkel/shepherd/issues/1875)). Set it to the **empty string** to disable the redirect and inherit tmpfs again; that is the one-variable rollback, and it is why an unset value and an empty value mean different things here |

See [Operating Shepherd](/operating/) for the host-level `/etc/fstab` belt.

## Runaway-orphan reaper

A background sweep ([#1144](https://github.com/erwins-enkel/shepherd/issues/1144))
that `SIGKILL`s a process only when it both **(a)** carries the archived session's
`SHEPHERD_SESSION_ID` in its `/proc/<pid>/environ` (provenance — an agent, or a
descendant that inherited the marker, spawned it) **and (b)** belongs to a session
whose row is present and `archived` (the agent is definitively done). Attribution is
by env marker, not working directory, so it survives `cd`, backgrounding, and
worktree deletion — and an operator's own processes (which never carry the marker)
can never be candidates. The CPU/age pair below is a performance prefilter that keeps
the sweep's `/proc/<pid>/environ` reads near zero, **not** a safety floor.

Every signal Shepherd sends — the reaper's and the other kill paths' alike — is
additionally bracketed against **pid recycling**
([#1925](https://github.com/erwins-enkel/shepherd/issues/1925)): the process's
`/proc/<pid>/stat` start time is captured, the facts that qualified it (cwd,
comm) are re-read, and the start time is checked again, so a pid the kernel
handed to an unrelated process in the meantime is never hit. It fails closed —
a candidate that can't be bracketed is not signalled, and it also stops being
*offered*, so the operator is never shown a leftover the reap would refuse.
The one residual is inherent: start time has 10 ms granularity, so same-tick pid
reuse is indistinguishable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_REAP_RUNAWAY` | `armed` | Reaper mode. `armed` (the default — any unset/unrecognised value) `SIGKILL`s qualifying orphans; `observe` runs every gate but only logs (never signals); `0`/`off` disables the sweep entirely |
| `SHEPHERD_REAP_RUNAWAY_MIN_CPU` | `0.8` | CPU prefilter: fraction of one core, averaged over the process's whole lifetime, a candidate must have burned before it can be reaped. Clamped to `0.05`–`1` (a set-but-empty value clamps rather than dropping the gate) |
| `SHEPHERD_REAP_RUNAWAY_MIN_AGE_S` | `300` | Minimum process age (seconds) before a candidate can be reaped — the floor that keeps a freshly restored session's briefly-archived row from being reaped. Clamped to a hard `60`s minimum (up to 24h) |

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

## Up Next quick-start

Opt-in, default-off. Configurable from the Settings panel (persisted in the SQLite
`settings` table); the env var below seeds a fresh DB.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_UPNEXT_SKIP_CLI_PICKER` | `0` (off) | Set `1` to make Up Next quick-start launch with the operator's default coding CLI instead of opening the "Choose coding CLI" picker, even when more than one CLI is ready. Default off preserves the picker behavior. |

## Session lifecycle (auto-archive + herdr daemon-restart revival)

Two independent sweeps, with opposite defaults.

**Auto-archive** is the hourly janitor that tears down **settled** sessions — a session
whose work stopped and that has nothing left in flight still holds a DB row, a worktree and
a herdr tab. It is **on by default** and has no Settings-panel toggle: override it with
`SHEPHERD_SESSION_AUTO_ARCHIVE=0` or a `sessionAutoArchiveEnabled` row in the `settings`
table (the stored value wins). Unlike the DB-housekeeping sweep, which only prunes
already-archived history, this one tears a **live** row down — so every gate fails closed and
anything unreadable spares the session.

**Revival** covers the opposite case. When the **herdr daemon** restarts, it re-creates each
pane as a bare shell while the agent process behind it is gone — a "stranded" husk whose
conversation is no longer live. Shepherd detects these and surfaces them (a daemon-restart
toast plus a herd banner with a **revive all** action, which force-resumes every stranded
session). It can also revive them autonomously: that part is opt-in, default-off,
configurable from the Settings panel (persisted in the SQLite `settings` table), and the
`SHEPHERD_AUTO_REVIVE` env var below seeds a fresh DB. The two sweeps never contend over the
same session — a `stranded` session is the revival population and is never auto-archived.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_SESSION_AUTO_ARCHIVE` | `1` (on) | Set `0` to disable the hourly auto-archive of **settled** sessions. When on, a session that stopped working 7 days ago is archived — but only with positive evidence that it is finished: no claude process left in its worktree, no open PR, no uncommitted or unpushed work, and nothing in flight (merge train, plan-gate round, reviewer spawn). Every gate fails closed, so anything unreadable spares the session. It archives at most 5 per sweep (each one generates a recap) and keeps the task's issue claim, so the drain never re-queues what it swept ([#1156](https://github.com/erwins-enkel/shepherd/issues/1156)) |
| `SHEPHERD_AUTO_REVIVE` | `0` (off) | Set `1` to seed autonomous auto-revive on for a fresh DB. When on, only the **default-account** complement of stranded sessions is auto-revived (account panes keep recovering via `reDriveAccount`); each revive is bounded so a persistently-refused session gives up rather than re-firing every sweep. Operators can still trigger a manual **revive all** from the HUD regardless of this flag ([#1630](https://github.com/erwins-enkel/shepherd/issues/1630)) |
| `SHEPHERD_SESSION_HOUSEKEEPING` | `1` (on) | Kill switch for the daily **DB housekeeping** sweep, which deletes archived sessions past the retention window or beyond the newest-N cap and cascades their review rows. It only ever touches already-archived history — it cannot tear down a live session the way auto-archive can. UI-configurable + persisted; `0` seeds it off on a fresh DB |

## Push-based hook ingestion

Shepherd injects Claude Code lifecycle **hooks** into each spawned agent that POST to a restricted
loopback ingress, giving the HUD push updates (tool activity, notifications, sub-agent roster,
turn-`Stop` timing) **on top of** the 1 s poller — never instead of it. The path is **fail-open**:
each hook is synchronous with a 5 s budget, so an unreachable or hung endpoint (e.g. an
autonomous/egress agent whose netns route is down) simply times out and the poller stays
authoritative.

Two independent stages, each an env override on a code default:

- **Ingest** (`SHEPHERD_HOOKS_INGEST`) — injection + ingest route + ring-buffer/logging + the
  sub-agent roster fan-out. Observe-only: it never mutates session status. **Default on** as of the
  post-soak flip; set `SHEPHERD_HOOKS_INGEST=0` to disable (the kill switch).
- **Signals** (`SHEPHERD_HOOKS_SIGNALS`) — feed matched hook events into the poller's signal
  pipeline. **Default on** as of the post-soak flip; meaningful only when ingest is also on (with
  ingest off, no events arrive to feed, and Shepherd warns and treats signals as off).

  The signals kill switch is deliberately **partial**: on herdr **0.7.5 and newer**, agents are
  spawned through external registration, so herdr never advances `agent_status` itself and the
  `Notification` hook is the *only* source of awaiting-input edges. Signals are therefore forced on
  there regardless of the flag, and `SHEPHERD_HOOKS_SIGNALS=0` takes effect only on herdr **0.7.4
  and older** — where herdr's own detection plus the transcript probe still cover the gap.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_HOOKS_INGEST` | `1` (on) | Inject observe-only lifecycle hooks into spawned agents (ingest route, ring buffer/logging, sub-agent roster fan-out). No status consumption; additive + fail-open. Set `0` to disable entirely (kill switch) |
| `SHEPHERD_HOOKS_SIGNALS` | `1` (on) | Forward matched hook events into the poller's signal pipeline. Meaningful only when `SHEPHERD_HOOKS_INGEST` is also on. Set `0` to disable — but see the caveat above: that only bites on herdr ≤ 0.7.4 |

## Tool guard (PreToolUse deny)

Separate from the ingest hooks above: a **local** `PreToolUse` hook on the `Bash` tool that
**denies** two hazards at the call site instead of warning about them in every agent's standing
prompt — a bare `git stash` (the stash stack is shared across worktrees) and a worktree-add or
dependency install under a tmpfs root. The refusal carries the explanation, so the agent learns why
only when it matters. It runs as a local `command` hook (not the fail-open HTTP ingest transport)
so the deny still holds for unattended, sandboxed sessions, and it is bound into the bwrap membrane
so it exists inside the sandbox too. Claude spawns only — Codex spawns have no such mechanism and
keep the equivalent prompt notices resident.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_TOOL_GUARD` | `1` (on) | Inject the `PreToolUse` Bash guard into Claude spawns. Set `0` to disable (kill switch) — turning it off puts both hazard notices back into the composed system prompt, so no guidance is lost |

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
| `SHEPHERD_DOC_AGENT_EFFORT` | `low` | Reasoning-effort tier for the doc-agent spawn: `default` follows the CLI's own effort, or pin a tier (`low` / `medium` / `high` / `xhigh` / `max` / `ultra` — `ultra` is Codex-only). Seeds a fresh DB; persisted + UI-configurable |
| `SHEPHERD_DOC_AGENT_NIGHTLY_HOUR` | `3` | Local hour (0–23) at/after which the nightly sweep evaluates each repo; invalid values fall back to `3` |

## Fast stop classifier (the judge)

Every time an agent's turn ends, autopilot has to decide **why** it stopped — a procedural gate it
can wave through, a real question for you, finished work to drive to a PR, a completed non-PR task,
or something it cannot tell. By default that decision costs a whole transient `claude` agent: a
spawn, a terminal pane and a polled result file under a two-minute budget.

The **judge** answers the same five-way question with a single request to a "System One" decision
model instead. It is typically an order of magnitude faster, costs a small fraction of a cent, and
spends no subscription quota — which is quota your real agents get to keep.

**Arming it needs two things: `SHEPHERD_JUDGE=1` and `JEV_API_KEY`.** Both, deliberately. That key
is also the eval harness's credential, so having it in the server's environment must not silently
arm a billed production path, and you have to be able to turn the judge off without deleting the
key the eval leg needs.

**There is no capability to lose by trying it.** On any failure — transport error, rate limit, the
wall-clock deadline, a spend ceiling breach — the classifier falls back to the `claude` spawn it
uses today. The one visible difference is the one-line gloss on a paused session: the judge cannot
write prose, so the gloss becomes an excerpt of the agent's own last terminal lines rather than a
model's paraphrase of them.

Spend is metered per local day and shown in **Usage → Spend**, kept separate from the weighted-unit
figures above it — those price subscription work at Anthropic list rates, this is money actually
billed by another vendor. Past the daily ceiling the classifier falls back to the spawn and you get
one notification.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_JUDGE` | `0` (off) | Set `1` to route the autopilot stop classifier through the decision model. Inert without `JEV_API_KEY`. Seeds a fresh DB; persisted + UI-configurable (Settings → Session) |
| `JEV_API_KEY` | _(unset)_ | TypeSafe AI (JEV) credential. Read by the server when `SHEPHERD_JUDGE` is on, and by the eval harness's `--backend jev` leg. Absent ⇒ the judge stays unarmed whatever the flag says |
| `SHEPHERD_JUDGE_MODEL` | `jev-1.13.0` | Decision model, pinned to a **snapshot**. The vendor SDK's own default is a floating alias, under which a re-point would arrive as a silent accuracy change rather than a version bump |
| `SHEPHERD_JUDGE_BASE_URL` | `https://api.typesafe.ai` | API root. Configurable so a self-hosted implementation of the same wire format can be pointed at without a code change |
| `SHEPHERD_JUDGE_DAILY_USD` | `1` | Daily USD ceiling. A runaway guard, not a budget — past it the classifier falls back to the spawn for the rest of the day and you get one notification. Persisted + UI-configurable |
| `SHEPHERD_JUDGE_TIMEOUT_MS` | `8000` | **Total** wall-clock budget for one judge call, retries included (1000–60000). The vendor SDK times out per *attempt* with no total budget, so without this a rate-limited call honouring `Retry-After` could outlast the spawn the judge exists to be faster than |
| `SHEPHERD_JUDGE_SPEND_RETENTION_DAYS` | `90` | How many days of judge spend rows the daily sweep keeps (1–3650) |

## Maintain loop (self-health bands)

Opt-in, default-off, and fully inert when off. Once per local day Shepherd scores four
**bands** over its **own** health data and escalates by tier: **tier 1** logs the reading,
**tier 2** spawns a read-only diagnosis agent that drafts a backlog issue which the trusted
server files **against Shepherd's own repo** — never a managed repo, so nothing lands in
someone else's backlog. The agent itself never touches a forge: it writes a JSON draft in a
disposable worktree and nothing else. **Tier 3** skips the issue and opens a **pull request**
— see below.

| Band | Measures | Window | Tier 1 | Tier 2 |
| --- | --- | --- | --- | --- |
| `critic_error_rate` | Share of outcome-bearing review spawns that errored (produced no verdict) | 7 days, min sample 10 | ≥ `0.15` | ≥ `0.30` |
| `incident_spike` | `signals` per kind — needs **both** an occurrence count and a distinct-session count, so one thrashing task can't trip it. The `reply`, `block` and `critic` kinds are excluded — operator corrections, an agent asking the operator a question, and a blocking review verdict the auto-address loop then iterates on are all high-volume by design, not fault classes. Rework has a denominated band of its own in `first_pass_collapse` | 7 days | ≥ 10 occurrences **and** ≥ 3 sessions | ≥ 25 occurrences **and** ≥ 5 sessions |
| `first_pass_collapse` | Per-repo first-pass review rate — direction is **inverted**, a lower rate is worse | 30 days, min sample 8 | ≤ `0.60` | ≤ `0.40` |
| `dead_code_drift` | Auto-fixable dead-code findings in Shepherd's own checkout (`fallow dead-code`). Point-in-time, no window and no minimum sample. Declares a tier-3 fix class, so its tier-2 breach is **promoted to tier 3** | now | ≥ 1 finding | ≥ 3 findings |

A band below its minimum sample reports "below min sample" rather than a misleading number.
Every band's live value is persisted and surfaced on the **Delivery lens** whether or not it
breached — the starting thresholds are calibrated guesses, and observed values are what let
you retune them.

**Spend bounds.** At most **one** band action per sweep — a tier-2 diagnosis spawn *or* a
tier-3 fix, whichever band is more severe; the rest wait for the next day. After a run
**completes** — published, skipped or errored — its band is suppressed for **14 days**. The
cooldown anchors on the run, not on a published issue or PR, precisely so observe mode (which
publishes nothing) still suppresses. A still-open issue or PR from the band's last run extends
the suppression past the cooldown.

### Tier 3 — the pre-approved fix class

A band may declare a **pre-approved fix class**: a remediation mechanical enough that no
judgement is needed, so the loop produces the diff itself and opens a PR instead of asking you
to read a drafted issue first. Exactly one class exists — `dead_code`, on `dead_code_drift`.

**No agent is involved.** The fix is `fallow fix`'s verbatim output, so a tier-3 run costs no
tokens and has no prompt to be injected into. The run:

1. creates a branch worktree `shepherd/maintain-fix-<8hex>` off `origin/<default branch>`;
2. runs `bun install --frozen-lockfile` in the root, `ui/` and `extension/` — **load-bearing**:
   without installed dependencies fallow cannot resolve imports and reports live code as dead;
3. re-measures in that pristine checkout and stands down if there is nothing to fix (the
   sweep's reading came from the live checkout, which can carry uncommitted edits);
4. runs `bunx fallow@<pinned> fix --yes --no-create-config`;
5. **verifies fail-closed** — the type-check of **every package the diff touches** must pass, and
   a re-run of `fallow dead-code` must report no auto-fixable findings left. Per package, not just
   the root: `bun run typecheck` is `tsc` against a tsconfig that excludes `ui`, `extension`,
   `site` and `docs-site`, while fallow analyses all of them, so a root-only gate would pass
   vacuously for a fix under `ui/src`. The root uses `bun run typecheck`; `ui` and `extension` use
   their own `bun run check`. The run also **refuses** to commit when the fix touched any
   `package.json` or lockfile (`fallow fix` removes unused *dependencies* too, and that needs a
   lockfile regen a background loop must not do), or anything under `site/` or `docs-site/`, whose
   dependencies are not installed in the fix worktree and which therefore cannot be verified at
   all;
6. commits `--no-verify`, pushes, and opens the PR.

Any failed gate opens nothing, records an `error` outcome and throws the branch away. **Nothing
is ever auto-merged.** If `openPr` fails after the push, the branch is deleted from the remote
rather than left orphaned.

**Phased soak (`observe → act → pr`)**, mirroring the doc agent:

1. **Observe** — `SHEPHERD_MAINTAIN_LOOP=1` alone. Bands are evaluated, readings persisted,
   breaches logged and the tier-2 diagnosis spawns, but finalize is **log-only**: it logs
   `[maintain] <band>: would file issue "<title>" (act is off)` and calls the forge never.
2. **Act** — additionally set `SHEPHERD_MAINTAIN_ACT=1` to escalate finalize to actually
   opening the labelled issue. Meaningful only when `SHEPHERD_MAINTAIN_LOOP` is also on.
3. **PR** — additionally set `SHEPHERD_MAINTAIN_PR=1` to let a tier-3 run open its pull
   request. **Independent of `SHEPHERD_MAINTAIN_ACT`**: arming issue-filing never implicitly
   arms PR-opening. Without it a tier-3 run still installs, fixes and verifies, then logs
   `would open a PR removing …` and discards the branch — so the log names the real diff.

`POST /api/maintain/sweep` runs an evaluation on demand (it `404`s when the flag is off, the
same unadvertised contract as the doc-agent route). It skips the hour/presence/once-a-day
cadence gates but **not** suppression. A diagnosis run interrupted by a restart is settled and
its worktree reclaimed by the boot reconcile; the breach is re-diagnosed on the next cadence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_MAINTAIN_LOOP` | `0` (off) | Set `1` to arm the loop (**observe**): band evaluation, tier-1 logging, and the tier-2 read-only diagnosis spawn. The drafted issue is only **logged** until `SHEPHERD_MAINTAIN_ACT` is also set |
| `SHEPHERD_MAINTAIN_ACT` | `0` (off) | **Act.** Set `1` to escalate finalize to actually filing the labelled issue against Shepherd's own repo. Meaningful only when `SHEPHERD_MAINTAIN_LOOP` is also on |
| `SHEPHERD_MAINTAIN_PR` | `0` (off) | **Tier 3.** Set `1` to let a tier-3 fix open a pull request against Shepherd's own repo. Never auto-merges. Meaningful only when `SHEPHERD_MAINTAIN_LOOP` is also on, and **independent of** `SHEPHERD_MAINTAIN_ACT` |
| `SHEPHERD_MAINTAIN_HOUR` | `4` | Local hour (0–23) at/after which the once-a-day band sweep may run — an hour after the doc agent's nightly so the two spawns don't land together. Invalid values fall back to `4` |
| `SHEPHERD_MAINTAIN_CLI` | `inherit` | Agent CLI for the diagnosis spawn: `inherit` follows the global default provider, or pin `claude` / `codex`. Env-only (not persisted or UI-configurable) |
| `SHEPHERD_MAINTAIN_MODEL` | `default` | Model for the diagnosis spawn: `default` follows the global default model, or pin a `<model alias>`. Env-only |
| `SHEPHERD_MAINTAIN_EFFORT` | `default` | Reasoning-effort tier for the diagnosis spawn: `default` follows the CLI's own effort, or pin a tier (`low` / `medium` / `high` / `xhigh` / `max` / `ultra` — `ultra` is Codex-only). Env-only |
| `SHEPHERD_MAINTAIN_THRESHOLDS` | _(unset)_ | JSON object deep-merged over the threshold table above, so a recalibration ships without a deploy. Parsed field-by-field and **fail-soft**: an unparseable value or a typo in one number falls back to that default rather than disarming a band. E.g. `{"critic_error_rate":{"tier1":0.2}}`. Retunes numbers only — a band's tier-3 fix class is not overridable, because `SHEPHERD_MAINTAIN_PR` is the one switch that disarms tier 3 |

## Anonymous usage telemetry

Off until you opt in. Shepherd can emit **anonymous, privacy-first** usage
telemetry (OS, version, arch, locale, engine, and which features are used — never
code, file paths, repo names, or personal data) to an [Aptabase](https://aptabase.com)
endpoint, to help prioritise the roadmap. It is server-side and best-effort: a
rejected batch is dropped and the failure never propagates to the code that
emitted the event.

The drop is recorded, though, so a stalled pipeline is not invisible. Every flush
stores its outcome — the time of the last accepted batch, and the time and short
reason (e.g. `HTTP 400` for a rejected payload, `HTTP 401` for a bad App-Key,
`HTTP 429` for quota) of the last failure — in the SQLite `settings` table, so it
survives a restart. Shepherd logs `[telemetry] send failed: … — events are being
dropped` when sending starts failing and `[telemetry] sending again` when it
recovers, logging only on those transitions rather than once per event. With
consent granted, the Settings panel shows the same state as a line under the
telemetry toggle: the last successful send, or the failure that is dropping
events.

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
| `SHEPHERD_OPERATOR_LANGUAGE` | `en` | Seeds the operator language for a fresh DB: `en` (agents write to the operator in English — no change) or `de` (agents address the operator in German while keeping code, commands, identifiers, logs, commit messages, and GitHub issue/PR text in their original language). A UI-set value in the DB overrides this env seed at boot; unrecognised values are ignored |

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
Shepherd self-tests at startup by running `node` and `git` through the real membrane.

A **second, separate** check asks whether the agent binary itself starts inside that
membrane — a launcher that dies there (a version manager rewriting its shims against
a read-only bind, say) leaves the self-test green while every confined helper dies at
launch. It surfaces as the **Agent launch in sandbox** row in Settings → Diagnose and
refuses the affected wrapped spawns up front instead of letting them hang; it never
changes whether the membrane is applied. See [Operating Shepherd](/operating/).

A few runtime toggles live in the SQLite `settings` table
(`~/.shepherd/shepherd.db`) rather than env — e.g. `branchPruneEnabled` (hourly
cleanup of merged local `shepherd/*` branches, on by default) and
`sessionAutoArchiveEnabled` (the persisted override for
`SHEPHERD_SESSION_AUTO_ARCHIVE` above; a stored `"0"`/`"1"` wins over the env seed).
