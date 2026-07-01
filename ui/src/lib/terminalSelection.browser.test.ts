import { describe, it, expect, afterEach } from "vitest";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { trimTrailingWhitespace } from "./terminalSelection";

// Integration coverage against a REAL @xterm/xterm instance — the two claims the
// fix depends on that a string-only unit test cannot prove:
//   1. xterm's getSelection() keeps the trailing padding spaces a TUI paints into
//      a row (the reported bug), and trimTrailingWhitespace strips them.
//   2. a capture-phase `copy` listener on the mount pre-empts xterm's own
//      bubble-phase copy handler (bound on term.element, a descendant of the
//      mount), so the native Cmd+C / right-click path emits the trimmed text.

let term: Terminal | undefined;
let host: HTMLDivElement | undefined;

function mount(cols = 40, rows = 8) {
  host = document.createElement("div");
  host.style.width = "600px";
  host.style.height = "240px";
  document.body.appendChild(host);
  term = new Terminal({ cols, rows, fontFamily: "monospace", fontSize: 14 });
  term.open(host);
  return term;
}

const write = (t: Terminal, data: string) => new Promise<void>((resolve) => t.write(data, resolve));

afterEach(() => {
  term?.dispose();
  term = undefined;
  host?.remove();
  host = undefined;
});

describe("terminal selection copy (real xterm)", () => {
  it("getSelection() keeps TUI trailing padding; trimTrailingWhitespace removes it", async () => {
    const t = mount();
    // two backslash-continued lines, each with trailing padding spaces after the "\"
    await write(t, "echo hi \\    \r\n  --flag val \\  \r\n");
    t.selectLines(0, 1);
    const raw = t.getSelection();

    // bug reproduced: the raw selection carries trailing whitespace
    expect(/[ \t]+(\r?\n|$)/.test(raw)).toBe(true);

    // fix: no trailing whitespace survives, content + backslashes intact
    const trimmed = trimTrailingWhitespace(raw);
    expect(/[ \t]+(\r?\n|$)/.test(trimmed)).toBe(false);
    for (const line of trimmed.split(/\r?\n/)) {
      expect(line).toBe(line.replace(/[ \t]+$/, ""));
    }
    expect(trimmed).toContain("echo hi \\");
    expect(trimmed).toContain("--flag val \\");
  });

  it("capture-phase copy interceptor pre-empts xterm's own bubble-phase handler", async () => {
    const t = mount();
    await write(t, "padded line   \r\n");
    t.selectLines(0, 0);

    // the production interceptor, verbatim
    const onCopy = (e: ClipboardEvent) => {
      const sel = trimTrailingWhitespace(t.getSelection());
      if (!sel) return;
      e.clipboardData?.setData("text/plain", sel);
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    host!.addEventListener("copy", onCopy, true);

    // stand-in on term.element (a descendant of host, bubble phase) representing
    // xterm's own copy handler — must NOT run once we stopImmediatePropagation
    let xtermHandlerRan = false;
    term!.element!.addEventListener("copy", () => {
      xtermHandlerRan = true;
    });

    const ev = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });
    (term!.textarea ?? term!.element!).dispatchEvent(ev);

    expect(xtermHandlerRan).toBe(false); // pre-empted by capture-on-host
    expect(ev.defaultPrevented).toBe(true);
  });

  it("interceptor writes the trimmed selection into the copy event's clipboardData", async () => {
    const t = mount();
    await write(t, "padded line   \r\n");
    t.selectLines(0, 0);

    // drive the handler directly with a real DataTransfer to assert the payload
    // deterministically (synthetic-dispatch clipboardData access is browser-flaky)
    const dt = new DataTransfer();
    let prevented = false;
    let stopped = false;
    const onCopy = (e: ClipboardEvent) => {
      const sel = trimTrailingWhitespace(t.getSelection());
      if (!sel) return;
      e.clipboardData?.setData("text/plain", sel);
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    onCopy({
      clipboardData: dt,
      preventDefault: () => {
        prevented = true;
      },
      stopImmediatePropagation: () => {
        stopped = true;
      },
    } as unknown as ClipboardEvent);

    expect(dt.getData("text/plain")).toBe("padded line");
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
  });

  it("changing fontFamily forces xterm to re-measure the character cell (Fix A primitive)", () => {
    // The selection-offset fix relies on toggling term.options.fontFamily to force
    // a fresh glyph measurement. Prove that primitive against real xterm: with a
    // fixed container, the columns FitAddon derives depend on the *measured* cell
    // width, so if a fontFamily change re-measures, the derived column count moves.
    const t = mount(80, 24);
    const fit = new FitAddon();
    t.loadAddon(fit);

    t.options.fontFamily = "monospace";
    fit.fit();
    const colsMono = t.cols;

    // a metrically different family → different measured cell width → different cols
    t.options.fontFamily = "'Times New Roman', serif";
    fit.fit();
    const colsSerif = t.cols;

    expect(colsMono).toBeGreaterThan(0);
    expect(colsSerif).not.toBe(colsMono); // re-measured: the option change took effect
  });
});
