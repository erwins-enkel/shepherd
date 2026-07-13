import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  CodexUsageProvider,
  latestCodexStateDb,
  parseCodexRateLimits,
  recentCodexRolloutPaths,
  readCodexRateLimits,
  readCodexTokenUsage,
} from "../src/codex-usage";

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

/** A Codex rollout `token_count` line carrying a rate-limit reading. */
function rolloutLine(primaryPct: number, secondaryPct: number, primaryReset: number): string {
  return JSON.stringify({
    timestamp: "2026-06-25T15:59:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 1 } },
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: primaryPct, window_minutes: 300, resets_at: primaryReset },
        secondary: {
          used_percent: secondaryPct,
          window_minutes: 10080,
          resets_at: primaryReset + 600,
        },
      },
    },
  });
}

test("parseCodexRateLimits reads the latest primary/secondary windows", () => {
  const resetSec = Math.floor(NOW / 1000) + 3600;
  const content = [
    rolloutLine(1, 1, resetSec - 60),
    '{"type":"event_msg","payload":{"type":"agent_message","text":"hi"}}',
    rolloutLine(43, 9, resetSec), // newest reading wins
  ].join("\n");

  expect(parseCodexRateLimits(content, NOW)).toMatchObject({
    session5h: { pct: 43, resetAt: resetSec * 1000 },
    week: { pct: 9, resetAt: (resetSec + 600) * 1000 },
    source: "rollout",
    checkedAt: NOW,
    filesScanned: 0,
    latestEventAt: Date.parse("2026-06-25T15:59:00.000Z"),
  });
});

test("parseCodexRateLimits classifies a real weekly-only primary window as weekly", () => {
  const content = readFileSync(
    join(import.meta.dir, "fixtures", "codex-usage", "weekly-primary-rollout.jsonl"),
    "utf8",
  );

  expect(parseCodexRateLimits(content, NOW)).toMatchObject({
    session5h: null,
    week: { pct: 3, resetAt: 1784487529 * 1000 },
  });
});

test("parseCodexRateLimits handles reordered weekly-primary and 5h-secondary windows", () => {
  const resetSec = Math.floor(NOW / 1000) + 3600;
  const content = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 17, window_minutes: 10080, resets_at: resetSec + 600 },
        secondary: { used_percent: 41, window_minutes: 300, resets_at: resetSec },
      },
    },
  });

  expect(parseCodexRateLimits(content, NOW)).toMatchObject({
    session5h: { pct: 41, resetAt: resetSec * 1000 },
    week: { pct: 17, resetAt: (resetSec + 600) * 1000 },
  });
});

test("parseCodexRateLimits ignores unknown present durations", () => {
  const resetSec = Math.floor(NOW / 1000) + 3600;
  const content = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 17, window_minutes: 60, resets_at: resetSec },
        secondary: null,
      },
    },
  });

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg) => warnings.push(String(msg));
  try {
    expect(parseCodexRateLimits(content, NOW)).toBeNull();
  } finally {
    console.warn = originalWarn;
  }
  expect(warnings).toEqual(["[codex-usage] ignoring unrecognized rate-limit window: 60m"]);
});

test("parseCodexRateLimits lets the later same-bucket known duration win", () => {
  const resetSec = Math.floor(NOW / 1000) + 3600;
  const content = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 17, window_minutes: 10080, resets_at: resetSec },
        secondary: { used_percent: 23, window_minutes: 10079, resets_at: resetSec + 600 },
      },
    },
  });

  expect(parseCodexRateLimits(content, NOW)).toMatchObject({
    session5h: null,
    week: { pct: 23, resetAt: (resetSec + 600) * 1000 },
  });
});

test("parseCodexRateLimits returns null when no rate-limit event is present", () => {
  const content = '{"type":"event_msg","payload":{"type":"agent_message","text":"hi"}}';
  expect(parseCodexRateLimits(content, NOW)).toBeNull();
});

test("parseCodexRateLimits tolerates whitespace after the rate_limits colon", () => {
  const resetSec = Math.floor(NOW / 1000) + 3600;
  // A line whose key reads `"rate_limits": {` (space after colon) must still be recognized.
  const spaced = rolloutLine(7, 3, resetSec).replace('"rate_limits":{', '"rate_limits": {');
  expect(spaced).toContain('"rate_limits": {');

  expect(parseCodexRateLimits(spaced, NOW)).toMatchObject({
    session5h: { pct: 7, resetAt: resetSec * 1000 },
    week: { pct: 3, resetAt: (resetSec + 600) * 1000 },
  });
});

test("parseCodexRateLimits skips a null rate_limits line and keeps scanning", () => {
  const resetSec = Math.floor(NOW / 1000) + 3600;
  const content = [
    rolloutLine(11, 4, resetSec),
    '{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}',
  ].join("\n");

  // The trailing null reading must not shadow the real one above it.
  expect(parseCodexRateLimits(content, NOW)).toMatchObject({
    session5h: { pct: 11, resetAt: resetSec * 1000 },
    week: { pct: 4, resetAt: (resetSec + 600) * 1000 },
  });
});

