import { expect, test } from "bun:test";
import {
  parseDarwinPressure,
  parseVmStatAvailable,
  sampleMemoryDarwin,
} from "../src/heavy-slot-darwin";
import { BRAKE_OFF, defaultHeavySlotBudget, nextBrake } from "../src/heavy-slot-core";

const vm = (page = 4096) => `Mach Virtual Memory Statistics: (page size of ${page} bytes)
Pages free: 10.
Pages inactive: 20.
Pages speculative: 3.
Pages purgeable: 9.`;

test("Darwin pressure uses dispatch constants, not internal kernel levels", () => {
  expect(["1\n", "2", "4", "0", "3", "", "2x"].map(parseDarwinPressure)).toEqual([
    "normal",
    "warning",
    "critical",
    null,
    null,
    null,
    null,
  ]);
});
test("vm_stat uses the reported page size without double-counting purgeable pages", () => {
  for (const size of [4096, 16384]) expect(parseVmStatAvailable(vm(size))).toBe(33 * size);
  for (const bad of [
    "",
    vm().replace("10.", "-10."),
    vm().replace("20.", "x."),
    vm().replace("3.", "9007199254740991."),
    vm().replace("Pages free", "missing"),
  ]) {
    expect(parseVmStatAvailable(bad)).toBeNull();
  }
});
test("Darwin sample preserves independent probe failures and never manufactures PSI", async () => {
  expect(await sampleMemoryDarwin(async (file) => (file.endsWith("sysctl") ? "2" : vm()))).toEqual({
    availableBytes: 33 * 4096,
    psiFullAvg10: null,
    darwinPressure: "warning",
  });
  expect(
    await sampleMemoryDarwin(async (file) => {
      if (file.endsWith("sysctl")) throw new Error("timeout");
      return vm();
    }),
  ).toMatchObject({ availableBytes: 33 * 4096, darwinPressure: null });
});
test("Darwin brake requires uninterrupted healthy telemetry to release", () => {
  const budget = defaultHeavySlotBudget({ cpus: 8, memTotalBytes: 16 * 1024 ** 3 });
  const healthy = {
    availableBytes: 8 * 1024 ** 3,
    psiFullAvg10: null,
    darwinPressure: "normal" as const,
  };
  for (const pressure of ["warning", "critical"] as const) {
    let brake = nextBrake(BRAKE_OFF, { ...healthy, darwinPressure: pressure }, budget, 0);
    expect(brake.engaged).toBe(true);
    brake = nextBrake(brake, healthy, budget, 1000);
    brake = nextBrake(brake, { ...healthy, darwinPressure: null }, budget, 31000);
    expect(brake).toMatchObject({ engaged: true, clearSince: null });
    brake = nextBrake(brake, healthy, budget, 32000);
    expect(nextBrake(brake, healthy, budget, 61999).engaged).toBe(true);
    expect(nextBrake(brake, healthy, budget, 62000).engaged).toBe(false);
    expect(nextBrake(brake, { ...healthy, availableBytes: null }, budget, 62000).engaged).toBe(
      true,
    );
  }
});
