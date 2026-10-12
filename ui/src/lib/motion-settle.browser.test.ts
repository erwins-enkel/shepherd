// Endless animations rest after a quiet period and play again on input or a status change
// (#3035). Real Chromium animations: the cancel/play round trip is the behaviour under test.
import { describe, it, expect, afterEach } from "vitest";
import { createMotionSettle, type MotionSettle } from "./motion-settle";

const IDLE = 60;
const CSS = `
  @keyframes ms-pulse { 50% { opacity: 0.2 } }
  @keyframes ms-once { from { opacity: 0 } }
  .indicator { animation: ms-pulse 1s infinite !important; }
  .halo::after { content: ""; animation: ms-pulse 1s infinite; }
  .two.classes { animation: ms-pulse 1s infinite !important; }
  .once { animation: ms-once 10s; }
`;

let stop: (() => void) | null = null;
let style: HTMLStyleElement | null = null;

function mount(html: string): MotionSettle {
  style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  document.body.innerHTML = html;
  const settle = createMotionSettle({ idleMs: IDLE });
  stop = settle.start();
  return settle;
}

afterEach(() => {
  stop?.();
  stop = null;
  style?.remove();
  document.body.innerHTML = "";
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = (sel: string) =>
  document
    .getAnimations()
    .filter(
      (a) =>
        a.playState === "running" &&
        (a.effect as KeyframeEffect).target === document.querySelector(sel),
    ).length;

describe("motion settle", () => {
  it("rests every infinite animation after the idle period, whatever its specificity", async () => {
    const settle = mount(
      `<i class="indicator"></i><i class="halo"></i><i class="two classes"></i><i class="once"></i>`,
    );
    expect(running(".indicator") + running(".halo") + running(".two")).toBe(3);
    await sleep(IDLE * 2);
    expect(settle.settled).toBe(true);
    expect(running(".indicator")).toBe(0);
    expect(running(".halo")).toBe(0); // ::after
    expect(running(".two")).toBe(0);
    expect(running(".once")).toBe(1); // one-shot animations finish on their own
    // at rest the element shows its static base style
    expect(getComputedStyle(document.querySelector(".indicator")!).opacity).toBe("1");
  });

  it("plays them again on input and on wake(), then rests again", async () => {
    const settle = mount(`<i class="indicator"></i><i class="halo"></i>`);
    await sleep(IDLE * 2);
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(settle.settled).toBe(false);
    expect(running(".indicator")).toBe(1);
    expect(running(".halo")).toBe(1);
    await sleep(IDLE * 2);
    expect(running(".indicator")).toBe(0);
    settle.wake();
    expect(running(".indicator")).toBe(1);
  });

  it("stays awake while input keeps coming", async () => {
    const settle = mount(`<i class="indicator"></i>`);
    for (let i = 0; i < 4; i++) {
      await sleep(IDLE / 2);
      window.dispatchEvent(new PointerEvent("pointermove"));
    }
    expect(settle.settled).toBe(false);
    expect(running(".indicator")).toBe(1);
  });

  it("wakes when the window becomes visible again", async () => {
    const settle = mount(`<i class="indicator"></i>`);
    await sleep(IDLE * 2);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(settle.settled).toBe(false);
    expect(running(".indicator")).toBe(1);
  });

  it("keeps animations inside an in-flight action or an open modal running", async () => {
    mount(
      `<button aria-busy="true"><i class="indicator a"></i></button>` +
        `<div class="overlay"><i class="indicator b"></i></div>` +
        `<dialog open><i class="indicator c"></i></dialog>` +
        `<i class="indicator d"></i>`,
    );
    await sleep(IDLE * 2);
    expect(running(".a") + running(".b") + running(".c")).toBe(3);
    expect(running(".d")).toBe(0);
  });

  it("rests an infinite animation that started after settling", async () => {
    mount(`<i class="later"></i>`);
    await sleep(IDLE * 2);
    document.querySelector(".later")!.classList.add("indicator");
    expect(running(".later")).toBe(1);
    await sleep(IDLE * 2); // the rescan while settled
    expect(running(".later")).toBe(0);
  });

  it("does not revive an animation whose rule stopped applying while it rested", async () => {
    const settle = mount(`<i class="pip indicator"></i>`);
    await sleep(IDLE * 2);
    document.querySelector(".pip")!.classList.remove("indicator"); // the session went idle
    settle.wake();
    expect(running(".pip")).toBe(0);
    expect(document.getAnimations()).toHaveLength(0);
  });

  it("does not double an animation the rule re-created while it rested", async () => {
    const settle = mount(`<i class="pip indicator"></i>`);
    await sleep(IDLE * 2);
    const pip = document.querySelector(".pip")!;
    pip.classList.remove("indicator");
    expect(getComputedStyle(pip).animationName).toBe("none"); // the rule is gone (style flushed)…
    pip.classList.add("indicator"); // …and back, with a fresh animation
    settle.wake();
    expect(running(".pip")).toBe(1);
  });
});
