import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { Steer } from "./types";
import { STEER_MAX } from "./validate";

const SETTING_KEY = "steers";
// One-time marker: the legacy standalone "standardCommand" setting has been folded
// into the steers list as an issue action. Set after the first migration check so a
// later deletion of all issue actions doesn't resurrect the migrated entry.
const MIGRATED_KEY = "steersIssueActionsMigrated";

/** Distinct default emojis cycled onto legacy steers that predate the emoji field,
 *  so each stays recognizable when a tight layout collapses to icon-only. Excludes
 *  ⚡ (the migrated Standard issue action) and 📡 (broadcast) to avoid a clash. */
const LEGACY_EMOJI_PALETTE = [
  "🧭",
  "🐛",
  "📝",
  "🔧",
  "🚀",
  "✨",
  "🔍",
  "📦",
  "🎯",
  "🔁",
  "🧪",
  "💡",
];

/** Shipped defaults; seeded on first read, then fully owned by the operator. */
export const DEFAULT_STEERS: Omit<Steer, "id">[] = [
  { label: "commit & push", text: "commit & push", inSteerBar: true, onIssues: false },
  { label: "rebase", text: "rebase onto the base branch", inSteerBar: true, onIssues: false },
  { label: "run tests", text: "run the tests", inSteerBar: true, onIssues: false },
];

/** The issue action a legacy/seeded standard command becomes. */
function standardIssueAction(text: string): Steer {
  return {
    id: randomUUID(),
    label: "Standard",
    emoji: "⚡",
    text,
    inSteerBar: false,
    onIssues: true,
  };
}

/** Fill surface defaults on stored entries that predate emoji + scopes. */
function normalize(s: Steer & { inSteerBar?: boolean; onIssues?: boolean }): Steer {
  return {
    ...s,
    inSteerBar: s.inSteerBar ?? true,
    onIssues: s.onIssues ?? false,
  };
}

/** Give each legacy (pre-emoji) steer a distinct default emoji, cycling the palette
 *  so an icon-only collapsed layout stays distinguishable. Entries that already carry
 *  an emoji are left untouched. Returns the list and whether anything changed. */
function backfillLegacyEmojis(list: Steer[]): { list: Steer[]; changed: boolean } {
  let changed = false;
  let paletteIdx = 0;
  const next = list.map((s) => {
    if (s.emoji != null) return s;
    changed = true;
    return { ...s, emoji: LEGACY_EMOJI_PALETTE[paletteIdx++ % LEGACY_EMOJI_PALETTE.length]! };
  });
  return { list: next, changed };
}

/** One-time upgrade pass over an existing steers list: backfill legacy emojis and
 *  fold the legacy standalone standardCommand into a trailing issue action. Persists
 *  the result and sets the marker so it runs exactly once. */
function migrateLegacySteers(
  store: Pick<SessionStore, "getSetting" | "setSetting">,
  list: Steer[],
  standardCommand: string,
): Steer[] {
  if (store.getSetting(MIGRATED_KEY) != null) return list;
  const filled = backfillLegacyEmojis(list);
  let next = filled.list;
  let persist = filled.changed;
  const cmd = (store.getSetting("standardCommand") ?? standardCommand).trim();
  if (cmd !== "" && next.length < STEER_MAX) {
    next = [...next, standardIssueAction(cmd)];
    persist = true;
  } else if (cmd !== "") {
    // fail loud: the marker below makes this one-shot, so a silent skip would lose
    // the operator's prompt without a trace. The "standardCommand" setting itself
    // stays in the store for manual recovery.
    console.warn(
      `[steers] legacy standard command NOT migrated: the steers list is at the ${STEER_MAX}-entry cap. ` +
        `Free a slot and re-add it as an issue action (prompt kept in the "standardCommand" setting): ${cmd}`,
    );
  }
  if (persist) store.setSetting(SETTING_KEY, JSON.stringify(next));
  store.setSetting(MIGRATED_KEY, "1");
  return next;
}

/** Read saved steers, seeding (and persisting) the defaults on first use.
 *  `standardCommand` is the config fallback for the legacy quick-launch prompt: on a
 *  fresh DB it seeds the default issue action; on an existing DB the stored
 *  "standardCommand" setting (the operator's own prompt) wins, folded in exactly once.
 *  The same one-time pass also backfills a distinct default emoji onto every legacy
 *  steer that predates the emoji field, persisted so the operator need not set them. */
export function loadSteers(
  store: Pick<SessionStore, "getSetting" | "setSetting">,
  standardCommand = "",
): Steer[] {
  const raw = store.getSetting(SETTING_KEY);
  if (raw == null) {
    const seeded: Steer[] = DEFAULT_STEERS.map((s) => ({ id: randomUUID(), ...s }));
    const cmd = (store.getSetting("standardCommand") ?? standardCommand).trim();
    if (cmd !== "") seeded.push(standardIssueAction(cmd));
    store.setSetting(SETTING_KEY, JSON.stringify(seeded));
    store.setSetting(MIGRATED_KEY, "1");
    return seeded;
  }
  let list: Steer[];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? (parsed as Steer[]).map(normalize) : [];
  } catch {
    return [];
  }
  return migrateLegacySteers(store, list, standardCommand);
}

/** Persist the steers list verbatim (caller has already validated it). */
export function saveSteers(store: Pick<SessionStore, "setSetting">, steers: Steer[]): void {
  store.setSetting(SETTING_KEY, JSON.stringify(steers));
}
