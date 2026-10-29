import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import type { HeavySlotSnapshot } from "#lib/types.js";
import HeavySlotChip from "./HeavySlotChip.svelte";
import HeavySlotStrip from "./HeavySlotStrip.svelte";
import HostPopover from "./HostPopover.svelte";

const GIB = 1024 ** 3;
const sessions = [
  { id: "h", name: "holder-session" },
  { id: "w1", name: "first-waiter" },
  { id: "w2", name: "second-waiter" },
];
function snap(over: Partial<HeavySlotSnapshot> = {}): HeavySlotSnapshot {
  return {
    enabled: true,
    capacity: 1,
    holders: [{ sessionId: "h", command: "vitest run", startedAt: 0, rssBytes: 2 * GIB }],
    waiters: [
      { sessionId: "w2", position: 2, reason: "slot" },
      { sessionId: "w1", position: 1, reason: "slot" },
    ],
    brake: { active: false, reason: null },
    pressure: {
      ramAvailableBytes: 2 * GIB,
      ramTotalBytes: 30 * GIB,
      swapUsedBytes: GIB,
      swapTotalBytes: 4 * GIB,
      memFullAvg10: 10,
      memBrakeThreshold: 20,
      cpuSomeAvg10: 34,
    },
    memoryBySource: {
      agentsBytes: 8 * GIB,
      foreignBytes: 3 * GIB,
      foreignTop: [{ name: "whisper", bytes: GIB }],
    },
    lastResults: [],
    ...over,
  };
}

