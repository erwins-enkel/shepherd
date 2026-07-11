# herdr app-binding scroll — captured lever matrix (issue #1639, Phase B spike)

Captured live against **herdr 0.7.3** on 2026-07-11 by driving throwaway `claude` + `codex` agents
over `terminal session control` and observing the rendered pane. This is the evidence behind keeping
`SHEPHERD_HERDR_SOCKET_TERMINAL` **default-off** (see `src/config.ts`). Re-run after a herdr/agent
upgrade to see whether the picture changed:

```
bun scripts/verify-herdr-terminal.ts --scroll
```

## Why this spike exists

The socket `terminal session control` stream is a screen-diff/redraw protocol with **no scrollback**
(see `capture-notes.md`). So in socket mode the terminal emulator has nothing to scroll — scrolling
can only happen if the **app itself** repaints a scrolled view in response to a keyboard lever
delivered over `terminal.input`. Issue #1639 proposed translating mobile swipe/wheel gestures into
`PageUp`/`PageDown` and flipping the terminal onto the socket stream, **gated on** proving the actual
target apps (Claude Code and Codex) honor such a lever. This is that proof.

## Method

- `herdr agent start __verify_scroll_<provider>__ --cwd /tmp --no-focus -- <provider…>` — a throwaway
  agent, NOT a Shepherd-managed session (`--takeover` on a live session fights Shepherd's own attach).
- Fill the transcript: submit "output the integers 1 through 150, one per line" so 130+ lines sit
  off-screen above a 80×24 viewport.
- Drive levers over a persistent `terminal session control <term> --takeover --cols 80 --rows 24`
  stream via `{"type":"terminal.input","text":"<seq>"}`.
- Observe with `herdr agent read <term> --source visible` (the app's actual rendered pane). The
  discriminator is **standalone numeric lines only** (`/^\s*\d{1,3}\s*$/`) — agent chrome (context %,
  model name, token counts) carries stray numbers that must not be counted. A lever "scrolled" iff a
  **smaller** line number became visible than the bottom baseline showed.
- **Codex config**: start it with `-c model_reasoning_effort="medium" -c model_verbosity="medium"`.
  Its local default tripped a provider 400 (`text.verbosity='low'` unsupported for `gpt-5.2-codex`),
  which produced no transcript at all — a false "nothing to scroll", not a scroll result.

## Result (reproduced, stable across runs)

| agent  | PageUp `\x1b[5~` | Shift+PageUp `\x1b[5;2~` | Ctrl+Home `\x1b[1;5H` | MouseWheelUp (SGR) |
| ------ | ---------------- | ------------------------ | --------------------- | ------------------ |
| claude | **scroll**       | —                        | —                     | **scroll**         |
| codex  | —                | —                        | —                     | —                  |

- **Claude Code** honors `PageUp` (~7 lines/key; bottom 135–150 → 112–128) and SGR mouse-wheel-up, and
  renders its own "Jump to bottom (ctrl+End) ↓" affordance; `Ctrl+End` (`\x1b[1;5F`) jumps to bottom.
- **Codex** honors **none** of the levers over `terminal.input` — the view stays pinned at the bottom
  and its 130+ off-screen lines are unreachable. The manual spike additionally checked Ctrl+End,
  Ctrl+Up, Up, Ctrl+B, Ctrl+U, Home — also no movement (9 levers total, all inert).

### Caveats on the secondary cells

`Ctrl+Home` reads `—` here because the probe restores to the bottom before each lever, and Claude
appears to honor `Ctrl+Home` only from an **already-scrolled** state (in a manual battery, run after a
prior PageUp, it jumped to line 1). `MouseWheelUp` is real but moot for the product: the socket frame
stream strips mouse modes, so a client can't ride it anyway. These secondary levers are timing- and
state-sensitive between runs, so the diagnostic **prints them for information but asserts only the two
load-bearing facts** (Claude honors PageUp; Codex honors no lever).

## Conclusion — do not flip the gate

Only `PageUp` is a usable, mode-independent lever, and only Claude honors it. Because **Codex honors
nothing**, flipping `SHEPHERD_HERDR_SOCKET_TERMINAL` on would leave Codex sessions unable to scroll
their transcript in socket mode — a regression versus today's node-pty terminal, which scrolls
natively for both providers. And node-pty removal (#1622) cannot complete while Codex needs node-pty.
So herdr's frame-stream transport is **not yet good enough** to replace the node-pty terminal:

- `SHEPHERD_HERDR_SOCKET_TERMINAL` stays default-off (Phase A gate unchanged).
- Follow-up **#1642** tracks a scrollback-preserving / raw-passthrough (PTY-forwarding) herdr terminal
  transport — the prerequisite for revisiting the flip and for #1622.
