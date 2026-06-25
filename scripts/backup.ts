#!/usr/bin/env bun
/**
 * Hourly SQLite backup for Shepherd's single source of truth (#1080).
 *
 * Runs OUT-OF-PROCESS (systemd-user `shepherd-backup.timer` → this script), never on the server's
 * single Bun event loop. Flow:
 *   1. `VACUUM INTO` a temp snapshot — atomic + transactionally consistent on the LIVE db (read
 *      lock only), compacted, and crucially emits no `-wal/-shm` artifacts. Opened read-only with
 *      a `busy_timeout` so a concurrent server write commit waits rather than throwing SQLITE_BUSY
 *      (the server connection carries the same pragma — see src/store.ts). Phase-0 spike confirmed
 *      bun:sqlite accepts `VACUUM INTO ?` on a read-only connection.
 *   2. `PRAGMA integrity_check` on the raw snapshot BEFORE compression — a failing snapshot is
 *      discarded and never kept.
 *   3. gzip (Bun built-in) → write to a temp sibling → atomic rename into place.
 *   4. GFS rotation (48 hourly / 14 daily / 8 weekly / 12 monthly).
 *   5. Record `.last-success` + append to `backup.log`. Any failure exits non-zero (journald logs).
 *
 * The pure `classifyRetention` is the unit-tested core (test/backup.test.ts).
 */
import { Database } from "bun:sqlite";
import { gzipSync } from "bun";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveBackupDir, resolveDbPath, lastSuccessMarker } from "../src/backup-paths";

/** Busy-timeout (ms) for both backup + server connections (kept equal to src/store.ts). */
export const BUSY_TIMEOUT_MS = 5000;

/** GFS retention tiers: keep the newest snapshot per bucket for the N most-recent buckets. */
export const GFS = { hourly: 48, daily: 14, weekly: 8, monthly: 12 } as const;

const FILE_RE = /^shepherd-(\d{8}T\d{6}Z)\.db\.gz$/;

/** UTC timestamp → `YYYYMMDDTHHmmssZ` (lexically sortable, parseable). */
export function formatTs(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Parse a snapshot filename back to a Date, or null if it isn't one of ours. */
export function parseTs(filename: string): Date | null {
  const m = FILE_RE.exec(filename);
  if (!m || !m[1]) return null;
  const s = m[1];
  const d = new Date(
    Date.UTC(
      Number(s.slice(0, 4)),
      Number(s.slice(4, 6)) - 1,
      Number(s.slice(6, 8)),
      Number(s.slice(9, 11)),
      Number(s.slice(11, 13)),
      Number(s.slice(13, 15)),
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayKey = (d: Date) => formatTs(d).slice(0, 8); // YYYYMMDD
const monthKey = (d: Date) => formatTs(d).slice(0, 6); // YYYYMM
/** ISO-8601 week key `YYYY-Www` (UTC). */
export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO: Thursday determines the week-year; week 1 contains Jan 4th.
  const day = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Pure GFS classifier. Given snapshot filenames, return which to keep and which to delete.
 * Keep = (newest 48 overall) ∪ (newest per day for 14 most-recent days) ∪ (newest per ISO week for
 * 8 most-recent weeks) ∪ (newest per month for 12 most-recent months). Unparseable names are kept
 * defensively (never delete what we can't identify).
 */
export function classifyRetention(filenames: string[]): { keep: string[]; delete: string[] } {
  const parsed = filenames
    .map((f) => ({ f, d: parseTs(f) }))
    .filter((x): x is { f: string; d: Date } => x.d !== null)
    .sort((a, b) => b.d.getTime() - a.d.getTime()); // newest first

  const keep = new Set<string>();
  // unparseable → keep, never delete
  for (const f of filenames) if (parseTs(f) === null) keep.add(f);

  // hourly: newest N overall
  for (const { f } of parsed.slice(0, GFS.hourly)) keep.add(f);

  // per-tier: walk newest-first, keep the first (newest) file of each new bucket up to `count`
  const tier = (keyFn: (d: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const { f, d } of parsed) {
      const k = keyFn(d);
      if (seen.has(k)) continue;
      if (seen.size >= count) continue; // already retained the `count` most-recent buckets
      seen.add(k);
      keep.add(f);
    }
  };
  tier(dayKey, GFS.daily);
  tier(weekKey, GFS.weekly);
  tier(monthKey, GFS.monthly);

  return {
    keep: filenames.filter((f) => keep.has(f)),
    delete: filenames.filter((f) => !keep.has(f)),
  };
}

/** Open the live DB read-only and `VACUUM INTO` a temp snapshot (consistent on a live db). */
export function snapshot(dbPath: string, tmpPath: string): void {
  const src = new Database(dbPath, { readonly: true });
  try {
    src.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    src.run("VACUUM INTO ?", [tmpPath]);
  } finally {
    src.close();
  }
}

/** Throw unless the snapshot passes `PRAGMA integrity_check` (=> caller discards it). */
export function verifyIntegrity(snapPath: string): void {
  const db = new Database(snapPath, { readonly: true });
  try {
    const rows = db.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`integrity_check failed: ${JSON.stringify(rows)}`);
    }
  } finally {
    db.close();
  }
}

/** gzip the snapshot and atomically rename into place. */
function compress(snapPath: string, outGz: string): void {
  const tmpGz = `${outGz}.tmp`;
  writeFileSync(tmpGz, gzipSync(readFileSync(snapPath)));
  renameSync(tmpGz, outGz);
}

/** Delete every snapshot the GFS classifier drops. */
export function rotate(dir: string): void {
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f));
  for (const f of classifyRetention(files).delete) unlinkSync(join(dir, f));
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const dir = resolveBackupDir();
  mkdirSync(dir, { recursive: true });

  const ts = formatTs(new Date());
  const snapTmp = join(dir, `.shepherd-${ts}.db.tmp`);
  const outGz = join(dir, `shepherd-${ts}.db.gz`);

  try {
    snapshot(dbPath, snapTmp);
    verifyIntegrity(snapTmp);
    compress(snapTmp, outGz);
  } finally {
    rmSync(snapTmp, { force: true });
  }

  rotate(dir);

  const nowIso = new Date().toISOString();
  writeFileSync(lastSuccessMarker(), `${nowIso}\n`);
  writeFileSync(join(dir, "backup.log"), `${nowIso} ok ${outGz}\n`, { flag: "a" });
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error(`[backup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
