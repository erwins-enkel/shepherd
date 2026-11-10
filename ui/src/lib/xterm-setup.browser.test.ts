import { describe, it, expect, afterEach, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { canFit, openXterm, wireTerminalCopy } from "./xterm-setup";

// Regression: a phone opens a session on the Chat tab, so the terminal mount is display:none when
// openXterm runs. iOS WebKit reports such a mount's computed width/height as "100%", which
// FitAddon parses to 100px → a 13×6 terminal whose size the PTY attach then forced onto the real
// pane (the AskUserQuestion dialog wrapped past recognition). Chromium reports "auto", so the
// WebKit reading is stubbed here.

let host: HTMLDivElement;
let term: Terminal | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  term?.dispose();
  term = undefined;
  host.remove();
});

function mount(hidden: boolean): HTMLDivElement {
  host = document.createElement("div");
  host.style.cssText = "width:800px;height:600px";
  const el = document.createElement("div");
  el.style.cssText = `width:100%;height:100%;${hidden ? "display:none" : ""}`;
  host.appendChild(el);
  document.body.appendChild(host);
  return el;
}

describe("openXterm", () => {
  it("does not fit a hidden mount (keeps the 80×24 default)", () => {
    const el = mount(true);
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((node, pseudo) => {
      const style = real(node, pseudo);
      if (node !== el) return style;
      return new Proxy(style, {
        get: (t, k) =>
          k === "getPropertyValue"
            ? (p: string) => (p === "width" || p === "height" ? "100%" : t.getPropertyValue(p))
            : Reflect.get(t, k, t),
      });
    });
    ({ term } = openXterm(el, { fontSize: 12, theme: "dark" }));
    expect([term.cols, term.rows]).toEqual([80, 24]);
  });

  it("fits a visible mount", () => {
    const el = mount(false);
    ({ term } = openXterm(el, { fontSize: 12, theme: "dark" }));
    expect(term.cols).toBeGreaterThan(80);
  });
});

describe("canFit", () => {
  it("is false for a hidden mount, true for a sized visible one", () => {
    expect(canFit(mount(true))).toBe(false);
    host.remove();
    expect(canFit(mount(false))).toBe(true);
  });
});

describe("wireTerminalCopy", () => {
  // A selection as a TUI paints it: rows padded with real spaces, which the copy drops.
  async function selected(): Promise<{ el: HTMLDivElement; term: Terminal }> {
    const el = mount(false);
    ({ term } = openXterm(el, { fontSize: 12, theme: "dark" }));
    const t = term;
    await new Promise<void>((r) => t.write("hello   \r\nworld  ", r));
    t.selectLines(0, 1);
    return { el, term: t };
  }
  const press = (el: HTMLElement) =>
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const release = () => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  const nativeCopy = (el: HTMLElement) => {
    const ev = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(ev);
    return ev;
  };

  it("copies the trimmed selection when a drag that began in the terminal is released", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { el, term } = await selected();
    const off = wireTerminalCopy(term, el);
    press(el);
    release();
    expect(write).toHaveBeenCalledExactlyOnceWith("hello\nworld");
    off();
  });

  it("ignores a release whose press began elsewhere, and an empty selection", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { el, term } = await selected();
    const off = wireTerminalCopy(term, el);
    release();
    term.clearSelection();
    press(el);
    release();
    expect(write).not.toHaveBeenCalled();
    off();
  });

  it("puts the trimmed selection on a native copy", async () => {
    const { el, term } = await selected();
    const off = wireTerminalCopy(term, el);
    const ev = nativeCopy(el);
    expect(ev.defaultPrevented).toBe(true);
    expect(ev.clipboardData!.getData("text/plain")).toBe("hello\nworld");
    off();
  });

  it("stops copying once disposed", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { el, term } = await selected();
    wireTerminalCopy(term, el)();
    press(el);
    release();
    expect(write).not.toHaveBeenCalled();
    expect(nativeCopy(el).defaultPrevented).toBe(false);
  });
});
