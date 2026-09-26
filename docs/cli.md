# The `shepherd` CLI

`shepherd` is a command-line client for a Shepherd server, for operators and for external
agents. It reads the herd, streams server events, and steers sessions. Everything goes over the
same HTTP API and `/events` socket as the web UI. The client is generated from
[`contracts/openapi.rust.yaml`](../contracts/README.md#rust-derivation), so nothing about the
server is hand-typed. The CLI ships in lockstep with the server and warns on stderr when
`/api/health` reports a different version.

## Install

You don't need a Rust toolchain. `deploy/install.sh` installs a prebuilt `shepherd` binary into
`~/.local/bin`, and `deploy/update.sh` (`bun run update`) refreshes it on every deploy, so the CLI
stays at the server's version. When the installed binary is already at that version, nothing is
downloaded. Both scripts only warn, and carry on, when no binary is published for the version, for
example on a dev checkout or while the release is still building.

Prebuilt targets:

| Host                  | Target                      |
| --------------------- | --------------------------- |
| Linux x86_64          | `x86_64-unknown-linux-gnu`  |
| Linux aarch64         | `aarch64-unknown-linux-gnu` |
| macOS (Apple Silicon) | `aarch64-apple-darwin`      |

The Linux builds need glibc 2.35 or newer, for example Ubuntu 22.04 or Debian 12. Other hosts,
including musl distros such as Alpine and Intel Macs, build from source (below). If a downloaded
binary doesn't run on the host, the script leaves the existing one in place.

Each release `vX.Y.Z` has a companion release `cli-vX.Y.Z` that holds the binaries, each with a
`.sha256` file. They live in a separate release because Shepherd's releases are immutable once
published. To install or refresh by hand, run the same script the installer runs, from a checkout:

```bash
deploy/install-cli.sh            # the checkout's version, into ~/.local/bin
deploy/install-cli.sh 1.48.0     # a specific version
```

`SHEPHERD_CLI_DIR` changes the install directory. `SHEPHERD_NO_CLI=1` makes `install.sh` and
`update.sh` skip the CLI. If `~/.cargo/bin` comes before `~/.local/bin` on your `PATH`, a
`cargo install`ed `shepherd` shadows the managed one.

## Build

The crate lives in `cli/`. It needs a Rust toolchain (stable, 1.88 or newer):

```bash
cargo install --path cli     # installs `shepherd` into ~/.cargo/bin
```

## Connect and authenticate

By default the CLI talks to `http://127.0.0.1:7330`. To reach a remote server, for example the
Tailscale `ts.net` origin, pass `--url`, set `SHEPHERD_URL`, or store it in a profile.

Mint an access token in the web UI under **Settings → Access**, then store it:

```bash
shepherd login --token shp_…                                   # default profile, local server
shepherd --profile remote --url https://box.tail1234.ts.net login --token shp_…
```

`--token -` reads the token from stdin, which keeps it out of your shell history and the process
list. `login` picks its server the same way as every other command (see below) and first checks the
token against it, storing nothing if it is rejected. A URL given by `--url` or `SHEPHERD_URL` is
saved in the profile with the token, so the two stay paired. The CLI
can't mint tokens itself, because the server mints only for an interactive operator session.

The config file is `$XDG_CONFIG_HOME/shepherd/config.toml`, or `~/.config/shepherd/config.toml`
when that variable is unset. This path is the same on every OS. The file is written with mode
`0600` and its directory with `0700`, because it holds a bearer token.

```toml
default_profile = "default"

[profiles.default]
token = "shp_…"

[profiles.remote]
url = "https://box.tail1234.ts.net"
token = "shp_…"
```

**Where the URL comes from** (first match wins): `--url`, then `SHEPHERD_URL`, then the profile's
`url`, then `http://127.0.0.1:7330`.

**Where the token comes from:** `SHEPHERD_TOKEN`, then the profile's `token`. A profile's token is
sent only to that profile's own URL. If `--url` or `SHEPHERD_URL` points somewhere else, the CLI
withholds the stored token and says so on stderr. Set `SHEPHERD_TOKEN` to authenticate there.

`--profile <name>` picks a profile. Without it the CLI uses `default_profile`, and falls back to
`default` when that isn't set.

### Token scopes

A token's scope, set when it is minted, limits what the CLI can do:

| Scope    | Commands                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`   | `sessions list`, `sessions show` (active sessions), `status`, `holds`, `git`, `reviews`, `events tail`, `login`                                                                                                                  |
| `submit` | everything `read` can, plus `new`, `held list\|spawn\|discard` and `train launch`                                                                                                                                                |
| `full`   | everything else, including `steer`, `interrupt`, `archive`, `resume`, `merge`, `merge-pr`, `go`, `halt`, `retry`, `epics`, `drain`, `up-next`, `settings`, `repo-config`, `diagnose`, and `sessions show` of an archived session |

The server's `403` doesn't say which scope was missing. The CLI names it for you, for example:
``error: `shepherd steer` needs a 'full' token; this token's scope does not include it.``

## Output

- **Tables** when stdout is a terminal.
- **JSON** when stdout is not a terminal, or when you pass `--json`. Each command prints one
  JSON document.
- **NDJSON** from `events tail`, always.
- Errors and warnings go to **stderr** only, so stdout stays machine-readable.

The CLI never prompts. It reads stdin only when you pass `-` as the text argument of `new` or
`steer`.

## Exit codes

These codes are stable. New ones may be added, but existing ones never change meaning.

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | Success                                                         |
| 1    | Unexpected failure                                              |
| 2    | Usage error (bad flag or argument, bad URL, unknown profile)    |
| 3    | Unauthenticated (`401`, or no token configured)                 |
| 4    | Insufficient token scope (`403 insufficient_scope`)             |
| 5    | Not found (`404`)                                               |
| 6    | Refused by the server (`400`, other `403`, `409`, `415`, `422`) |
| 7    | Server unreachable (connection, DNS, TLS, timeout)              |
| 8    | Server error (`5xx`, or a response the CLI cannot decode)       |

## Commands

A `<session>` argument takes a session id or the designation the UI shows: `TASK-07`, `task-7`,
or a bare `7`. The CLI resolves designations against the active session list.

### Read

| Command                            | What it shows                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `shepherd sessions list`           | Active (non-archived) sessions                                                   |
| `shepherd sessions show <session>` | One session. Archived sessions aren't in the active list and need a `full` token |
| `shepherd status`                  | Server URL and version, CLI version, session counts by status, held sessions     |
| `shepherd holds`                   | Sessions parked by a hold, and why                                               |
| `shepherd git`                     | Each session's cached pull-request state                                         |
| `shepherd reviews`                 | Critic reviews running right now, with the provider, model and effort of each    |

### Events

```bash
shepherd events tail [--session <session>] [--event <prefix>]… [--no-snapshot]
```

`/events` doesn't replay past events. So the CLI opens the socket first, then prints one synthetic
line, and only then streams:

```json
{"event":"snapshot","data":{"sessions":[…],"holds":{…},"git":{…}}}
```

After that line, every frame is printed verbatim as it arrives, as `{"event": …, "data": …}`.
Frames that arrived while the snapshot was loading are printed right after it, so nothing falls
between the snapshot and the stream.

If the connection drops, the CLI reconnects with backoff (1 s up to 30 s) and prints a fresh
snapshot. `--event` keeps only frames whose name starts with the prefix, and you can repeat it.
`--session` keeps only frames about one session and narrows the snapshot to that session.
Ctrl-C exits `0`.

### Session control

| Command                                | Route                              | Scope    |
| -------------------------------------- | ---------------------------------- | -------- |
| `shepherd new [flags] <prompt\|->`     | `POST /api/sessions`               | `submit` |
| `shepherd steer <session> <text\|->`   | `POST /api/sessions/:id/reply`     | `full`   |
| `shepherd interrupt <session>`         | `POST /api/sessions/:id/interrupt` | `full`   |
| `shepherd archive <session>`           | `DELETE /api/sessions/:id`         | `full`   |
| `shepherd resume <session> [--force]`  | `POST /api/sessions/:id/resume`    | `full`   |
| `shepherd go <session>`                | `POST /api/sessions/:id/go`        | `full`   |
| `shepherd halt --yes`                  | `POST /api/halt`                   | `full`   |
| `shepherd retry [<session>…] [--text]` | `POST /api/retry`                  | `full`   |

`go` releases an approved plan gate and starts execution. The server refuses (exit `6`) when the
session isn't in the planning phase or its plan isn't approved.

`halt` interrupts every live working agent at once, the fleet-wide emergency stop. It needs
`--yes`; without it the CLI exits `2` and sends nothing.

`retry` resumes halted sessions and steers each to continue. Without sessions it takes every
session the usage limit halted, and prints `nothing to retry` when there is none. `--text` replaces
the default steer, the one the UI's Retry dialog sends.

Flags for `new`:

- `--repo <path>`: the repository path on the server. Defaults to the current directory's git
  toplevel, which is only right when the CLI runs on the server's host.
- `--base <branch>`: the base branch. Defaults to `main`.
- `--model`, `--effort <low|medium|high|xhigh|max|ultra>`, `--provider <claude|codex>`: override
  the server's defaults.
- `--plan-gate`, `--autopilot`: turn on the plan gate or autopilot for this session.
- `--force`: spawn now even if the usage hold would queue the task.

When the usage hold trips, `new` still exits `0`. It prints the held task (`{"held": true, …}`)
instead of a session.

```bash
shepherd new --repo ~/Work/my-repo "Add OAuth login to the settings page"
echo "please rebase onto main" | shepherd steer TASK-07 -
shepherd --json sessions list | jq -r '.[] | select(.status == "done") | .desig'
```

### Work intake

A `--repo <path>` flag defaults to the current directory's git toplevel, as it does for `new`.

| Command                                  | Route                                             | Scope    |
| ---------------------------------------- | ------------------------------------------------- | -------- |
| `shepherd backlog`                       | `GET /api/backlog`                                | `full`   |
| `shepherd issues [--repo]`               | `GET /api/issues?repo=`                           | `full`   |
| `shepherd drain status`                  | `GET /api/drain`                                  | `full`   |
| `shepherd drain queue [--repo]`          | `GET /api/drain/queue?repo=`                      | `full`   |
| `shepherd drain start\|stop [--repo]`    | `PUT /api/repo-config?repo=` (`autoDrainEnabled`) | `full`   |
| `shepherd up-next list`                  | `POST /api/up-next/refresh`, then `/events`       | `full`   |
| `shepherd up-next start <item>… [flags]` | same, then `POST /api/up-next/start`              | `full`   |
| `shepherd held list`                     | `GET /api/held`                                   | `submit` |
| `shepherd held spawn <id> [--provider]`  | `POST /api/held/:id/spawn`                        | `submit` |
| `shepherd held discard <id>`             | `DELETE /api/held/:id`                            | `submit` |

`backlog` hides repos hidden in the UI from its table. Its JSON carries every repo with a `hidden`
flag. `drain start` and `drain stop` flip the repo's auto-drain setting, the same one the UI
toggles.

The server has no read route for Up Next. So `up-next` opens `/events`, asks the server to
recompute the queue, and prints the first `upnext:snapshot` frame. The recompute lists every repo
on its forge, so it can take a while; the CLI waits up to 90 s and then exits `1`.

`up-next start` takes items as `<repo>#<number>`, where `<repo>` is the slug (`owner/repo`), the
repo name or its label. A bare `<number>` works when only one queued item has it. An unknown or
ambiguous item exits `2` and names the candidates. `--provider <claude|codex>`, `--model` and
`--effort` override the defaults; `--model` and `--effort` need `--provider`. A start that fails
for every item exits `8` and names each failure.

### Reviews and merge

| Command                                                                       | Route                                             | Scope    |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| `shepherd review-pr <session>`                                                | `POST /api/sessions/:id/review-pr`                | `full`   |
| `shepherd review-plan <session>`                                              | `POST /api/sessions/:id/review-plan`              | `full`   |
| `shepherd merge <session> [--method] [--keep-branch] [--takeover]`            | `POST /api/sessions/:id/git/merge`                | `full`   |
| `shepherd train status`                                                       | `GET /api/automerge`                              | `full`   |
| `shepherd train start\|stop [--repo]`                                         | `PUT /api/repo-config?repo=` (`autoMergeEnabled`) | `full`   |
| `shepherd train set <session> on\|off\|default`                               | `PUT /api/sessions/:id/automerge`                 | `full`   |
| `shepherd merge-pr <number> [--repo] [--method] [--keep-branch] [--takeover]` | `POST /api/prs/merge`                             | `full`   |
| `shepherd train launch [<number>…] [--repo] [--base]`                         | `POST /api/sessions`                              | `submit` |

`review-pr` and `review-plan` start the critic or the plan review now and print what the server
did, for example `started` or `running`.

`merge --method <merge|squash|rebase>` picks the merge method; the forge default applies without
it. `--keep-branch` keeps the head branch. When someone else is responsible for the pull request,
the server refuses the merge and the CLI exits `6` and suggests `--takeover`. `--takeover` confirms
the takeover with the PR state the server has cached (head commit, target branch and who is
responsible), and the server refuses again if any of it changed.

`merge-pr` merges a repo's pull request by number, with or without a session, like **Merge** in
the backlog's PR panel. `--method` and `--keep-branch` work as for `merge`. `--takeover` has no
cached state to echo, so it sends the merge unconfirmed first. When the server refuses because
someone else is responsible, the CLI echoes the PR state from that refusal and retries once; the
server rechecks every field, and a second refusal is final.

`train` is the full-auto merge train. `train start` and `train stop` flip the repo's setting.
Like the UI toggle, `train start` also turns off the repo's draft mode, because the two can't both
be on. `train set` overrides the train for one session, and `default` goes back to the repo setting.

`train launch` spawns a merge-train agent session, like **Merge train** in the Herd or the PR
panel: it reviews the PRs, proposes a merge order and waits for your approval before merging.
Without numbers it takes every PR flagged ready to merge whose review isn't running. `--repo`
narrows them to one repo; without it the CLI picks the repo with the most ready PRs and warns on
stderr about the ones it left out. No ready PR exits `6`. With numbers it runs over exactly those
PRs in `--repo` (default: the current directory's git toplevel). The session skips the plan gate
and autopilot and bypasses the usage hold. `--base` defaults to `main`.

```bash
shepherd up-next list
shepherd up-next start owner/repo#42 --provider claude
shepherd merge TASK-07 --method squash
shepherd merge-pr 1234 --repo ~/Work/my-repo
shepherd train launch --repo ~/Work/my-repo
```

### Epics

`<parent>` is the epic's parent issue number. `--repo` defaults to the current directory's git
toplevel.

| Command                                                                    | Route                                       | Scope  |
| -------------------------------------------------------------------------- | ------------------------------------------- | ------ |
| `shepherd epics list [--repo]`                                             | `GET /api/epics?repo=`                      | `full` |
| `shepherd epics show <parent> [--repo]`                                    | `GET /api/epic?repo=&parent=`               | `full` |
| `shepherd epics start <parent> [--mode] [--provider] [--model] [--effort]` | `PUT /api/epic?repo=&parent=`               | `full` |
| `shepherd epics pause\|stop <parent> [--repo]`                             | `PUT /api/epic?repo=&parent=`               | `full` |
| `shepherd epics approve-next <parent> [--repo]`                            | `POST /api/epic/approve-next?repo=&parent=` | `full` |

`epics show` prints the epic's run settings, its warnings and one row per child with its state,
blockers, PR and session. `start` sets the run to running and, when given, its mode
(`auto|attended`), coding agent, model and effort; `pause` and `stop` set it to paused or idle,
like the epic panel's buttons. `approve-next` approves the next child spawn of an attended epic.
A server without the drain answers `503`, so these exit `8`.

### Settings and diagnostics

| Command                                           | Route                        | Scope  |
| ------------------------------------------------- | ---------------------------- | ------ |
| `shepherd settings`                               | `GET /api/settings`          | `full` |
| `shepherd settings set <key> <value\|->`          | `PATCH /api/settings`        | `full` |
| `shepherd repo-config [--repo]`                   | `GET /api/repo-config?repo=` | `full` |
| `shepherd repo-config set <key> <value> [--repo]` | `PUT /api/repo-config?repo=` | `full` |
| `shepherd diagnose [--refresh]`                   | `GET /api/diagnostics`       | `full` |
| `shepherd diagnose fix <check>`                   | `POST /api/diagnostics/fix`  | `full` |

`settings` and `repo-config` print one row per key. Use the key names they print with `set`.
`set` changes one key per call. The value is read as a JSON literal first (`true`, `80`,
`["a.com"]`) and as plain text when it isn't one, so `shepherd settings set defaultModel opus`
needs no quotes. The CLI checks the key and the value's type before sending anything; an unknown
key or a value of the wrong type exits `2`. The validated value is sent as written, so `null` and
`[]` reach the server, which reads them as "clear": `repo-config set egressExtraHosts '[]'`
removes every extra egress host.

`anthropicApiKey` is only read from stdin, so the key stays out of your shell history and the
process list. A value on the command line exits `2`, and so does empty stdin, because the server
would read a blank key as "clear". `shepherd settings set anthropicApiKey null` clears it. The line
the CLI prints comes from the server's `hasApiKey`, not from what was sent:

```bash
shepherd settings set anthropicApiKey - < ~/.secrets/anthropic-key
```

`diagnose` prints each environment check with its state, its hint key and, when the check has
one, the fix the server can run. It exits `0` whatever the checks say; read `overall` in the JSON
to branch on it. `--refresh` probes again instead of answering from the cached snapshot.
`diagnose fix <check>` runs that check's fix on the server host, then prints the check as it
stands after a fresh probe. An unknown check, or one without a fix, exits `6`; a fix that fails on
the server exits `8`.

```bash
shepherd settings set usageHoldPct 80
shepherd repo-config set maxAuto 3 --repo ~/Work/my-repo
shepherd --json diagnose | jq -r '.checks[] | select(.state != "ok") | .id'
```
