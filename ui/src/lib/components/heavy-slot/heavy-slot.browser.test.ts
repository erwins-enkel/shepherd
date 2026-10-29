import { afterEach, describe, expect, it, vi } from "vitest";
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
});
