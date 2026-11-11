import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import ShapeRound from "./ShapeRound.svelte";
import type { ShapeRound as ShapeRoundData } from "#lib/types.js";

const round: ShapeRoundData = {
  draft: {
    problem: "The reaper leaks tabs across a restart.",
    outcome: "No orphan tab survives a restart.",
    constraints: ["Keep the label vocabulary"],
    nonGoals: ["Rewriting herdr"],
  },
  block: {
    type: "question-form",
    id: "shape-questions",
    questions: [
      { id: "q1", prompt: "Which reaper?", kind: "single", options: ["tab", "transient"] },
    ],
  },
};

const ENGINE = "Claude Code · Opus (latest)";

// The props every state takes besides its own: the engine chip and the ways out of a failed round.
const chrome = () => ({
  engineLabel: ENGINE,
  onshowengine: vi.fn(),
  onretry: vi.fn(),
  onstartplain: vi.fn(),
});

describe("ShapeRound", () => {
  it("shows a running state with no draft and no questions yet", async () => {
    const { container } = await render(ShapeRound, {
      status: "running",
      onuse: vi.fn(),
      ondismiss: vi.fn(),
      ...chrome(),
    });
    await expect
      .element(page.getByText("Reading the repo and drafting questions…"))
      .toBeInTheDocument();
    expect(container.querySelectorAll("input").length).toBe(0);
  });

  it("renders the draft, the question count, and hands answers to the parent", async () => {
    const onuse = vi.fn();
    const { container } = await render(ShapeRound, {
      status: "ready",
      round,
      onuse,
      ondismiss: vi.fn(),
      ...chrome(),
    });
    await expect
      .element(page.getByText("The reaper leaks tabs across a restart."))
      .toBeInTheDocument();
    await expect.element(page.getByText("No orphan tab survives a restart.")).toBeInTheDocument();
    await expect.element(page.getByText("Keep the label vocabulary")).toBeInTheDocument();
    await expect.element(page.getByText("Rewriting herdr")).toBeInTheDocument();
    await expect.element(page.getByText("1 to settle")).toBeInTheDocument();

    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await page.elementLocator(radios[1]!).click();
    await page.getByRole("button", { name: "Use brief" }).click();
    expect(onuse).toHaveBeenCalledTimes(1);
    expect(onuse.mock.calls[0]![0]).toEqual([
      { blockId: "shape-questions", questionId: "q1", optionIndices: [1] },
    ]);
  });

  it("omits draft sections the helper left empty rather than showing bare labels", async () => {
    const { container } = await render(ShapeRound, {
      status: "ready",
      round: {
        ...round,
        draft: { problem: "just this", outcome: "", constraints: [], nonGoals: [] },
      },
      onuse: vi.fn(),
      ondismiss: vi.fn(),
      ...chrome(),
    });
    expect(container.textContent).toContain("Problem");
    expect(container.textContent).not.toContain("Outcome");
    expect(container.textContent).not.toContain("Non-goals");
  });

  it("maps each error slug to its own message", async () => {
    for (const [errorKey, copy] of [
      ["spawn-failed", "Couldn't start the shaping round. Try again."],
      ["unavailable", "Shaping is unavailable: API-key mode is on but no key is configured."],
      ["timeout", "The shaping round didn't finish in time."],
    ] as const) {
      const { container, unmount } = await render(ShapeRound, {
        status: "error",
        errorKey,
        onuse: vi.fn(),
        ondismiss: vi.fn(),
        ...chrome(),
      });
      expect(container.textContent).toContain(copy);
      unmount();
    }
  });

  it("dismisses the round on the operator's say-so, in every state", async () => {
    const ondismiss = vi.fn();
    // A running round is cancelled: there is nothing to discard yet.
    const running = await render(ShapeRound, {
      status: "running",
      onuse: vi.fn(),
      ondismiss,
      ...chrome(),
    });
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(ondismiss).toHaveBeenCalledTimes(1);
    running.unmount();

    await render(ShapeRound, { status: "ready", round, onuse: vi.fn(), ondismiss, ...chrome() });
    await page.getByRole("button", { name: "Discard" }).click();
    expect(ondismiss).toHaveBeenCalledTimes(2);
  });
});

