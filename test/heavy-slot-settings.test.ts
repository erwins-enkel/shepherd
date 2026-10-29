import { expect, test } from "bun:test";
import {
  EMPTY_HEAVY_SLOT_SETTINGS,
  parseHeavySlotPatch,
  effectiveHeavySlot,
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
