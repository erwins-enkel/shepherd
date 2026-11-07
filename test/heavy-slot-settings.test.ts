import { expect, test } from "bun:test";
import {
  EMPTY_HEAVY_SLOT_SETTINGS,
  parseHeavySlotPatch,
  effectiveHeavySlot,
  heavySlotDefaults,
  storedHeavySlotSettings,
} from "../src/heavy-slot-settings";
import { recordHeavyPeak } from "../src/heavy-slot-apply";
import { SessionStore } from "../src/store";
import { isHeavyCommand } from "../scripts/tool-guard.mjs";

test("settings validate bounded waiting and preserve disabled values across persistence", () => {
  const parsed = parseHeavySlotPatch(
    { enabled: false, slots: 3, waitMinutes: 5, brake: { psiFullMax: 12 } },
    EMPTY_HEAVY_SLOT_SETTINGS,
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const saved = storedHeavySlotSettings(JSON.stringify(parsed.value));
  expect(saved).toMatchObject({ enabled: false, slots: 3, waitMinutes: 5 });
  expect(
    effectiveHeavySlot(
      saved,
      { cpus: 16, memTotalBytes: 32 * 1024 ** 3 },
      { enabled: true, slots: 0 },
    ),
  ).toMatchObject({ enabled: false, budget: { slots: 3, psiFullMax: 12 } });
  for (const waitMinutes of [-1, 1.5, 61, "5"])
    expect(parseHeavySlotPatch({ waitMinutes }, saved).ok).toBe(false);
});

test("last measured peak replaces an older larger run", () => {
  const store = new SessionStore(":memory:");
  recordHeavyPeak(store, "vitest run", 2000);
  recordHeavyPeak(store, "vitest run", 1000);
  expect(JSON.parse(store.getSetting("heavySlotPeaks")!)).toEqual({ vitest: 1000 });
});

test("custom commands replace built-ins and disabled commands no longer count", () => {
  const heavyList = () => ({
    disabled: ["vitest"],
    custom: [
      { command: "cargo", subcommands: ["bench"] },
      { command: "mycheck", subcommands: [] },
    ],
  });
  expect(isHeavyCommand("vitest run", "/", { heavyList })).toBe(false);
  expect(isHeavyCommand("cargo test", "/", { heavyList })).toBe(false);
  expect(isHeavyCommand("cargo bench", "/", { heavyList })).toBe(true);
  expect(isHeavyCommand("mycheck", "/", { heavyList })).toBe(true);
});

test("custom entries can be disabled without deleting the saved rule", () => {
  expect(
    isHeavyCommand("mycheck test", "/", {
      heavyList: () => ({
        custom: [{ command: "mycheck", subcommands: [] }],
        disabled: ["mycheck"],
      }),
    }),
  ).toBe(false);
});

test("unknown brake keys return a validation error, including inherited object names", () => {
  for (const key of ["constructor", "__proto__", "toString"]) {
    const patch = JSON.parse(`{"brake":{"${key}":10}}`);
    expect(parseHeavySlotPatch(patch, EMPTY_HEAVY_SLOT_SETTINGS).ok).toBe(false);
  }
});

test("memory per heavy run (#3555): null = a quarter of RAM in 4–16 GiB, else 512 MiB–1 TiB", () => {
  const GIB = 1024 ** 3;
  const run = (memTotalBytes: number, runMemoryMaxMiB: number | null = null) =>
    effectiveHeavySlot(
      { ...EMPTY_HEAVY_SLOT_SETTINGS, runMemoryMaxMiB },
      { cpus: 8, memTotalBytes },
      { enabled: true, slots: 0 },
    ).runMemoryMaxBytes;
  expect(run(8 * GIB)).toBe(4 * GIB);
  expect(run(32 * GIB)).toBe(8 * GIB);
  expect(run(128 * GIB)).toBe(16 * GIB);
  expect(run(128 * GIB, 6144)).toBe(6 * GIB);
  expect(heavySlotDefaults({ cpus: 8, memTotalBytes: 32 * GIB }).runMemoryMaxMiB).toBe(8192);

  const parsed = parseHeavySlotPatch({ runMemoryMaxMiB: 6144 }, EMPTY_HEAVY_SLOT_SETTINGS);
  expect(parsed.ok && storedHeavySlotSettings(JSON.stringify(parsed.value)).runMemoryMaxMiB).toBe(
    6144,
  );
  expect(parseHeavySlotPatch({ runMemoryMaxMiB: null }, EMPTY_HEAVY_SLOT_SETTINGS).ok).toBe(true);
  for (const runMemoryMaxMiB of [511, 1024 * 1024 + 1, 1.5, "6144"])
    expect(parseHeavySlotPatch({ runMemoryMaxMiB }, EMPTY_HEAVY_SLOT_SETTINGS).ok).toBe(false);
});
