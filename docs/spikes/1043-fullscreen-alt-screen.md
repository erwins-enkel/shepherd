# Spike #1043 — Can Shepherd read the fullscreen-renderer alt-screen frame?

**Phase-0 go/no-go.** Handoff from #1042 (which pinned the classic renderer for every
spawned agent via `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`). This spike asks the one
load-bearing question before any compat work is built on it:

> Does the read path Shepherd actually uses (`HerdrDriver.read` →
> `herdr agent read --format text --source visible`) capture the **alternate-screen-buffer**
> frame of a Claude Code agent running under the opt-in **fullscreen renderer** (v2.1.89+)?

## Decision: **GO** ✅

Fullscreen frames are captured cleanly and legibly through the production wrapper. The idle
prompt and the working spinner classify correctly **as-is**; the permission menu needs a
**single, verified regex re-tune** (`OPTION_RE`). No windowing change is required. The
follow-up implementation issue is filed as #1047 (see end).

The classic-renderer pin (#1042) stays the permanent default regardless — this spike only
proves that opting _into_ fullscreen (for its flat-memory upside on long autonomous drains)
is feasible.

## Environment

|                      |                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| herdr                | `0.7.0`                                                                                                                                                   |
| claude               | `2.1.186` (fullscreen renderer needs ≥ 2.1.89)                                                                                                            |
| Fullscreen lever     | `CLAUDE_CODE_NO_FLICKER=1` (verified — see Activation)                                                                                                    |
| Classic lever        | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (the #1042 pin)                                                                                                  |
| Production read path | `HerdrDriver.read`/`readAsync` (`src/herdr.ts:205`), argv `agent read <t> --format text --source visible --lines 200`, JSON-unwrapped `.result.read.text` |

All captures were taken **through the real `HerdrDriver`** (a tiny script instantiating the
exported class and calling `.read(terminalId)`), resolving the spawned agent's `terminalId`
from `herdr agent list` exactly as the poller passes `s.herdrAgentId`. `.ansi` fixtures are
a Layer-A diagnostic only (herdr's re-serialized cell grid; no literal `?1049h`).

## Protocol (as executed)

1. **Synthetic alt-screen pre-check** (claude-independent): spawned
   `sh -c 'printf "\033[?1049h\033[2J\033[H SYNTHETIC-ALT-MARKER-7f3 …"; sleep …'` in a herdr
   pane and read it back through the real wrapper.
2. **Spawn fullscreen claude** (`CLAUDE_CODE_NO_FLICKER=1`) in a throwaway scratch git repo;
   **verify** the renderer engaged via `/tui`.
3. **Capture** idle / permission-menu / working-spinner under **both** renderers (fullscreen
   and classic baseline): `.txt` (authoritative) plus `.ansi` (diagnostic).
4. **Analyse** every `.txt` with the real exported `tailLines` / `classifyBlocked` /
   `hasActiveSpinner` (`src/blocked.ts`); record per-line `OPTION_RE` hits + distance-from-
   bottom.

## Layer B settled: `--source visible` follows the alt buffer

**Synthetic pre-check → PASS.** The marker written to the alt buffer _after_ `?1049h` is
read back verbatim by `--source visible` through the real wrapper
(`test/fixtures/fullscreen/synthetic-altscreen.txt`):

```
 SYNTHETIC-ALT-MARKER-7f3 line2-on-alt-buffer
```

So herdr's `visible` source tracks the **active** buffer (the alt buffer when switched). The
rubric's structural NO-GO branch (marker absent → herdr-level capture change required) is
ruled out.

## Activation verified (not assumed)

`CLAUDE_CODE_NO_FLICKER=1` actually engaged fullscreen — `/tui` reported it
(`test/fixtures/fullscreen/tui-status.txt`):

```
❯ /tui
  ⎿  Current renderer: fullscreen. Usage: /tui
     <default|fullscreen>
```

Corroborated structurally: the fullscreen frame is a full-height bordered UI distinct from
the classic baseline, and the classic spawn independently reported `Current renderer:
default`.

## Per-state results (real `classifyBlocked` / `hasActiveSpinner`)

| Renderer   | State   | `classifyBlocked` shape | spinner  | Category    | Notes                                  |
| ---------- | ------- | ----------------------- | -------- | ----------- | -------------------------------------- |
| classic    | idle    | `awaiting-input`        | false    | CLEAN       | baseline                               |
| classic    | menu    | `menu` (3 options)      | false    | CLEAN       | `1./2./3.` all matched                 |
| classic    | spinner | `awaiting-input`        | **true** | CLEAN       | `✢ Skedaddling… (9s)`                  |
| fullscreen | idle    | `awaiting-input`        | false    | CLEAN       | legible prompt box                     |
| fullscreen | menu    | `awaiting-input` ⚠️     | false    | **RE-TUNE** | option 2 missed (see below)            |
| fullscreen | spinner | `awaiting-input`        | **true** | CLEAN       | `✽ Newspapering… (12s · ↓ 123 tokens)` |

**Distance-from-bottom** (load-bearing option lines vs the `tailLines=15` window): fullscreen
menu options sit at distance 4 / 3 / 1; classic at 6 / 5 / 2 — **all well inside the window**.
Windowing is _not_ implicated; `tailLines=15` is sufficient for both renderers.

## The one finding — fullscreen menu RE-TUNE (`OPTION_RE`)

Under fullscreen, `classifyBlocked` returned `awaiting-input` instead of `menu`. Cause,
confirmed at byte level (`cat -A`): the fullscreen renderer packs the **long** option 2
without a space after the delimiter, while options 1 and 3 (short labels) keep theirs:

```
fullscreen-menu.txt        classic-menu.txt
 ❯ 1. Yes                    ❯ 1. Yes
   2.Yes, allow all edits…     2. Yes, allow all edits…   ← classic keeps the space
   3. No                       3. No
```

`OPTION_RE = /^[\s│|]*[❯>*]?\s*(\d+)[.)]\s+(.*\S)\s*$/` requires **≥1** whitespace after the
`.`/`)` delimiter (`\s+`), so it matched options 1 & 3 but **missed `2.Yes`**. That breaks
`classifyBlocked`'s contiguous-run detection (it needs 1,2,3 in sequence), collapsing the
whole menu to `awaiting-input`.

The menu **text is fully present and legible** — this is a regex miss on a concrete recorded
delta, i.e. **RE-TUNE, not DEGRADED**. A minimal fix (tolerate a zero-space `N.Label`
variant) was verified against the fixtures: it recovers **all three** fullscreen options AND
leaves classic parsing identical.

```
fullscreen-menu.txt
  CURRENT  run: [{"label":"Yes","send":"1"}]                              ← menu lost
  RE-TUNED run: [{"label":"Yes",…},{"label":"Yes, allow all edits…",…},{"label":"No",…}]
classic-menu.txt
  CURRENT  run: [3 options]   RE-TUNED run: [3 options]                   ← unchanged
```

Caveat for the follow-up: the fullscreen pane was wider (54 cols) than the classic baseline
(27 cols), so the no-space packing could be width-influenced as well as renderer-influenced.
The follow-up must validate `OPTION_RE` against fullscreen menus at multiple widths, and the
relaxed pattern must avoid new false positives (e.g. `2.5 GB`) — the contiguous-run guard
helps but isn't sufficient alone.

## Fixture corpus (`test/fixtures/fullscreen/`)

| File                            | What                                                |
| ------------------------------- | --------------------------------------------------- |
| `synthetic-altscreen.txt`       | alt-buffer marker read-back (structural pre-check)  |
| `tui-status.txt`                | `/tui` report — fullscreen activation evidence      |
| `fullscreen-idle.{txt,ansi}`    | fullscreen idle prompt                              |
| `fullscreen-menu.{txt,ansi}`    | fullscreen Write permission menu (the RE-TUNE case) |
| `fullscreen-spinner.{txt,ansi}` | fullscreen working spinner                          |
| `classic-idle.{txt,ansi}`       | classic baseline idle                               |
| `classic-menu.{txt,ansi}`       | classic baseline permission menu                    |
| `classic-spinner.{txt,ansi}`    | classic baseline spinner                            |

`.txt` = authoritative (production wrapper output, what `classifyBlocked` consumes).
`.ansi` = Layer-A diagnostic (herdr's re-serialized grid + SGR styling).

## Follow-up (implementation) issue scope

Filed as **#1047**. Per the GO branch:

- **Re-tune `OPTION_RE`** to accept the fullscreen no-space `N.Label` packing; keep classic
  fixtures green (**dual-renderer** tests over this corpus). Guard against false positives.
- **`SPINNER_RE` / `tailLines`**: confirmed working as-is on this corpus (spinner detected,
  window sufficient) — add the fullscreen fixtures as regression coverage anyway.
- **Stall detection**: verify the `--source visible` diff still advances under flicker-free
  rendering (fullscreen repaints in place; ensure the buffer still reads as "changing" during
  a live turn so the frozen-TUI stall heuristic isn't tripped).
- **Web-terminal mouse**: decide between embracing xterm mouse forwarding vs
  `CLAUDE_CODE_DISABLE_MOUSE=1` (fullscreen captures the mouse).
- **Gate behind an opt-in per-spawn `tui` toggle.** Never flip the default — this is a
  "behavior may change" research preview; the #1042 classic pin remains the default.

## Out of scope (unchanged here)

No change to `classifyBlocked` / `OPTION_RE` / `SPINNER_RE` / `tailLines` in this spike, and
no change to the classic-renderer default. This PR carries only the findings doc + the raw
fixture corpus (+ fixture-hygiene config touches).
