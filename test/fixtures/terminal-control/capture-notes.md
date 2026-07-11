# herdr `terminal session control` — captured wire contract (Phase 0)

Captured live against **herdr 0.7.3** (protocol 16) on 2026-07-11 by round-tripping a
throwaway scratch pane. These bytes are the pinned contract — `src/socket-pty-bridge.ts`
parsers and `test/socket-pty-bridge.test.ts` derive from the fixtures here, NOT from docs.
Re-run `bun scripts/verify-herdr-terminal.ts` against a live herdr after any herdr upgrade
to confirm the framing still holds.

## argv (confirmed via `--help` and live run)

```
herdr terminal session control <target> [--takeover] [--cols N] [--rows N]
herdr terminal session observe <target> [--cols N] [--rows N]
```

- `--cols`/`--rows` set the initial paint size (confirmed: seq 1 arrives at the given size).

## Target format (reviewer pt 3 — confirmed on the SAME binary)

`api snapshot` reports each pane's `pane_id` as the FULL `<workspace>:<pane>` string
(e.g. `w6526465cd86e32:pJTD`), with `workspace_id` as a separate field. `HerdrAgent.paneId`
(= `a.pane_id`) is therefore already a valid target. Compose defensively:
`paneId.includes(":") ? paneId : ${workspaceId}:${paneId}`.

## stdout NDJSON (see control-roundtrip.ndjson)

- `terminal.frame` — fields: `type`, `bytes` (base64 ANSI), `encoding` ("ansi"), `full` (bool),
  `width`, `height`, `seq` (monotonic from 1). `full:true` = full redraw, `full:false` = delta.
  Forward decoded `bytes` to the ws verbatim in arrival order (a single stdout pipe is ordered;
  no `seq` reordering needed).
- `terminal.closed` — fields: `type`, `reason`.

Round-trip proof (control-roundtrip.ndjson): seq 1 full 80×24; we sent `terminal.input`
(echoed command + output visible in seq 2 delta); we sent `terminal.resize` 100×30 → seq 4
full redraw at 100×30; we sent `terminal.release` → `terminal.closed{reason:"detached"}`, exit 0.

## stdin NDJSON commands (what the bridge WRITES; confirmed to take effect)

```
{"type":"terminal.input","text":"<utf8 keystrokes>"}
{"type":"terminal.resize","cols":<n>,"rows":<n>}
{"type":"terminal.release"}
```

## Failure modes (drive the fallback logic)

- **Bad / gone target** (bad-target.ndjson): exit **0**, no frames, one line
  `terminal.closed{reason contains "not found"}`. This is the AGENT-GONE signal → map to
  `PTY_GONE` (4001), exactly like node-pty's `agent_not_found`. NOT a node-pty fallback.
- **Clean release**: `terminal.closed{reason:"detached"}`, exit 0.
- **Version skew** (subcommand absent/renamed on a future herdr): the herdr CLI prints a usage
  error to stderr and exits non-zero with NO NDJSON on stdout. Discriminator is therefore
  "did we get well-formed NDJSON (a `terminal.frame` or a `terminal.closed`)?" — if the process
  produces none and exits, fall back to node-pty. (Not reproducible on 0.7.3, where the
  subcommand exists.)

## First-frame latency (drives the adaptive watchdog SEED)

5 observe attaches on dev: 18, 34, 44, 17, 19 ms; control first-frame: 27 ms. Worst ~44 ms.
Seed is set generously above this; the runtime watchdog is adaptive (max(seed, margin ×
running-max)) so a slower prod host self-widens, and the `terminalTransport` counters make a
uniformly-slow-host silent fallback observable regardless.
