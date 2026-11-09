import type { HeavySlotLastResult, HeavySlotSnapshot, RemoteInstance } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { machineColorVar } from "#lib/remote-sessions.js";

/** The master switch is the only gate: with it off there is no chip, strip or popover. */
export function slotEnabled(s: HeavySlotSnapshot | null | undefined): s is HeavySlotSnapshot {
  return s?.enabled === true;
}

/** One machine's check slot in the overview: this Shepherd's own (`instanceId` null) or a
 *  connected machine's, as its last answered connection check reported it. */
export interface SlotLane {
  instanceId: string | null;
  /** The machine's display name; null for this Shepherd. */
  name: string | null;
  /** The machine's color as a CSS value; null for this Shepherd. */
  color: string | null;
  snapshot: HeavySlotSnapshot;
  /** The machine is not reachable now: `snapshot` is its last known state, read at `readAt`. */
  stale: boolean;
  readAt: number | null;
}

/** Every switched-on slot: each connected machine's that reported one, in the machines' color
 *  order (stable across reloads, so a lane never jumps), then this Shepherd's own. */
export function slotLanes(
  own: HeavySlotSnapshot | null | undefined,
  machines: readonly RemoteInstance[],
): SlotLane[] {
  const ordered = [...machines].sort(
    (a, b) => a.createdAt - b.createdAt || a.instanceId.localeCompare(b.instanceId),
  );
  const lanes: SlotLane[] = [];
  for (const x of ordered) {
    const hs = x.heavySlot;
    if (!hs || !slotEnabled(hs.snapshot)) continue;
    lanes.push({
      instanceId: x.instanceId,
      name: x.name,
      color: machineColorVar(x.instanceId, machines),
      snapshot: hs.snapshot,
      stale: hs.stale,
      readAt: hs.readAt,
    });
  }
  if (slotEnabled(own)) {
    lanes.push({
      instanceId: null,
      name: null,
      color: null,
      snapshot: own,
      stale: false,
      readAt: null,
    });
  }
  return lanes;
}

/** A connected machine reports a slot: strip, chip and popover then name each lane's machine. */
export function hasMachineLanes(lanes: readonly SlotLane[]): boolean {
  return lanes.some((l) => l.instanceId !== null);
}

/** Lanes with something going on (an unreachable machine's by its last known state). */
export function activeLanes(lanes: readonly SlotLane[]): SlotLane[] {
  return lanes.filter((l) => slotActive(l.snapshot));
}

/** Held, capacity and waiting summed over the reachable lanes; braking if any of them brakes. */
export function laneTotals(lanes: readonly SlotLane[]): ChipModel {
  const live = lanes.filter((l) => !l.stale);
  return {
    held: live.reduce((n, l) => n + l.snapshot.holders.length, 0),
    capacity: live.reduce((n, l) => n + l.snapshot.capacity, 0),
    waiting: live.reduce((n, l) => n + l.snapshot.waiters.length, 0),
    free: live.reduce((n, l) => n + chipModel(l.snapshot).free, 0),
    ramPct: null,
    braking: live.some((l) => l.snapshot.brake.active),
  };
}

/** How many waiters a lane lists while several lanes share the strip, before "+ n more". */
export const LANE_WAITERS_SHOWN = 3;

