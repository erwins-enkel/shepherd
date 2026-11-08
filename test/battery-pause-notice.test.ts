import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATTERY_PAUSE_EVENT,
  BATTERY_PAUSE_NOTICE,
  watchBatteryPauseNotice,
} from "../src/battery-pause-notice";

let dir: string;
let stop: () => void = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "battery-pause-"));
});

afterEach(() => {
  stop();
  rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("a notice left from an earlier run is removed without being announced", async () => {
  writeFileSync(join(dir, BATTERY_PAUSE_NOTICE), "");
  const emitted: string[] = [];
  stop = watchBatteryPauseNotice(dir, (event) => emitted.push(event));
  expect(existsSync(join(dir, BATTERY_PAUSE_NOTICE))).toBe(false);
  await Bun.sleep(100);
  expect(emitted).toEqual([]);
});

test("a new notice is announced once, then deleted as the acknowledgement", async () => {
  const emitted: [string, unknown][] = [];
  stop = watchBatteryPauseNotice(dir, (event, data) => emitted.push([event, data]));
  writeFileSync(join(dir, BATTERY_PAUSE_NOTICE), "");
  await until(() => !existsSync(join(dir, BATTERY_PAUSE_NOTICE)));
  await Bun.sleep(100);
  expect(emitted).toEqual([[BATTERY_PAUSE_EVENT, {}]]);
});

test("other files in the directory announce nothing", async () => {
  const emitted: string[] = [];
  stop = watchBatteryPauseNotice(dir, (event) => emitted.push(event));
  writeFileSync(join(dir, "shepherd-update.log"), "line\n");
  await Bun.sleep(100);
  expect(emitted).toEqual([]);
});

test("after stop, a notice is left alone", async () => {
  const emitted: string[] = [];
  watchBatteryPauseNotice(dir, (event) => emitted.push(event))();
  writeFileSync(join(dir, BATTERY_PAUSE_NOTICE), "");
  await Bun.sleep(100);
  expect(emitted).toEqual([]);
  expect(existsSync(join(dir, BATTERY_PAUSE_NOTICE))).toBe(true);
});

test("a missing directory degrades to a no-op instead of throwing", () => {
  const stopMissing = watchBatteryPauseNotice(join(dir, "missing"), () => {});
  expect(typeof stopMissing).toBe("function");
  stopMissing();
});
