/**
 * Settings → Resources (#3552): the operator's runtime controls for the heavy-check slot, stored as
 * one server setting. NO I/O — the server persists it, HeavySlotService applies it.
 *
 *   - `null` means "the hardware default"; `enabled: null` means "what SHEPHERD_HEAVY_SLOT says".
 *   - The heavy list holds only the operator's EDITS (custom entries, switched-off built-ins); the
 *     built-in list itself lives in scripts/tool-guard.mjs and is never copied here.
 *   - A patch replaces `enabled` / `slots` / `heavyList` when named and merges `brake` per field.
 */
import { defaultHeavySlotBudget, type HeavySlotBudget } from "./heavy-slot-core";

export const HEAVY_SLOT_SETTING = "heavySlot";
export const HEAVY_SLOT_PEAKS_SETTING = "heavySlotPeaks";

const MIB = 1024 ** 2;

export interface HeavyCustomEntry {
  command: string;
  /** Empty = heavy whatever the arguments. */
  subcommands: string[];
}

export interface HeavySlotSettings {
  enabled: boolean | null;
  slots: number | null;
  waitMinutes: number;
  brake: {
    minAvailableMiB: number | null;
    psiFullMax: number | null;
    releaseHoldSec: number | null;
  };
  heavyList: { custom: HeavyCustomEntry[]; disabled: string[] };
}

export const EMPTY_HEAVY_SLOT_SETTINGS: HeavySlotSettings = {
  enabled: null,
  slots: null,
  waitMinutes: 0,
  brake: { minAvailableMiB: null, psiFullMax: null, releaseHoldSec: null },
  heavyList: { custom: [], disabled: [] },
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_CUSTOM = 64;

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function parseNames(raw: unknown, at: string): Parsed<string[]> {
  if (!Array.isArray(raw) || raw.length > MAX_CUSTOM) {
    return { ok: false, error: `${at} must be a list of at most ${MAX_CUSTOM} names` };
  }
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n !== "string" || !NAME.test(n)) return { ok: false, error: `${at}: bad name` };
    if (!out.includes(n)) out.push(n);
  }
  return { ok: true, value: out };
}

function parseHeavyList(raw: unknown): Parsed<HeavySlotSettings["heavyList"]> {
  const at = `${HEAVY_SLOT_SETTING}.heavyList`;
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
  const disabled = parseNames(raw.disabled ?? [], `${at}.disabled`);
  if (!disabled.ok) return disabled;
  if (
    !Array.isArray(raw.custom ?? []) ||
    ((raw.custom as unknown[] | undefined)?.length ?? 0) > MAX_CUSTOM
  ) {
    return { ok: false, error: `${at}.custom must be a list of at most ${MAX_CUSTOM} entries` };
  }
  const custom: HeavyCustomEntry[] = [];
  for (const e of (raw.custom as unknown[] | undefined) ?? []) {
    if (!isRecord(e) || typeof e.command !== "string" || !NAME.test(e.command)) {
      return { ok: false, error: `${at}.custom: each entry needs a command name` };
    }
    const subs = parseNames(e.subcommands ?? [], `${at}.custom.subcommands`);
    if (!subs.ok) return subs;
    if (custom.some((c) => c.command === e.command)) continue;
    custom.push({ command: e.command, subcommands: subs.value });
  }
  return { ok: true, value: { custom, disabled: disabled.value } };
}

function parseBrake(
  raw: unknown,
  current: HeavySlotSettings["brake"],
): Parsed<HeavySlotSettings["brake"]> {
  const at = `${HEAVY_SLOT_SETTING}.brake`;
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
  const next = { ...current };
  const ranges = {
    minAvailableMiB: [64, 1024 * 1024],
    psiFullMax: [1, 100],
    releaseHoldSec: [1, 3600],
  } as const;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(ranges, key))
      return { ok: false, error: `${at}.${key} is not a known field` };
    const k = key as keyof typeof ranges;
    const v = raw[key];
    if (v !== null && !intInRange(v, ranges[k][0], ranges[k][1])) {
      return {
        ok: false,
        error: `${at}.${key} must be null or an integer in ${ranges[k].join("–")}`,
      };
    }
    next[k] = v as number | null;
  }
  return { ok: true, value: next };
}