/** The wall-clock time an unreachable machine's last known slot state was read. */
export function formatReadAt(ts: number | null): string {
  return ts == null
    ? "–"
    : new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Something is going on worth a strip: a holder, a waiter, the brake holding starts back, or new
 *  sessions waiting to start. */
export function slotActive(s: HeavySlotSnapshot | null | undefined): boolean {
  return (
    slotEnabled(s) &&
    (s.holders.length > 0 ||
      s.waiters.length > 0 ||
      s.brake.active ||
      (s.startQueue?.length ?? 0) > 0)
  );
}

/** The line under the queue: the brake holding new starts back (with how many wait), or — once it
 *  let go — the waiting starts following one by one; null when neither. */
export function brakeLine(s: HeavySlotSnapshot): string | null {
  const n = s.startQueue?.length ?? 0;
  if (s.brake.active)
    return n > 0 ? m.heavyslot_strip_brake_waiting({ n }) : m.heavyslot_strip_brake();
  return n > 0 ? m.heavyslot_strip_starts_pacing({ n }) : null;
}

/** Used RAM as a whole percent, or null when the host didn't report it. */
export function ramUsedPct(s: HeavySlotSnapshot): number | null {
  const { ramAvailableBytes: free, ramTotalBytes: total } = s.pressure;
  if (free == null || total == null || total <= 0) return null;
  return Math.round(((total - free) / total) * 100);
}

/** A bar cut at the brake line, as fractions of its whole scale that sum to 1: used up to the line,
 *  used past it, still free before it, and the brake zone beyond. */
export interface Zones {
  used: number;
  over: number;
  free: number;
  reserve: number;
}

const unit = (x: number) => Math.min(1, Math.max(0, x));

/** The zones of a bar filled to `used` with its brake line at `limit`, both 0..1 of the scale. */
export function zones(used: number, limit: number): Zones {
  const u = unit(used);
  const b = unit(limit);
  return {
    used: Math.min(u, b),
    over: Math.max(0, u - b),
    free: Math.max(0, b - u),
    reserve: 1 - Math.max(u, b),
  };
}

export interface RamGauge {
  zones: Zones;
  freeBytes: number;
  usedBytes: number;
  totalBytes: number;
  /** The brake engages below this much free RAM; null from an older server (no brake zone). */
  minBytes: number | null;
  /** Free before the brake engages: green on the bar. Null without `minBytes`. */
  usableBytes: number | null;
  /** Free RAM is below `minBytes`: this is what holds the brake. */
  short: boolean;
}

/** RAM as used | free before the brake | brake zone, or null when the host didn't report it. */
export function ramGauge(s: HeavySlotSnapshot): RamGauge | null {
  const { ramAvailableBytes: free, ramTotalBytes: total } = s.pressure;
  const min = s.pressure.ramMinAvailableBytes ?? null;
  if (free == null || total == null || total <= 0) return null;
  const used = Math.max(0, total - free);
  return {
    zones: zones(used / total, min == null ? 1 : (total - min) / total),
    freeBytes: free,
    usedBytes: used,
    totalBytes: total,
    minBytes: min,
    usableBytes: min == null ? null : Math.max(0, free - min),
    short: min != null && free < min,
  };
}

/** The pressure bar's scale runs half again past the brake limit, so the brake zone stays a third. */
const PSI_SCALE = 1.5;

export interface PsiGauge {
  zones: Zones;
  /** Memory PSI `full` avg10, percent. */
  value: number;
  limit: number;
  over: boolean;
}

/** Memory pressure against its brake limit, or null when either is unknown (macOS has no PSI). */
export function psiGauge(s: HeavySlotSnapshot): PsiGauge | null {
  const { memFullAvg10: v, memBrakeThreshold: t } = s.pressure;
  if (v == null || t == null || t <= 0) return null;
  return { zones: zones(v / (t * PSI_SCALE), 1 / PSI_SCALE), value: v, limit: t, over: v > t };
}

export type SlotCell =
  | { kind: "held"; holder: HeavySlotSnapshot["holders"][number] }
  | { kind: "free" | "blocked"; n: number };

/** Every slot in order: the held ones, then the free ones — blocked while the brake holds. */
export function slotCells(s: HeavySlotSnapshot): SlotCell[] {
  const held: SlotCell[] = s.holders.map((holder) => ({ kind: "held", holder }));
  const kind: "free" | "blocked" = s.brake.active ? "blocked" : "free";
  const free = Math.max(0, s.capacity - held.length);
  return [...held, ...Array.from({ length: free }, (_, i) => ({ kind, n: held.length + i + 1 }))];
}

/** Above this many slots the chip counts them instead of drawing one pip each. */
const PIPS_MAX = 8;

/** One pip kind per slot, or null past `PIPS_MAX` (then the slots are counted instead). */
export function pipKinds(s: HeavySlotSnapshot): SlotCell["kind"][] | null {
  return s.capacity > PIPS_MAX ? null : slotCells(s).map((c) => c.kind);
}

/** Can a heavy check start here now: free, every slot taken, or the brake holds new starts back —
 *  for a limit that is over (`ram` / `pressure`), or `hold` while calm readings run out their
 *  hold (`leftMs` of `holdMs`). `cause` is null from an older server that doesn't say. */
export type SlotStatus =
  | { kind: "free"; free: number }
  | { kind: "full"; waiting: number }
  | {
      kind: "brake";
      cause: "ram" | "pressure" | "hold" | null;
      leftMs: number | null;
      holdMs: number | null;
    };

export function slotStatus(s: HeavySlotSnapshot, nowMs: number): SlotStatus {
  const b = s.brake;
  if (b.active) {
    const releaseAt = b.releaseAt ?? null;
    if (releaseAt != null)
      return {
        kind: "brake",
        cause: "hold",
        leftMs: Math.max(0, releaseAt - nowMs),
        holdMs: b.releaseHoldMs ?? null,
      };
    const cause =
      b.cause === "memory_available" ? "ram" : b.cause === "memory_pressure" ? "pressure" : null;
    return { kind: "brake", cause, leftMs: null, holdMs: null };
  }
  const free = Math.max(0, s.capacity - s.holders.length);
  return free > 0 ? { kind: "free", free } : { kind: "full", waiting: s.waiters.length };
}

/** Whole seconds left on a countdown, never below zero. */
export function secondsLeft(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/** The status in a few words for the chip: "2 free", "full", "blocked · 18 s". */
export function statusShort(st: SlotStatus): string {
  if (st.kind === "free") return m.heavyslot_free({ n: st.free });
  if (st.kind === "full") return m.heavyslot_full();
  if (st.leftMs == null) return m.heavyslot_blocked();
  return `${m.heavyslot_blocked()} · ${m.heavyslot_seconds({ n: secondsLeft(st.leftMs) })}`;
}

export interface ChipModel {
  held: number;
  capacity: number;
  waiting: number;
  /** Slots nobody holds, whether or not the brake lets them be used. */
  free: number;
  ramPct: number | null;
  braking: boolean;
}

export function chipModel(s: HeavySlotSnapshot): ChipModel {
  return {
    held: s.holders.length,
    capacity: s.capacity,
    waiting: s.waiters.length,
    free: Math.max(0, s.capacity - s.holders.length),
    ramPct: ramUsedPct(s),
    braking: s.brake.active,
  };
}

/** `m:ss` (or `h:mm:ss`) since `startedAt`; never negative. */
export function formatRuntime(startedAt: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const sec = String(total % 60).padStart(2, "0");
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}:${sec}`;
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}:${sec}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "–";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

const LEADING_CD = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:;|&&)\s*/;

/** A check command shortened for a one-line slot row: its first line, without the leading
 *  `cd <dir>;` / `cd <dir> &&` hops (the worktree is already implied by the session). */
export function commandLabel(command: string): string {
  const first = command.split("\n").find((l) => l.trim() !== "") ?? "";
  let label = first.trim();
  while (LEADING_CD.test(label)) label = label.replace(LEADING_CD, "");
  return label.replace(/\s+/g, " ") || first.trim();
}

/** What a holder is doing with its slot; an older server that doesn't say only ever ran checks. */
export function holderState(
  h: HeavySlotSnapshot["holders"][number],
): "offered" | "running" | "lingering" {
  return h.state ?? "running";
}

/** Waiters in queue order. */
export function orderedWaiters(s: HeavySlotSnapshot): HeavySlotSnapshot["waiters"] {
  return [...s.waiters].sort((a, b) => a.position - b.position);
}

/** How often an open overview re-reads the snapshot while a result still counts as current. */
export const RESULT_REFRESH_MS = 15_000;

/** A result that is still current can go stale at any moment (the agent keeps editing, and no
 *  event announces it), so such a snapshot has to be re-read. Stale ones only change on a new run. */
export function needsResultRefresh(s: HeavySlotSnapshot | null | undefined): boolean {
  return slotEnabled(s) && s.lastResults.some((r) => !r.stale);
}

export type ResultView = "passed" | "failed" | "aborted" | "stale";

/** What a last result shows as. A pass whose revision no longer matches the worktree is "stale",
 *  never green; a failure stays red (an old failure is still the more useful signal). */
export function resultView(r: HeavySlotLastResult): ResultView {
  return r.result === "passed" && r.stale ? "stale" : r.result;
}

/** The 7-character commit the job ran on, or a dash when it is unknown. */
export function shortRevision(r: HeavySlotLastResult): string {
  return r.head ? r.head.slice(0, 7) : "–";
}

/** How many last results the overview lists before "show all". */
const RESULTS_SHOWN = 5;

/** Last results newest first (unknown end last), cut to `RESULTS_SHOWN` unless `all`. */
export function recentResults(
  s: HeavySlotSnapshot,
  all: boolean,
): { rows: HeavySlotLastResult[]; hidden: number } {
  const sorted = [...s.lastResults].sort((a, b) => (b.endedAt ?? -1) - (a.endedAt ?? -1));
  const rows = all ? sorted : sorted.slice(0, RESULTS_SHOWN);
  return { rows, hidden: sorted.length - rows.length };
}

/** The anchored popover's left offset inside its positioning box: under the chip's left edge,
 *  pulled back so it never overflows the box's right edge (nor its left, when it can't fit). */
export function popoverLeft(
  chipLeft: number,
  popWidth: number,
  boxLeft: number,
  boxWidth: number,
): number {
  return Math.min(Math.max(0, chipLeft - boxLeft), Math.max(0, boxWidth - popWidth));
}
