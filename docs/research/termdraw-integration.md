# Research: Integrating termdraw into Shepherd

**Verdict: DO NOT INTEGRATE (as a code dependency).** termdraw is a Bun + OpenTUI (native-Zig) + React 19 **interactive** terminal drawing editor. Its runtime model — render to a real TTY through a native binary, driven by mouse — has no seam in Shepherd's architecture (headless Bun server + **browser** UI where xterm.js already owns terminal rendering). The only portable asset is termdraw's **output** (fenced-ASCII / `.td.json`), and consuming that needs zero Shepherd code today. Recommendation and the (narrow) conditions that would change it are at the end.

This is a read-only research task (per the research directive): the deliverable is this report. No product code changed.

## What termdraw is

[termdraw](https://github.com/benvinegar/termdraw) (Ben Vinegar, MIT, TypeScript, ~262★, last push 2026-05) is "an agent-friendly ASCII illustrator for the terminal" — an object-based drawing editor (retained boxes, lines, paint strokes, text) that runs **in** the terminal and exports **plain terminal text**, not SVG/bitmap. It ships as three npm packages:

| Package                      | Role                                      | Notable deps                                                |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `@termdraw/app` (v0.4.1)     | Standalone CLI — the `termdraw` binary    | `@opentui/core` 0.1.97, `@opentui/react` 0.1.97, `react` 19 |
| `@termdraw/opentui` (v0.4.1) | Embeddable OpenTUI components/renderables | peer: `@opentui/core`, `@opentui/react`, `react`            |
| `@termdraw/pi` (v0.4.1)      | Overlay extension for the Pi coding agent | `opentui-island` ^0.4.0, `@earendil-works/pi-*`             |

**Runtime requirements (from the app README):** Bun **1.3+** and "a terminal with mouse support." Exported library API surface (`@termdraw/opentui`): `TermDrawApp`, `TermDrawEditor`, `TermDraw`, their `*Renderable` variants, plus `formatSavedOutput`, `buildHelpText`, `parseDrawDocument`.

**Formats:** native editable `.td.json` (object model, git-diffable) ↔ export as plain text / fenced Markdown / stdout. `.td.json` round-trips; text exports are read-only.

### The load-bearing dependency: OpenTUI

termdraw is a thin app over **[OpenTUI](https://github.com/anomalyco/opentui)** (`@opentui/core`) — _"a TypeScript library on a native **Zig** core for building terminal user interfaces."_ This is the crux of the fit analysis: OpenTUI renders by driving a **real TTY** through a **native (Zig) binary**. It is not a data/format library; it is a renderer bound to a terminal device.

### The "hackery" library: opentui-island

The tweet announcing termdraw framed the interesting reusable piece as _"OpenTUI in Pi (Node) took some hackery … available as a library."_ That library is **[opentui-island](https://github.com/benvinegar/opentui-island)** (MIT) — _"Embed your OpenTUI components in Ink and pi-tui."_ It ships adapters `./ink` and `./pi-tui` and requires Bun ≥1.3.10. It exists to mount an OpenTUI render region **inside a host Node TUI** (Ink or pi-tui). Shepherd has neither host TUI, so this library has nothing to attach to.

### "Agent-friendly" — what it actually means

There is **no agent API**. termdraw's `AGENTS.md` is a contributor guide, not an integration surface, and the app is an **interactive, mouse-driven editor** — `--load` still "needs a controlling terminal for the interactive session." An autonomous/headless agent cannot drive it. "Agent-friendly" means only that its _outputs_ (plain-text ASCII and structured `.td.json`) are diffable and paste-able into prompts/tickets — a human, or an **attended** agent whose PTY a human is watching, does the drawing.

## Shepherd's terminal architecture (the target surfaces)

Shepherd bridges real agent PTYs into a browser viewer; it owns no TTY of its own:

```
herdr (external binary) ── owns the real claude/codex PTYs
        ▼  CLI + Unix-socket NDJSON
Shepherd server (Bun/TS; node-pty helper forced into a Node subprocess)
        ▼  WebSocket /pty/:id
Shepherd UI (SvelteKit browser) ── renders via xterm.js (Viewport.svelte)
```

Two conceivable seams for a terminal-drawing library, both blocked:

1. **Browser rendering** — `ui/src/lib/components/Viewport.svelte` already uses **xterm.js** (`@xterm/xterm` v6 + fit/web-links/**webgl** addons) with full ANSI/alt-screen emulation and buffer access (`ui/src/lib/terminalSelection.ts`). OpenTUI **cannot run in a browser at all** (native-Zig core, no DOM/TTY). So termdraw cannot render in Shepherd's UI; xterm.js already occupies this seam.
2. **Server-side frame interpretation** — `src/blocked.ts` classifies agent state by regex-scraping ANSI-stripped tails (the `OPTION_RE`/fullscreen-menu guard, `SPINNER_RE`). This wants a _terminal-grid model_, but termdraw/OpenTUI is a **producer** of terminal frames, not a parser/emulator — wrong tool. And any native/Node-only lib on the server inherits the existing node-pty pain (node-pty already can't load under Bun, forcing the `src/pty-attach.mjs` Node subprocess). OpenTUI's Zig core would be a heavier instance of that same constraint.

## Fit analysis

| Integration angle                                                                                            | Verdict                             | Why                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render termdraw / OpenTUI in Shepherd's **browser** UI                                                       | ✗ Impossible                        | OpenTUI is native-Zig→TTY; no browser target. xterm.js already owns this seam.                                                                                                                |
| Embed termdraw via **opentui-island** into a Shepherd TUI                                                    | ✗ N/A                               | Shepherd is web-first; has no Ink/pi-tui host TUI to embed into.                                                                                                                              |
| Run `@termdraw/opentui` components **server-side**                                                           | ✗ No target                         | Headless Bun server has no TTY to render to; would re-hit the node-pty/native-addon problem.                                                                                                  |
| **Autonomous** agents auto-generate diagrams with termdraw                                                   | ✗ Blocked                           | Interactive, mouse-driven, needs a controlling terminal — not headless-drivable.                                                                                                              |
| **Attended** agent / human runs `termdraw` in its own PTY, pastes fenced-ASCII into a Shepherd issue/plan/PR | ~ Works with **zero** Shepherd code | Output is monospace text; Shepherd already renders it. This is _using termdraw alongside Shepherd_, not integrating it.                                                                       |
| Render/edit `.td.json` **diagrams in Shepherd's browser**                                                    | ~ Possible but from-scratch         | Only the _file format_ is reusable; the renderer would be a new Svelte/canvas build (termdraw's renderer is unusable in a browser). High effort, speculative demand, no current user request. |

The pattern is consistent: every path that would reuse termdraw's **code** is blocked by the OpenTUI/native-TTY runtime; every path that survives reuses only its **format**, and those need no dependency.

## Recommendation

**Do not add a termdraw / OpenTUI / opentui-island dependency.** There is no runtime seam for it, and the reusable value (an ASCII-diagram _convention_) requires no integration:

- **If diagram-authoring is desired now:** treat termdraw as an **optional external tool** a developer (or an attended agent, human-supervised) runs in their own terminal to produce a fenced-ASCII block, then pastes into a Shepherd issue/plan/PR body. Shepherd already renders monospace/markdown — nothing to build. Do not vendor it.
- **Do not** attempt to render OpenTUI in the browser or host it server-side; xterm.js and the existing PTY bridge already cover Shepherd's needs and are the right tools.

### Conditions that would re-open this

Revisit only if **all** of a scenario materialize:

1. A concrete, requested need for **editable** (not static) diagrams stored on Shepherd artifacts (issues/plans/recaps) — beyond what a pasted ASCII block gives.
2. That need is strong enough to justify a **from-scratch browser renderer** for the `.td.json` object model (reusing termdraw's _format_, not its code). At that point termdraw's value is a well-designed, documented format to borrow — not a library to depend on.
3. Independently: Shepherd grows a **native Bun/Node TUI** front-end (it has none today). Only then would `opentui-island` / OpenTUI have a host to embed into.

Absent those, the assessment is closed: **interesting tool, no integration seam.**

## Sources

- termdraw — <https://github.com/benvinegar/termdraw> (README, `AGENTS.md`, package manifests)
- `@benvinegar/termdraw` / `@termdraw/app` — <https://www.npmjs.com/package/@benvinegar/termdraw>
- opentui-island — <https://github.com/benvinegar/opentui-island> (npm registry manifest)
- OpenTUI — <https://github.com/anomalyco/opentui> (`@opentui/core` npm description)
- Announcement thread — Ben Vinegar (@bentlegen), X, 2026 ("termDRAW! is an OpenTUI app (Bun) … hackery … available as a library")
- Shepherd terminal architecture — this repo: `ui/src/lib/components/Viewport.svelte`, `src/pty-bridge.ts`, `src/socket-pty-bridge.ts`, `src/pty-attach.mjs`, `src/herdr.ts`, `src/blocked.ts`
