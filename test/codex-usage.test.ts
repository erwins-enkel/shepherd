import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { latestCodexStateDb, readCodexTokenUsage } from "../src/codex-usage";

const NOW = Date.parse("2026-06-25T16:00:00.000Z");
const H = 60 * 60 * 1000;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-codex-usage-"));
  dirs.push(dir);
  return dir;
}

function createStateDb(path: string): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      model_provider TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  return db;
}

test("latestCodexStateDb chooses the newest state database", () => {
  const dir = tempDir();
  createStateDb(join(dir, "state_4.sqlite")).close();
  createStateDb(join(dir, "state_12.sqlite")).close();

  expect(latestCodexStateDb(dir)).toBe(join(dir, "state_12.sqlite"));
});

test("latestCodexStateDb returns null when Codex home is not readable as a directory", () => {
  const dir = tempDir();
  const file = join(dir, "not-a-dir");
  writeFileSync(file, "not a directory");

  expect(latestCodexStateDb(file)).toBeNull();
});

test("readCodexTokenUsage summarizes OpenAI Codex tokens", () => {
  const dir = tempDir();
  const path = join(dir, "state_5.sqlite");
  const db = createStateDb(path);
  const insert = db.query(
    "INSERT INTO threads (id, model_provider, tokens_used, updated_at_ms) VALUES (?, ?, ?, ?)",
  );
  insert.run("recent", "openai", 1_000, NOW - H);
  insert.run("week", "openai", 2_000, NOW - 24 * H);
  insert.run("old", "openai", 4_000, NOW - 10 * 24 * H);
  insert.run("local", "ollama", 8_000, NOW - H);
  db.close();

  const usage = readCodexTokenUsage(path, NOW);

  expect(usage).toMatchObject({
    provider: "codex",
    kind: "tokens",
    totalTokens: 7_000,
    session5hTokens: 1_000,
    weekTokens: 3_000,
    updatedAt: NOW - H,
    stale: false,
  });
});

test("readCodexTokenUsage returns null when no OpenAI Codex threads exist", () => {
  const dir = tempDir();
  const path = join(dir, "state_5.sqlite");
  const db = createStateDb(path);
  db.query(
    "INSERT INTO threads (id, model_provider, tokens_used, updated_at_ms) VALUES (?, ?, ?, ?)",
  ).run("local", "ollama", 8_000, NOW - H);
  db.close();

  expect(readCodexTokenUsage(path, NOW)).toBeNull();
});
