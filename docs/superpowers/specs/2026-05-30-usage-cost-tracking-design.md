# Usage / Cost Tracking from `~/.claude` session JSONL

Date: 2026-05-30
Status: approved, implementing

## Goal

Two surfaces, both sourced from local Claude Code session JSONL:

1. **Per-session token usage** — input/output/cache token counts per Shepherd UNIT.
2. **Account-wide 5h + weekly limit gauges** — live `% used` of the subscription rate-limit windows.

No dollar figures are displayed (operator is on a subscription). Pricing exists only as an
internal relative-weight table for the limit-% math.

## Constraints / decisions

- **Tokens only** in the UI. No `$`.
- **No backfill** — only sessions created after this ships get a pinned `claudeSessionId`.
- **No credits line** (`€/€ spent` ignored).
- **Daily** ceiling calibration via scraping `claude /usage`; gauges stay **live** between scrapes
  by recomputing from local JSONL.
- ToS-pure: the only Claude interaction is driving an **interactive** ephemeral session for
  `/usage` (no `-p`, no SDK).

## Data facts (verified)

- JSONL path: `~/.claude/projects/<dashified cwd>/<sessionId>.jsonl`, where dashify replaces every
  `/` and `.` with `-`.
- Assistant records carry `cwd`, `timestamp`, `message.model`, `message.usage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`),
  and `requestId`. No `costUSD`.
- `claude --session-id <uuid>` is supported → deterministic mapping.
- `/usage` TUI renders parseable lines:
  - `Current session … (\d+)% used … Resets <time>` → 5h window
  - `Current week … (\d+)% used … Resets <date>` → weekly window
  - It is "approximate, based on local sessions on this machine" — i.e. the same JSONL we read.

## Architecture

### 1. Deterministic session → JSONL mapping

- `service.ts`: generate `const claudeSessionId = randomUUID()` at create time; insert
  `--session-id <claudeSessionId>` into the `claude` argv (before the prompt).
- `store.ts`: add `claudeSessionId TEXT` column + idempotent migration (same pattern as `model`).
- `types.ts`: add `claudeSessionId: string` to `Session`.
- Helper `jsonlPathFor(session)` → `<dashified worktreePath>/<claudeSessionId>.jsonl`.

### 2. `src/usage.ts`

**Per-session parse** — `sessionTokens(session): SessionUsage`:

- Stream the session's JSONL line-by-line.
- For each `type:"assistant"` with `message.usage`, accumulate by token kind; dedup by `requestId`
  (skip a `requestId` already counted) to avoid double-counting retried iterations.
- Returns `{ input, output, cacheRead, cacheWrite, total, byModel, messageCount, lastActivity }`.
- Missing file → all-zero result (session may not have produced output yet).

**Account aggregator** — `accountWindows(now): { window5h, window7d }`:

- Incrementally indexes every `~/.claude/projects/**/*.jsonl`. Index entry per file keyed on
  `{ size, mtimeMs }`; on tick, only read appended bytes for files whose size grew, re-parse files
  whose mtime changed unexpectedly, drop deleted files.
- Each parsed assistant record → `{ ts, weightedUnits }` where
  `weightedUnits = Σ tokens_kind × WEIGHT[model][kind]`.
- Returns the sum of `weightedUnits` for records whose `ts` falls in the current 5h and 7d windows
  (window boundaries derived from the persisted reset anchors — see §4).
- In-memory only; rebuilt on core restart. Recompute cadence ~30s (not the 1s status tick).

**`WEIGHTS`** — internal const, never displayed. Relative per-token cost by model prefix
(`opus-4-*`, `sonnet-4-*`, `haiku-4-*`) and kind (input, output, cacheRead, cacheWrite5m,
cacheWrite1h). Unknown model → a default mid weight + console warn once. Daily recalibration of the
cap absorbs systematic weight error as long as model mix is stable within a day.

### 3. herdr additions (`herdr.ts`)

- `send(terminalId, text)` → `herdr agent send <id> <text>`.
- `read(terminalId)` → `herdr agent read <id> --format ansi` (returns raw ANSI string).
- Resolve `terminalId → agent/paneId` via existing `list()` where the CLI needs the agent handle.
  (Exact herdr arg shape confirmed against the installed `herdr` during implementation.)

### 4. `src/usage-limits.ts`

