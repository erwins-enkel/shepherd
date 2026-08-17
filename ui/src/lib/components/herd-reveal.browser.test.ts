import { describe, it, expect, afterEach } from "vitest";
import { scrollParentOf } from "./herd-reveal";

// scrollParentOf is the one part of the reveal path that can only be wrong against a real
// layout: it reads computed overflow and live scroll/client heights. The rail (`.units`,
// `overflow: auto`) and its mobile flow mode (`overflow: visible`, the page scrolls) are
// the two shapes it has to tell apart.

let host: HTMLElement | null = null;

function mount(html: string): HTMLElement {
  host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe("scrollParentOf", () => {
  it("finds the scrolling ancestor a row actually lives in", () => {
    const el = mount(`
      <div style="height: 100px; overflow: auto" data-rail>
        <div style="height: 900px"><div data-row></div></div>
      </div>`);
    const row = el.querySelector("[data-row]") as HTMLElement;
    expect(scrollParentOf(row)).toBe(el.querySelector("[data-rail]"));
  });

  it("skips an `overflow: auto` ancestor that has nothing to scroll", () => {
    // A short rail — fewer sessions than fit — must not be mistaken for the viewport that
    // clips the row, or a visible row could be judged off-screen and pointlessly centred.
    const el = mount(`
      <div style="height: 400px; overflow: auto" data-rail>
        <div style="height: 20px"><div data-row></div></div>
      </div>`);
    const row = el.querySelector("[data-row]") as HTMLElement;
    expect(scrollParentOf(row)).not.toBe(el.querySelector("[data-rail]"));
  });

  it("returns null when nothing between the row and the document scrolls (mobile flow mode)", () => {
    const el = mount(`
      <div style="overflow: visible" data-rail>
        <div><div data-row></div></div>
      </div>`);
    const row = el.querySelector("[data-row]") as HTMLElement;
    expect(scrollParentOf(row)).toBeNull();
  });
});
