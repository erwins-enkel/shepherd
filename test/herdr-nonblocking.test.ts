import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { HerdrDriver } from "../src/herdr";

// #3127: a herdr that stops answering must only delay the callers awaiting it, never Bun's loop.
// A fake `herdr` that hangs HANG_MS stands in for the 10s-timeout incident; a parallel timer
// proves the loop keeps turning while every read surface waits on it.
const HANG_MS = 1_500;
const TICK_MS = 50;

let dir: string;
let prevBin: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-slow-"));
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/bin/sh\nsleep ${HANG_MS / 1000}\necho '{"result":{"agents":[],"tabs":[],"panes":[],"read":{"text":"ok"}}}'\n`,
  );
  chmodSync(bin, 0o755);
  prevBin = config.herdrBin;
  config.herdrBin = bin;
});

afterAll(() => {
  config.herdrBin = prevBin;
  rmSync(dir, { recursive: true, force: true });
});

/** Run `call` against the default (real-spawn) driver while a timer ticks; return the largest
 *  gap between ticks and how many ticks landed. */
async function measure(call: (d: HerdrDriver) => Promise<unknown>) {
  const d = new HerdrDriver();
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, TICK_MS);
  const started = performance.now();
  try {
    await call(d);
  } finally {
    clearInterval(timer);
  }
  return { maxGap, ticks, elapsed: performance.now() - started };
}

describe("herdr reads never block the event loop (#3127)", () => {
  const cases: [string, (d: HerdrDriver) => Promise<unknown>][] = [
    ["listAsync", (d) => d.listAsync()],
    ["tabsAsync", (d) => d.tabsAsync()],
    ["panesAsync", (d) => d.panesAsync()],
    ["readAsync", (d) => d.readAsync("t1", "visible")],
  ];
  for (const [name, call] of cases) {
    it(`${name}: a parallel timer keeps firing while herdr hangs`, async () => {
      const { maxGap, ticks, elapsed } = await measure(call);
      expect(elapsed).toBeGreaterThanOrEqual(HANG_MS - 100); // the fake really hung
      expect(maxGap).toBeLessThan(300);
      expect(ticks).toBeGreaterThanOrEqual(Math.floor(HANG_MS / TICK_MS / 2));
    });
  }
});

describe("no synchronous herdr read surface", () => {
  const srcDir = join(import.meta.dir, "..", "src");

  it("src/herdr.ts never spawns herdr synchronously", () => {
    const text = readFileSync(join(srcDir, "herdr.ts"), "utf8");
    expect(text).not.toMatch(/\bexecFileSync\s*\(/);
    expect(text).not.toMatch(/import\s*\{[^}]*\bexecFileSync\b/);
  });

  it("no src file calls a sync herdr list/tabs/panes/read", () => {
    const hits: string[] = [];
    for (const f of readdirSync(srcDir, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(join(srcDir, f), "utf8");
      if (/\bherdr\s*\.\s*(list|tabs|panes|read)\s*\(/.test(text)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
