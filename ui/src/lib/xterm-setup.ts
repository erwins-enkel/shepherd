import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { theme, xtermTheme, xtermMinContrast } from "./theme.svelte";
import { oscLinkHandler, openTerminalLink } from "./terminalLinks";

/**
 * An agent terminal, opened into `el` and fitted to it: the one xterm setup shared by a local
 * session's Viewport and the terminal of a session on a connected machine (#2764). The caller
 * owns everything after this — the PTY connection, its key handling and `term.dispose()`.
 */
export function openXterm(
  el: HTMLElement,
  opts: { fontSize: number; theme: "light" | "dark"; screenReaderMode?: boolean },
): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: opts.fontSize,
    theme: xtermTheme(opts.theme),
    minimumContrastRatio: xtermMinContrast(opts.theme),
    cursorBlink: true,
    // Mirror terminal output into xterm's hidden ARIA live region so screen
    // readers can follow the live agent session (the .term-mount region label
    // alone names the area but exposes none of its scrolling content). A caller may start it
    // off: the mirror re-lays-out on every write, so Viewport keeps it only while attended.
    screenReaderMode: opts.screenReaderMode ?? true,
    // Claude Code runs as a TUI with mouse tracking on, which hands mouse drags
    // to the app instead of selecting text. xterm lets a modifier force local
    // selection anyway — Shift on Linux/Windows, Option (⌥) on macOS — but the
    // macOS path only works when this option is enabled (default off). Without
    // it, Mac users can't select terminal text at all while an agent is running.
    macOptionClickForcesSelection: true,
    // OSC 8 hyperlinks (Claude Code's `PR #…` badge) open on a plain tap/click like the
    // linkified URLs below, instead of xterm's default confirm() warning.
    linkHandler: oscLinkHandler,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  // Linkify URLs in the terminal so they're tappable — on a phone a plain-text
  // URL can't be opened at all (no text-selection affordance inside xterm's
  // canvas), and even on desktop a click beats copy-paste. Plain tap/click
  // opens in a new tab; noopener so the opened page can't reach back via
  // window.opener.
  term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)));
  term.open(el);
  fit.fit();

  // WebGL renderer. The default DOM renderer flows text with a per-glyph
  // letter-spacing derived from a fractional cell width; at a non-integer
  // fontSize (12.5) on a HiDPI display (devicePixelRatio 2) xterm's glyph
  // measurement and its computed cell width disagree by half a device pixel,
  // so the rendered text drifts ~0.25px/char off the hit-test grid and the
  // selection lands a few characters short by the end of a long line. The
  // WebGL renderer rasterizes each glyph into its exact grid cell (no flowed
  // text, no letter-spacing), so text, the selection overlay and mouse
  // hit-testing all share one grid. Loaded after open() as the addon requires.
  // Guarded: if WebGL is unavailable (context creation throws, or is lost and
  // unrecoverable) we dispose it and fall back to the DOM renderer rather than
  // leaving the terminal blank.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (err) {
    console.warn("webgl renderer unavailable; using DOM renderer", err);
  }
  return { term, fit };
}

/** Repaint a live terminal in the active theme, in place (no recreation). Reads the theme state,
 *  so an `$effect` calling it re-runs on every theme or contrast change. */
export function repaintXterm(term: Terminal): void {
  const resolved = theme.resolved;
  term.options.theme = xtermTheme(resolved);
  term.options.minimumContrastRatio = xtermMinContrast(resolved, theme.contrast);
  term.refresh(0, Math.max(0, term.rows - 1));
}
