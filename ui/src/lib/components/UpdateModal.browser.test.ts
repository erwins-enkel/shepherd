import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { DeployState, DirtyStatus, UpdateStatus } from "#lib/types.js";

vi.mock("#lib/api.js", async (orig) => ({
  ...((await orig()) as object),
  applyUpdate: vi.fn(() => new Promise(() => {})),
  getUpdateDirty: vi.fn(async () => ({ dirty: false, dirtyFiles: [], dirtyCount: 0, sig: null })),
  getInstance: vi.fn(async () => ({ name: "moes-tavern", platform: "linux" })),
  applyMachineUpdate: vi.fn(async () => {}),
  getMachineUpdateLog: vi.fn(async () => ({ phase: "done", exitCode: 0, log: "" })),
  getMachineUpdateDirty: vi.fn(async () => ({
    dirty: false,
    dirtyFiles: [],
    dirtyCount: 0,
    sig: null,
  })),
  checkRemoteInstance: vi.fn(async () => ({})),
}));

import UpdateModal from "./UpdateModal.svelte";
import { theme } from "#lib/theme.svelte.js";
import {
  applyMachineUpdate,
  applyUpdate,
  getMachineUpdateDirty,
  getMachineUpdateLog,
  getUpdateDirty,
} from "#lib/api.js";
import type { MachineUpdate } from "#lib/types.js";

