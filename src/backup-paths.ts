/**
 * Pure, side-effect-free path resolution for the SQLite backup feature (#1080).
 *
 * Deliberately self-contained: the backup *script* (`scripts/backup.ts`) must NOT import
 * `src/config.ts`, which eagerly runs `loadForgeMap`/`resolveNodeBin` and other side effects at
 * module load. Both the script and the server's staleness check import THIS module so the backup
 * directory default can never drift between writer and reader.
 */
import { dirname, join } from "node:path";

/** Absolute path to the SQLite DB. Mirrors `src/config.ts`'s `SHEPHERD_DB` resolution exactly. */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHEPHERD_DB ?? `${env.HOME}/.shepherd/shepherd.db`;
}

/** Backup destination dir. `SHEPHERD_BACKUP_DIR` override, else `<dir-of-db>/backups` (mirrors
 *  how forges.json sits next to the db). */
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHEPHERD_BACKUP_DIR ?? join(dirname(resolveDbPath(env)), "backups");
}

/** Marker written when the backup timer is enabled (provision/update). Its presence is what tells
 *  the server a host is *expected* to have backups — so a box with zero successful runs is still
 *  flagged stale, while a macOS/core-only host (no timer, no marker) stays silent. */
export function backupConfiguredMarker(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveBackupDir(env), ".backup-configured");
}

/** Timestamp of the most recent successful backup (ISO string inside). */
export function lastSuccessMarker(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveBackupDir(env), ".last-success");
}
