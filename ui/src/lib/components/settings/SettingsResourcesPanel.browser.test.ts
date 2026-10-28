import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { getSettings, getHeavySlot, putHeavyResources } from "#lib/api.js";
import type { HeavyResourceSettings, HeavySlotSnapshot, Settings } from "#lib/types.js";
import SettingsResourcesPanel from "./SettingsResourcesPanel.svelte";

vi.mock("#lib/api.js", async (original) => ({
  ...(await original<typeof import("#lib/api.js")>()),
  getSettings: vi.fn(),
  getHeavySlot: vi.fn(),
  putHeavyResources: vi.fn(),
}));
let settings: HeavyResourceSettings;
let snapshot: HeavySlotSnapshot;
beforeEach(() => {
  vi.resetAllMocks();
  settings = {
    enabled: true,
    slots: 2,
    waitMinutes: 0,
    brake: { minAvailableMiB: null, psiFullMax: null, releaseHoldSec: null },
    heavyList: { custom: [], disabled: [] },
    defaults: {
      slots: 1,
      minAvailableMiB: 4096,
      psiFullMax: 20,
      releaseHoldSec: 30,
      heavyList: [{ command: "cargo", subcommands: ["test", "build"] }],
    },
    peaks: { cargo: 1024 ** 3 },
  };
  snapshot = {
    enabled: true,
    capacity: 2,
    holders: [],
    waiters: [{ sessionId: "queued", position: 1, reason: "slot" }],
    brake: { active: false, reason: null },
    pressure: {
      ramAvailableBytes: 12 * 1024 ** 3,
      ramTotalBytes: 32 * 1024 ** 3,
      swapUsedBytes: null,
      swapTotalBytes: null,
      memFullAvg10: 0,
      memBrakeThreshold: 20,
      cpuSomeAvg10: null,
    },
    memoryBySource: { agentsBytes: null, foreignBytes: 1024 ** 3, foreignTop: [] },
    lastResults: [],
  };
  vi.mocked(getSettings).mockImplementation(
    async () => ({ heavySlot: structuredClone(settings) }) as Settings,
  );
  vi.mocked(getHeavySlot).mockImplementation(async () => structuredClone(snapshot));
  vi.mocked(putHeavyResources).mockImplementation(async (patch) => {
    settings = { ...settings, ...patch };
    return { heavySlot: structuredClone(settings) };
  });
});

it("warns before disabling queued work and retains disabled settings", async () => {
  render(SettingsResourcesPanel);
  await page.getByRole("switch", { name: m.resources_enabled() }).click();
  await expect.element(page.getByText(m.resources_disable_warning({ count: 1 }))).toBeVisible();
  expect(putHeavyResources).not.toHaveBeenCalled();
  await page.getByRole("button", { name: m.resources_disable_confirm() }).click();
  await expect
    .element(page.getByRole("spinbutton", { name: m.resources_slots(), exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("spinbutton", { name: m.resources_slots(), exact: true }))
    .toHaveValue(2);
  await page.getByRole("switch", { name: m.resources_enabled() }).click();
  await expect
    .element(page.getByRole("spinbutton", { name: m.resources_slots(), exact: true }))
    .toBeEnabled();
});

it("restores a failed slot save and reports the failure", async () => {
  vi.mocked(putHeavyResources).mockRejectedValue(new Error("offline"));
  render(SettingsResourcesPanel);
  const slots = page.getByRole("spinbutton", { name: m.resources_slots(), exact: true });
  await slots.fill("4");
  await page.getByRole("heading", { name: m.resources_now(), exact: true }).click();
  await expect.element(page.getByText(m.resources_save_failed())).toBeVisible();
  await expect.element(slots).toHaveValue(2);
});

it("edits a built-in command and saves only list overrides", async () => {
  render(SettingsResourcesPanel);
  await page
    .getByRole("button", { name: m.resources_edit_command({ command: "cargo" }), exact: true })
    .click();
  await page.getByRole("textbox", { name: m.resources_subcommands(), exact: true }).fill("bench");
  await page.getByRole("button", { name: m.common_save(), exact: true }).click();
  await expect.element(page.getByText("cargo bench", { exact: true })).toBeVisible();
  expect(putHeavyResources).toHaveBeenCalledWith({
    heavyList: { custom: [{ command: "cargo", subcommands: ["bench"] }], disabled: [] },
  });
});
