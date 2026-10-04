import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { getRepoConfig, putRepoConfig } from "$lib/api";
import { repoConfig } from "$lib/reviews.svelte";
import type { DrainRunSummary } from "$lib/types";
import { m } from "$lib/paraglide/messages";

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getRepoConfig: vi.fn(), putRepoConfig: vi.fn() };
});

const { default: SlotStepper } = await import("./SlotStepper.svelte");
const { default: EpicsListHeading } = await import("./EpicsListHeading.svelte");
const mockGet = vi.mocked(getRepoConfig);
const mockPut = vi.mocked(putRepoConfig);

// repoConfig is a module singleton, so every test steps its own repo.
let n = 0;
let repo = "";

const less = () => page.getByRole("button", { name: m.slotstepper_less() });
const more = () => page.getByRole("button", { name: m.slotstepper_more() });

beforeEach(() => {
  repo = `/repo/slots-${++n}`;
  mockGet.mockReset();
  mockPut.mockReset();
  // No stored config by default: the stepper starts from the server's cap.
  mockGet.mockRejectedValue(new Error("offline"));
  mockPut.mockImplementation(async (_repo, patch) => ({ ...patch }) as never);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SlotStepper", () => {
  it("steps the repo's cap up and down from the server's value", async () => {
    render(SlotStepper, { repoPath: repo, max: 2 });

    await more().click();
    expect(mockPut).toHaveBeenLastCalledWith(repo, { maxAuto: 3 });
    await more().click();
    expect(mockPut).toHaveBeenLastCalledWith(repo, { maxAuto: 4 });
    await less().click();
    expect(mockPut).toHaveBeenLastCalledWith(repo, { maxAuto: 3 });
  });

  it("starts from the stored config once it has loaded", async () => {
    mockGet.mockResolvedValue({ maxAuto: 5 } as never);
    render(SlotStepper, { repoPath: repo, max: 2 });

    await expect.poll(() => repoConfig.isConfigLoaded(repo)).toBe(true);
    await more().click();
    expect(mockPut).toHaveBeenLastCalledWith(repo, { maxAuto: 6 });
  });

  it("disables − at 1 and + at 20, the Limit field's bounds", async () => {
    render(SlotStepper, { repoPath: repo, max: 1 });
    await expect.element(less()).toBeDisabled();
    await expect.element(more()).toBeEnabled();
    document.body.innerHTML = "";

    render(SlotStepper, { repoPath: `${repo}-top`, max: 20 });
    await expect.element(more()).toBeDisabled();
    await expect.element(less()).toBeEnabled();
  });

  it("the slot count beside it shows the new cap at once, before the drain re-reports", async () => {
    const runSummary: DrainRunSummary = {
      leadingEpic: null,
      windingDown: [],
      slots: { used: 1, max: 2, holders: [] },
      next: [],
      after: [],
    };
    render(EpicsListHeading, { repoPath: repo, runSummary });
    const slots = () => document.querySelector(".slots")!.textContent;
    await expect.poll(slots).toContain("1/2");

    await more().click();
    await expect.poll(slots).toContain("1/3");
  });
});