**Scrape + calibrate** — `calibrate()`:

1. Spawn ephemeral claude via `herdr.start("usage-probe", cwd, ["claude","--dangerously-skip-permissions"])`
   with `--no-focus`.
2. Poll `herdr.read()` until boot settles; `send("/usage\r")`; keep reading until the
   "Scanning local sessions" / "Refreshing" state resolves (bounded timeout ~15s).
3. `pane close` the probe.
4. Parse the **last** rendered frame (strip ANSI, collapse whitespace) for the two `% used` +
   `Resets` values.
5. For each window: `cap = accountWindows(now)[window].weightedUnits / (pct/100)` (guard: if
   `pct` is 0 or implausibly small, keep the previously persisted cap to avoid a noisy estimate).
6. Persist `{ window, cap, pct, resetAt, scrapedAt }`.

**Scheduler** — calibrate on startup, then every 24h (`setInterval`). Failure (spawn error, parse
miss, version drift) → log, keep last-good persisted caps, mark `stale: true`. Never throw into the
core.

**Live read** — `limits(now)`:

- `units = accountWindows(now)[window]`; `pct = round(units / cap * 100)`; clamp [0,100].
- Window boundary: roll the persisted `resetAt` anchor forward by the period (5h / 7d) until
  `resetAt ≥ now`; window start = `resetAt − period`.
- Returns `{ session5h: {pct, resetAt}, week: {pct, resetAt}, stale, calibratedAt }`.

### 5. Persistence

New SQLite table in `store.ts` (same DB):

```sql
CREATE TABLE IF NOT EXISTS usage_caps (
  window TEXT PRIMARY KEY,      -- 'session5h' | 'week'
  cap REAL NOT NULL,           -- weighted-unit ceiling
  resetAt INTEGER NOT NULL,     -- ms epoch of the scraped reset boundary
  pct INTEGER NOT NULL,         -- last scraped %
  scrapedAt INTEGER NOT NULL
);
```

Store methods: `getCaps()`, `putCap(row)`.

### 6. API + events (`server.ts`)

- `GET /api/sessions/:id/usage` → `SessionUsage` (404 if session unknown).
- `GET /api/usage/limits` → `{ session5h, week, stale, calibratedAt }`.
- Event `usage:limits` emitted on each ~30s recompute and after each calibration, pushed over the
  existing `/events` WS.

### 7. Wiring (`index.ts`)

- Construct the account aggregator + usage-limits service; pass into the app deps.
- Start the 30s recompute tick (emits `usage:limits`) and the 24h calibration scheduler.

### 8. UI

- `ui/src/lib/types.ts`: `SessionUsage`, `UsageLimits`.
- `ui/src/lib/api.ts`: `getSessionUsage(id)`, `getUsageLimits()`.
- `ui/src/lib/store.svelte.ts`: hold `usageLimits`; update on `usage:limits` WS events.
- `ui/src/lib/format.ts`: `formatTokens(n)` (k/M compaction), `formatReset(ts)`.
- **TopBar**: two compact gauges (5h, weekly). Color ramps toward red near 100%; title/tooltip
  shows reset time. `stale` → muted styling.
- **UnitRow / Viewport**: per-session token count (e.g. `1.2M tok`), refreshed on the existing poll
  tick via `getSessionUsage`.

## Testing

- `test/usage.test.ts`: JSONL fixture → assert per-session token totals; `requestId` dedup;
  missing-file → zeros; `byModel` split.
- `test/usage-window.test.ts`: window roll-forward from a reset anchor; weighted-unit aggregation;
  calibration cap math (`cap = units / (pct/100)`); low-pct guard keeps prior cap.
- `test/usage-parse.test.ts`: `/usage` raw-frame fixture (captured) → extracts both `% used` +
  `Resets` values; tolerates multi-frame buffers (takes last).
- Scrape orchestration (herdr spawn/send/read) stays thin; covered by an integration-style test
  with a stubbed `HerdrDriver`.

## Out of scope

- Dollar/credit display, account-wide charts, per-repo rollups, backfilling existing sessions.

## Known approximations

- Limit % is approximate (matches `/usage`'s own disclaimer): internal weights + daily
  recalibration. Low-`pct` scrapes don't update the cap (too noisy to invert).
- Account scan is in-memory; rebuilt on restart (first post-restart tick re-reads all JSONL once).
