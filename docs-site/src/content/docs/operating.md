---
title: Operating Shepherd
description: Run Shepherd as a systemd service, expose it over Tailscale, and deploy code changes.
---

## Run as a systemd user service

Shepherd runs as a **systemd user service** — as your own user, so it keeps your
`claude` subscription login, `~/Work`, and herdr. The installer sets this up on
Linux. It binds to **loopback only** (`SHEPHERD_HOST=127.0.0.1`).

```bash
systemctl --user status shepherd     # check it
systemctl --user restart shepherd    # restart it
```

The unit runs straight from the working tree, so **whatever is checked out is what
runs**.

### Restart from the UI

You don't need a shell to restart: **Settings → Session → Restart Shepherd → Restart…**
(searching "restart" in Settings jumps there). The page reloads by itself once Shepherd
answers again, usually within a few seconds. Agent sessions keep running — they live in
herdr, not in Shepherd.

Tick **Also restart the herdr daemon** in the confirm dialog to restart herdr too. herdr
goes first, via `herdr server live-handoff`: its panes move to a fresh server, so sessions
survive and attached terminals reconnect briefly. If the handoff fails, the old herdr server
keeps running and Shepherd restarts anyway.

The same dialog opens from the plugin banner (**Restart Shepherd to apply your changes**)
after a plugin update or uninstall.

Under the hood this is `POST /api/restart` with `{ "herdr": true | false }`, answered `202`
once launched. The restart runs in a detached transient unit, so its output lands in
`journalctl --user -u shepherd-restart`.

The button only works on the systemd unit itself. A Shepherd started from a terminal or a
dev worktree answers `not_systemd` — on purpose, so a dev UI can never bounce the production
instance; restart that one by hand. A second click within a minute answers
`already_restarting`.

### If the HUD freezes

HTTP, the web terminal and all background work share **one event loop**. If code ever spins
on it, the whole HUD stops responding — and `systemctl --user restart` hangs for its full
90 s stop timeout, because a frozen loop never runs its shutdown handler.

The unit arms a **watchdog** for this. A separate thread pings systemd only while the loop
is still turning:

- **After 10 s frozen** it writes a stall report to `~/.shepherd/shepherd.log`: the requests
  and timers that were in flight, and what finished just before, with timestamps.
- **After `WatchdogSec` (60 s)** without a ping, systemd kills and restarts the service.

```bash
grep -a 'loop-watchdog' ~/.shepherd/shepherd.log | tail -20   # the stall report
journalctl --user -u shepherd | grep -i watchdog               # the restart itself
```

The in-flight entry that started just before the stall is the prime suspect — attach the
report when you file an issue. A later `event loop recovered after …` line means the block
was long but finite, and the service was never restarted. An install from before the
watchdog picks it up on the next `bun run update`.

## Expose it over the network

Reach Shepherd over the network by putting it behind a trusted proxy — e.g.
Tailscale:

```bash
tailscale serve --bg 7330    # → https://<host>.<tailnet>.ts.net proxies to 127.0.0.1:7330
```

A Tailscale-served HUD needs **no allowlist step**: at startup Shepherd folds
every host that `tailscale serve status` shows fronting its port into the CSRF
origin allowlist — the node's own tailnet name (a direct `tailscale serve`, as
above) as well as a Tailscale **Service** front (e.g. `svc:shepherd` →
`shepherd.ts.net`). Only a front that doesn't appear in `tailscale serve status`
— a non-Tailscale reverse proxy or custom-DNS name — still needs its hostname
added to `SHEPHERD_ALLOWED_HOSTS`.

Access control is layered: the network reach is gated by
**tailnet membership**, and the app itself is gated by a **single-operator
password**. The password is exchanged for an HMAC-signed session cookie that
covers every HTTP route plus the live `/events` and `/pty` WebSocket channels.
Set it with `SHEPHERD_PASSWORD`; if you leave it unset, Shepherd generates a
strong one on first boot and prints it to the log **once** (`systemctl --user
status shepherd` / `journalctl --user -u shepherd`) — change it by setting
`SHEPHERD_PASSWORD` in `~/.shepherd/env` and restarting. A changed password
rotates the cookie secret, so existing sessions are signed out (unless
`SHEPHERD_COOKIE_SECRET` pins the secret).

