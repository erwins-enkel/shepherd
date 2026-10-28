import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { pullToCommand, type PullToCommandOptions } from "./pullToCommand";

let node: HTMLDivElement;
let action: ReturnType<typeof pullToCommand>;
let opts: {
  enabled: () => boolean;
  onstage: Mock<PullToCommandOptions["onstage"]>;
  onsearch: Mock<() => void>;
  onreload: Mock<() => void>;
};
let enabled = true;

beforeEach(() => {
  enabled = true;
  window.scrollTo(0, 0);
  node = document.createElement("div");
  node.style.height = "400px";
  document.body.appendChild(node);
  opts = { enabled: () => enabled, onstage: vi.fn(), onsearch: vi.fn(), onreload: vi.fn() };
  action = pullToCommand(node, opts);
});
afterEach(() => {
  action.destroy();
  node.remove();
  document.body.style.height = "";
  window.scrollTo(0, 0);
});

function touch(target: Element, y: number, x = 100) {
  return new Touch({ identifier: 1, target, clientX: x, clientY: y });
}
function fire(type: string, target: Element, y: number, x = 100): TouchEvent {
  const touches = type === "touchend" || type === "touchcancel" ? [] : [touch(target, y, x)];
  const e = new TouchEvent(type, { bubbles: true, cancelable: true, touches });
  target.dispatchEvent(e);
  return e;
}
/** Pull from y=20 through each listed y, then release. Returns the touchmove events. */
function pull(ys: number[], target: Element = node, x = 100): TouchEvent[] {
  fire("touchstart", target, 20, 100);
  const moves = ys.map((y) => fire("touchmove", target, y, x));
  fire("touchend", target, ys.at(-1) ?? 20);
  return moves;
}

describe("pullToCommand", () => {
  it("opens search on a short pull", () => {
    pull([60, 120, 160]);
    expect(opts.onsearch).toHaveBeenCalledOnce();
    expect(opts.onreload).not.toHaveBeenCalled();
    expect(opts.onstage).toHaveBeenLastCalledWith("idle", 0);
  });

  it("reloads on a long pull", () => {
    pull([100, 250, 420]);
    expect(opts.onreload).toHaveBeenCalledOnce();
    expect(opts.onsearch).not.toHaveBeenCalled();
  });

  it("does nothing when released below the search threshold", () => {
    pull([40, 60]);
    expect(opts.onsearch).not.toHaveBeenCalled();
    expect(opts.onreload).not.toHaveBeenCalled();
  });

  it("drops back to search when pulled past reload then back", () => {
    pull([250, 420, 160]);
    expect(opts.onsearch).toHaveBeenCalledOnce();
    expect(opts.onreload).not.toHaveBeenCalled();
  });

  it("prevents default only once armed", () => {
    const [jitter, armed] = pull([24, 120]);
    expect(jitter.defaultPrevented).toBe(false);
    expect(armed.defaultPrevented).toBe(true);
  });

  it("ignores the touch when disabled", () => {
    enabled = false;
    const moves = pull([120, 420]);
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(opts.onstage).not.toHaveBeenCalled();
    expect(opts.onsearch).not.toHaveBeenCalled();
    expect(opts.onreload).not.toHaveBeenCalled();
  });

  it("never arms while the page is scrolled down", () => {
    document.body.style.height = "5000px";
    window.scrollTo(0, 300);
    const moves = pull([120, 420]);
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(opts.onsearch).not.toHaveBeenCalled();
    expect(opts.onreload).not.toHaveBeenCalled();
  });

  it("leaves a scrolled nested region alone", () => {
    const inner = document.createElement("div");
    inner.style.cssText = "height:100px;overflow:auto";
    inner.innerHTML = '<div style="height:1000px"></div>';
    node.appendChild(inner);
    inner.scrollTop = 50;
    pull([120, 420], inner.firstElementChild!);
    expect(opts.onsearch).not.toHaveBeenCalled();
    expect(opts.onreload).not.toHaveBeenCalled();
  });

  it("ignores horizontal swipes", () => {
    pull([40, 60], node, 300);
    expect(opts.onstage).not.toHaveBeenCalled();
  });

  it("caps a long pull at search when there is no reload", () => {
    action.update({ enabled: () => true, onstage: opts.onstage, onsearch: opts.onsearch });
    pull([100, 250, 420]);
    expect(opts.onsearch).toHaveBeenCalledOnce();
    expect(opts.onstage).not.toHaveBeenCalledWith("reload", expect.anything());
  });

  it("arms under a scrolled page when scrollTop says the region is at its top", () => {
    document.body.style.height = "5000px";
    window.scrollTo(0, 300);
    action.update({ ...opts, scrollTop: () => 0 });
    pull([120, 160]);
    expect(opts.onsearch).toHaveBeenCalledOnce();
  });

  it("ignores a pull that starts in a field", () => {
    const field = document.createElement("textarea");
    node.appendChild(field);
    const moves = pull([120, 420], field);
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(opts.onsearch).not.toHaveBeenCalled();
    expect(opts.onreload).not.toHaveBeenCalled();
  });
});
