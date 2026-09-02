import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import ShapeRound from "./ShapeRound.svelte";
import type { ShapeRound as ShapeRoundData } from "$lib/types";

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

describe("ShapeRound", () => {
  it("shows a running state with no draft and no questions yet", async () => {
    const { container } = await render(ShapeRound, {
      status: "running",
      onuse: vi.fn(),
      ondismiss: vi.fn(),
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
      });
      expect(container.textContent).toContain(copy);
      unmount();
    }
  });

  it("dismisses the round on the operator's say-so, in every state", async () => {
    const ondismiss = vi.fn();
    await render(ShapeRound, { status: "running", onuse: vi.fn(), ondismiss });
    await page.getByRole("button", { name: "Discard" }).click();
    expect(ondismiss).toHaveBeenCalledTimes(1);
  });
});
