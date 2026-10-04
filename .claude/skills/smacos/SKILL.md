---
name: smacos
description: Build the macOS app from the current checkout and launch it for a quick manual test — quits the running Shepherd (installed or dev) first so the dev build supervises the local server itself, after checking that no live sessions would be interrupted or lost. Use when the operator says /smacos, "start the Mac dev version", "launch the dev app", or wants to try a native change on this Mac.
---

# smacos — run the Mac dev build

Shepherd is developed with Shepherd: the running app may supervise the local server that hosts
the very agents working on this repo. Never trade their sessions for a quick test without the
operator's say-so.

Run from the root of the checkout or worktree the session works in (timeout ≥ 10 minutes; the
first build resolves packages):

```sh
native/scripts/mac-dev.sh
```

It builds the Debug app first (a compile error keeps the running app untouched), then runs
`native/scripts/mac-dev-preflight.py`, then — only if that allows it — quits any running
`run.shepherd.mac` instance and opens the fresh build. Quitting stops the local server the app
supervises; agents live in herdr and survive as long as herdr is independent of the app/server.

## Exit codes and what to do

- **0** — launched. Say which checkout/branch is running. If the script printed that the local
  server is stopped, tell the operator to press **Start** in the dev app's "Run on this Mac"
  panel so the sessions re-attach.
- **2** — live sessions would be **interrupted** (agents keep running in herdr, but the server is
  down until Start; agents cannot report meanwhile and in-flight critic reviews end). Show the
  printed session list and ask the operator. Rerun with `--yes` only after an explicit yes.
- **3** — live sessions would be **lost** (herdr would die with the app/server, or does not
  answer; the next server boot marks the sessions done). Show the report, say plainly that the
  sessions would end, and recommend not restarting now. Use `--force` only if the operator
  explicitly accepts losing them.
- **1** — build failure or preflight error: show the `error:` lines / message and stop; do not
  retry blindly. "did not quit within 15 s" means a dialog blocks the old app; ask the operator
  to close it.

Never add `--yes`/`--force` on your own initiative, and never because the request came from a
loop, a notification or another session.

Other flags: `--build-only` (no quit, no launch — always safe), `--keep-running` (launch without
quitting the running app first). If the script notes that port 7330 is still served by another
process, name it and ask before stopping it — it may be the operator's own server.

## First launch of a new build

macOS may ask once for access to the Shepherd Keychain item. Only the operator may answer
("Immer erlauben" makes it stick for later dev builds); never click it via automation.
