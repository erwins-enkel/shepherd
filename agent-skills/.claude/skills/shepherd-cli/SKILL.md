---
name: shepherd-cli
description: How to drive the Shepherd server from inside a session with the `shepherd` CLI - start a fresh session or task (`shepherd new`), list and inspect sessions, read another agent's messages, steer it, wait for it, archive it. Load when the operator asks to start, spawn, kick off or hand off work to a new or fresh session or task, to check on, steer or wait for another session, or before guessing any `shepherd` command syntax.
---

# Driving Shepherd with the `shepherd` CLI

`shepherd` is on `PATH` and talks to the operator's Shepherd server with the operator's stored
profile, so no login or flags are needed for the local server. Output is JSON when stdout is not a
terminal, which is always the case for you.

If a command exits **3** (unauthenticated) or **7** (server unreachable), this session cannot reach
the server — it runs sandboxed. Tell the operator and stop. Never look for, read or copy tokens or
config files to work around it.

## Start a fresh session

```bash
shepherd new --repo "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" - <<'EOF'
<the task prompt, written so a fresh agent with no context can act on it>
EOF
```

- **Always pass `--repo` with the main checkout**, as above. The default is the current git
  toplevel, which in a Shepherd session is your worktree, not the repository.
- `-` reads the prompt from stdin; use it for anything longer than one line.
- The new agent shares none of your context: put the goal, relevant files, decisions and constraints
  into the prompt.
- Optional flags:
  - `--base <branch>`: base branch (default `main`).
  - `--after <task>`: hold it until that task's PR has landed (e.g. `--after TASK-07`).
  - `--plan-gate` / `--autopilot`: run the plan gate, or autopilot.
  - `--model <model>`, `--effort <level>`, `--provider <claude|codex>`: override server defaults.
  - `--force`: spawn now even if the usage hold would queue it. Only when the operator asks.
- The JSON result carries the new session's `desig` (e.g. `TASK-4530`); report it to the operator.
  `{"held": true, …}` (still exit 0) means the usage hold queued it instead of spawning.

## Inspect, steer, wait, archive

`<session>` is a designation (`TASK-07`, `task-7`, `7`) or a session id. Yours is
`$SHEPHERD_SESSION_ID`.

| Command                                                        | Does                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `shepherd sessions list [--all]`                               | Active sessions (`--all` adds archived ones)                      |
| `shepherd sessions show <session>`                             | One session: status, phase, PR, `pendingQuestion`                 |
| `shepherd messages <session> [-n N] [--include-user]`          | The agent's last messages and the question it waits on            |
| `shepherd steer <session> <text\|->`                           | Send text to that session's agent (`-` reads stdin)               |
| `shepherd wait <session> [--until <states>] [--timeout <dur>]` | Block until `needs-input`, `plan-ready`, `pr`, `done` or `halted` |
| `shepherd archive <session>`                                   | Stop the agent and archive the session                            |

`wait` can block for hours: always give it `--timeout` (e.g. `30m`) or run it in the background. It
exits with the state reached: 9 timeout, 10 needs-input, 11 plan-ready, 12 pr, 13 done, 14 halted.

Other exit codes: 0 ok, 1 failure, 2 usage, 4 insufficient token scope, 5 not found, 6 refused by
the server, 8 server error.

## Guardrails

- Never steer, interrupt or archive **your own** session.
- Fleet- or repo-wide commands (`halt`, `retry`, `merge`, `merge-pr`, `drain`, `train`, `settings`,
  `repo-config`) only when the operator explicitly asks for that exact action.

## Everything else

`shepherd --help` lists every command; `shepherd <command> --help` shows its flags. The full
reference is `docs/cli.md` in the Shepherd repository.
