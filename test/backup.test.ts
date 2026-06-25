import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRetention,
  formatTs,
  parseTs,
  weekKey,
  snapshot,
  verifyIntegrity,
  rotate,
  GFS,
} from "../scripts/backup";

const name = (d: Date) => `shepherd-${formatTs(d)}.db.gz`;
const hoursAgo = (base: Date, h: number) => new Date(base.getTime() - h * 3600_000);

describe("formatTs / parseTs round-trip", () => {
  it("formats UTC and parses back", () => {
    const d = new Date(Date.UTC(2026, 5, 25, 14, 30, 5));
    expect(formatTs(d)).toBe("20260625T143005Z");
    expect(parseTs(name(d))?.getTime()).toBe(d.getTime());
  });
  it("rejects foreign filenames", () => {
    expect(parseTs("shepherd.db.gz")).toBeNull();
    expect(parseTs("backup.log")).toBeNull();
    expect(parseTs("shepherd-20260625T143005Z.db.gz.tmp")).toBeNull();
  });
});

describe("weekKey (ISO-8601)", () => {
  it("matches known ISO weeks", () => {
    // 2026-01-01 is a Thursday → ISO week 2026-W01
    expect(weekKey(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-W01");
    // 2025-12-29 (Mon) belongs to ISO week 2026-W01
    expect(weekKey(new Date(Date.UTC(2025, 11, 29)))).toBe("2026-W01");
  });
});

describe("classifyRetention (GFS)", () => {
  const base = new Date(Date.UTC(2026, 5, 25, 0, 0, 0));
  // 6-hourly snapshots across 400 days → exercises every tier + heavy deletion.
  const files = Array.from({ length: 400 * 4 }, (_, i) => name(hoursAgo(base, i * 6)));

  it("partitions input disjointly and completely", () => {
    const { keep, delete: del } = classifyRetention(files);
    expect(keep.length + del.length).toBe(files.length);
    expect(new Set([...keep, ...del]).size).toBe(files.length);
  });

  it("never keeps more than the tier ceiling", () => {
    const { keep } = classifyRetention(files);
    expect(keep.length).toBeLessThanOrEqual(GFS.hourly + GFS.daily + GFS.weekly + GFS.monthly);
  });

  it("deletes the bulk of a long sparse history", () => {
    const { keep, delete: del } = classifyRetention(files);
    expect(del.length).toBeGreaterThan(keep.length); // 1600 in, ≤82 kept
  });

  it("keeps the newest snapshot and drops the oldest", () => {
    const { keep, delete: del } = classifyRetention(files);
    expect(keep).toContain(name(base)); // newest
    expect(del).toContain(name(hoursAgo(base, 399 * 24))); // oldest
  });

  it("keeps every one of the newest 48 (hourly window)", () => {
    const { keep } = classifyRetention(files);
    for (let i = 0; i < GFS.hourly; i++) expect(keep).toContain(name(hoursAgo(base, i * 6)));
  });

  it("retains at least the 12 most-recent monthly buckets", () => {
    const { keep } = classifyRetention(files);
    const keptMonths = new Set(keep.map((f) => formatTs(parseTs(f)!).slice(0, 6)));
    expect(keptMonths.size).toBeGreaterThanOrEqual(GFS.monthly);
  });

  it("keeps unparseable names defensively", () => {
    const { keep, delete: del } = classifyRetention([
      ...files.slice(0, 5),
      "shepherd.db",
      "weird.gz",
    ]);
    expect(keep).toContain("shepherd.db");
    expect(keep).toContain("weird.gz");
    expect(del).not.toContain("shepherd.db");
  });

  it("is deterministic", () => {
    expect(classifyRetention(files)).toEqual(classifyRetention(files));
  });
});

describe("snapshot + integrity + rotate (live db)", () => {
  let dir: string;
  let dbPath: string;
  let live: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shep-backup-"));
    dbPath = join(dir, "shepherd.db");
    live = new Database(dbPath); // a connection stays OPEN to mimic the running server
    live.run("PRAGMA foreign_keys = ON");
    live.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < 500; i++) live.run("INSERT INTO t (v) VALUES (?)", ["row" + i]);
  });
  afterEach(() => {
    live.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshots a live db read-only and the snapshot passes integrity_check", () => {
    const snap = join(dir, "snap.db");
    snapshot(dbPath, snap);
    expect(existsSync(snap)).toBe(true);
    expect(() => verifyIntegrity(snap)).not.toThrow();
    // the live writer can still commit afterwards
    expect(() => live.run("INSERT INTO t (v) VALUES ('after')")).not.toThrow();
  });

  it("verifyIntegrity throws on a corrupt snapshot (=> caller discards it)", () => {
    const bad = join(dir, "bad.db");
    writeFileSync(bad, "this is not a sqlite file at all");
    expect(() => verifyIntegrity(bad)).toThrow();
  });

  it("rotate deletes only the GFS losers, keeping shepherd-*.db.gz survivors", () => {
    // plant 200 six-hourly snapshots + a foreign file
    const base = new Date(Date.UTC(2026, 5, 25, 0, 0, 0));
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, name(hoursAgo(base, i * 6))), "x");
    writeFileSync(join(dir, "backup.log"), "log");
    rotate(dir);
    const left = readdirSync(dir).filter((f) => f.startsWith("shepherd-") && f.endsWith(".db.gz"));
    expect(left.length).toBeLessThanOrEqual(GFS.hourly + GFS.daily + GFS.weekly + GFS.monthly);
    expect(left.length).toBeLessThan(200);
    expect(existsSync(join(dir, "backup.log"))).toBe(true); // foreign file untouched
  });

  it("rotate reaps orphaned in-progress temp files a crashed run left behind", () => {
    const ts = formatTs(new Date(Date.UTC(2026, 5, 25, 0, 0, 0)));
    const snapTmp = `.shepherd-${ts}.db.tmp`; // uncompressed snapshot temp
    const gzTmp = `shepherd-${ts}.db.gz.tmp`; // pre-rename gzip temp
    writeFileSync(join(dir, snapTmp), "x");
    writeFileSync(join(dir, gzTmp), "x");
    writeFileSync(join(dir, name(new Date(Date.UTC(2026, 5, 25)))), "x"); // a real survivor
    rotate(dir);
    expect(existsSync(join(dir, snapTmp))).toBe(false);
    expect(existsSync(join(dir, gzTmp))).toBe(false);
    expect(existsSync(join(dir, name(new Date(Date.UTC(2026, 5, 25)))))).toBe(true);
  });
});
