import { test, expect } from "bun:test";
import {
  StarPromptService,
  computeShouldPrompt,
  STAR_ELIGIBLE_AFTER_MS,
  STAR_SNOOZE_MS,
  STAR_SETTING_KEY,
  type StarPromptState,
} from "../src/star-prompt";

/** In-memory settings KV matching the slice StarPromptService uses. */
function fakeStore() {
  const m = new Map<string, string>();
  return {
    getSetting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string) => void m.set(k, v),
    _raw: () => m,
  };
}

const DAY = 24 * 60 * 60 * 1000;

test("computeShouldPrompt: false inside the grace window, true once elapsed", () => {
  const s: StarPromptState = { firstSeenAt: 0 };
  expect(computeShouldPrompt(s, STAR_ELIGIBLE_AFTER_MS - 1)).toBe(false);
  expect(computeShouldPrompt(s, STAR_ELIGIBLE_AFTER_MS)).toBe(true);
});

test("computeShouldPrompt: dismissed/starred are terminal, snooze suppresses until its time", () => {
  const past = STAR_ELIGIBLE_AFTER_MS + DAY;
  expect(computeShouldPrompt({ firstSeenAt: 0, dismissed: true }, past)).toBe(false);
  expect(computeShouldPrompt({ firstSeenAt: 0, starred: true }, past)).toBe(false);
  expect(computeShouldPrompt({ firstSeenAt: 0, snoozeUntil: past + DAY }, past)).toBe(false);
  expect(computeShouldPrompt({ firstSeenAt: 0, snoozeUntil: past - 1 }, past)).toBe(true);
});

test("seeds firstSeenAt on construction and stays inside the grace window", () => {
  const store = fakeStore();
  let now = 1_000;
  const svc = new StarPromptService({ store, gh: async () => "", now: () => now });
  expect(store.getSetting(STAR_SETTING_KEY)).toBeTruthy();
  expect(svc.status()).toEqual({ shouldPrompt: false, starred: false });
  // crossing the grace window flips shouldPrompt without re-seeding firstSeenAt
  now += STAR_ELIGIBLE_AFTER_MS;
  expect(svc.status().shouldPrompt).toBe(true);
});

test("dismiss is permanent", () => {
  const store = fakeStore();
  let now = 0; // firstSeenAt seeds to 0 here
  const svc = new StarPromptService({ store, gh: async () => "", now: () => now });
  now = STAR_ELIGIBLE_AFTER_MS * 10; // grace window long since elapsed
  expect(svc.status().shouldPrompt).toBe(true);
  expect(svc.dismiss()).toEqual({ shouldPrompt: false, starred: false });
  expect(svc.status().shouldPrompt).toBe(false);
});

test("snooze suppresses for STAR_SNOOZE_MS then returns", () => {
  const store = fakeStore();
  let now = 0;
  const svc = new StarPromptService({ store, gh: async () => "", now: () => now });
  now = STAR_ELIGIBLE_AFTER_MS * 10;
  svc.snooze();
  expect(svc.status().shouldPrompt).toBe(false);
  now += STAR_SNOOZE_MS - 1;
  expect(svc.status().shouldPrompt).toBe(false);
  now += 1;
  expect(svc.status().shouldPrompt).toBe(true);
});

test("star issues the gh PUT, marks starred, and never prompts again", async () => {
  const store = fakeStore();
  let now = 0;
  const calls: string[][] = [];
  const svc = new StarPromptService({
    store,
    gh: async (args) => {
      calls.push(args);
      return "";
    },
    now: () => now,
  });
  now = STAR_ELIGIBLE_AFTER_MS * 10;
  const status = await svc.star();
  expect(calls).toEqual([["api", "--method", "PUT", "/user/starred/erwins-enkel/shepherd"]]);
  expect(status).toEqual({ shouldPrompt: false, starred: true });
  expect(svc.status()).toEqual({ shouldPrompt: false, starred: true });
});

test("a failed gh star throws and leaves state unstarred", async () => {
  const store = fakeStore();
  let now = 0;
  const svc = new StarPromptService({
    store,
    gh: async () => {
      throw new Error("gh not authenticated");
    },
    now: () => now,
  });
  now = STAR_ELIGIBLE_AFTER_MS * 10;
  await expect(svc.star()).rejects.toThrow("gh not authenticated");
  expect(svc.status()).toEqual({ shouldPrompt: true, starred: false });
});

test("onChange fires with the fresh status on every mutation", () => {
  const store = fakeStore();
  const now = STAR_ELIGIBLE_AFTER_MS * 10;
  const seen: { shouldPrompt: boolean; starred: boolean }[] = [];
  const svc = new StarPromptService({
    store,
    gh: async () => "",
    now: () => now,
    onChange: (s) => seen.push(s),
  });
  svc.snooze();
  svc.dismiss();
  expect(seen).toEqual([
    { shouldPrompt: false, starred: false },
    { shouldPrompt: false, starred: false },
  ]);
});

test("corrupt persisted state is re-seeded rather than throwing", () => {
  const store = fakeStore();
  store.setSetting(STAR_SETTING_KEY, "{not json");
  let now = 5_000;
  const svc = new StarPromptService({ store, gh: async () => "", now: () => now });
  expect(svc.status()).toEqual({ shouldPrompt: false, starred: false });
  now += STAR_ELIGIBLE_AFTER_MS;
  expect(svc.status().shouldPrompt).toBe(true);
});
