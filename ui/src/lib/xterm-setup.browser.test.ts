import { describe, it, expect, afterEach, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { canFit, openXterm } from "./xterm-setup";

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
