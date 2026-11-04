import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import type { HeavySlotSnapshot, RemoteInstance } from "#lib/types.js";
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

  it("reads quiet when nothing holds, waits or brakes, amber otherwise", async () => {
    const props = { sessions, nowMs: 0, onrelease: vi.fn() };
    render(HeavySlotChip, { ...props, heavySlot: snap({ holders: [], waiters: [] }) });
    render(HeavySlotChip, { ...props, heavySlot: snap() });
    const [idle, active] = document.querySelectorAll(".hs-chip");
    expect(idle.classList.contains("idle")).toBe(true);
    expect(active.classList.contains("idle")).toBe(false);
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

  it("marks a lingering and an offered holder in the host popover (#3631)", async () => {
    render(HeavySlotChip, {
      heavySlot: snap({
        capacity: 3,
        holders: [
          {
            sessionId: "h",
            command: "vitest run",
            startedAt: 0,
            rssBytes: GIB,
            state: "lingering",
          },
          { sessionId: "w1", command: "bun test", startedAt: 0, rssBytes: null, state: "offered" },
          { sessionId: "w2", command: "tsc", startedAt: 0, rssBytes: null },
        ],
        waiters: [],
      }),
      sessions,
      nowMs: 0,
      onrelease: vi.fn(),
    });
    await userEvent.click(page.getByRole("button", { name: /3 of 3 held/i }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const states = [...document.querySelectorAll<HTMLElement>(".hp-state")].map((n) => ({
      text: n.textContent?.trim(),
      shown: n.offsetParent !== null,
    }));
    expect(states).toEqual([
      { text: "Command finished · leftover processes hold the slot", shown: true },
      { text: "Reserved until the session reruns its check", shown: true },
      { text: "", shown: false },
    ]);
    // A lingering holder can still be released by hand.
    expect(page.getByRole("button", { name: "Release", exact: true }).elements()).toHaveLength(3);
  });

  // The bar (.hud) is the popover's positioning box; the render container stands in for it.
  async function openIn(width: number, chipOffset: number) {
    render(HeavySlotChip, { heavySlot: snap(), sessions, nowMs: 0, onrelease: vi.fn() });
    const container = document.querySelector<HTMLElement>(".hs-wrap")!.parentElement!;
    Object.assign(container.style, {
      position: "relative",
      width: `${width}px`,
      paddingLeft: `${chipOffset}px`,
      boxSizing: "border-box",
    });
    await userEvent.click(page.getByRole("button", { name: /held/i }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const pop = document.querySelector<HTMLElement>(".hp")!.getBoundingClientRect();
    const chip = document.querySelector<HTMLElement>(".hs-chip")!.getBoundingClientRect();
    return { pop, chip, box: container.getBoundingClientRect() };
  }

  it("drops the popover under the chip, not at the bar's right edge", async () => {
    const { pop, chip } = await openIn(1000, 100);
    expect(Math.abs(pop.left - chip.left)).toBeLessThanOrEqual(1);
  });

  it("keeps the popover inside the bar when the chip sits near its right edge", async () => {
    const { pop, box } = await openIn(600, 500);
    expect(pop.right).toBeLessThanOrEqual(box.right + 1);
    expect(pop.left).toBeGreaterThanOrEqual(box.left - 1);
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

  it("says what a holder does: running, leftover processes, or an open offer (#3631)", async () => {
    render(HeavySlotStrip, {
      heavySlot: snap({
        capacity: 3,
        holders: [
          {
            sessionId: "h",
            command: "vitest run",
            startedAt: 0,
            rssBytes: GIB,
            state: "lingering",
          },
          { sessionId: "w1", command: "bun test", startedAt: 0, rssBytes: null, state: "offered" },
          { sessionId: "w2", command: "tsc", startedAt: 0, rssBytes: null },
        ],
        waiters: [],
      }),
      sessions,
    });
    const lines = [...document.querySelectorAll(".hs-holder .hs-cmd")].map((n) => n.textContent);
    expect(lines).toEqual([
      "Leftover processes of vitest run",
      "Offered for bun test",
      "Running tsc",
    ]);
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

  it("counts the new sessions the brake holds, and stays up while they follow one by one", async () => {
    const startQueue = [
      {
        kind: "task" as const,
        repoPath: "/r",
        issueNumber: null,
        label: "x",
        since: 0,
        position: 1,
      },
    ];
    const idle = { holders: [], waiters: [] };
    render(HeavySlotStrip, {
      heavySlot: snap({ ...idle, brake: { active: true, reason: "memory" }, startQueue }),
      sessions,
    });
    await expect.element(page.getByText(/Brake on: .* · 1 waiting/)).toBeVisible();
    document.body.innerHTML = "";
    render(HeavySlotStrip, { heavySlot: snap({ ...idle, startQueue }), sessions });
    await expect.element(page.getByText(/1 waiting starts follow one by one/)).toBeVisible();
  });
});

describe("HostPopover — waiting starts", () => {
  it("lists new sessions in start order after the queue, only while any wait", async () => {
    const props = (startQueue: HeavySlotSnapshot["startQueue"]) => ({
      heavySlot: snap({ brake: { active: true, reason: "memory" }, startQueue }),
      sessions,
      nowMs: 0,
      onrelease: vi.fn(),
      onClose: vi.fn(),
    });
    render(HostPopover, props([]));
    expect(document.body.textContent).not.toContain("Waiting starts");
    document.body.innerHTML = "";
    render(
      HostPopover,
      props([
        {
          kind: "drain",
          repoPath: "/x/shepherd",
          issueNumber: 42,
          label: "Fix login",
          since: 1,
          position: 1,
        },
        {
          kind: "task",
          repoPath: "/x/bartab",
          issueNumber: null,
          label: "Tidy up",
          since: 2,
          position: 2,
        },
      ]),
    );
    const heads = [...document.querySelectorAll("h3")].map((h) => h.textContent);
    expect(heads.indexOf("Waiting starts")).toBe(heads.indexOf("Queue") + 1);
    const rows = [...document.querySelectorAll("section:nth-of-type(3) .sq-row")].map((r) =>
      r.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toEqual(["1. shepherd #42 Fix login Auto-drain", "2. bartab Tidy up Task"]);
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
const LABEL =
  "bun run test src/lib/components/heavy-slot/heavy-slot.browser.test.ts src/lib/a.test.ts";

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
    it(`shows holder and result commands as their first step on one line at ${w}px`, async () => {
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
        expect(text.textContent).toBe(LABEL);
        expect(text.clientHeight).toBeLessThanOrEqual(lineHeight() + 1);
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
    const toggle = page.getByRole("button", { name: /^Show full command: bun run test/ }).first();
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
    expect(cmdText(holder).clientHeight).toBeLessThanOrEqual(lineHeight() + 1);
    expect(cmdText(holder).textContent).toBe(LABEL);
  });
});

describe("HeavySlotStrip — long commands", () => {
  beforeEach(pinLineHeight);
  it("shows the command's first step on one line of at most 40ch", async () => {
    await page.viewport(1440, 900);
    const panel = document.createElement("div");
    panel.style.cssText = "display:flex;flex-direction:column;width:1000px;";
    document.body.appendChild(panel);
    render(HeavySlotStrip, { target: panel, props: { heavySlot: longSnap(), sessions } });
    const cmd = document.querySelector(".hs-cmd") as HTMLElement;
    expect(cmd.textContent).toBe(`Running ${LABEL}`);
    expect(cmd.clientHeight).toBeLessThanOrEqual(lineHeight() + 1);
    expect(cmd.scrollWidth).toBeGreaterThan(cmd.clientWidth);
    const ruler = document.createElement("span");
    ruler.textContent = "0".repeat(40);
    cmd.parentElement!.appendChild(ruler);
    expect(cmd.getBoundingClientRect().width).toBeLessThanOrEqual(
      ruler.getBoundingClientRect().width + 1,
    );
    expect(document.querySelector(".hs-holder")?.getAttribute("title")).toBe(LONG);
  });

  it("closes off its panel in the document flow, rows stacked", async () => {
    render(HeavySlotStrip, { heavySlot: snap(), sessions });
    const strip = document.querySelector<HTMLElement>(".hs-strip")!;
    expect(getComputedStyle(strip).position).toBe("static");
    const [a, b] = [...strip.querySelectorAll(".hs-rows > li")].map((li) =>
      li.getBoundingClientRect(),
    );
    expect(b.top).toBeGreaterThanOrEqual(a.bottom);
  });
});

describe("HostPopover — last results", () => {
  const result = (sessionId: string, endedAt: number, stale = false) => ({
    sessionId,
    command: "vitest run",
    startedAt: 0,
    endedAt,
    exitCode: 0,
    result: "passed" as const,
    head: "a1b2c3d4e5",
    treeHash: "t",
    stale,
  });
  const many = Array.from({ length: 7 }, (_, i) => result(`r${i}`, i, i < 2));
  const names = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `result-${i}` }));
  const props = (lastResults = many) => ({
    heavySlot: snap({ lastResults }),
    sessions: [...sessions, ...names(7)],
    nowMs: 0,
    onrelease: vi.fn(),
    onClose: vi.fn(),
  });
  const shown = () =>
    [...document.querySelectorAll("section:last-of-type .hp-name")].map((n) => n.textContent);

  it("comes after pressure and memory by origin", async () => {
    render(HostPopover, props());
    const heads = [...document.querySelectorAll("h3")].map((h) => h.textContent);
    expect(heads).toEqual([
      "Holding the slot",
      "Queue",
      "Pressure",
      "Memory by origin",
      "Last check results",
    ]);
  });

  it("lists the five newest and reveals the rest on request", async () => {
    render(HostPopover, props());
    expect(shown()).toEqual(["result-6", "result-5", "result-4", "result-3", "result-2"]);
    await userEvent.click(page.getByRole("button", { name: "Show all (7)" }));
    expect(shown()).toHaveLength(7);
    expect(document.querySelector(".hp-more")?.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(page.getByRole("button", { name: "Show fewer" }));
    expect(shown()).toHaveLength(5);
  });

  it("explains staleness once, and only when a shown result is stale", async () => {
    render(HostPopover, props());
    expect(document.body.textContent).not.toContain("source changed");
    await userEvent.click(page.getByRole("button", { name: "Show all (7)" }));
    expect(document.body.textContent?.match(/source changed/g)).toHaveLength(1);
    expect(document.querySelectorAll(".hp-res-stale")).toHaveLength(2);
  });

  it("offers no toggle at or under five results", async () => {
    render(HostPopover, props(many.slice(0, 5)));
    expect(document.querySelector(".hp-more")).toBeNull();
  });
});

describe("Check slots across connected machines", () => {
  function machine(slot: HeavySlotSnapshot, stale = false): RemoteInstance {
    return {
      instanceId: "mac-1",
      name: "macbook",
      label: null,
      reportedName: "macbook",
      url: "https://macbook.example.ts.net",
      tokenHint: null,
      createdAt: 1,
      status: stale ? "unreachable" : "connected",
      reason: null,
      checkedAt: 0,
      lastSeenAt: 0,
      info: null,
      projects: null,
      capabilities: null,
      heavySlot: { snapshot: slot, readAt: Date.UTC(2026, 10, 4, 13, 2), stale },
      released: true,
    };
  }
  const macSessions = [
    ...sessions,
    { id: "mh", name: "mac-holder" },
    ...[1, 2, 3, 4, 5].map((n) => ({ id: `m${n}`, name: `mac-waiter-${n}` })),
  ];
  const macSlot = (waiting: number) =>
    snap({
      holders: [{ sessionId: "mh", command: "cat >> x", startedAt: 0, rssBytes: GIB }],
      waiters: Array.from({ length: waiting }, (_, i) => ({
        sessionId: `m${i + 1}`,
        position: i + 1,
        reason: "slot" as const,
      })),
    });

  it("strip: one lane per machine with work, three waiters each, the rest on request", async () => {
    const onselect = vi.fn();
    render(HeavySlotStrip, {
      heavySlot: snap(),
      machines: [machine(macSlot(5))],
      sessions: macSessions,
      onselect,
    });
    const lanes = [...document.querySelectorAll(".hs-machine")].map((n) => n.textContent);
    expect(lanes).toEqual(["macbook", "This Shepherd"]);
    expect(document.querySelector(".hs-total")?.textContent).toBe("■ 2/2 · ◔ 7");
    await expect.element(page.getByText("mac-waiter-3")).toBeVisible();
    expect(document.body.textContent).not.toContain("mac-waiter-4");
    await userEvent.click(page.getByRole("button", { name: "+ 2 more on macbook" }));
    await expect.element(page.getByText("mac-waiter-5")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /mac-waiter-5/ }));
    expect(onselect).toHaveBeenCalledWith("m5");
  });

  it("strip: only the busy machine's lane, its whole queue, while this one idles", async () => {
    render(HeavySlotStrip, {
      heavySlot: snap({ holders: [], waiters: [] }),
      machines: [machine(macSlot(5))],
      sessions: macSessions,
    });
    const lanes = [...document.querySelectorAll(".hs-machine")].map((n) => n.textContent);
    expect(lanes).toEqual(["macbook"]);
    expect(document.querySelector(".hs-total")?.textContent).toBe("■ 1/2 · ◔ 5");
    await expect.element(page.getByText("mac-waiter-5")).toBeVisible();
    expect(document.querySelector(".hs-more")).toBeNull();
  });

  it("strip: an unreachable machine keeps its last known queue, saying since when", async () => {
    render(HeavySlotStrip, {
      heavySlot: null,
      machines: [machine(macSlot(1), true)],
      sessions: macSessions,
    });
    await expect.element(page.getByText(/^Unreachable · as of/)).toBeVisible();
    await expect.element(page.getByText("mac-waiter-1")).toBeVisible();
  });

  it("chip: a segment per machine with work, every machine named for screen readers", async () => {
    render(HeavySlotChip, {
      heavySlot: snap(),
      machines: [machine(macSlot(5))],
      sessions: macSessions,
      nowMs: 0,
      onrelease: vi.fn(),
      compact: true,
    });
    const chip = page.getByRole("button", {
      name: "Check slots: macbook 1 of 1 held, 5 waiting; This Shepherd 1 of 1 held, 2 waiting. Open details.",
    });
    await expect.element(chip).toBeVisible();
    expect(document.querySelectorAll(".hs-seg")).toHaveLength(2);
    expect(chip.element().classList.contains("idle")).toBe(false);
  });

  it("chip: quiet totals when no machine has work", async () => {
    render(HeavySlotChip, {
      heavySlot: snap({ holders: [], waiters: [] }),
      machines: [machine(snap({ holders: [], waiters: [] }))],
      nowMs: 0,
      onrelease: vi.fn(),
      compact: true,
    });
    const chip = document.querySelector(".hs-chip");
    expect(chip?.classList.contains("idle")).toBe(true);
    expect(chip?.textContent).toContain("■ 0/2");
    expect(document.querySelectorAll(".hs-seg")).toHaveLength(0);
  });

  it("popover: a section per machine, details folded, release only for this one's slot", async () => {
    render(HostPopover, {
      heavySlot: snap(),
      machines: [machine(macSlot(2))],
      sessions: macSessions,
      nowMs: 0,
      onrelease: vi.fn(),
      onClose: vi.fn(),
    });
    await expect.element(page.getByRole("dialog", { name: "Check slots" })).toBeVisible();
    const sections = [...document.querySelectorAll(".hp-machine")];
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["macbook", "This Shepherd"]);
    expect(sections[0].querySelector(".hp-btn")).toBeNull();
    expect(sections[1].querySelector(".hp-btn")?.textContent?.trim()).toBe("Release");
    expect(document.body.textContent).not.toContain("Memory by origin");
    const fold = page.getByRole("button", { name: /Pressure & memory/ }).first();
    await userEvent.click(fold);
    await expect.element(page.getByText("Memory by origin").first()).toBeVisible();
  });
});
