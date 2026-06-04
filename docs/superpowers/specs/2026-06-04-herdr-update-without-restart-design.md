# herdr update without a shepherd restart (Design A)

**Date:** 2026-06-04
**Status:** Approved — ready for implementation plan

## Problem

Running a herdr update through shepherd leaves the UI stuck at 502. Prior "shell
command magic" (#241 stop-server-first, #274 unconditional restart) treated
symptoms and did not fix the root cause.

### Root cause (investigation findings)

1. **Shepherd holds no persistent herdr session.** `HerdrDriver` is stateless —
   every method shells out fresh via `execFileSync(herdrBin, …)` (`src/herdr.ts:28`).
   Live terminals are per-WebSocket subprocesses (`src/pty-bridge.ts`), not core
   state. `ensureWorkspace()` (`src/herdr.ts:79`) already exists to handle a daemon
   "restarted after an update." So the restart's stated reason ("re-establish its
   herdr session", `src/herdr-update.ts:183`) is false — the 1s poller reconnects on
   its own.

2. **The restart is the sole cause of the 502.** `systemctl --user restart shepherd`
   is the only step that takes the HTTP listener (`:7330`, fronted by Tailscale
   serve) down. Remove it → no 502 window.

3. **The #274 band-aid rests on a false premise.** It assumed `herdr update` signals
   failure via exit code. The durable audit log (`~/.shepherd/herdr-update.log`)
   shows `herdr update` printing "Herdr was not updated" yet exiting `rc=0` — so the
   restart fires (502) while the update silently did nothing.