const twoSlotsOneSession = snap({
  capacity: 2,
  holders: [
    { sessionId: "h", command: "vitest run", startedAt: 0, rssBytes: GIB },
    { sessionId: "h", command: "bun test", startedAt: 1, rssBytes: GIB },
  ],
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("HeavySlotChip", () => {
  it("renders nothing when the master switch is off", async () => {
    render(HeavySlotChip, {
      heavySlot: snap({ enabled: false }),
      sessions,
      nowMs: 0,
      onrelease: vi.fn(),
    });
    expect(document.querySelector(".hs-chip")).toBeNull();
  });

  it("shows holders, waiters and RAM, and opens the host popover on click", async () => {
    render(HeavySlotChip, { heavySlot: snap(), sessions, nowMs: 134_000, onrelease: vi.fn() });
    const chip = page.getByRole("button", { name: /1 of 1 held, 2 waiting/i });
    await expect.element(chip).toBeVisible();
    expect(chip.element().textContent).toContain("RAM 93 %");
    await userEvent.click(chip);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("holder-session")).toBeVisible();
    await expect.element(page.getByText(/2:14/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".hp")).toBeNull();
  });

  it("lists every slot one session holds in the host popover", async () => {
    render(HeavySlotChip, {
      heavySlot: twoSlotsOneSession,
      sessions,
      nowMs: 0,
      onrelease: vi.fn(),
    });
    await userEvent.click(page.getByRole("button", { name: /2 of 2 held/i }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(document.querySelectorAll(".hp-row").length).toBe(4);
  });

  it("asks before releasing and reports the session to onrelease", async () => {
    const onrelease = vi.fn().mockResolvedValue(undefined);
    render(HeavySlotChip, { heavySlot: snap(), sessions, nowMs: 0, onrelease });
    await userEvent.click(page.getByRole("button", { name: /held/i }));
    await userEvent.click(page.getByRole("button", { name: "Release", exact: true }));
    expect(onrelease).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Release slot" }));
    expect(onrelease).toHaveBeenCalledWith("h");
  });
});

describe("HeavySlotStrip", () => {
  it("stays hidden when disabled or idle", async () => {
    render(HeavySlotStrip, { heavySlot: snap({ enabled: false }), sessions });
    render(HeavySlotStrip, { heavySlot: snap({ holders: [], waiters: [] }), sessions });
    expect(document.querySelector(".hs-strip")).toBeNull();
  });

  it("lists the holder then waiters in queue order and jumps to the session", async () => {
    const onselect = vi.fn();
    render(HeavySlotStrip, { heavySlot: snap(), sessions, onselect });
    const names = [...document.querySelectorAll(".hs-name")].map((n) => n.textContent?.trim());
    expect(names).toEqual(["holder-session", "◔ first-waiter", "◔ second-waiter"]);
    await userEvent.click(page.getByRole("button", { name: /second-waiter/ }));
    expect(onselect).toHaveBeenCalledWith("w2");
  });

  it("opens the host panel from its label only when given onopen", async () => {
    render(HeavySlotStrip, { heavySlot: snap(), sessions });
    expect(document.querySelector(".hs-open")).toBeNull();
    const onopen = vi.fn();
    render(HeavySlotStrip, { heavySlot: snap(), sessions, onopen });
    await userEvent.click(page.getByRole("button", { name: /1 of 1 held, 2 waiting/i }));
    expect(onopen).toHaveBeenCalledOnce();
  });

  it("lists every slot one session holds when capacity is above one", async () => {
    render(HeavySlotStrip, { heavySlot: twoSlotsOneSession, sessions });
    const names = [...document.querySelectorAll(".hs-holder .hs-name")].map((n) => n.textContent);
    expect(names).toEqual(["holder-session", "holder-session"]);
  });

  it("names the brake", async () => {
    render(HeavySlotStrip, {
      heavySlot: snap({ holders: [], waiters: [], brake: { active: true, reason: "memory" } }),
      sessions,
    });
    await expect.element(page.getByText(/Brake on/)).toBeVisible();
  });
});

describe("HostPopover — phone sheet", () => {
  it("portals a full-screen modal over a scrim that fits a 390px screen", async () => {
    await page.viewport(390, 800);
    const host = document.createElement("div");
    host.style.cssText = "will-change:transform;position:fixed;top:0;left:200px;width:60px;";
    document.body.appendChild(host);
    const onClose = vi.fn();
    render(HostPopover, {
      target: host,
      props: {
        variant: "sheet",
        heavySlot: snap(),
        sessions,
        nowMs: 0,
        onrelease: vi.fn(),
        onClose,
      },
    });
    const sheet = page.getByRole("dialog");
    await expect.element(sheet).toBeVisible();
    const el = sheet.element() as HTMLElement;
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(host.contains(el)).toBe(false);
    expect(document.querySelector(".hp-portal .scrim")).not.toBeNull();
    const r = el.getBoundingClientRect();
    expect(r.left).toBe(0);
    expect(r.right).toBe(window.innerWidth);
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    host.remove();
  });

  // Synthetic touches spaced 500ms apart, so back-to-back dispatches never read as a flick.
  let clock = 0;
  function fakeTouch(type: string, x: number, y: number): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", {
      value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
      configurable: true,
    });
    Object.defineProperty(e, "timeStamp", { value: (clock += 500), configurable: true });
    return e;
  }
  function swipe(el: Element, from: [number, number], to: [number, number]) {
    el.dispatchEvent(fakeTouch("touchstart", ...from));
    el.dispatchEvent(fakeTouch("touchmove", ...to));
    el.dispatchEvent(fakeTouch("touchend", ...to));
  }
  const props = (variant: "sheet" | "anchored", onClose: () => void) => ({
    variant,
    heavySlot: snap(),
    sessions,
    nowMs: 0,
    onrelease: vi.fn(),
    onClose,
  });

  it("a rightward swipe closes; it follows the finger; short, leftward and vertical stay", async () => {
    await page.viewport(390, 800);
    const onClose = vi.fn();
    render(HostPopover, props("sheet", onClose));
    const el = document.querySelector<HTMLElement>(".hp-sheet")!;
    el.dispatchEvent(fakeTouch("touchstart", 10, 300));
    el.dispatchEvent(fakeTouch("touchmove", 60, 300));
    await expect.poll(() => el.style.transform).toBe("translateX(50px)");
    el.dispatchEvent(fakeTouch("touchend", 60, 300));
    await expect.poll(() => el.style.transform).toBe("");
    swipe(el, [10, 300], [40, 300]);
    swipe(el, [300, 300], [10, 300]);
    swipe(el, [100, 100], [110, 500]);
    expect(onClose).not.toHaveBeenCalled();
    swipe(el, [10, 300], [300, 300]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("the anchored desktop panel has no swipe", async () => {
    const onClose = vi.fn();
    render(HostPopover, props("anchored", onClose));
    const el = document.querySelector<HTMLElement>(".hp")!;
    swipe(el, [10, 300], [300, 300]);
    expect(onClose).not.toHaveBeenCalled();
    expect(el.dataset.swipeBack).toBeUndefined();
  });
});

// A real agent check: a multi-line heredoc pipeline, hundreds of characters long.
const LONG = [
  "cd ui && bun run test src/lib/components/heavy-slot/heavy-slot.browser.test.ts src/lib/a.test.ts",
  "cat <<'EOF' > /tmp/check.sh",
  ...Array.from(
    { length: 8 },
    (_, i) => `bunx vitest run --project browser src/lib/part-${i}.test.ts`,
  ),
  "EOF",
  "bash /tmp/check.sh && cargo test --locked --manifest-path cli/Cargo.toml",
].join("\n");

function longSnap(): HeavySlotSnapshot {
  return snap({
    holders: [{ sessionId: "h", command: LONG, startedAt: 0, rssBytes: 2 * GIB }],
    lastResults: [
      {
        sessionId: "w1",
        command: LONG,
        startedAt: 0,
        endedAt: 1,
        exitCode: 1,
        result: "failed",
        head: "a1b2c3d4e5",
        treeHash: "t",
        stale: false,
      },
    ],
  });
}

// Test pages load no app.css, so pin a px line-height for the line-count arithmetic.
const LINE = 18;
const lineHeight = () => LINE;
const pinLineHeight = () => (document.body.style.lineHeight = `${LINE}px`);
const cmdText = (btn: Element) => btn.querySelector(".hp-cmd-text") as HTMLElement;

describe("HostPopover — long commands", () => {
  beforeEach(pinLineHeight);
  for (const [w, h] of [
    [390, 800],
    [1440, 900],
  ] as const) {
    it(`clamps every command to two lines at ${w}px and keeps the meta visible`, async () => {
      await page.viewport(w, h);
      render(HostPopover, {
        heavySlot: longSnap(),
        sessions,
        nowMs: 134_000,
        onrelease: vi.fn(),
        onClose: vi.fn(),
      });
      const cmds = [...document.querySelectorAll(".hp-cmd")];
      expect(cmds).toHaveLength(2);
      for (const btn of cmds) {
        const text = cmdText(btn);
        expect(btn.getAttribute("aria-expanded")).toBe("false");
        expect(btn.getAttribute("title")).toBe(LONG);
        expect(text.clientHeight).toBeLessThanOrEqual(2 * lineHeight() + 1);
        expect(text.scrollHeight).toBeGreaterThan(text.clientHeight);
      }
      await expect.element(page.getByText("2:14 · 2.0 GiB")).toBeVisible();
      await expect.element(page.getByText(/a1b2c3d · exit 1/)).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Release", exact: true }))
        .toBeVisible();
    });
  }

  it("expands one row's command to the full text and collapses it again", async () => {
    await page.viewport(390, 800);
    render(HostPopover, {
      heavySlot: longSnap(),
      sessions,
      nowMs: 0,
      onrelease: vi.fn(),
      onClose: vi.fn(),
    });
    const [holder, result] = document.querySelectorAll(".hp-cmd");
    const toggle = page.getByRole("button", { name: /^Show full command: cd ui/ }).first();
    await userEvent.click(toggle);
    expect(holder.getAttribute("aria-expanded")).toBe("true");
    expect(holder.hasAttribute("title")).toBe(false);
    const text = cmdText(holder);
    expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight);
    expect(text.clientHeight).toBeGreaterThan(4 * lineHeight());
    expect(text.textContent).toBe(LONG);
    expect(result.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(page.getByRole("button", { name: /^Collapse command: cd ui/ }));
    expect(holder.getAttribute("aria-expanded")).toBe("false");
    expect(cmdText(holder).clientHeight).toBeLessThanOrEqual(2 * lineHeight() + 1);
  });
});

describe("HeavySlotStrip — long commands", () => {
  beforeEach(pinLineHeight);
  it("cuts the holder command to one line without widening the page", async () => {
    await page.viewport(1440, 900);
    const chrome = document.createElement("header");
    chrome.style.cssText = "display:flex;flex-direction:column;";
    document.body.appendChild(chrome);
    render(HeavySlotStrip, { target: chrome, props: { heavySlot: longSnap(), sessions } });
    const cmd = document.querySelector(".hs-cmd") as HTMLElement;
    expect(cmd.clientHeight).toBeLessThanOrEqual(lineHeight() + 1);
    expect(cmd.scrollWidth).toBeGreaterThan(cmd.clientWidth);
    expect(cmd.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(document.querySelector(".hs-holder")?.getAttribute("title")).toBe(LONG);
  });
});
