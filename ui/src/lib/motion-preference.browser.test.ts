// Guards the motion kill switch in app.css. Two things must hold at once, and
// they pull against each other:
//
//   1. `[data-motion="reduced"]` stills decorative animation everywhere.
//   2. Functional status indicators (CI dot-pulse, pip-pulse, critic rev-pulse)
//      keep animating — they encode "work is happening", not decoration, and
//      they earn that by carrying their own `animation: … !important` on a more
//      specific selector.
//
// #2 only survives because the guard sits inside `:where()` (zero specificity).
// Drop the `:where()` and this file goes red — which is the entire point of it.
import { describe, it, expect, afterEach } from "vitest";
import "../app.css";

let style: HTMLStyleElement | null = null;

function mount(html: string, css: string) {
  style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = html;
}

afterEach(() => {
  style?.remove();
  style = null;
  document.body.innerHTML = "";
  delete document.documentElement.dataset.motion;
});

// The indicator selector is a SINGLE class on purpose — specificity (0,1,0),
// exactly like the real `.dot-pending` / `.cb-cog` / `.pip-pulse` rules. A
// two-class selector would be (0,2,0) and would survive even an unguarded
// `html[data-motion="reduced"] *` (0,1,1), i.e. it would not catch the
// regression this file exists to catch.
const FIXTURE = `
  @keyframes mp-spin { from { rotate: 0deg } to { rotate: 360deg } }
  .decor { animation: mp-spin 1s linear infinite; }
  .indicator { animation: mp-spin 1s linear infinite !important; }
`;

const nameOf = (sel: string) =>
  getComputedStyle(document.querySelector(sel) as Element).animationName;

describe("motion preference", () => {
  it("leaves both animations running when no preference is set", () => {
    mount(`<div class="decor"></div><div class="indicator"></div>`, FIXTURE);

    expect(nameOf(".decor")).toBe("mp-spin");
    expect(nameOf(".indicator")).toBe("mp-spin");
  });

  it('stills decorative motion under [data-motion="reduced"]', () => {
    document.documentElement.dataset.motion = "reduced";
    mount(`<div class="decor"></div>`, FIXTURE);

    expect(nameOf(".decor")).toBe("none");
  });

  it('keeps functional status animation alive under [data-motion="reduced"]', () => {
    document.documentElement.dataset.motion = "reduced";
    mount(`<div class="indicator"></div>`, FIXTURE);

    // If this fails, the guard in app.css outranks the component's !important —
    // check that `html[data-motion=…]` is still wrapped in :where().
    expect(nameOf(".indicator")).toBe("mp-spin");
  });

  it('does not still anything under [data-motion="full"] or "system"', () => {
    for (const pref of ["full", "system"] as const) {
      document.documentElement.dataset.motion = pref;
      mount(`<div class="decor"></div>`, FIXTURE);
      expect(nameOf(".decor"), `data-motion="${pref}"`).toBe("mp-spin");
      style?.remove();
    }
  });
});