4. **Shepherd resurrects the herdr server mid-update.** `herdr server stop` does not
   stick because shepherd stays alive and polls `herdr agent list` every 1s
   (`src/poller.ts:21`, `tick()` at `:34`); any herdr CLI call auto-spawns the
   daemon. So `herdr update` finds the old server still running ("session default is
   still running") and refuses to swap the binary. The runner has **no timeout**
   (`src/herdr.ts:28`) and `tick()` calls it synchronously on Bun's single JS thread,
   so a herdr CLI that blocks while herdr is half-down freezes the event loop → the
   *persistent* 502.

**Conclusion:** the restart is unnecessary (shepherd auto-reconnects) and harmful
(it is the 502 source). The fix is to make shepherd stop touching herdr for the
stop→update window and drop the self-restart.

## Design A — pause, don't restart

With the self-restart gone, the entire reason the update ran in a detached
`systemd-run` unit ("survive the shepherd restart it triggers") disappears. The
update becomes a **managed child** of shepherd: spawned, streamed, awaited, and
verified in-process. This deletes the transient unit, the journalctl follow, and
the unconditional restart.

### Components

#### 1. Maintenance gate — `src/maintenance.ts` (new)

A tiny singleton, the single source of truth for "herdr is mid-update, don't touch
it":

```
class HerdrMaintenance extends EventEmitter {
  active: boolean        // default false
  begin(): void          // set true, emit "change"
  end(): void            // set false, emit "change"
}
export const maintenance = new HerdrMaintenance()
```

Exported as a shared module-level singleton so loops, the driver, and the server
all read one flag. EventEmitter so the UI/SSE can surface a banner.

#### 2. Pause the herdr-touching loops (primary mechanism)

Each periodic tick that shells out to herdr gets a one-line guard at the top:

```
tick() { if (maintenance.active) return; … }
```

Affected loops: `StatusPoller` (`src/poller.ts`), `distiller`, `drain`, `review`,
usage `calibrate`/`HerdrUsageProbe`, `backlogPoller`, `sweepOrphanTabs`
(tab-reaper). This is what actually stops the 1s poller from resurrecting the herdr
server mid-update.

**Why pause loops rather than no-op the driver:** if `list()` returned `[]` during
maintenance, the poller would see every agent "gone" and wrongly reap all live
sessions (`reapGone`). Pausing the tick avoids that state corruption. Skipping a few
ticks during the ~15s update is harmless — the agents are about to die anyway.

#### 3. Harden the `HerdrDriver` runner — `src/herdr.ts` (defense-in-depth)

- **Always-on timeout** (~10s) on the `execFileSync` runner. A stuck herdr CLI can
  never again block Bun's single thread → removes the event-loop-freeze that caused
  the persistent 502. Applies in all states, not just maintenance.
- **During maintenance, the runner throws immediately** (a fail-fast
  `HerdrUnavailableError`, no spawn). Safety net catching any loop we forgot to
  pause; a hard guarantee nothing resurrects the server.

Both layers are belt-and-suspenders: (2) is the real mechanism, (3) is the net.

#### 4. Rewrite `HerdrUpdateService.apply()` — `src/herdr-update.ts`

```
apply():
  if applying: return { started: false }
  applying = true
  maintenance.begin()
  spawn child: bash -lc "herdr server stop || true; herdr update"
  stream child stdout/stderr -> onLog(line) (modal) + append to herdrUpdateLogPath
  on exit OR ~5min watchdog (kill + treat as failure):
    success = (versionRunner() parsed === last.latest)   // NOT rc — rc=0 lies
    emit status: { ok: success, current: <reparsed>, … }
    maintenance.end()        // in finally — always clears
    applying = false
  return { started: true }
```

- Child output is captured by shepherd live and streamed to the modal. The durable
  audit log `~/.shepherd/herdr-update.log` is kept and **written by the script itself**
  via `tee -a` (a delimited, timestamped, versioned block) — this survives even a
  shepherd crash, so it stays the durable post-mortem rather than something shepherd
  has to write.
- **Success is keyed off a re-read `herdr --version` matching the target**, not the
  exit code.
- `maintenance.end()` runs in `finally` so a throw or watchdog timeout can never
  strand shepherd in maintenance forever.
- **No `systemctl restart shepherd`. No `systemd-run`. No journalctl.** When
  maintenance ends, the resumed poller's next tick spawns the fresh-version daemon
  and `ensureWorkspace()` recreates the workspace.

Deleted from this file: `defaultLaunch()` (systemd-run) and `defaultFollow()`
(journalctl). `buildUpdateScript()` is **kept and shrunk** to `herdr server stop ||
true; herdr update` wrapped in the delimited, `tee -a`'d audit-log block with its
three `>>> herdr-update:` step markers (only the `systemctl restart shepherd` line
and its markers are dropped). It stays exported and unit-tested so the command
sequence is verifiable without a live herdr release. The final verified ✓/✗ result
is determined by shepherd (re-read version), separate from the script.

**End-state parity:** live agents still end (inherent to `herdr update` —
destructive by design). The resumed poller reconciles those sessions as ended —
the same end-state as today's post-restart `reconcile()`, minus the outage. On a
failed update ("Herdr was not updated"), maintenance ends, the poller resumes on
the old version, the modal shows "still on Y", and the operator can retry — still
no 502.

#### 5. UI — `ui/src/lib/components/HerdrUpdateModal.svelte`

- A final terminal state: ✓ "updated to X" / ✗ "not updated — still on Y".
- A small note, driven by the maintenance flag, that agent activity is paused while
  herdr updates and live panes will end.
- New message keys added to **both** `ui/messages/en.json` and
  `ui/messages/de.json` (catalog parity gate). Reuse existing keys where one fits.

### Components removed

- The detached `systemd-run --unit=herdr-update` transient unit.
- The `journalctl --user -u herdr-update -f` follow tailer (`defaultFollow`).
- The unconditional `systemctl --user restart shepherd`.

### Testing

DI is already in place (`versionRunner`, `fetchLatest`, `launch`, `onLog`). Cover:

- `apply()` sets `maintenance.active` around the launch and **always clears it in
  `finally`** — including when the child throws and when the watchdog fires.
- Success is determined by the re-read version matching `last.latest`, not by rc
  (regression test for the rc=0-on-no-op lie).
- Failure path: version unchanged → status reports not-updated, maintenance cleared.
- Runner: throws fast (no spawn) while maintenance is active; passes a `timeout` to
  `execFileSync`.
- `poller.tick()` early-returns when maintenance is active — no `list()` call, no
  `reapGone`.

## Sub-decisions (defaulted, approved)

- **Keep** the audit log `~/.shepherd/herdr-update.log`, written by shepherd from the
  captured child output.
- **Watchdog = 5 min** before force-killing a hung `herdr update`.

## Out of scope

- Proactively closing PTY bridges: when the herdr server stops, the `pty-attach.mjs`
  children exit and the WS closes on its own (`src/pty-bridge.ts:30`); browsers
  reconnect automatically.
- Any change to the git self-update / `deploy/update.sh` flow — that one *does* ship
  new shepherd code and legitimately restarts; it is unrelated to herdr updates.
