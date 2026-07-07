import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { DeployState, UpdateStatus } from "$lib/types";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyUpdate: vi.fn(() => new Promise(() => {})),
}));

import UpdateModal from "./UpdateModal.svelte";

const update: UpdateStatus = {
  behind: 1,
  current: "abc1234",
  latest: "def5678",
  commits: [{ sha: "def5678", subject: "Fix update modal scrollbar overflow" }],
  checkedAt: 0,
};

const deploy: DeployState = {
  phase: "running",
  exitCode: null,
  log: [
    "=== shepherd-update 2026-07-01T07:10:00Z abc1234 -> def5678 ===",
    "bun install",
    "bun run build",
    "restarting shepherd",
    "waiting for server",
  ].join("\n"),
};

afterEach(async () => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  await page.viewport(1280, 900);
});

describe("UpdateModal", () => {
  function mockReducedMotion(matches: boolean) {
    const real = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      if (query === "(prefers-reduced-motion: reduce)") {
        return {
          matches,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      }
      return real(query);
    });
  }

  it("keeps modal chrome from creating stray scrollbars with an active deploy log", async () => {
    await page.viewport(800, 600);

    render(UpdateModal, {
      props: {
        update,
        updating: true,
        deploy,
      },
    });

    await vi.waitFor(() => expect(document.querySelector(".log")).not.toBeNull());

    const card = document.querySelector<HTMLElement>(".card");
    expect(card).not.toBeNull();
    expect(card!.scrollWidth, "dialog should not have horizontal overflow").toBeLessThanOrEqual(
      card!.clientWidth,
    );
    expect(
      card!.scrollHeight,
      "dialog should not need its own vertical scrollbar",
    ).toBeLessThanOrEqual(card!.clientHeight + 1);
  });

  it("does not render the decorative flock before the update is busy", async () => {
    render(UpdateModal, {
      props: {
        update,
        updating: false,
        deploy: null,
      },
    });

    expect(document.querySelector("[data-flock]")).toBeNull();
  });

  it("shows a viewport-wide flock layer behind the desktop dialog while busy", async () => {
    await page.viewport(1280, 900);

    render(UpdateModal, {
      props: {
        update,
        updating: true,
        deploy,
      },
    });

    const flock = document.querySelector<HTMLElement>('[data-flock="backdrop"]');
    const sheet = document.querySelector<HTMLElement>('[data-flock="sheet"]');
    const sheep = flock?.querySelector<SVGElement>('[data-flock-actor="sheep"]');
    const dog = flock?.querySelector<SVGElement>('[data-flock-actor="dog"]');
    const card = document.querySelector<HTMLElement>(".card");
    const run = page.getByRole("button", { name: /updating/i });

    expect(flock).not.toBeNull();
    expect(sheet).not.toBeNull();
    expect(sheep).not.toBeNull();
    expect(dog).not.toBeNull();
    expect(flock!.querySelector("pre")).toBeNull();
    expect(sheep!.tagName).toBe("svg");
    expect(sheep!.querySelector("[data-sheep-body]")).not.toBeNull();
    expect(dog!.querySelector("[data-dog-body]")).not.toBeNull();
    expect(card).not.toBeNull();
    await expect.element(run).toBeVisible();

    const flockRect = flock!.getBoundingClientRect();
    const cardRect = card!.getBoundingClientRect();
    expect(getComputedStyle(flock!).display).not.toBe("none");
    expect(getComputedStyle(sheet!).display).toBe("none");
    expect(flockRect.left).toBeLessThanOrEqual(1);
    expect(flockRect.right).toBeGreaterThanOrEqual(window.innerWidth - 1);
    expect(flockRect.left).toBeLessThan(cardRect.left);
    expect(flockRect.right).toBeGreaterThan(cardRect.right);
    expect(card!.scrollWidth, "dialog should not have horizontal overflow").toBeLessThanOrEqual(
      card!.clientWidth,
    );
  });

  it("keeps the mobile in-sheet flock visible while the sheet scrolls", async () => {
    await page.viewport(390, 220);

    render(UpdateModal, {
      props: {
        update: {
          ...update,
          commits: Array.from({ length: 14 }, (_, i) => ({
            sha: `def56${String(i).padStart(2, "0")}`,
            subject: `Fix update modal scrollbar overflow ${i}`,
          })),
        },
        updating: true,
        deploy,
      },
    });

    const backdrop = document.querySelector<HTMLElement>('[data-flock="backdrop"]');
    const sheet = document.querySelector<HTMLElement>('[data-flock="sheet"]');
    const card = document.querySelector<HTMLElement>(".card");

    expect(backdrop).not.toBeNull();
    expect(sheet).not.toBeNull();
    expect(card).not.toBeNull();
    expect(getComputedStyle(backdrop!).display).toBe("none");
    expect(getComputedStyle(sheet!).display).not.toBe("none");
    expect(
      card!.scrollHeight,
      "fixture should exercise the mobile sheet scroll path",
    ).toBeGreaterThan(card!.clientHeight);

    const before = sheet!.getBoundingClientRect();
    card!.scrollTop = 80;
    card!.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(card!.scrollTop).toBeGreaterThan(0));
    const after = sheet!.getBoundingClientRect();

    expect(after.top, "sheet flock should stay pinned to the visible sheet").toBeCloseTo(
      before.top,
      1,
    );
    expect(after.bottom).toBeGreaterThan(0);
    expect(after.top).toBeLessThan(window.innerHeight);
    expect(sheet!.querySelectorAll('[data-flock-actor="sheep"]').length).toBeGreaterThan(1);
    expect(sheet!.querySelector('[data-flock-actor="dog"]')).not.toBeNull();
    expect(sheet!.querySelector("pre")).toBeNull();
    expect(sheet!.querySelector("[data-sheep-body]")).not.toBeNull();
  });

  it("uses a testable static flock state when reduced motion is requested", async () => {
    mockReducedMotion(true);

    render(UpdateModal, {
      props: {
        update,
        updating: true,
        deploy,
      },
    });

    const flock = document.querySelector<HTMLElement>('[data-flock="backdrop"]');
    const actor = flock?.querySelector<SVGElement>(".actor");
    expect(flock).not.toBeNull();
    expect(actor).not.toBeNull();

    await vi.waitFor(() => expect(flock!.dataset.reduced).toBe("true"));
    expect(getComputedStyle(actor!).animationName).toBe("none");
    expect(flock!.querySelectorAll('[data-flock-actor="sheep"]').length).toBeGreaterThan(1);
    expect(flock!.querySelector("[data-sheep-body]")).not.toBeNull();
  });
});