/** Validate a patch and merge it onto `current`. */
export function parseHeavySlotPatch(
  raw: unknown,
  current: HeavySlotSettings,
): Parsed<HeavySlotSettings> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return { ok: false, error: `${HEAVY_SLOT_SETTING} must be a non-empty object` };
  }
  const next: HeavySlotSettings = structuredClone(current);
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (key === "enabled") {
      if (v !== null && typeof v !== "boolean") {
        return { ok: false, error: `${HEAVY_SLOT_SETTING}.enabled must be a boolean or null` };
      }
      next.enabled = v;
    } else if (key === "slots") {
      if (v !== null && !intInRange(v, 1, 64)) {
        return {
          ok: false,
          error: `${HEAVY_SLOT_SETTING}.slots must be null or an integer in 1–64`,
        };
      }
      next.slots = v;
    } else if (key === "waitMinutes") {
      if (!intInRange(v, 0, 60))
        return { ok: false, error: "heavySlot.waitMinutes must be an integer in 0–60" };
      next.waitMinutes = v;
    } else if (key === "brake") {
      const b = parseBrake(v, next.brake);
      if (!b.ok) return b;
      next.brake = b.value;
    } else if (key === "heavyList") {
      const l = parseHeavyList(v);
      if (!l.ok) return l;
      next.heavyList = l.value;
    } else {
      return { ok: false, error: `${HEAVY_SLOT_SETTING}.${key} is not a known field` };
    }
  }
  return { ok: true, value: next };
}

/** The persisted settings; anything that no longer validates falls back to the defaults. */
export function storedHeavySlotSettings(stored: string | null | undefined): HeavySlotSettings {
  if (!stored) return structuredClone(EMPTY_HEAVY_SLOT_SETTINGS);
  try {
    const parsed = parseHeavySlotPatch(
      JSON.parse(stored),
      structuredClone(EMPTY_HEAVY_SLOT_SETTINGS),
    );
    return parsed.ok ? parsed.value : structuredClone(EMPTY_HEAVY_SLOT_SETTINGS);
  } catch {
    return structuredClone(EMPTY_HEAVY_SLOT_SETTINGS);
  }
}

export interface HeavySlotHardware {
  cpus: number;
  memTotalBytes: number;
}

/** The slot budget and master switch the settings resolve to. `envEnabled` / `envSlots` are the
 *  SHEPHERD_HEAVY_SLOT / SHEPHERD_HEAVY_SLOTS values that apply while the operator set nothing. */
export function effectiveHeavySlot(
  settings: HeavySlotSettings,
  hw: HeavySlotHardware,
  env: { enabled: boolean; slots: number },
): { enabled: boolean; budget: HeavySlotBudget } {
  const base = defaultHeavySlotBudget(hw, settings.slots ?? (env.slots > 0 ? env.slots : null));
  const { minAvailableMiB, psiFullMax, releaseHoldSec } = settings.brake;
  return {
    enabled: settings.enabled ?? env.enabled,
    budget: {
      slots: base.slots,
      minAvailableBytes: minAvailableMiB === null ? base.minAvailableBytes : minAvailableMiB * MIB,
      psiFullMax: psiFullMax ?? base.psiFullMax,
      releaseHoldMs: releaseHoldSec === null ? base.releaseHoldMs : releaseHoldSec * 1000,
    },
  };
}

/** The hardware defaults the page shows beside every override. */
export function heavySlotDefaults(hw: HeavySlotHardware) {
  const b = defaultHeavySlotBudget(hw, null);
  return {
    slots: b.slots,
    minAvailableMiB: Math.round(b.minAvailableBytes / MIB),
    psiFullMax: b.psiFullMax,
    releaseHoldSec: Math.round(b.releaseHoldMs / 1000),
  };
}

/** What the guard and the Codex shims read: just the operator's edits. */
export function heavyListFileBody(settings: HeavySlotSettings): string {
  return JSON.stringify({
    custom: settings.heavyList.custom,
    disabled: settings.heavyList.disabled,
  });
}

/** Persisted peak RSS per list command (bytes). */
export function storedHeavyPeaks(stored: string | null | undefined): Record<string, number> {
  if (!stored) return {};
  try {
    const raw: unknown = JSON.parse(stored);
    if (!isRecord(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        ([k, v]) => NAME.test(k) && typeof v === "number" && Number.isFinite(v) && v >= 0,
      ),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The list commands a heavy command line runs (word match), for attributing a measured peak. */
export function commandsInLine(line: string, commands: readonly string[]): string[] {
  const words = new Set(line.split(/[\s;&|()]+/).map((w) => w.split("/").pop() ?? ""));
  return commands.filter((c) => words.has(c));
}
