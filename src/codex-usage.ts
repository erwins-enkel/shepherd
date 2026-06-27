import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { UsageProviderSnapshot, UsageProviderSource } from "./usage-limits";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

interface CodexUsageRow {
  totalTokens: number | null;
  session5hTokens: number | null;
  weekTokens: number | null;
  updatedAt: number | null;
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function latestCodexStateDb(home = codexHome()): string | null {
  if (!existsSync(home)) return null;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return null;
  }
  const candidates = entries
    .map((name) => {
      const m = /^state_(\d+)\.sqlite$/.exec(name);
      return m ? { name, version: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; version: number } => x !== null)
    .sort((a, b) => b.version - a.version);
  return candidates[0] ? join(home, candidates[0].name) : null;
}

export function readCodexTokenUsage(dbPath: string, now: number): UsageProviderSnapshot | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query<CodexUsageRow, [number, number]>(
        `
        SELECT
          COALESCE(SUM(tokens_used), 0) AS totalTokens,
          COALESCE(SUM(CASE WHEN updated_at_ms >= ? THEN tokens_used ELSE 0 END), 0) AS session5hTokens,
          COALESCE(SUM(CASE WHEN updated_at_ms >= ? THEN tokens_used ELSE 0 END), 0) AS weekTokens,
          MAX(updated_at_ms) AS updatedAt
        FROM threads
        WHERE model_provider = 'openai'
      `,
      )
      .get(now - FIVE_HOURS_MS, now - WEEK_MS);
    if (!row || row.updatedAt === null) return null;
    return {
      provider: "codex",
      kind: "tokens",
      totalTokens: row.totalTokens ?? 0,
      session5hTokens: row.session5hTokens ?? 0,
      weekTokens: row.weekTokens ?? 0,
      updatedAt: row.updatedAt,
      stale: now - row.updatedAt > STALE_MS,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export class CodexUsageProvider implements UsageProviderSource {
  constructor(private stateDbPath?: string) {}

  snapshot(now: number): UsageProviderSnapshot | null {
    const path = this.stateDbPath ?? latestCodexStateDb();
    return path ? readCodexTokenUsage(path, now) : null;
  }
}
