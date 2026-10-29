// Glue between the stored Settings → Resources values (src/heavy-slot-settings.ts) and the things
// they steer: the slot service, the guard's heavy-list file, and the measured peaks (#3552).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { config } from "./config";
import {
  commandsInLine,
  effectiveHeavySlot,
  HEAVY_SLOT_PEAKS_SETTING,
  HEAVY_SLOT_SETTING,
  heavyListFileBody,
  heavySlotDefaults,
  storedHeavyPeaks,
  storedHeavySlotSettings,
  type HeavySlotSettings,
} from "./heavy-slot-settings";
import { heavyDefaults } from "../scripts/tool-guard.mjs";
import type { HeavySlotConfig } from "./heavy-slot";

type SettingsStore = {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
};

const hardware = () => ({ cpus: cpus().length, memTotalBytes: totalmem() });

/** The master switch and budget in force: the operator's setting over the env defaults. */
export function resolveHeavySlotConfig(store: Pick<SettingsStore, "getSetting">): HeavySlotConfig {
  return {
    ...effectiveHeavySlot(
      storedHeavySlotSettings(store.getSetting(HEAVY_SLOT_SETTING)),
      hardware(),
      { enabled: config.heavySlot, slots: config.heavySlots },
    ),
    waitMinutes: storedHeavySlotSettings(store.getSetting(HEAVY_SLOT_SETTING)).waitMinutes,
  };
}

/** Write the operator's list edits where the guard and shims read them (atomic rename). */
export function writeHeavyListFile(
  settings: HeavySlotSettings,
  path = config.heavyListPath,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.heavy-list.${process.pid}.tmp`);
    writeFileSync(tmp, heavyListFileBody(settings));
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.warn(`[heavy-slot] could not write ${path}: ${(err as Error).message}`);
    return false;
  }
}

/** The GET /api/settings value: stored values plus what the page needs to explain them. */
export function heavySlotSettingsView(store: Pick<SettingsStore, "getSetting">) {
  const settings = storedHeavySlotSettings(store.getSetting(HEAVY_SLOT_SETTING));
  return {
    ...settings,
    enabled: settings.enabled ?? config.heavySlot,
    defaults: {
      ...heavySlotDefaults(hardware()),
      ...(config.heavySlots > 0 ? { slots: config.heavySlots } : {}),
      heavyList: heavyDefaults(),
    },
    peaks: storedHeavyPeaks(store.getSetting(HEAVY_SLOT_PEAKS_SETTING)),
  };
}

/** Remember the latest measured peak per list command a finished job ran. */
export function recordHeavyPeak(store: SettingsStore, command: string, peakBytes: number): void {
  const settings = storedHeavySlotSettings(store.getSetting(HEAVY_SLOT_SETTING));
  const names = [
    ...heavyDefaults().map((e) => e.command),
    ...settings.heavyList.custom.map((e) => e.command),
  ];
  const hit = commandsInLine(command, names);
  if (hit.length === 0) return;
  const peaks = storedHeavyPeaks(store.getSetting(HEAVY_SLOT_PEAKS_SETTING));
  let changed = false;
  for (const name of hit) {
    if (peakBytes !== peaks[name]) {
      peaks[name] = Math.round(peakBytes);
      changed = true;
    }
  }
  if (changed) store.setSetting(HEAVY_SLOT_PEAKS_SETTING, JSON.stringify(peaks));
}