Per-deployment overrides (password, token, repo root, alternate hosts) go in
`~/.shepherd/env` (`KEY=value` lines), read by the unit if present. See
[Configuration](/reference/configuration/) for the full list.

The state dir (`~/.shepherd`, or the dir of `SHEPHERD_DB`) is owner-only: 0700, with
`shepherd.db` (+ SQLite side files) and `shepherd.log*` at 0600. The server tightens them at every
boot, the unit runs with `UMask=0077`, and `install.sh` / `bun run update` tighten an existing
install. A path that is a symlink or owned by another user is left alone with a warning.

## Connect another machine

Another Shepherd, for example the one on your MacBook, can run tasks you start
here: connect it under **Settings → Machines** with its tailnet address and a
Full access token created on it. The whole session then runs on that machine,
and its sessions show up in your herd. Setup for Linux and macOS, the trust
decision, the limits and an end-to-end checklist:
[Run tasks on another machine](/machines/).

## Deploy a code change

The unit runs from the working tree, so to deploy local changes in one shot
(install deps → build UI → restart → health check):

```bash
bun run update          # deploy the current working tree (warns if dirty / off main)
bun run update --pull   # fast-forward main from origin first (skip on a dev==prod box)
```

It is idempotent and safe to re-run — sessions survive the restart (herdr owns the
PTYs). It also refreshes the prebuilt `shepherd` CLI to the server's version (skipped
when already current or when `SHEPHERD_NO_CLI=1`; a missing binary only warns). UI-only changes don't strictly need it: a fresh `cd ui && bun run build` is
served on the next request, since the core reads `ui/build` from disk per request.

## Backups & restore

On Linux the installer/provision step also enables a **second** systemd user
timer — `shepherd-backup.timer` (`OnCalendar=hourly`) — that snapshots the SQLite
state DB out-of-process from the server (read-only `VACUUM INTO` → integrity check
→ gzip → atomic rename → GFS rotation). Snapshots land in `~/.shepherd/backups/`
by default (override `SHEPHERD_BACKUP_DIR`). Backups are owner-only: the backup dir is
kept at 0700 and every file in it at 0600, tightening files an older run left at 0644.

```bash
systemctl --user status shepherd-backup.timer   # check the timer
journalctl --user -u shepherd-backup             # per-run logs
deploy/shepherd-restore.sh                       # list snapshots, then restore one
deploy/shepherd-restore.sh <file>                # restore a specific shepherd-*.db.gz
```

