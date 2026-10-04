---
name: smacos
description: Build the macOS app from the current checkout and launch it for a quick manual test — quits the running Shepherd (installed or dev) first so the dev build supervises the local server itself. Use when the operator says /smacos, "start the Mac dev version", "launch the dev app", or wants to try a native change on this Mac.
---

# smacos — run the Mac dev build

Run from the root of the checkout or worktree the session works in:

```sh
native/scripts/mac-dev.sh
```

It builds the Debug app first (a compile error keeps the running app untouched), then quits any
running `run.shepherd.mac` instance, then opens the fresh build. The build is incremental; expect
a minute or two on the first run, seconds afterwards.

Flags: `--build-only` (no quit, no launch), `--keep-running` (launch without quitting the running
app first). Run it with a timeout of at least 10 minutes; the first build resolves packages.

## Report back

- Success: say the build is running and from which checkout/branch.
- Build failure: show the `error:` lines the script printed and stop — do not retry blindly.
- "did not quit within 15 s": a dialog is blocking the old app; ask the operator to close it.
- "port 7330 is still served by …": the dev app will treat that server as externally managed;
  name the process and ask before stopping it — it may be the operator's own server or a herdr
  host for live agents.

## First launch of a new build

macOS may ask once for access to the Shepherd Keychain item. Only the operator may answer
("Immer erlauben" makes it stick for later dev builds); never click it via automation.