const mockApply = applyUpdate as unknown as ReturnType<typeof vi.fn>;
const mockDirty = getUpdateDirty as unknown as ReturnType<typeof vi.fn>;
const mockApplyMachine = applyMachineUpdate as unknown as ReturnType<typeof vi.fn>;
const mockMachineLog = getMachineUpdateLog as unknown as ReturnType<typeof vi.fn>;
const mockMachineDirty = getMachineUpdateDirty as unknown as ReturnType<typeof vi.fn>;
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
  mockApplyMachine.mockReset();
  mockApplyMachine.mockResolvedValue(undefined);
  mockMachineLog.mockReset();
  mockMachineLog.mockResolvedValue({ phase: "done", exitCode: 0, log: "" });
  mockMachineDirty.mockReset();
  theme.setMotion("system");
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

  it("faces every actor the way it actually travels", async () => {
    await page.viewport(1280, 900);

    render(UpdateModal, { props: { update, updating: true, deploy } });

    const actors = [...document.querySelectorAll<SVGElement>('[data-flock="backdrop"] .actor')];
    expect(actors.length).toBeGreaterThan(4);
    for (const a of actors) {
      // `--distance` is the signed ground travel; the sprites are drawn facing
      // right. A mismatch here is an animal moon-walking across the pasture.
      const travel = parseFloat(a.style.getPropertyValue("--distance"));
      expect(travel, `${a.className.baseVal} has no travel`).not.toBe(0);
      expect(a.dataset.facing, `${a.className.baseVal} travels ${travel}vw`).toBe(
        travel < 0 ? "left" : "right",
      );
    }
  });

  it("keeps every actor inside the pasture band — nothing clipped at the edges", async () => {
    for (const [w, h] of [
      [1280, 900],
      [1440, 900],
    ] as const) {
      await page.viewport(w, h);
      render(UpdateModal, { props: { update, updating: true, deploy } });

      const flock = document.querySelector<HTMLElement>('[data-flock="backdrop"]')!;
      const band = flock.querySelector<HTMLElement>(".pasture")!.getBoundingClientRect();
      const actors = [...flock.querySelectorAll<SVGElement>(".actor")];
      expect(actors.length).toBeGreaterThan(4);
      for (const a of actors) {
        const r = a.getBoundingClientRect();
        expect(
          r.bottom,
          `${a.className.baseVal} at ${w}x${h} sinks below the band`,
        ).toBeLessThanOrEqual(band.bottom + 0.5);
        expect(
          r.top,
          `${a.className.baseVal} at ${w}x${h} rises above the band`,
        ).toBeGreaterThanOrEqual(band.top - 0.5);
      }
      document.body.innerHTML = "";
    }
  });

  it("stands the flock on a horizon rather than letting it float", async () => {
    await page.viewport(1280, 900);

    render(UpdateModal, { props: { update, updating: true, deploy } });

    const flock = document.querySelector<HTMLElement>('[data-flock="backdrop"]')!;
    const horizon = flock.querySelector<HTMLElement>(".horizon")!;
    expect(horizon).not.toBeNull();
    const hr = horizon.getBoundingClientRect();
    // Far animals stand beyond the horizon line, near ones in front of it.
    const far = flock.querySelector<SVGElement>(".actor.far")!.getBoundingClientRect();
    const near = flock.querySelector<SVGElement>(".actor.near")!.getBoundingClientRect();
    expect(far.bottom).toBeGreaterThan(hr.bottom);
    expect(near.bottom).toBeGreaterThan(far.bottom);
    expect(far.height).toBeLessThan(near.height);
  });

  it('keeps the flock moving when the operator picked "full" motion', async () => {
    mockReducedMotion(true); // the system says reduce…
    theme.setMotion("full"); // …and the operator overruled it

    render(UpdateModal, { props: { update, updating: true, deploy } });

    const flock = document.querySelector<HTMLElement>('[data-flock="backdrop"]')!;
    expect(flock.dataset.reduced).toBe("false");
    expect(getComputedStyle(flock.querySelector(".actor")!).animationName).not.toBe("none");
  });

  it('stills the flock when the operator picked "reduced" motion', async () => {
    mockReducedMotion(false); // the system says nothing…
    theme.setMotion("reduced"); // …and the operator asked for calm

    render(UpdateModal, { props: { update, updating: true, deploy } });

    const flock = document.querySelector<HTMLElement>('[data-flock="backdrop"]')!;
    await vi.waitFor(() => expect(flock.dataset.reduced).toBe("true"));
    expect(getComputedStyle(flock.querySelector(".actor")!).animationName).toBe("none");
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

  // ── every machine ──────────────────────────────────────────────────────────

  const machine = (over: Partial<MachineUpdate> = {}): MachineUpdate => ({
    instanceId: "mac",
    name: "MacBook",
    platform: "macos",
    status: "connected",
    update: {
      behind: 11,
      current: "bb73c95",
      latest: "048d35c",
      commits: [{ sha: "048d35c", subject: "fix(mac): add web backend app menu item" }],
      checkedAt: 0,
    },
    ...over,
  });
  const vps = machine({
    instanceId: "vps",
    name: "hetzner-vps",
    platform: "linux",
    update: { behind: 0, current: "048d35c", latest: "048d35c", commits: [], checkedAt: 0 },
  });
  const nas = machine({ instanceId: "nas", name: "nas", status: "unreachable" });
  const rowOf = (name: string) => document.querySelector<HTMLElement>(`[data-machine="${name}"]`)!;

  it("lists every machine with the update it needs, beside this one", async () => {
    render(UpdateModal, {
      props: { update, updating: false, deploy: null, machines: [machine(), vps, nas] },
    });

    await vi.waitFor(() => expect(rowOf("moes-tavern")).toBeTruthy());
    expect(document.body.textContent).toContain("of 4 machines need an update");
    expect(rowOf("MacBook").textContent).toContain("bb73c95 → 048d35c · 11 commits");
    expect(rowOf("hetzner-vps").textContent).toContain("Up to date");
    expect(rowOf("nas").textContent).toContain("Unreachable");
    expect(rowOf("nas").querySelector("button")).toBeNull(); // nothing to start out of reach
    await vi.waitFor(() => expect(btn(/update all \(2\)/i)).toBeTruthy());
  });

  it("a row's own button updates only that machine", async () => {
    render(UpdateModal, {
      props: { update, updating: false, deploy: null, machines: [machine(), vps] },
    });

    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Update MacBook" })).toBeTruthy(),
    );
    await page.getByRole("button", { name: "Update MacBook" }).click();
    await vi.waitFor(() => expect(mockApplyMachine).toHaveBeenCalledWith("mac", false, undefined));
    await vi.waitFor(() => expect(rowOf("MacBook").textContent).toContain("Updated"), {
      timeout: 5000,
    });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("update all starts the other machines first and this one only once they are through", async () => {
    let finish!: () => void;
    const through = new Promise<void>((r) => (finish = r));
    mockMachineLog.mockImplementation(async () => {
      await through;
      return { phase: "done", exitCode: 0, log: "" };
    });
    render(UpdateModal, {
      props: { update, updating: false, deploy: null, machines: [machine(), vps] },
    });

    await vi.waitFor(() => expect(btn(/update all \(2\)/i)).toBeTruthy());
    expect(document.body.textContent).toContain("this machine goes last");
    btn(/update all \(2\)/i)!.click();

    await vi.waitFor(() => expect(mockApplyMachine).toHaveBeenCalledWith("mac", false, undefined));
    await vi.waitFor(() => expect(rowOf("moes-tavern").textContent).toContain("Waiting"));
    expect(mockApply).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(mockApply).toHaveBeenCalledWith(false), { timeout: 5000 });
  });

  it("a machine blocked by local changes holds this one back until it is skipped", async () => {
    mockMachineLog.mockResolvedValue({
      phase: "failed",
      exitCode: 1,
      log: "--pull needs a clean tree",
      reason: "dirty",
    });
    mockMachineDirty.mockResolvedValue(DIRTY({ dirtyFiles: [" M native/Client.swift"] }));
    render(UpdateModal, {
      props: { update, updating: false, deploy: null, machines: [machine()] },
    });

    await vi.waitFor(() => expect(btn(/update all \(2\)/i)).toBeTruthy());
    btn(/update all \(2\)/i)!.click();

    await vi.waitFor(() => expect(rowOf("MacBook").textContent).toContain("Blocked"), {
      timeout: 5000,
    });
    expect(rowOf("MacBook").textContent).toContain("native/Client.swift");
    expect(mockApply).not.toHaveBeenCalled();

    btn(/^skip$/i)!.click();
    await vi.waitFor(() => expect(mockApply).toHaveBeenCalledWith(false));
    expect(rowOf("MacBook").textContent).toContain("Skipped");
  });

  it("a machine that drops out mid-run no longer holds this one back", async () => {
    mockMachineLog.mockImplementation(() => new Promise(() => {})); // never answers
    const screen = await render(UpdateModal, {
      props: { update, updating: false, deploy: null, machines: [machine(), vps] },
    });

    await vi.waitFor(() => expect(btn(/update all \(2\)/i)).toBeTruthy());
    btn(/update all \(2\)/i)!.click();
    await vi.waitFor(() => expect(rowOf("moes-tavern").textContent).toContain("Waiting"));

    // removed from this Shepherd (or gone from the list) while its update was being followed
    await screen.rerender({ machines: [vps] });
    await vi.waitFor(() => expect(mockApply).toHaveBeenCalledWith(false));
  });
});
