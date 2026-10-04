import { describe, it, expect, afterEach, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { oscLinkHandler } from "./terminalLinks";

// Integration coverage against a REAL @xterm/xterm instance: a click on an OSC 8 hyperlink
// (Claude Code's `PR #…` status-line badge) runs through xterm's own Linkifier and
// OscLinkProvider into oscLinkHandler — the path a string-only unit test cannot prove.

let term: Terminal | undefined;
let host: HTMLDivElement | undefined;

const osc8 = (uri: string, text: string) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

async function mount(data: string): Promise<Terminal> {
  host = document.createElement("div");
  host.style.width = "600px";
  host.style.height = "240px";
  document.body.appendChild(host);
  term = new Terminal({ cols: 40, rows: 8, linkHandler: oscLinkHandler });
  term.open(host);
  const t = term;
  await new Promise<void>((resolve) => t.write(data, resolve));
  return t;
}

/** Hover, press and release on a cell's centre — the sequence a click (or a mobile tap's
 *  synthesized mouse events) delivers to xterm's Linkifier. */
function click(t: Terminal, col: number, row: number) {
  const screen = host?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) throw new Error("no .xterm-screen — term.open() did not render");
  const r = screen.getBoundingClientRect();
  const init: MouseEventInit = {
    clientX: r.left + (col + 0.5) * (r.width / t.cols),
    clientY: r.top + (row + 0.5) * (r.height / t.rows),
    bubbles: true,
    cancelable: true,
    button: 0,
  };
  screen.dispatchEvent(new MouseEvent("mousemove", init));
  screen.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  screen.dispatchEvent(new MouseEvent("mouseup", init));
}

afterEach(() => {
  vi.restoreAllMocks();
  term?.dispose();
  term = undefined;
  host?.remove();
  host = undefined;
});

describe("OSC 8 hyperlinks (real xterm)", () => {
  it("a click opens the link in a new tab without xterm's confirm() warning", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const t = await mount(`PR ${osc8("https://github.com/o/r/pull/7", "#7")}`);

    click(t, 3, 0);

    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/o/r/pull/7",
      "_blank",
      "noopener,noreferrer",
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("plain text beside the link opens nothing", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const t = await mount(`PR ${osc8("https://github.com/o/r/pull/7", "#7")}`);

    click(t, 0, 0);

    expect(open).not.toHaveBeenCalled();
  });

  it("a non-http(s) hyperlink never opens", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const t = await mount(`PR ${osc8("file:///etc/passwd", "#7")}`);

    click(t, 3, 0);

    expect(open).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