test("parseCodexRateLimits ignores non-token-count payloads that mention rate_limits", () => {
  const resetSec = Math.floor(NOW / 1000) + 3600;
  const content = [
    rolloutLine(15, 5, resetSec),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "tool_call",
        internal_chat_message_metadata_passthrough: {
          rate_limits: { primary: { used_percent: 99 } },
        },
      },
    }),
  ].join("\n");

  expect(parseCodexRateLimits(content, NOW)).toMatchObject({
    session5h: { pct: 15, resetAt: resetSec * 1000 },
    week: { pct: 5, resetAt: (resetSec + 600) * 1000 },
  });
});

test("readCodexRateLimits skips files without a reading and uses the first that has one", () => {
  const dir = tempDir();
  const empty = join(dir, "empty.jsonl");
  const withData = join(dir, "with-data.jsonl");
  const resetSec = Math.floor(NOW / 1000) + 3600;
  writeFileSync(empty, '{"type":"event_msg","payload":{"type":"agent_message"}}\n');
  writeFileSync(withData, rolloutLine(50, 20, resetSec));

  expect(readCodexRateLimits([empty, withData, "/no/such/file.jsonl"], NOW)).toMatchObject({
    session5h: { pct: 50, resetAt: resetSec * 1000 },
    week: { pct: 20, resetAt: (resetSec + 600) * 1000 },
    filesScanned: 2,
  });
});

test("recentCodexRolloutPaths lists newest rollout files under CODEX_HOME sessions", () => {
  const dir = tempDir();
  const sessions = join(dir, "sessions", "2026", "06", "25");
  mkdirSync(sessions, { recursive: true });
  const oldPath = join(sessions, "rollout-old.jsonl");
  const newPath = join(sessions, "rollout-new.jsonl");
  writeFileSync(oldPath, "{}\n");
  writeFileSync(newPath, "{}\n");
  writeFileSync(join(sessions, "notes.txt"), "{}\n");
  utimesSync(oldPath, new Date(NOW - H), new Date(NOW - H));
  utimesSync(newPath, new Date(NOW), new Date(NOW));

  expect(recentCodexRolloutPaths(dir, 2)).toEqual([newPath, oldPath]);
});

test("CodexUsageProvider falls back to recent session rollouts when DB paths carry no limits", () => {
  const dir = tempDir();
  const dbPath = join(dir, "state_5.sqlite");
  const sessions = join(dir, "sessions", "2026", "06", "25");
  mkdirSync(sessions, { recursive: true });
  const newest = join(sessions, "rollout-newest.jsonl");
  const older = join(sessions, "rollout-older.jsonl");
  const resetSec = Math.floor(NOW / 1000) + 3600;
  writeFileSync(newest, '{"type":"event_msg","payload":{"type":"agent_message","text":"hi"}}\n');
  writeFileSync(older, rolloutLine(61, 33, resetSec));
  utimesSync(older, new Date(NOW - H), new Date(NOW - H));
  utimesSync(newest, new Date(NOW), new Date(NOW));

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      model_provider TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      rollout_path TEXT NOT NULL DEFAULT ''
    )
  `);
  db.query(
    "INSERT INTO threads (id, model_provider, tokens_used, updated_at_ms, rollout_path) VALUES (?, ?, ?, ?, ?)",
  ).run("recent", "openai", 1_000, NOW - H, "");
  db.close();

  const snap = new CodexUsageProvider(dbPath, dir).snapshot(NOW);

  expect(snap).toMatchObject({
    provider: "codex",
    kind: "tokens",
    session5h: { pct: 61, resetAt: resetSec * 1000 },
    week: { pct: 33, resetAt: (resetSec + 600) * 1000 },
    rateLimitSource: "rollout",
    rateLimitFilesScanned: 2,
  });
});

test("CodexUsageProvider.snapshot merges token counts with rollout rate limits", () => {
  const dir = tempDir();
  const dbPath = join(dir, "state_5.sqlite");
  const rollout = join(dir, "rollout.jsonl");
  const resetSec = Math.floor(NOW / 1000) + 3600;
  writeFileSync(rollout, rolloutLine(38, 22, resetSec));

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      model_provider TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      rollout_path TEXT NOT NULL DEFAULT ''
    )
  `);
  db.query(
    "INSERT INTO threads (id, model_provider, tokens_used, updated_at_ms, rollout_path) VALUES (?, ?, ?, ?, ?)",
  ).run("recent", "openai", 1_000, NOW - H, rollout);
  db.close();

  const snap = new CodexUsageProvider(dbPath, dir).snapshot(NOW);

  expect(snap).toMatchObject({
    provider: "codex",
    kind: "tokens",
    totalTokens: 1_000,
    session5h: { pct: 38, resetAt: resetSec * 1000 },
    week: { pct: 22, resetAt: (resetSec + 600) * 1000 },
    rateLimitSource: "rollout",
  });
});
