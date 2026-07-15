import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { DeployState, DirtyStatus, UpdateStatus } from "$lib/types";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyUpdate: vi.fn(() => new Promise(() => {})),
  getUpdateDirty: vi.fn(async () => ({ dirty: false, dirtyFiles: [], dirtyCount: 0, sig: null })),
}));

import UpdateModal from "./UpdateModal.svelte";
import { applyUpdate, getUpdateDirty } from "$lib/api";

const mockApply = applyUpdate as unknown as ReturnType<typeof vi.fn>;
const mockDirty = getUpdateDirty as unknown as ReturnType<typeof vi.fn>;
const DIRTY = (over: Partial<DirtyStatus> = {}): DirtyStatus => ({
  dirty: true,
  dirtyFiles: [" M src/a.ts"],
  dirtyCount: 1,
  sig: "SIG-1",
  ...over,
});
const btn = (re: RegExp) =>
  [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));

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
  mockApply.mockReset();
  mockApply.mockImplementation(() => new Promise(() => {}));
  mockDirty.mockReset();
  mockDirty.mockResolvedValue({ dirty: false, dirtyFiles: [], dirtyCount: 0, sig: null });
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

  // ── dirty-repo flow ────────────────────────────────────────────────────────

  it("discard is two-click: the first arms only, the second sends the displayed sig", async () => {
    mockDirty.mockResolvedValue(DIRTY({ sig: "SIG-1" }));
    mockApply.mockResolvedValue(undefined);
    render(UpdateModal, { props: { update, updating: false, deploy: null } });

    // proactive probe resolves → the discard button appears
    await vi.waitFor(() => expect(btn(/discard & update/i)).toBeTruthy());
    expect(document.body.textContent).toContain("src/a.ts"); // changed-file list

    btn(/discard & update/i)!.click(); // FIRST click: arm only
    await vi.waitFor(() => expect(btn(/yes, reset/i)).toBeTruthy());
    expect(mockApply).not.toHaveBeenCalled(); // no API call yet

    btn(/yes, reset/i)!.click(); // SECOND click: send
    await vi.waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith(true, "SIG-1");
  });

  it("a failed dirty probe falls back to an enabled Update now (never a stuck button)", async () => {
    mockDirty.mockRejectedValue(new Error("network"));
    render(UpdateModal, { props: { update, updating: false, deploy: null } });

    await vi.waitFor(() => {
      const b = btn(/update now/i);
      expect(b).toBeTruthy();
      expect((b as HTMLButtonElement).disabled).toBe(false);
    });
    expect(btn(/discard & update/i)).toBeFalsy();
  });

  it("too-large (sig:null) offers no discard button, just the manual hint", async () => {
    mockDirty.mockResolvedValue(DIRTY({ sig: null }));
    render(UpdateModal, { props: { update, updating: false, deploy: null } });

    await vi.waitFor(() => expect(document.body.textContent).toContain("src/a.ts"));
    expect(btn(/discard & update/i)).toBeFalsy();
    expect(document.body.textContent).toContain("too large");
  });

  it("a reactive stale failure shows the refreshed list + re-confirm, not the raw log", async () => {
    mockDirty.mockResolvedValue(DIRTY({ dirtyFiles: [" M src/fresh.ts"], sig: "SIG-2" }));
    const failedDeploy: DeployState = {
      phase: "failed",
      exitCode: 1,
      log: "SHEPHERD_DISCARD_STALE: working tree changed",
      reason: "stale",
    };
    render(UpdateModal, { props: { update, updating: false, deploy: failedDeploy } });

    await vi.waitFor(() => expect(btn(/discard & update/i)).toBeTruthy());
    expect(document.body.textContent).toContain("src/fresh.ts");
    expect(document.body.textContent).not.toContain("SHEPHERD_DISCARD_STALE"); // raw log hidden
  });

  it("a reactive dirty failure that is now clean offers a plain retry, no discard", async () => {
    mockDirty.mockResolvedValue({ dirty: false, dirtyFiles: [], dirtyCount: 0, sig: null });
    const failedDeploy: DeployState = {
      phase: "failed",
      exitCode: 1,
      log: "--pull needs a clean tree",
      reason: "dirty",
    };
    render(UpdateModal, { props: { update, updating: false, deploy: failedDeploy } });

    await vi.waitFor(() => expect(btn(/retry/i)).toBeTruthy());
    expect(btn(/discard & update/i)).toBeFalsy();
  });
});
