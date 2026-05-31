import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { Steer } from "./types";

const SETTING_KEY = "steers";

/** Shipped defaults; seeded on first read, then fully owned by the operator. */
export const DEFAULT_STEERS: Omit<Steer, "id">[] = [
  { label: "commit & push", text: "commit & push" },
  { label: "rebase", text: "rebase onto the base branch" },
  { label: "run tests", text: "run the tests" },
];

/** Read saved steers, seeding (and persisting) the defaults on first use. */
export function loadSteers(store: Pick<SessionStore, "getSetting" | "setSetting">): Steer[] {
  const raw = store.getSetting(SETTING_KEY);
  if (raw == null) {
    const seeded = DEFAULT_STEERS.map((s) => ({ id: randomUUID(), ...s }));
    store.setSetting(SETTING_KEY, JSON.stringify(seeded));
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Steer[]) : [];
  } catch {
    return [];
  }
}

/** Persist the steers list verbatim (caller has already validated it). */
export function saveSteers(store: Pick<SessionStore, "setSetting">, steers: Steer[]): void {
  store.setSetting(SETTING_KEY, JSON.stringify(steers));
}