// The running round's DOM: what the wait shows at each point of the clock, the engine chip and the
// ways out. The clock's thresholds themselves are pinned at the unit seam (new-task/shape.test.ts).

function props(over: Record<string, unknown> = {}) {
  return {
    status: "running" as const,
    engineLabel: ENGINE,
    onuse: vi.fn(),
    ondismiss: vi.fn(),
    onshowengine: vi.fn(),
    onretry: vi.fn(),
    onstartplain: vi.fn(),
    ...over,
  };
}

const text = () => document.querySelector(".shape")?.textContent ?? "";
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".shape button")].find(
    (b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name,
  );

describe("ShapeRound while running", () => {
  it("names the engine the round runs on and shows the elapsed clock", async () => {
    await render(ShapeRound, { props: props({ elapsedMs: 23_000 }) });
    expect(text()).toContain(ENGINE);
    expect(text()).toContain("00:23");
    expect(text()).toContain(m.shape_running());
    expect(text()).toContain(m.shape_skeleton_label());
    expect(button(m.common_cancel())).toBeTruthy();
  });

  it("says when the wait runs long, and counts down with a way out before the deadline", async () => {
    const { rerender } = await render(ShapeRound, { props: props({ elapsedMs: 60_000 }) });
    expect(text()).toContain(m.shape_wait_long());
    expect(button(m.shape_start_plain())).toBeUndefined();

    await rerender(props({ elapsedMs: 155_000 }));
    await expect.poll(text).toContain(m.shape_wait_closing());
    expect(text()).toContain(m.shape_clock_remaining({ remaining: "00:25" }));
    expect(button(m.shape_start_plain())).toBeTruthy();
  });

  it("keeps the ticking clock out of the live region", async () => {
    await render(ShapeRound, { props: props({ elapsedMs: 23_000 }) });
    const live = document.querySelector('.shape [role="status"]');
    expect(live?.textContent).toBe(m.shape_running());
    expect(document.querySelector(".shape-clock")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("pages through the hints in both directions", async () => {
    await render(ShapeRound, { props: props({ elapsedMs: 0 }) });
    const tip = () => document.querySelector(".shape-tip")?.textContent;
    expect(tip()).toBe(m.shape_tip_questions());
    button(m.shape_tip_next_aria())!.click();
    await expect.poll(tip).toBe(m.shape_tip_no_session());
    button(m.shape_tip_prev_aria())!.click();
    button(m.shape_tip_prev_aria())!.click();
    await expect.poll(tip).toBe(m.shape_tip_deadline({ minutes: 3 }));
  });

  it("points at the engine setting when the engine chip is clicked", async () => {
    const p = props();
    await render(ShapeRound, { props: p });
    button(m.shape_engine_aria({ engine: ENGINE }))!.click();
    expect(p.onshowengine).toHaveBeenCalledOnce();
  });
});

describe("ShapeRound after a failed round", () => {
  it("offers another go or a plain start when the round never came back", async () => {
    const p = props({ status: "error", errorKey: "timeout" });
    await render(ShapeRound, { props: p });
    expect(text()).toContain(m.shape_err_timeout());
    button(m.shape_retry())!.click();
    button(m.shape_start_plain())!.click();
    expect(p.onretry).toHaveBeenCalledOnce();
    expect(p.onstartplain).toHaveBeenCalledOnce();
  });

  it("offers neither when the failure names its own fix", async () => {
    await render(ShapeRound, { props: props({ status: "error", errorKey: "unavailable" }) });
    expect(button(m.shape_retry())).toBeUndefined();
    expect(button(m.shape_start_plain())).toBeUndefined();
  });
});