The server's daily sweep also runs a read-only **staleness probe**: on a host
that's expected to back up, if the newest snapshot is missing or older than 3h it
logs a warning, records a durable `backup_stale` signal, and sends a best-effort
web-push alert. macOS / core-only hosts have no backup timer and stay silent. Full
details are in the
[backups runbook](https://github.com/erwins-enkel/shepherd/blob/main/docs/backups.md).

## Preview detection

Live previews depend on Shepherd being able to see the processes an agent starts.
How it looks depends on the host: on Linux it reads `/proc` live; on macOS it runs
a single `lsof` call per refresh and answers every probe from that short-lived
snapshot. On any other OS there is no backend at all.

The **Preview detection** row in Settings → Diagnose makes that visible instead of
leaving a preview that silently never appears. It **warns** when the backend can't
run on this host, when the OS isn't supported, and when the snapshot has gone stale
(the last inspection didn't finish in time, so previews may be delayed or missing);
it stays `ok` when detection works. It never escalates to an error — previews are a
convenience, so a broken one shouldn't turn the health pip red. If the check itself
can't complete, the row reports that it couldn't be verified rather than degrading
the pip. Starting a dev server from the UI on a host where detection is dead or
stale still starts it, but you get an alert pointing here instead of a "started"
toast, because the preview can never bind.

Detection also backs sweeps that are more consequential than previews. When process
data is unknown, Shepherd **skips** rather than acting on it: session liveness stays
unreported (no husk/stranded verdict, no auto-revive) and the boot/daily worktree
reap is skipped — it logs `worktree reap skipped (live cwds unknown)` and still runs
the package-manager store reclaim, which doesn't depend on process data. Idle-stop
behaves the same way; see `SHEPHERD_PREVIEW_IDLE_STOP_MS` in
[Configuration](/reference/configuration/).

## Agent CLIs managed by mise

If `claude` or `codex` is managed by [mise](https://mise.jdx.dev), Shepherd works
_with_ that install instead of planting a second one beside it.

**Installing.** When a `claude`/`codex` check is red and `mise which <tool>` resolves,
the **Fix** button symlinks the mise binary into `~/.local/bin` rather than running the
vendor installer. mise exposes tools through a shims dir that isn't on the systemd
unit's `PATH`, and `mise activate` only runs in interactive shells — so the binary
existed, it was just unreachable. `~/.local/bin` **is** on the unit's `PATH`. Hosts
without mise, and tools mise doesn't manage, get the vendor installer exactly as before.

**Updating.** When mise owns the `codex` on `PATH` — a shim, an install path, or a
symlink resolving to one — the codex update runs `mise upgrade codex` and **nothing
else**. `mise upgrade` respects the version request in your mise config, so a pinned
codex won't advance; Shepherd then reports the update as not converged and points you at
`mise use -g codex@latest` rather than falling back to `codex update` or `npm install -g`,
either of which would install a second codex shadowing the mise-managed one.

Claude Code has no Shepherd-side updater (it self-updates), so a mise-managed `claude` is
upgraded by you: `mise upgrade claude`.

### The Claude Code install row

Claude Code self-updates by writing a **native** install into `~/.local/share/claude/versions`
and repointing `~/.local/bin/claude` at it. On a host where mise also manages `claude`, that
native copy **shadows** the mise-managed one: the two drift apart, and `mise upgrade claude`
then moves only the install nothing runs.

Two things happen on a host where mise owns the `claude` Shepherd spawns:

- Shepherd sets `DISABLE_AUTOUPDATER=1` on agent spawns, so Claude Code stops re-planting the
  native copy. `mise upgrade claude` is the update path from then on. This only applies when
  mise really does own what runs — a host without mise keeps self-updating exactly as before,
  so nothing gets stranded on an old build.
- The **claude install** row in Settings → Diagnose reports the state. It **warns** when the
  `claude` on `PATH` and the one mise manages report different versions (naming both, so you can
  see which one Shepherd actually spawns); when the versions agree but what runs is still the
  native copy, which mise can't advance, so the two will drift again; and when mise really does
  own what runs but a leftover native tree is sitting on disk — those builds are several hundred
  MB each. The row is never `ok` unless the pin is in effect, so it can't claim a pin that
  wasn't applied — though the reverse doesn't hold: the leftover-tree warning is a pinned state
  too, since mise does own what runs there and it's only the old files that need clearing.

Ownership is decided by comparing what `claude --version` reports against the mise-managed
binary's own `--version`, not by inspecting paths — so a shim, a `~/.local/bin` symlink and a
launcher script that `exec`s `mise x claude` all read correctly.

The row has no **Fix** button by design: repointing `~/.local/bin/claude` would clobber a
launcher script you may have put there on purpose, and deleting a several-hundred-MB install
tree is your call, not Shepherd's. On a host where mise doesn't manage `claude` the row is
absent entirely.

### Claude Code version and model support

Claude Code validates `--model` against a model catalog **compiled into the binary**. Picking a
model newer than the installed CLI is not a slow failure or a quiet downgrade — every spawn dies
with a `400` naming the version it needs:

```
API Error: 400 Claude Code 2.1.277 does not support this model;
           version 2.1.280 or newer is required.
```

The **claude model support** row in Settings → Diagnose warns before that happens: when a model
you have configured — as the global default, a repo default, a per-role model, or on a live epic
run — needs a newer Claude Code than the one on `PATH`, the row names the model, the version
required and the version running. It stays silent otherwise, including when `claude --version`
can't be read: Shepherd would rather say nothing than guess at a version it never established.

Like the install row above it, this one has no **Fix** button — updating your Claude Code is your
call. On a mise-managed host that's `mise upgrade claude`; otherwise `claude update`. Currently
two models carry a floor, each with its `[1m]` variant: `claude-opus-5-5` at 2.1.280 and
`claude-sonnet-5-5` at 2.1.284. Sonnet 5.5 is the softer case: an older CLI doesn't reject it but
runs it as an unrecognized model, with auto-compact capping the context at 200k tokens.

### Transient API errors

A Claude turn can end on a transient API error instead of a real stop — `API Error: Connection
lost mid-response…` or `API Error: 529 Overloaded…` once Claude Code's own retries run out. The
agent then sits idle. Shepherd spots that error as the last message of the transcript and types
a "continue where you left off" message for you, in every Claude session, attended or autopilot (except the Operator Assistant's own chat):
after 20 seconds, then 60, then 180 if the error keeps coming back. After the third failed retry
it stops and flags the session **halted on an error**. A turn that ends normally resets the count.
Autopilot holds off while a retry is pending, and takes over as usual if the retry is called off.
Login, usage-limit and other API errors are left to their own handling. Pending retries don't
survive a Shepherd restart.

## Agent launch inside the sandbox

Shepherd's startup self-test proves that **bubblewrap can build a sandbox** on this
host — it runs `node` and `git` through the real membrane. It deliberately does not
launch the agent binary, because a `null` verdict there means "run unconfined", and
folding a launcher fault into it would silently strip the sandbox from exactly the
hosts that can sandbox.

A separate check answers the other question: does `claude` / `codex` actually
**start** inside the membrane? A version manager that rebuilds its shims directory
against a read-only bind, for instance, exits non-zero at launch — so every confined
helper (plan reviewer, PR critic, doc agent, maintain diagnosis, standalone critic) died at launch,
waited out its whole timeout and reported no verdict, while the sandbox row stayed
green.

The **Agent launch in sandbox** row in Settings → Diagnose reports it, and a `broken`
verdict also **blocks**: a wrapped helper spawn is refused up front with a stated
reason instead of hanging to its timeout — per binary, so a broken `codex` doesn't
stop `claude` roles. It is fail-open: only a **non-zero exit** counts as broken; a
probe that throws or times out is reported as un-inspectable and spawns proceed.
The launcher's own output holds host paths, so it goes to Shepherd's log rather than
into the row.

The row is guidance-only — no **Fix** button, because the repair is host-side
toolchain surgery (which manager owns the binary, which path it rewrites). It is
absent on a host with no sandbox backend (nothing is wrapped) and for an agent CLI
that isn't on `PATH` (the `claude` / `codex` rows already say so). Hitting **Re-run**
probes fresh rather than reading a cached verdict, and the refusal path reads the
same result — so a repaired host un-blocks its confined helpers as soon as the row
goes green.

## Host tuning — tmpfs inodes

Shepherd keeps spawned agents' Node compile cache **off** the `/tmp` tmpfs and runs
an inode-guard sweep on **startup + daily** that, once `/tmp` inode use crosses a
threshold, drops the compile cache and stale regenerable tool caches (but never a
live session's scratch). As a host-level belt on long-uptime hosts, raise `/tmp`'s
`nr_inodes` in `/etc/fstab`:

```text
tmpfs /tmp tmpfs nr_inodes=4194304 0 0
```

The relevant override env vars (`SHEPHERD_NODE_COMPILE_CACHE`,
`SHEPHERD_TMP_INODE_PCT`, `SHEPHERD_TMP_ENTRY_LIMIT`, `SHEPHERD_TMP_STALE_HOURS`,
`SHEPHERD_TMP_ORPHAN_DAYS`, `SHEPHERD_TMP_SWEEP_DIR`) are listed in [Configuration](/reference/configuration/).

The **Temp filesystem inodes** row in Settings → Diagnose surfaces this live: it warns
at `SHEPHERD_TMP_INODE_PCT` (the same threshold that gates the sweep) and errors at 95% by
default. The bands stay ordered: if you raise the knob above 95 the error band rises with it, so
the row never alarms below the line you set.

Not every filesystem has an inode ceiling to express as a percentage — btrfs, XFS and ZFS allocate
inodes on demand and report a total of zero. There the sweep and the row both fall back
to counting how many leftover top-level entries have accumulated in each temp root, warning at
`SHEPHERD_TMP_ENTRY_LIMIT` and erroring at ten times it. Both signals are evaluated **per root**,
and the row reports the worst — a quiet `/tmp` can sit beside a disk-backed agent temp root that is
filling steadily, and one reading would hide the other. "Worst" is ranked by the state each root
would report, not by a raw ratio, because the two signals reach their warning band at different
fractions of their error band.

The row measures only the roots a sweep can **reclaim**. Session-scratch roots are excluded: their
contents belong to live sessions and cannot be removed by the row's Fix — so counting them would
pin the row at a warning that no action clears.

A live session's own scratch is still reclaimed, just not by the row: at teardown, and — for
whatever a teardown never got to (a crash, a restart, a removal path that predates the fix) — by a
reconcile that runs inside the same **boot + daily** sweep. It removes orphaned per-session scratch
and the scratch left behind by transient helper agents — both halves of the latter: the copy under
the agent's own temp root, and the helper's `mkdtemp` working directory sitting directly under the
helper temp root. It is fail-closed throughout: an entry is removed only on positive proof that it
is dead, every live worktree and every live helper `cwd` is kept, a directory that holds a `.git` is
refused outright (that is a worktree, and reaping those belongs to the worktree half), an unreadable
repo disqualifies its own entries, and anything unrecognised — including your own interactive
`claude` sessions' scratch — is left strictly alone. Where live process data is unknown both helper
rules are skipped entirely, the same stance as the worktree reap. Each run logs what it removed
(`[tmp-sweep] <phase>: scratch reconcile removed …`).
This matters because inode exhaustion is easy to misdiagnose — writes start failing with
"no space" errors while `df -h` still shows the volume mostly empty. `df -i` is what shows
the real cause.

Its **Fix** button runs the sweep immediately, ignoring the usage threshold. It reclaims
what Shepherd owns — the compile cache and stale tool caches — so the row can legitimately
stay non-OK right after you click it: the two largest consumers when an agent has run a
dependency install in the temp filesystem — a leftover git worktree and the forked
package-manager (pnpm) store it pinned — are **not** touched by the on-demand Fix button.
They are reclaimed by the background sweep that runs at boot and daily: abandoned agent
worktrees are reaped, then the forked pnpm store is **partially** reclaimed — under inode
pressure it unlinks the store content nothing still references and prunes the emptied bucket
dirs, while keeping content a surviving worktree still hardlinks. So a store that is still
partly pinned frees its unlinked fraction rather than nothing at all.

## Host tuning — resource guardrails

**Settings → DIAGNOSE** includes a **Host capacity** check. On a systemd-managed
host it **warns** when Shepherd's unit has no memory or CPU guardrails
(`MemoryMax` / `MemoryHigh` / `CPUQuota`), so a runaway fan-out of sessions can
starve the box. Add limits to the unit — or to a dedicated slice such as
`shepherd.slice` — before running many concurrent sessions.

On a **user-scoped** install the check covers **both** units: Shepherd's own unit
and `herdr.service`, which runs your agent sessions. It stays `ok` only when
Shepherd is bounded *and* herdr is not positively unbounded, and it raises a
distinct warning for the case where Shepherd is bounded but herdr is not. A herdr
that isn't a loaded user unit (absent, masked, or system-scoped) can't be read, so
it's excluded from the verdict rather than reported as unbounded. The check also
**errors** when the kernel reports dangerous live memory/IO pressure (PSI), a cue
to pause or reduce active agent sessions until the host recovers. On non-systemd
or local dev hosts it stays quiet. Because sustained pressure is steady-state, the
background re-check is *not* accelerated on this error — use the Diagnostics
**Re-run** button for an on-demand live reading.

### Add a limit (one click)

On a user-scoped install with at least 6 GiB of RAM, the warning carries a **Fix**
button. It proposes a conservative, host-derived pair — `MemoryHigh` leaving
`clamp(15%, 2 GiB, 8 GiB)` of RAM headroom, `CPUQuota` leaving
`min(1 core, 15% of cores)` for the OS — and shows the exact values and units in a
confirm modal before anything is applied. Applying runs `systemctl --user
set-property` on **only** the units that are currently unbounded, so a limit you
set deliberately is never overwritten. Like the copy-paste command below, it is
live and persistent with no restart and no interrupted sessions.

It bounds each unit **on its own**; it does not create the shared cap across
Shepherd and herdr that a slice gives you — for that, use the slice setup below.

### Add a limit (copy-paste)

Shepherd installs as a **systemd user service** (`shepherd.service`), so you can
add a live, persistent guardrail without `sudo` or a restart. `set-property`
writes a drop-in under `~/.config/systemd/user.control/` and applies it
immediately:

```sh
# Tune the values to the host — e.g. MemoryHigh a few GB below total RAM,
# CPUQuota to leave headroom for the OS and other services. 300% = 3 cores.
systemctl --user set-property shepherd.service MemoryHigh=6G CPUQuota=300%
```

Setting **any** of `MemoryHigh`, `MemoryMax`, or `CPUQuota` on a unit marks that
unit bounded. `MemoryHigh` throttles and reclaims *before* the harder `MemoryMax`
OOM-kill ceiling, so it's the safer first lever.

On a user-scoped install the command above is not enough on its own to clear the
**Host capacity** warning: agent sessions run under **herdr**, a *separate* unit,
so a limit on `shepherd.service` alone bounds Shepherd but not the sessions that
actually consume the box — and where herdr is a loaded user unit, the check keeps
warning until it is bounded too. Repeat the `set-property` for it:

```sh
systemctl --user set-property herdr.service MemoryHigh=6G CPUQuota=300%
```

For **real** protection, prefer a shared **slice** — a per-unit limit on each of
the two still lets them add up to twice the ceiling. Put both units in one slice
and limit the slice instead:

```ini
# ~/.config/systemd/user/shepherd.slice
[Slice]
MemoryHigh=12G
CPUQuota=600%
```

```ini
# ~/.config/systemd/user/shepherd.service.d/slice.conf   (same for herdr.service)
[Service]
Slice=shepherd.slice
```

`Slice=` is assigned at unit load, not via `set-property`, so this pair needs a
reload + restart to take effect (the restart briefly drops the HUD):

```sh
systemctl --user daemon-reload
systemctl --user restart herdr.service shepherd.service
```

A **system**-level install (unit under `/etc/systemd/system/`) takes the same
properties via `sudo systemctl set-property …` or an equivalent drop-in there.

### herdr restarts and the task limit

When herdr starts, it restores every tab saved in `~/.config/herdr/session.json`
(or `sessions/<name>/session.json` when you set `HERDR_SESSION`) as a fresh shell.
Every agent process dies with the server, so a restarted herdr brings those tabs
back as empty shells. If the tabs include hundreds of leftover Shepherd helper
tabs (reviewers, the namer, the usage probe…), they all spawn at once.

To prevent that, `herdr.service` runs `deploy/herdr-prune-session.ts` before herdr
starts. It removes helper tabs from `session.json`, keeps a copy of the original as
`session.json.pre-prune`, and logs one `[herdr-prune]` line to the journal
(`journalctl --user -u herdr`). The script doesn't touch your own tabs or session
tabs. It makes no change when:

- the file's format isn't one it recognizes,
- a herdr server is still answering on the socket, or
- a process from a previous pane is still running.

If the script fails, herdr still starts.

The unit also sets `TasksMax=16384`. Every pane and its threads count against
herdr's task limit, and a low systemd default (2500 on some hosts) can make herdr
crash with `pthread_create: EAGAIN`.

It also sets `LimitNOFILE=65536:524288`. Every pane holds open files, and at the
default soft limit of 1024 a burst of tabs can stop herdr's API with
`No file descriptors available`. A `herdr.service.d` drop-in of your own still
overrides this value.

## Auto-merge without PR CI

Full auto-merge waits for green CI before it merges a PR. Two cases have no CI to wait for, and
Shepherd reports both instead of waiting forever.

**The repo has no PR CI.** Shepherd reads `.github/workflows` and counts only workflows that check a
PR: `pull_request`, `pull_request_target`, `merge_group`, and `push` unless it is limited to tags
or to fixed branch names such as `[main]`. A repo whose workflows only run on `schedule`,
`workflow_dispatch`, `release` and similar counts as having no CI. A workflow file Shepherd cannot
parse counts as CI.

- The automation pane warns under **Merge without CI**.
- **Settings → Diagnostics** lists the repo as **No PR CI** until you add CI or opt in.
- The merge train holds the PR. The session banner says no workflow runs on pull requests.
- To land it, add a CI workflow, use **Merge without CI** on the banner (one PR, with the usual
  merge confirmation), or turn on **Merge without CI** in the automation pane. The setting covers
  every PR in the repo and is off by default.

**CI skips this PR.** A CI repo's workflow can skip a PR through a `paths` or `branches` filter. If
the PR's latest commit has no checks for 10 minutes and GitHub reports it mergeable, the banner
says CI apparently doesn't run for this PR and offers **Merge without CI**. Pushing a commit that
triggers CI clears it.

## Operator Assistant

The **Operator Assistant** is a Claude session that Shepherd runs for you and grounds
in its own state. Ask it in plain words why the herd stalled, why an epic won't drain,
why an agent died, or whether this node is healthy. It reads, explains and tells you
what to do. Ask it to get something done in a repo and it starts a session for it, as New
Task would. What else it may change itself — steer a session, approve a plan, merge a PR,
flip repo automation — you decide under **Settings → Assistant**.

It uses Shepherd's default Claude model and effort, and its tokens count toward your
usage like any session's. The first open starts it with no prompt, so nothing is spent
until you ask.

### Open it

- **Assist** in the top bar opens it as a panel beside the selected session; ⌘K / Ctrl+K
  → _Open Operator Assistant_ does the same, and on desktop ⌘J / Ctrl+J opens or closes it
  from anywhere, even a focused terminal. The session terminal keeps working next to
  it. On a phone the assistant is its own screen, opened from the Assist icon in the top
  bar (or the gear sheet); **Back** returns to where you were.
- **Ask the assistant** in a herd row's right-click / long-press menu opens it with
  "What's going on with TASK-31, and is anything stuck?" typed into its prompt.
- **Ask the assistant** on a warning or error check under Settings → Diagnose does the
  same for that check.

The panel shows the conversation on its own warm card, so it never reads as one more
session terminal: your messages on the right, its replies as text, background notices as
quiet one-liners. Write in the field at the bottom — Enter sends, Shift+Enter breaks the
line, Esc or **Stop** interrupts a turn. **Terminal** in the panel header switches to its
raw terminal, for a confirmation it waits on there (the conversation points you to it) or
anything the conversation leaves out; the choice is remembered per device. The header also
names what it sees right now, such as _sees TASK-31 · Diff_.

An Ask types the question but never sends it: read it, edit it, press Enter. Whether the
panel is open is remembered per device. The Assist button carries a pip: amber while the
assistant works, red while a command waits for your approval. The chip in the panel
header shows what it may do — _Read-only_, _Asks first_ or _Acts itself_ — and opens
Settings → Assistant.

### Repo assistants

The Operator Assistant covers everything. When you work on one repo for a while, give it
its own assistant: **Assistant for this repo only** in a repo chip's right-click /
long-press menu, or **+ Repo assistant** at the top of the panel, which lists every repo.
There is at most one per repo; on a repo that has one, the same entries open it.

- **It sees one repo.** Its herd and repo-automation tools show only that repo's sessions,
  held tasks and settings, it starts sessions only there, and its actions refuse a session
  or repo outside it. Shepherd enforces this, not only the prompt. With every message it
  gets that repo as its filter, and the session in view only when it belongs there.
  Questions about the node — health, logs — still work.
- **Everything else stays with the global assistant.** Ask there about the whole herd or
  about another repo. Halting the whole herd is the global one's too: a repo assistant
  interrupts its repo's sessions one by one instead.
- **All of them stack in the panel.** The global one is always on top, repo assistants
  follow in the order you started them, and that order never changes. One is open; the
  others fold into bars that show the repo, whether it is working (amber) or waiting for you
  (red), its newest reply and how many replies came in since you folded it. Click a bar to
  open it. On a phone the stack becomes tabs under the assistant's title.
- **The Assist button counts them** once there are two or more, and its pip shows the most
  urgent: red as soon as any one waits for your approval.
- **End** (the square in a repo assistant's header, clicked twice) archives it. The global
  assistant is never ended, only started over with **New conversation**.

Each repo assistant is a Claude session of its own, with the same model, effort and
**Settings → Assistant** permissions, and its tokens count like the global one's.

### What it reads

Through four read-only tools, which never ask:

- **the herd** — every live session's status, plan gate, hold reason and minutes since
  its last update, plus the held tasks per repo; for one session also its plan questions,
  recent signals and its PR and CI state;
- **repo automation** — the drain, auto-merge, critic and usage-ceiling settings, the drain
  status, and epic runs and queues;
- **diagnostics and the host** — the Settings → Diagnose checks, herdr's runtime, load,
  memory and pressure, the Shepherd, herdr and claude versions, and the systemd state of
  Shepherd and herdr;
- **logs** — the tail of Shepherd's, herdr's and the updaters' logs, with secrets masked.

It can also read Shepherd's own docs and source in the install directory.

With every message it also gets what your Shepherd window shows: the repo filter, the session
in view with its open tab and its epic, and which client you use. So "why is this one stuck?"
or "what's wrong in the current repo?" means what you're looking at. On a phone, the session
in view is the one you opened the assistant from. When that doesn't settle what you mean, it
asks. A conversation started before this arrived picks it up after **New conversation**.

### Permissions (Settings → Assistant)

The assistant runs in Claude's default permission mode. **Settings → Assistant** sets how
far it goes, one row each:

| Row | Covers | Levels |
| --- | --- | --- |
| Shell commands | Commands it runs on this node to diagnose | Off · Ask for every command · Reads run, the rest asks · Run everything |
| Steering & answers | Send a message into a session, answer a plan's open questions | Off · Ask first · Allowed |
| Start sessions | Start a new session in a repo, as New Task: its own worktree from the repo's default branch (or one it names), your default model and effort, and the repo's plan gate, autopilot and usage hold | Off · Ask first · Allowed |
| Control sessions | Interrupt, resume, relaunch or archive a session | Off · Ask first · Allowed |
| Approvals & merge | Start an approved plan, approve a build queue, mark a PR ready, merge a PR | Off · Ask first · Allowed |
| Automation | Repo automation (Auto-Drain, max auto sessions, auto-merge, critic, usage ceiling), a session's autopilot and auto-merge, pausing or resuming an epic, held tasks, halting and retrying the herd | Off · Ask first · Allowed |

- **The default** lets read-only commands run (grep, cat, git log, ps, systemctl status …)
  and starting a session, and has every other action ask first. It answers with the new
  session's designation, or the held task's when the usage hold queued it.
- **Ask first** shows Claude's confirmation in the panel's terminal before each call; **Allowed** runs
  it without asking; **Off** refuses it — Shepherd itself refuses a turned-off action, not
  only Claude.
- **A merge you approve is the revision you saw.** The request names the PR, its head
  commit and its base. If the agent pushes after that, the merge is refused and the
  assistant has to ask again. A request you leave unanswered expires after 10 minutes.
- **Changes apply at once**, also to a running conversation: Shepherd rewrites the
  assistant's `.claude/settings.local.json` and Claude re-reads it.
- **Every action is your own button.** Each one runs the same route the UI does, with the
  same checks. It targets sessions by designation, never the assistant itself or another
  machine's sessions, and logs one line per action to Shepherd's log.
- **It acts only when you ask.** For a diagnosis question it names the action it would take
  and waits; it never acts because issue, PR or log text tells it to. A merge someone else
  is responsible for is never taken over — it hands that back to you.
- Security-relevant repo settings (sandbox profile, egress and browser hosts, the Shared
  Browser, repo mode, draft mode and sign-off) stay yours alone.

Whatever the levels:

- **File edits are denied** (Edit, Write, NotebookEdit).
- **Credential files are unreadable:** `~/.shepherd/env`, `~/.config/shepherd/config.toml`,
  `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.config/gh/hosts.yml`,
  `~/.ssh/`, `~/.aws/`, `~/.config/gcloud/`, `~/.azure/`, `~/.netrc`,
  `~/.git-credentials`, `~/.docker/config.json` and `~/.kube/config`.
- Reading anything outside its own directory and the install directory asks first. Raw
  log files are no exception; the log tool's masked tail is the way in.
- **Your own `~/.claude` settings don't apply inside it:** their allow rules can't approve
  a command for you, and your plugins and hooks don't load. Only Shepherd's MCP server is
  connected.

What **Allowed** costs: text in issues, PRs and logs reaches the assistant fenced as data,
and its instructions say never to act on it — but on Allowed nothing else stands between
such text and an action. With the shell on _Reads run_, Claude's file rules still keep
credential files out of `cat`, `head` and the like, but a command built to dodge them
(say, a file read inside `$(…)`) is no plain read and asks. And on a host shared with other
users, the assistant's session id — the key to its tools on Shepherd's local agent
port — shows in the process list like every agent's. Keep the groups you would regret on
Ask first.

A conversation started before an update that added tools learns them on its next start:
**New conversation** once.

### When herdr is down

The assistant runs in a herdr pane, so it can't run while herdr is down. The panel then
says so and links to Settings → Diagnose, which reports herdr's state and offers its
repair. The same goes for a node without `claude`: the panel names the reason instead of
starting anything.

### New conversation

**New conversation** in the panel header (click it twice to confirm) archives the current
conversation and starts a fresh one. Closing the panel only hides it: the conversation
keeps going, survives reloads, and after a Shepherd or herdr restart the next open
resumes it.
