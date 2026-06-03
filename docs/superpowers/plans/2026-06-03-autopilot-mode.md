# Autopilot Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in per-session loop that keeps an interactive Claude Code agent moving through procedural gates and drives it to a PR, escalating only genuine questions to the operator (distinct state + push).

**Architecture:** A new `AutopilotService` (`src/autopilot.ts`) — the pre-PR twin of the critic's `runAutoAddress` loop. It subscribes to the `session:block` and `session:status` events the `StatusPoller` already emits. On a settled, autopilot-enabled session with no open PR, it spawns a transient haiku classifier (`src/autopilot-llm.ts`, mirroring `src/namer-llm.ts`) over the terminal tail + task prompt, which returns `gate` | `question` | `finished` | `unknown`. Gates get a server-owned "keep going" steer; `finished` gets steered (resume if the pane exited) toward `gh pr create`; `question`/`unknown` pause the session loudly. Menus and stalls are never auto-answered. Hands off to the existing critic loop the moment a PR opens.

**Tech Stack:** Bun + TypeScript (server, `src/`), `bun:sqlite` store, `bun:test`; SvelteKit + Paraglide i18n (`ui/`). Transient `claude` CLI spawns via the herdr driver (subscription OAuth, `--permission-mode dontAsk`).

**Reference reading before you start:** `src/review.ts` (the loop to mirror — `consider`/`begin`/`runAutoAddress`, the `starting` re-entrancy guard, the spawn argv + its load-bearing comments), `src/namer-llm.ts` (the transient-classifier spawn to clone), `src/poller.ts` (`onBlock`/`onChange` callback shapes), `src/service.ts:264` (`resume`) + `:364` (`reply`), `src/store.ts:194-226` (repo config), `src/push.ts` (notify pipeline). The design spec is `docs/superpowers/specs/2026-06-03-autopilot-mode-design.md`.

**House rules that bite here:** spendy loop defaults OFF / explicit opt-in; agent-facing steer text is English-only (NOT in the i18n catalog — comment why); every new UI string needs matching `en.json` + `de.json` keys (the `check:i18n` gate); bound content injected into agent prompts; never `--dangerously-skip-permissions` for the classifier; bare `Write` tool (scoped `Write(path)` is denied under `dontAsk`); `--permission-mode` must sit AFTER the variadic `--allowedTools` and BEFORE the trailing prompt.

---

## File Structure

**Create:**
- `src/autopilot-llm.ts` — transient classifier spawn (clone of `namer-llm.ts`): `classifierPrompt()`, `classifyStop()`, file constant. One responsibility: turn a terminal tail into an `AutopilotVerdict`.
- `src/autopilot.ts` — `AutopilotService`: eligibility, shape-gating, step accounting, action dispatch, pause/handoff. The loop.
- `test/autopilot-llm.test.ts`, `test/autopilot.test.ts` — unit tests for the two new modules.

**Modify:**
- `src/types.ts` — `AutopilotKind`/`AutopilotVerdict` types; `Session` autopilot fields; `RepoConfig.autopilotEnabled`.
- `src/store.ts` — `sessions` + `repo_config` migrations; `hydrate` coercion; `getRepoConfig`/`setRepoConfig`; `update` patch widening; new `setAutopilotState`.
- `src/config.ts` — `autopilotStepCap`, `autopilotModel`.
- `src/push.ts` — `autopilot` notify kind + `summary` passthrough.
- `src/index.ts` — instantiate + wire `AutopilotService`; attach its push.
- `src/server.ts` — repo-config PUT accepts `autopilotEnabled`; `PUT /api/sessions/:id/autopilot`.
- `ui/src/lib/types.ts`, `ui/src/lib/api.ts`, `ui/src/lib/components/GitRail.svelte`, the session-row/control component, `ui/messages/en.json`, `ui/messages/de.json`.

---

## Task 1: Data model — types, store migrations, accessors

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store.ts:25-30` (RepoConfig), `:75-114` (migrations), `:194-226` (config accessors), `:328-350` (update), `hydrate`
- Test: `test/store-autopilot.test.ts` (create)

- [ ] **Step 1: Add types**

In `src/types.ts`, extend `Session` (after `readyToMerge`, before `status`):

```typescript
  readyToMerge: boolean; // manually-toggled "parked / done" flag; orthogonal to status
  /** Autopilot opt-in: true/false override, or null to inherit the repo default. */
  autopilotEnabled: boolean | null;
  /** Auto-steers autopilot has spent on this session (runaway guard; reset on PR-open / operator reply). */
  autopilotStepCount: number;
  /** True when autopilot handed control back for a genuine question / step-cap. */
  autopilotPaused: boolean;
  /** The classifier's 1–2 sentence summary of what the agent is waiting for; null when not paused. */
  autopilotQuestion: string | null;
```

Extend `RepoConfig` in `src/types.ts` (it is re-exported via store; the interface lives in `src/store.ts:25` — add the field there, see Step 3). Add the verdict types at the end of `src/types.ts`:

```typescript
// ── autopilot mode ──────────────────────────────────────────────────────────
export type AutopilotKind = "gate" | "question" | "finished" | "unknown";

export interface AutopilotVerdict {
  kind: AutopilotKind;
  /** 1–2 sentence plain-English description of what the agent is waiting for. */
  summary: string;
}
```

- [ ] **Step 2: Write the failing store test**

Create `test/store-autopilot.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

function freshStore(): SessionStore {
  return new SessionStore(":memory:");
}

function seed(store: SessionStore) {
  return store.create({
    name: "t",
    prompt: "p",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "term_1",
  } as any);
}

test("new sessions default autopilot off/zeroed/unpaused", () => {
  const store = freshStore();
  const s = store.get(seed(store).id)!;
  expect(s.autopilotEnabled).toBeNull();
  expect(s.autopilotStepCount).toBe(0);
  expect(s.autopilotPaused).toBe(false);
  expect(s.autopilotQuestion).toBeNull();
});

test("setAutopilotState patches only the given fields", () => {
  const store = freshStore();
  const id = seed(store).id;
  store.setAutopilotState(id, { enabled: true });
  expect(store.get(id)!.autopilotEnabled).toBe(true);
  store.setAutopilotState(id, { stepCount: 3, paused: true, question: "Which auth provider?" });
  let s = store.get(id)!;
  expect(s.autopilotEnabled).toBe(true); // untouched
  expect(s.autopilotStepCount).toBe(3);
  expect(s.autopilotPaused).toBe(true);
  expect(s.autopilotQuestion).toBe("Which auth provider?");
  store.setAutopilotState(id, { paused: false, question: null, stepCount: 0 });
  s = store.get(id)!;
  expect(s.autopilotPaused).toBe(false);
  expect(s.autopilotQuestion).toBeNull();
  expect(s.autopilotStepCount).toBe(0);
});

test("repo config autopilotEnabled defaults off and round-trips", () => {
  const store = freshStore();
  expect(store.getRepoConfig("/repo").autopilotEnabled).toBe(false);
  store.setRepoConfig("/repo", {
    criticEnabled: true,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: true,
  });
  expect(store.getRepoConfig("/repo").autopilotEnabled).toBe(true);
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `bun test ./test/store-autopilot.test.ts`
Expected: FAIL — `setAutopilotState` is not a function / `autopilotEnabled` undefined.

- [ ] **Step 4: Implement the store changes**

In `src/store.ts`, add to the `RepoConfig` interface (`:25`):

```typescript
export interface RepoConfig {
  criticEnabled: boolean;
  /** Auto-feed critic findings back to the task agent until clean or the round cap. */
  autoAddressEnabled: boolean;
  learningsEnabled: boolean;
  /** Pre-PR autopilot loop: drive procedural gates, surface real questions, lead to a PR. */
  autopilotEnabled: boolean;
}
```

In the `sessions` `CREATE TABLE` (`:75`), append the four columns to the column list and add migrations after the `readyToMerge` migration (`:91-93`):

```typescript
    if (!cols.some((c) => c.name === "autopilotEnabled")) {
      // nullable: NULL = inherit repo default, 0/1 = explicit per-session override
      this.db.run(`ALTER TABLE sessions ADD COLUMN autopilotEnabled INTEGER`);
    }
    if (!cols.some((c) => c.name === "autopilotStepCount")) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN autopilotStepCount INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.some((c) => c.name === "autopilotPaused")) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN autopilotPaused INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.some((c) => c.name === "autopilotQuestion")) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN autopilotQuestion TEXT`);
    }
```

Also add the four columns to the `CREATE TABLE IF NOT EXISTS sessions (...)` body so fresh DBs get them (place after `readyToMerge` is implied via migration — but the create statement at `:75` does not list `readyToMerge` either; it relies on migration. Follow that pattern: rely on the migrations above, no change to the CREATE body). Update `COLS` (`:68`) to include the new columns so `get`/`list`/`create` read/write them:

```typescript
const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, claudeSessionId, model, readyToMerge, status, lastState,
  autopilotEnabled, autopilotStepCount, autopilotPaused, autopilotQuestion,
  createdAt, updatedAt, archivedAt`;
```

In `create` (`:292`), the `INSERT ... VALUES` placeholder count and the values array must match `COLS`. Insert the four values right after `s.lastState` and before `s.createdAt`, defaulting them (new sessions start off/zeroed):

```typescript
      s.status,
      s.lastState,
      null, // autopilotEnabled — inherit repo default
      0, // autopilotStepCount
      0, // autopilotPaused
      null, // autopilotQuestion
      s.createdAt,
```

Add `?` placeholders to match (the `VALUES (?,?,…)` list must grow by 4). Also set the defaults on the constructed `s` object (`:279`) so the returned Session is correct without a re-read:

```typescript
      readyToMerge: false,
      autopilotEnabled: null,
      autopilotStepCount: 0,
      autopilotPaused: false,
      autopilotQuestion: null,
```

In `hydrate` (the `Session` one), coerce the int columns:

```typescript
  private hydrate(r: any): Session {
    return {
      ...r,
      isolated: !!r.isolated,
      readyToMerge: !!r.readyToMerge,
      claudeSessionId: r.claudeSessionId ?? "",
      autopilotEnabled: r.autopilotEnabled === null || r.autopilotEnabled === undefined
        ? null
        : !!r.autopilotEnabled,
      autopilotStepCount: r.autopilotStepCount ?? 0,
      autopilotPaused: !!r.autopilotPaused,
      autopilotQuestion: r.autopilotQuestion ?? null,
    } as Session;
  }
```

Update `getRepoConfig` (`:194`) to select + default `autopilotEnabled` (defaults OFF, like auto-address):

```typescript
  getRepoConfig(repoPath: string): RepoConfig {
    const r = this.db
      .query(
        `SELECT criticEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled FROM repo_config WHERE repoPath = ?`,
      )
      .get(repoPath) as {
      criticEnabled: number;
      autoAddressEnabled: number;
      learningsEnabled: number;
      autopilotEnabled: number;
    } | null;
    return {
      criticEnabled: r ? !!r.criticEnabled : true,
      autoAddressEnabled: r ? !!r.autoAddressEnabled : false,
      learningsEnabled: r ? !!r.learningsEnabled : true,
      autopilotEnabled: r ? !!r.autopilotEnabled : false,
    };
  }
```

Add the `repo_config` migration after the `learningsEnabled` one (`:112-114`):

```typescript
    if (!repoCfgCols.some((c) => c.name === "autopilotEnabled")) {
      this.db.run(`ALTER TABLE repo_config ADD COLUMN autopilotEnabled INTEGER NOT NULL DEFAULT 0`);
    }
```

Update `setRepoConfig` (`:212`) to persist `autopilotEnabled` (add the column to the INSERT, the `ON CONFLICT` SET list, and the values array):

```typescript
  setRepoConfig(repoPath: string, cfg: RepoConfig): void {
    this.db.run(
      `INSERT INTO repo_config (repoPath, criticEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled, updatedAt)
         VALUES (?,?,?,?,?,?)
       ON CONFLICT(repoPath) DO UPDATE SET criticEnabled = excluded.criticEnabled,
         autoAddressEnabled = excluded.autoAddressEnabled,
         learningsEnabled = excluded.learningsEnabled,
         autopilotEnabled = excluded.autopilotEnabled, updatedAt = excluded.updatedAt`,
      [
        repoPath,
        cfg.criticEnabled ? 1 : 0,
        cfg.autoAddressEnabled ? 1 : 0,
        cfg.learningsEnabled ? 1 : 0,
        cfg.autopilotEnabled ? 1 : 0,
        Date.now(),
      ],
    );
  }
```

Add a focused `setAutopilotState` method near `update` (`:328`). It is separate from `update` because `update`'s typed patch only covers a fixed column set and is called all over the poller — keeping autopilot writes here avoids widening that hot path:

```typescript
  /** Patch a session's autopilot fields. Only the provided keys are written. */
  setAutopilotState(
    id: string,
    patch: {
      enabled?: boolean | null;
      stepCount?: number;
      paused?: boolean;
      question?: string | null;
    },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const enabled = patch.enabled === undefined ? cur.autopilotEnabled : patch.enabled;
    const stepCount = patch.stepCount ?? cur.autopilotStepCount;
    const paused = patch.paused ?? cur.autopilotPaused;
    const question = patch.question === undefined ? cur.autopilotQuestion : patch.question;
    this.db.run(
      `UPDATE sessions SET autopilotEnabled=?, autopilotStepCount=?, autopilotPaused=?, autopilotQuestion=?, updatedAt=? WHERE id=?`,
      [
        enabled === null ? null : enabled ? 1 : 0,
        stepCount,
        paused ? 1 : 0,
        question,
        Date.now(),
        id,
      ],
    );
  }
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `bun test ./test/store-autopilot.test.ts`
Expected: PASS (3 tests).

Also run the existing store-touching tests to confirm no regression from the `COLS`/migration change:
Run: `bun test ./test/rename.test.ts ./test/reconcile.test.ts ./test/poller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store.ts test/store-autopilot.test.ts
git commit -m "feat(autopilot): session + repo-config data model"
```

---

## Task 2: Config knobs — step cap + classifier model

**Files:**
- Modify: `src/config.ts:78` (near `houseRulesBudgetChars`)

- [ ] **Step 1: Add the settings**

In `src/config.ts`, after `houseRulesBudgetChars` (`:78`):

```typescript
  /** Max auto-steers autopilot spends per session before it pauses for the operator. */
  autopilotStepCap: Number(process.env.SHEPHERD_AUTOPILOT_STEP_CAP ?? 10),
  /** Model alias for the transient autopilot classifier spawn. */
  autopilotModel: process.env.SHEPHERD_AUTOPILOT_MODEL ?? "haiku",
```

- [ ] **Step 2: Verify it type-checks**

Run: `bunx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(autopilot): step-cap + classifier-model config"
```

---

## Task 3: The classifier — `src/autopilot-llm.ts`

**Files:**
- Create: `src/autopilot-llm.ts`
- Test: `test/autopilot-llm.test.ts`

This clones `src/namer-llm.ts` exactly (same spawn isolation, same poll-file pattern), but the agent reads a tail + task and writes a `{kind, summary}` verdict instead of a slug. Read `src/namer-llm.ts` first and mirror its structure and its load-bearing comments.

- [ ] **Step 1: Write the failing test**

Create `test/autopilot-llm.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { classifyStop, classifierPrompt, VERDICT_FILE } from "../src/autopilot-llm";

function makeDeps(over: Partial<import("../src/autopilot-llm").ClassifierDeps> = {}) {
  const calls: any = { started: null, stopped: false, cleaned: false };
  const base = {
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        calls.started = { name, cwd, argv };
        return { terminalId: "term_c", cwd } as any;
      },
      stop: () => {
        calls.stopped = true;
      },
    },
    makeTmpDir: () => "/tmp/autopilot-xyz",
    cleanup: () => {
      calls.cleaned = true;
    },
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 30_000,
    pollMs: 1_000,
    ...over,
  };
  return { deps: base as any, calls };
}

test("classifierPrompt embeds the tail + task and asks for the verdict file", () => {
  const p = classifierPrompt(["agent: Shall I write the spec first? (y/n)"], "Build a login page");
  expect(p).toContain("Shall I write the spec first");
  expect(p).toContain("Build a login page");
  expect(p).toContain(VERDICT_FILE);
  expect(p.toLowerCase()).toContain("gate");
  expect(p.toLowerCase()).toContain("question");
});

test("classifyStop: parses a gate verdict; spawns haiku, dontAsk, Write-only", async () => {
  const { deps, calls } = makeDeps({
    readVerdict: () => ({ kind: "gate", summary: "asking whether to start" }),
  });
  const v = await classifyStop(["Ready to start? (y/n)"], "task", deps, "autopilot TASK-07");
  expect(v).toEqual({ kind: "gate", summary: "asking whether to start" });
  expect(calls.started.name).toBe("autopilot TASK-07");
  expect(calls.started.argv[0]).toBe("claude");
  expect(calls.started.argv).toContain("--model");
  expect(calls.started.argv).toContain("haiku");
  // dontAsk must sit AFTER --allowedTools and BEFORE the prompt
  const pm = calls.started.argv.indexOf("--permission-mode");
  const at = calls.started.argv.indexOf("--allowedTools");
  expect(at).toBeGreaterThan(-1);
  expect(pm).toBeGreaterThan(at);
  expect(calls.started.argv[pm + 1]).toBe("dontAsk");
  expect(calls.started.argv[calls.started.argv.length - 1]).toContain("task");
  expect(calls.stopped).toBe(true);
  expect(calls.cleaned).toBe(true);
});

test("classifyStop: unknown/surface on timeout (null verdict)", async () => {
  const { deps } = makeDeps({ readVerdict: () => null, timeoutMs: 0 });
  const v = await classifyStop(["…"], "task", deps, "l");
  expect(v).toEqual({ kind: "unknown", summary: "" });
});

test("classifyStop: bad kind coerces to unknown (bias to surface)", async () => {
  const { deps } = makeDeps({ readVerdict: () => ({ kind: "banana", summary: "x" }) as any });
  const v = await classifyStop(["…"], "task", deps, "l");
  expect(v.kind).toBe("unknown");
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test ./test/autopilot-llm.test.ts`
Expected: FAIL — module `../src/autopilot-llm` not found.

- [ ] **Step 3: Implement `src/autopilot-llm.ts`**

```typescript
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrDriver } from "./herdr";
import type { AutopilotVerdict, AutopilotKind } from "./types";

/** The file the classifier agent writes its verdict JSON to, in its temp cwd. */
export const VERDICT_FILE = ".shepherd-autopilot.json";

const KINDS: AutopilotKind[] = ["gate", "question", "finished", "unknown"];
/** Uncertain → surface. A wrongly-surfaced gate costs one click; a wrongly-answered
 *  question costs a bad product decision. */
const SURFACE: AutopilotVerdict = { kind: "unknown", summary: "" };

export interface ClassifierDeps {
  herdr: Pick<HerdrDriver, "start" | "stop">;
  makeTmpDir?: () => string;
  readVerdict?: (cwd: string) => RawVerdict | null;
  cleanup?: (cwd: string) => void;
  model?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

interface RawVerdict {
  kind?: unknown;
  summary?: unknown;
}

/**
 * Self-contained instructions for the classifier agent. NOT UI chrome — never i18n'd.
 * The tail is UNTRUSTED agent output; it is embedded as data the agent only classifies,
 * never executes — the Write-only / dontAsk / no-Bash sandbox contains any injection.
 */
export function classifierPrompt(tail: string[], taskPrompt: string): string {
  const clippedTask = taskPrompt.slice(0, 1500);
  const clippedTail = tail.slice(-20).join("\n").slice(0, 3000);
  return [
    "You are triaging why a coding agent has stopped. Read its task and the tail of its terminal,",
    "then classify WHY it is waiting. Do not do the task. Do not run anything.",
    "",
    "The agent's task:",
    clippedTask,
    "",
    "The tail of the agent's terminal (most recent last):",
    clippedTail,
    "",
    "Classify into exactly one `kind`:",
    '- "gate": a procedural/workflow stop the agent could resolve itself and the answer is obviously "yes, keep going" — e.g. "shall I write the spec first?", "ready to start implementing?", "want me to commit now?". Choose this ONLY when proceeding is clearly correct.',
    '- "question": a real decision that needs a human — a product/requirements fork, ambiguous intent, a choice between materially different approaches, or anything the agent should not decide unilaterally.',
    '- "finished": the agent believes it is done or has nothing left to do, but has not opened a pull request yet.',
    '- "unknown": you cannot confidently tell. When in doubt, use this — never guess "gate".',
    "",
    `Write your verdict as JSON to the file \`${VERDICT_FILE}\` in the current directory, with EXACTLY this shape, then stop:`,
    '{"kind": "gate" | "question" | "finished" | "unknown", "summary": "<1-2 sentence plain description of what the agent is waiting for>"}',
    "Do not read or modify any other file.",
  ].join("\n");
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultMakeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-autopilot-"));
}
function defaultReadVerdict(cwd: string): RawVerdict | null {
  const p = join(cwd, VERDICT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawVerdict;
  } catch {
    return null; // partial write; try again next poll
  }
}
function defaultCleanup(cwd: string): void {
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * The `claude` argv for the classifier spawn — identical isolation to the namer
 * (src/namer-llm.ts) and critic: clean context (disableAllHooks + disable-slash-commands),
 * subscription OAuth (NOT --bare), bare `Write` (scoped Write denied under dontAsk),
 * and --permission-mode dontAsk LAST (after the variadic --allowedTools, before the
 * trailing prompt). Don't reorder.
 */
function classifierArgv(model: string | null, prompt: string): string[] {
  const argv = [
    "claude",
    "--session-id",
    randomUUID(),
    "--settings",
    '{"disableAllHooks":true}',
    "--disable-slash-commands",
    "--allowedTools",
    "Write",
  ];
  if (model) argv.push("--model", model);
  argv.push("--permission-mode", "dontAsk");
  argv.push(prompt);
  return argv;
}

interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

async function pollForVerdict(
  readVerdict: (cwd: string) => RawVerdict | null,
  cwd: string,
  clock: PollClock,
): Promise<RawVerdict | null> {
  const start = clock.now();
  while (clock.now() - start <= clock.timeoutMs) {
    const raw = readVerdict(cwd);
    if (raw !== null) return raw;
    await clock.sleep(clock.pollMs);
  }
  return null;
}

function normalize(raw: RawVerdict | null): AutopilotVerdict {
  if (!raw || typeof raw.kind !== "string" || !KINDS.includes(raw.kind as AutopilotKind)) {
    return SURFACE;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.slice(0, 280) : "";
  return { kind: raw.kind as AutopilotKind, summary };
}

/**
 * Classify why an agent stopped, via a transient interactive `claude` (subscription OAuth —
 * NOT `claude -p`). Spawns the classifier model in a fresh temp dir with only the Write
 * tool, polls for the verdict file, normalizes it, then tears the agent + dir down.
 * Returns `{kind:"unknown",summary:""}` on any failure/timeout/garbage — bias to surface.
 */
export async function classifyStop(
  tail: string[],
  taskPrompt: string,
  deps: ClassifierDeps,
  label: string,
): Promise<AutopilotVerdict> {
  const {
    makeTmpDir = defaultMakeTmpDir,
    readVerdict = defaultReadVerdict,
    cleanup = defaultCleanup,
    model = "haiku",
    now = Date.now,
    sleep = realSleep,
    timeoutMs = 60_000,
    pollMs = 1_000,
  } = deps;

  let cwd: string | null = null;
  let terminalId: string | null = null;
  try {
    cwd = makeTmpDir();
    const prompt = classifierPrompt(tail, taskPrompt);
    try {
      terminalId = deps.herdr.start(label, cwd, classifierArgv(model, prompt)).terminalId;
    } catch {
      return SURFACE; // herdr/claude unavailable → surface (don't auto-proceed blind)
    }
    const raw = await pollForVerdict(readVerdict, cwd, { now, sleep, timeoutMs, pollMs });
    return normalize(raw);
  } finally {
    if (terminalId) {
      try {
        deps.herdr.stop(terminalId);
      } catch {
        /* best-effort */
      }
    }
    if (cwd) cleanup(cwd);
  }
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test ./test/autopilot-llm.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/autopilot-llm.ts test/autopilot-llm.test.ts
git commit -m "feat(autopilot): transient stop-classifier spawn"
```

---

## Task 4: `AutopilotService` — eligibility, classify, dispatch

**Files:**
- Create: `src/autopilot.ts`
- Test: `test/autopilot.test.ts`

Mirror `ReviewService` (`src/review.ts`): a `pending` re-entrancy guard (its `starting` analog), injectable deps, all I/O behind callbacks so it unit-tests with zero real spawns.

- [ ] **Step 1: Write the failing test**

Create `test/autopilot.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { AutopilotService, PROCEED_STEER, OPEN_PR_STEER } from "../src/autopilot";
import type { AutopilotVerdict, Session } from "../src/types";
import type { BlockReason } from "../src/blocked";

function sess(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "t",
    prompt: "Build login",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "term_1",
    claudeSessionId: "cs",
    model: null,
    readyToMerge: false,
    autopilotEnabled: true,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotQuestion: null,
    status: "blocked",
    lastState: "blocked",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...over,
  };
}

function block(tail = ["Shall I start? (y/n)"]): BlockReason {
  return { shape: "awaiting-input", options: [], tail };
}

function harness(opts: {
  session: Session;
  verdict?: AutopilotVerdict;
  repoEnabled?: boolean;
  openPr?: boolean;
  paneAlive?: boolean;
  resumeOk?: boolean;
  steerOk?: boolean;
}) {
  let cur = opts.session;
  const events: any[] = [];
  const svc = new AutopilotService({
    store: {
      get: () => cur,
      getRepoConfig: () =>
        ({ criticEnabled: true, autoAddressEnabled: false, learningsEnabled: true,
           autopilotEnabled: opts.repoEnabled ?? false }) as any,
      setAutopilotState: (_id, patch) => {
        cur = {
          ...cur,
          autopilotEnabled: patch.enabled === undefined ? cur.autopilotEnabled : patch.enabled,
          autopilotStepCount: patch.stepCount ?? cur.autopilotStepCount,
          autopilotPaused: patch.paused ?? cur.autopilotPaused,
          autopilotQuestion: patch.question === undefined ? cur.autopilotQuestion : patch.question,
        };
      },
    } as any,
    classify: async () => opts.verdict ?? { kind: "unknown", summary: "" },
    steer: (_id, text) => {
      events.push({ steer: text });
      return opts.steerOk ?? true;
    },
    resume: () => {
      events.push({ resume: true });
      return opts.resumeOk ?? true;
    },
    paneAlive: () => opts.paneAlive ?? true,
    readTail: () => ["finished, nothing else"],
    hasOpenPr: () => opts.openPr ?? false,
    onPause: (id, q) => events.push({ pause: id, q }),
    stepCap: 10,
  });
  return { svc, events, state: () => cur };
}

test("gate verdict → proceed steer + step++", async () => {
  const h = harness({ session: sess(), verdict: { kind: "gate", summary: "asking to start" } });
  await h.svc.onBlock("s1", block());
  expect(h.events).toContainEqual({ steer: PROCEED_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
  expect(h.state().autopilotPaused).toBe(false);
});

test("finished verdict → open-PR steer", async () => {
  const h = harness({ session: sess(), verdict: { kind: "finished", summary: "done, no PR" } });
  await h.svc.onBlock("s1", block(["I'm done."]));
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER });
  expect(h.state().autopilotStepCount).toBe(1);
});

test("question verdict → pause + onPause, no steer", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "question", summary: "Which auth provider?" },
  });
  await h.svc.onBlock("s1", block(["Use OAuth or passwords?"]));
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.events).toContainEqual({ pause: "s1", q: "Which auth provider?" });
  expect(h.state().autopilotPaused).toBe(true);
  expect(h.state().autopilotQuestion).toBe("Which auth provider?");
});

test("unknown verdict → pause (bias to surface)", async () => {
  const h = harness({ session: sess(), verdict: { kind: "unknown", summary: "" } });
  await h.svc.onBlock("s1", block());
  expect(h.state().autopilotPaused).toBe(true);
});

test("menu shape never classifies or steers (always surfaces as-is)", async () => {
  const h = harness({ session: sess(), verdict: { kind: "gate", summary: "x" } });
  await h.svc.onBlock("s1", { shape: "menu", options: [{ label: "Yes", send: "1" }], tail: [] });
  expect(h.events.length).toBe(0);
  expect(h.state().autopilotStepCount).toBe(0);
});

test("disabled (repo off, no override) → no-op", async () => {
  const h = harness({
    session: sess({ autopilotEnabled: null }),
    repoEnabled: false,
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("session override on beats repo off", async () => {
  const h = harness({
    session: sess({ autopilotEnabled: true }),
    repoEnabled: false,
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.state().autopilotStepCount).toBe(1);
});

test("session override off beats repo on", async () => {
  const h = harness({
    session: sess({ autopilotEnabled: false }),
    repoEnabled: true,
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("open PR → autopilot stands down (critic owns it)", async () => {
  const h = harness({ session: sess(), openPr: true, verdict: { kind: "gate", summary: "x" } });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("already paused → no re-classify", async () => {
  const h = harness({
    session: sess({ autopilotPaused: true }),
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.length).toBe(0);
});

test("step at cap → pause instead of steering", async () => {
  const h = harness({
    session: sess({ autopilotStepCount: 10 }),
    verdict: { kind: "gate", summary: "x" },
  });
  await h.svc.onBlock("s1", block());
  expect(h.events.some((e) => "steer" in e)).toBe(false);
  expect(h.state().autopilotPaused).toBe(true);
});

test("steer that doesn't land → no step++", async () => {
  const h = harness({
    session: sess(),
    verdict: { kind: "gate", summary: "x" },
    steerOk: false,
  });
  await h.svc.onBlock("s1", block());
  expect(h.state().autopilotStepCount).toBe(0);
});

test("finished + dead pane → resume then steer", async () => {
  const h = harness({
    session: sess({ status: "done" }),
    verdict: { kind: "finished", summary: "done" },
    paneAlive: false,
    resumeOk: true,
  });
  await h.svc.onDone("s1");
  expect(h.events).toContainEqual({ resume: true });
  expect(h.events).toContainEqual({ steer: OPEN_PR_STEER });
});

test("onStatus running after pause clears pause + resets steps", async () => {
  const h = harness({ session: sess({ autopilotPaused: true, autopilotStepCount: 5 }) });
  h.svc.onStatus("s1", "running");
  expect(h.state().autopilotPaused).toBe(false);
  expect(h.state().autopilotQuestion).toBeNull();
  expect(h.state().autopilotStepCount).toBe(0);
});

test("onStatus running when not paused is a no-op (doesn't reset the cap)", async () => {
  const h = harness({ session: sess({ autopilotPaused: false, autopilotStepCount: 5 }) });
  h.svc.onStatus("s1", "running");
  expect(h.state().autopilotStepCount).toBe(5);
});

test("onPrOpen resets steps + clears pause (handoff)", async () => {
  const h = harness({ session: sess({ autopilotPaused: true, autopilotStepCount: 7 }) });
  h.svc.onPrOpen("s1");
  expect(h.state().autopilotStepCount).toBe(0);
  expect(h.state().autopilotPaused).toBe(false);
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test ./test/autopilot.test.ts`
Expected: FAIL — module `../src/autopilot` not found.

- [ ] **Step 3: Implement `src/autopilot.ts`**

```typescript
import type { SessionStore } from "./store";
import type { Session, AutopilotVerdict } from "./types";
import type { BlockReason } from "./blocked";

/**
 * Agent-facing steer templates. NOT UI chrome — never i18n'd (they are typed into the
 * agent's PTY, which is an English Claude Code session). Shepherd owns this text; the
 * classifier never authors pane input, so an untrusted tail can't inject a steer.
 */
export const PROCEED_STEER = [
  "You're in autopilot. Don't stop to ask whether to write specs, plans, or to start",
  "implementing — make a reasonable decision yourself and keep going. Drive the work all",
  "the way to an open pull request. Only stop to ask if you hit a genuine product or",
  "requirements decision that only the user can make.",
].join("\n");

export const OPEN_PR_STEER = [
  "You're in autopilot and you've stopped, but there's no pull request yet. Commit your",
  "work, push the branch, and open a PR (gh pr create). If something genuinely blocks that,",
  "say specifically what you need.",
].join("\n");

/** Steers autopilot will only consider for these block shapes. menu/stall always surface. */
const STEERABLE_SHAPES = new Set(["awaiting-input", "yes-no"]);

export interface AutopilotDeps {
  store: Pick<SessionStore, "get" | "getRepoConfig" | "setAutopilotState">;
  /** Classify why an agent stopped (src/autopilot-llm.classifyStop, pre-bound to herdr+model). */
  classify: (tail: string[], taskPrompt: string, label: string) => Promise<AutopilotVerdict>;
  /** Steer text into the session's live PTY (SessionService.reply). false = didn't land. */
  steer: (id: string, text: string) => boolean;
  /** Resume an exited session so it can be steered (SessionService.resume). truthy = ok. */
  resume: (id: string) => unknown;
  /** Whether the session's herdr pane is currently live. */
  paneAlive: (id: string) => boolean;
  /** Visible terminal tail for a session (herdr.read → tailLines). */
  readTail: (id: string) => string[];
  /** Whether the session already has an open PR (critic territory → autopilot stands down). */
  hasOpenPr: (id: string) => boolean;
  /** Fired when autopilot hands a session back for a genuine question / step-cap. */
  onPause: (id: string, question: string) => void;
  stepCap?: number;
}

const DEFAULT_STEP_CAP = 10;
/** Shown when the runaway guard trips rather than a classifier question. */
const CAP_MESSAGE = "Autopilot reached its step limit without opening a PR — over to you.";

export class AutopilotService {
  // Re-entrancy guard: classify() is async, so a second event for the same session must
  // not start a second spawn (mirrors ReviewService.starting).
  private pending = new Set<string>();
  private stepCap: number;

  constructor(private deps: AutopilotDeps) {
    this.stepCap = deps.stepCap ?? DEFAULT_STEP_CAP;
  }

  /** Resolve a session's effective autopilot opt-in: override wins; null inherits the repo. */
  private enabled(s: Session): boolean {
    if (s.autopilotEnabled !== null) return s.autopilotEnabled;
    return this.deps.store.getRepoConfig(s.repoPath).autopilotEnabled;
  }

  /** Shared eligibility gate. Returns the session when autopilot should act, else null. */
  private eligible(id: string): Session | null {
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived") return null;
    if (!this.enabled(s)) return null;
    if (s.autopilotPaused) return null; // already handed back; waits for operator
    if (this.deps.hasOpenPr(id)) return null; // PR exists → critic loop owns it
    if (this.pending.has(id)) return null; // a classify is already in flight
    return s;
  }

  private pause(s: Session, question: string): void {
    this.deps.store.setAutopilotState(s.id, { paused: true, question: question || CAP_MESSAGE });
    this.deps.onPause(s.id, question || CAP_MESSAGE);
  }

  private bump(s: Session): void {
    this.deps.store.setAutopilotState(s.id, { stepCount: s.autopilotStepCount + 1 });
  }

  /** Steer `text` into the session, resuming an exited pane first. Bumps the step on a
   *  landed steer. Returns nothing — best-effort; a dead/unreachable pane just doesn't count. */
  private driveSteer(s: Session, text: string): void {
    if (!this.deps.paneAlive(s.id)) {
      // Exited pane: resume so there's something to steer. resume() returns falsy when it
      // can't (archived / no pinned session id) — then there's nothing to do.
      if (!this.deps.resume(s.id)) return;
    }
    if (this.deps.steer(s.id, text)) this.bump(s);
  }

  private dispatch(s: Session, v: AutopilotVerdict): void {
    switch (v.kind) {
      case "gate":
        this.driveSteer(s, PROCEED_STEER);
        return;
      case "finished":
        this.driveSteer(s, OPEN_PR_STEER);
        return;
      default: // "question" | "unknown" → bias to surface
        this.pause(s, v.summary);
    }
  }

  /** Core: classify a settled session's tail and act. `tail` is the terminal context. */
  private async consider(id: string, tail: string[], label: string): Promise<void> {
    const s = this.eligible(id);
    if (!s) return;
    if (s.autopilotStepCount >= this.stepCap) {
      this.pause(s, ""); // runaway guard → CAP_MESSAGE
      return;
    }
    this.pending.add(id);
    try {
      const v = await this.deps.classify(tail, s.prompt, label);
      // Re-check: the session may have changed (archived / toggled off / paused / PR opened)
      // during the classify await.
      const cur = this.eligible(id);
      if (!cur) return;
      this.dispatch(cur, v);
    } finally {
      this.pending.delete(id);
    }
  }

  /** session:block handler. Only steerable shapes are eligible; menu/stall surface as-is. */
  async onBlock(id: string, block: BlockReason | null): Promise<void> {
    if (!block || !STEERABLE_SHAPES.has(block.shape)) return;
    await this.consider(id, block.tail, `autopilot ${id}`);
  }

  /** session:status "done" handler — agent exited / idled. Read its tail and classify;
   *  a `finished` verdict drives it to a PR (resuming the pane if needed). */
  async onDone(id: string): Promise<void> {
    let tail: string[] = [];
    try {
      tail = this.deps.readTail(id);
    } catch {
      // empty tail still classifies (→ likely "unknown" → surface), which is safe
    }
    await this.consider(id, tail, `autopilot ${id}`);
  }

  /** session:status "running" handler. A paused→running transition is the operator
   *  answering: clear the pause and refresh the step budget. Non-paused running is a no-op
   *  (autopilot's OWN gate-steers resume the agent — those must not reset the cap). */
  onStatus(id: string, status: string): void {
    if (status !== "running") return;
    const s = this.deps.store.get(id);
    if (!s || !s.autopilotPaused) return;
    this.deps.store.setAutopilotState(id, { paused: false, question: null, stepCount: 0 });
  }

  /** A PR opened → hand off to the critic loop. Clear pause + reset the step budget. */
  onPrOpen(id: string): void {
    const s = this.deps.store.get(id);
    if (!s) return;
    this.deps.store.setAutopilotState(id, { paused: false, question: null, stepCount: 0 });
  }
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test ./test/autopilot.test.ts`
Expected: PASS (all tests).

Note: the test injects `classify` directly and ignores the `label` arg — that's fine; the real wiring (Task 7) binds `classify` to `classifyStop`.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot.ts test/autopilot.test.ts
git commit -m "feat(autopilot): pre-PR steering loop service"
```

---

## Task 5: Push notification — `autopilot` kind

**Files:**
- Modify: `src/push.ts:8-43` (types), `:56-97` (copy), `:135-161` (buildPayload)
- Test: `test/push-autopilot.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/push-autopilot.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { buildPayload } from "../src/push";

test("autopilot payload: title names the session, body is the question summary", () => {
  const p = buildPayload(
    { kind: "autopilot", sessionId: "s1", tag: "s1", name: "login", summary: "Which auth provider?" },
    "en",
  );
  expect(p.kind).toBe("autopilot");
  expect(p.title).toContain("login");
  expect(p.body).toContain("Which auth provider?");
});

test("autopilot payload falls back when summary empty", () => {
  const p = buildPayload(
    { kind: "autopilot", sessionId: "s1", tag: "s1", name: "login", summary: "" },
    "de",
  );
  expect(p.title).toContain("login");
  expect(p.body.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test ./test/push-autopilot.test.ts`
Expected: FAIL — `kind "autopilot"` not assignable / no payload branch.

- [ ] **Step 3: Implement the push changes**

In `src/push.ts`, add `"autopilot"` to `PushPayload["kind"]` (`:12`) and `NotifyInput["kind"]` (`:30`):

```typescript
  kind: "blocked" | "done" | "review" | "ci" | "review-human" | "autopilot";
```

Add it to `KIND_CATEGORY` (`:20`) under the `agent` category:

```typescript
  blocked: "agent",
  done: "agent",
  autopilot: "agent",
  review: "reviews",
```

Add a `summary` field to `NotifyInput` (`:43`, for the autopilot question text — passthrough data, localized only by the fallback):

```typescript
  /** For kind "autopilot": the classifier's question summary (verbatim passthrough). */
  summary?: string;
```

Add copy to both locales in `NOTIFY_TEXT` (`:56`/`:77`). EN:

```typescript
    autopilotTitle: (name: string) => `${name} — needs you`,
    autopilotFallback: "Autopilot paused for your input.",
```

DE:

```typescript
    autopilotTitle: (name: string) => `${name} — braucht dich`,
    autopilotFallback: "Autopilot pausiert für deine Eingabe.",
```

Add the `buildPayload` branch (`:138`, before `default`):

```typescript
    case "autopilot":
      return {
        ...base,
        title: t.autopilotTitle(input.name),
        body: input.summary && input.summary.trim() ? input.summary : t.autopilotFallback,
      };
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test ./test/push-autopilot.test.ts`
Expected: PASS (2 tests).

Run the existing push suite to confirm the union widening didn't break exhaustiveness:
Run: `bun test ./test/push.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/push.ts test/push-autopilot.test.ts
git commit -m "feat(autopilot): autopilot-paused push notification"
```

---

## Task 6: Wire `AutopilotService` into `index.ts`

**Files:**
- Modify: `src/index.ts` (after the `reviewService` wiring, `:167-197`)

This is integration glue; verify by `tsc` + a boot smoke test (Task 10). Bind the classifier to herdr + config, and the service's I/O callbacks to the existing `service`, `prPoller`, `herdr`, and `push`.

- [ ] **Step 1: Add imports**

At the top of `src/index.ts` with the other `./` imports:

```typescript
import { AutopilotService } from "./autopilot";
import { classifyStop } from "./autopilot-llm";
import { tailLines } from "./blocked";
```

- [ ] **Step 2: Instantiate + wire (after the `reviewService` block, before the Learnings section `:199`)**

```typescript
// Autopilot: the pre-PR twin of the critic's auto-address loop. When an autopilot-enabled
// session (per-repo default + per-session override) stalls on a procedural gate with no PR
// yet, a transient classifier decides gate (auto-proceed) / question (surface) / finished
// (drive to a PR). Genuine questions pause the session loudly (distinct state + push).
const autopilot = new AutopilotService({
  store,
  classify: (tail, taskPrompt, label) =>
    classifyStop(tail, taskPrompt, { herdr, model: config.autopilotModel }, label),
  steer: (id, text) => service.reply(id, text),
  resume: (id) => service.resume(id),
  paneAlive: (id) => {
    const s = store.get(id);
    return !!s && herdr.list().some((a) => a.terminalId === s.herdrAgentId);
  },
  readTail: (id) => {
    const s = store.get(id);
    return s ? tailLines(herdr.read(s.herdrAgentId, "visible")) : [];
  },
  hasOpenPr: (id) => prPoller.snapshot()[id]?.state === "open",
  onPause: (id, question) => {
    const s = store.get(id);
    if (!s) return;
    void push.notify({ kind: "autopilot", sessionId: id, tag: id, name: s.name, summary: question });
  },
  stepCap: config.autopilotStepCap,
});

// Drive autopilot off the same poller events the rest of the system already emits.
events.subscribe((event, data) => {
  if (event === "session:block") {
    const { id, block } = data as { id: string; block: import("./blocked").BlockReason | null };
    void autopilot.onBlock(id, block).catch((err) => console.warn("[autopilot] onBlock:", err));
  } else if (event === "session:status") {
    const { id, status } = data as { id: string; status: string };
    autopilot.onStatus(id, status); // clears a pause when the operator replies
    if (status === "done")
      void autopilot.onDone(id).catch((err) => console.warn("[autopilot] onDone:", err));
  } else if (event === "session:git") {
    const { id, git } = data as { id: string; git: import("./forge/types").GitState };
    if (git.state === "open") autopilot.onPrOpen(id); // handoff to the critic loop
  }
});
```

- [ ] **Step 3: Verify it type-checks**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(autopilot): wire service to poller/PR/push events"
```

---

## Task 7: Server endpoints — repo toggle + per-session toggle

**Files:**
- Modify: `src/server.ts:164-200` (repo-config PUT validation) and the `/api/sessions/:id/*` POST routing (near `:554`, the `reply` route)
- Test: `test/server-autopilot.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Look at `test/server-reviews.test.ts` for the harness shape (how it builds `serve` deps + issues requests), then create `test/server-autopilot.test.ts` mirroring it:

```typescript
import { test, expect } from "bun:test";
import { serve } from "../src/server";
import { SessionStore } from "../src/store";

// Mirror the dep-construction in test/server-reviews.test.ts. Build a server on an
// ephemeral port with an in-memory store, create a session, then exercise the two routes.
// (Fill in the same stub deps server-reviews uses — store, service, events, etc.)

function setup() {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "t", prompt: "p", repoPath: "/repo", baseBranch: "main", branch: "shepherd/t",
    worktreePath: "/wt", isolated: true, herdrSession: "h", herdrAgentId: "term_1",
  } as any);
  // ...build the same `deps` object server-reviews.test.ts passes to serve(), with
  // `store` above and a `service` whose .setSessionAutopilot delegates to the store.
  return { store, sessionId: s.id /*, base url */ };
}

test("PUT /api/repo-config accepts autopilotEnabled", async () => {
  // PUT { autopilotEnabled: true } to /api/repo-config?repo=/repo, expect 200 and
  // store.getRepoConfig("/repo").autopilotEnabled === true
});

test("PUT /api/sessions/:id/autopilot sets the per-session override", async () => {
  // PUT { enabled: true } → store.get(id).autopilotEnabled === true
  // PUT { enabled: null } → inherits (autopilotEnabled === null)
});
```

> Implementer note: complete the harness by copying `test/server-reviews.test.ts`'s `serve()` dep object verbatim and swapping in the store above — that test is the canonical example of standing up the HTTP layer in-process. Keep the two assertions exactly as described in the comments.

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test ./test/server-autopilot.test.ts`
Expected: FAIL — `autopilotEnabled` rejected by the validator / 404 on the autopilot route.

- [ ] **Step 3: Implement — extend repo-config validation**

In `src/server.ts`, in `parseRepoConfigPatch` (`:166`), add `autopilotEnabled` everywhere the other three booleans appear:

```typescript
  const body = (await req.json().catch(() => ({}))) as {
    criticEnabled?: unknown;
    autoAddressEnabled?: unknown;
    learningsEnabled?: unknown;
    autopilotEnabled?: unknown;
  };
  if (
    bad(body.criticEnabled) ||
    bad(body.autoAddressEnabled) ||
    bad(body.learningsEnabled) ||
    bad(body.autopilotEnabled)
  ) {
    return badReq(
      { error: "fields criticEnabled/autoAddressEnabled/learningsEnabled/autopilotEnabled must be booleans" },
    );
  }
  if (
    body.criticEnabled === undefined &&
    body.autoAddressEnabled === undefined &&
    body.learningsEnabled === undefined &&
    body.autopilotEnabled === undefined
  ) {
    // ...existing "no fields" 400
  }
```

Add `autopilotEnabled` to the returned patch object and to the `RepoConfig` merge where the PUT handler calls `setRepoConfig` (find where the patch is applied to the current config — include `autopilotEnabled: patch.autopilotEnabled ?? current.autopilotEnabled`).

- [ ] **Step 4: Implement — the per-session autopilot route**

Find the `POST /api/sessions/:id/reply` route (`:554`). Add a sibling `PUT /api/sessions/:id/autopilot` route in the same routing block:

```typescript
  // PUT /api/sessions/:id/autopilot — set the per-session opt-in override.
  // Body: { enabled: boolean | null }  (null = inherit the repo default)
  if (parts[2] && parts[3] === "autopilot" && req.method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
    const e = body.enabled;
    if (!(e === true || e === false || e === null)) {
      return json({ error: "enabled must be true, false, or null" }, 400);
    }
    const s = deps.store.get(parts[2]);
    if (!s) return json({ error: "no session" }, 404);
    deps.store.setAutopilotState(parts[2], { enabled: e });
    deps.events.emit("session:status", { id: parts[2], status: s.status }); // nudge clients to refetch
    return json(deps.store.get(parts[2]));
  }
```

> Match the exact routing idiom used by the neighboring routes (`parts[]` indexing, `json()` helper, method check). If the file uses a different dispatch shape, follow it.

- [ ] **Step 5: Run the test — verify it passes**

Run: `bun test ./test/server-autopilot.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server-autopilot.test.ts
git commit -m "feat(autopilot): repo + per-session toggle endpoints"
```

---

## Task 8: UI — types, API client, message catalogs

**Files:**
- Modify: `ui/src/lib/types.ts:141` (RepoConfig + Session)
- Modify: `ui/src/lib/api.ts:517-527` (putRepoConfig) + new `setSessionAutopilot`
- Modify: `ui/messages/en.json`, `ui/messages/de.json`

- [ ] **Step 1: Extend UI types**

In `ui/src/lib/types.ts`, add to `RepoConfig` (`:141`):

```typescript
export interface RepoConfig {
  criticEnabled: boolean;
  autoAddressEnabled: boolean;
  learningsEnabled: boolean;
  autopilotEnabled: boolean;
}
```

Find the UI `Session` interface in the same file and add the four fields mirroring the server type:

```typescript
  autopilotEnabled: boolean | null;
  autopilotStepCount: number;
  autopilotPaused: boolean;
  autopilotQuestion: string | null;
```

- [ ] **Step 2: Extend the API client**

In `ui/src/lib/api.ts`, widen `putRepoConfig`'s patch type (`:519`) to include `autopilotEnabled`:

```typescript
  patch: Partial<
    Pick<RepoConfig, "criticEnabled" | "autoAddressEnabled" | "learningsEnabled" | "autopilotEnabled">
  >,
```

Add a new client call after it:

```typescript
export async function setSessionAutopilot(
  id: string,
  enabled: boolean | null,
): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/autopilot`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`autopilot toggle failed: ${r.status}`);
}
```

- [ ] **Step 3: Add message keys to BOTH catalogs**

Add to `ui/messages/en.json`:

```json
  "gitrail_autopilot_toggle_aria": "Toggle autopilot for this repository",
  "gitrail_autopilot_on_title": "Autopilot is on by default: new sessions drive through procedural stops and head for a PR on their own, pausing only for genuine questions. Click to turn it off for this repository.",
  "gitrail_autopilot_off_title": "Autopilot is off: turn it on so sessions auto-proceed through procedural stops and lead themselves to a PR, surfacing only real questions. Click to turn it on for this repository.",
  "session_autopilot_toggle_aria": "Toggle autopilot for this session",
  "session_autopilot_on_label": "Autopilot on",
  "session_autopilot_off_label": "Autopilot off",
  "session_autopilot_paused_label": "Autopilot paused — needs you",
  "session_autopilot_paused_title": "Autopilot handed this back for a decision: {question}"
```

Add to `ui/messages/de.json` (same keys — the `check:i18n` gate fails otherwise):

```json
  "gitrail_autopilot_toggle_aria": "Autopilot für dieses Repository umschalten",
  "gitrail_autopilot_on_title": "Autopilot ist standardmäßig an: Neue Sessions arbeiten sich selbst durch prozedurale Stopps und steuern auf einen PR zu; sie pausieren nur bei echten Fragen. Klicken zum Ausschalten für dieses Repository.",
  "gitrail_autopilot_off_title": "Autopilot ist aus: Einschalten, damit Sessions prozedurale Stopps selbst überspringen und sich zu einem PR führen und nur echte Fragen melden. Klicken zum Einschalten für dieses Repository.",
  "session_autopilot_toggle_aria": "Autopilot für diese Session umschalten",
  "session_autopilot_on_label": "Autopilot an",
  "session_autopilot_off_label": "Autopilot aus",
  "session_autopilot_paused_label": "Autopilot pausiert — braucht dich",
  "session_autopilot_paused_title": "Autopilot hat dies für eine Entscheidung zurückgegeben: {question}"
```

- [ ] **Step 4: Verify catalog parity + UI typecheck**

Run: `cd ui && bun install && bun run check:i18n && bun run check`
Expected: i18n parity PASS; `check` PASS (the new message functions and types resolve).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(autopilot): UI types, api client, message catalogs"
```

---

## Task 9: UI — repo toggle in GitRail + per-session control + paused state

**Files:**
- Modify: `ui/src/lib/components/GitRail.svelte` (mirror the auto-address toggle at `:300-312`)
- Modify: the repo-config store helper `ui/src/lib/reviews.svelte.ts` (it exposes `isAutoAddressEnabled` — add `isAutopilotEnabled`)
- Modify: the session-row / control component that renders per-session state (find where `autopilotPaused` should surface and where the per-session toggle belongs)

This task follows existing patterns exactly — read the auto-address toggle in `GitRail.svelte` and the `repoConfig` helper in `ui/src/lib/reviews.svelte.ts` before writing.

- [ ] **Step 1: Add the repo-config accessor**

In `ui/src/lib/reviews.svelte.ts` (the store backing `repoConfig.isAutoAddressEnabled`), add an `isAutopilotEnabled(repoPath)` getter and an optimistic setter that calls `putRepoConfig({ autopilotEnabled })`, mirroring the existing `isAutoAddressEnabled` / its setter one-for-one.

- [ ] **Step 2: Add the repo toggle button in GitRail.svelte**

Mirror the auto-address `<button>` block (`:300-312`). Add a sibling button:

```svelte
{@const autopilotOn = repoConfig.isAutopilotEnabled(repoPath)}
<button
  class="rail-toggle"
  aria-label={m.gitrail_autopilot_toggle_aria()}
  aria-pressed={autopilotOn}
  title={autopilotOn ? m.gitrail_autopilot_on_title() : m.gitrail_autopilot_off_title()}
  onclick={() => repoConfig.setAutopilot(repoPath, !autopilotOn)}
>
  🛫<span class="crit-dot" class:on={autopilotOn} aria-hidden="true"></span>
</button>
```

Use the same derived-state idiom the file already uses (`$derived`, as in `const autoAddressOn = $derived(...)` at `:202`) rather than `{@const}` if that's the file's convention — match the surrounding code.

- [ ] **Step 3: Per-session toggle + paused badge**

In the per-session control/row component (the one rendering status), add:
- A small toggle bound to `session.autopilotEnabled` that calls `setSessionAutopilot(session.id, next)`. Three-state is unnecessary in the UI — a simple on/off is fine; map the checkbox to `true`/`false` (the `null`-inherit default still works server-side for sessions never toggled). Label via `m.session_autopilot_on_label()` / `m.session_autopilot_off_label()`, aria via `m.session_autopilot_toggle_aria()`.
- When `session.autopilotPaused` is true, render a distinct badge using `m.session_autopilot_paused_label()` with `title={m.session_autopilot_paused_title({ question: session.autopilotQuestion ?? '' })}`. This is the loud, distinct "Autopilot paused — needs you" state separate from the generic red badge.

Follow the existing status-badge markup/classes in that component; do not invent new visual chrome beyond what a sibling badge uses.

- [ ] **Step 4: Verify**

Run: `cd ui && bun run check && bun run lint`
Expected: PASS.

Run: `cd ui && bun run test`
Expected: PASS (no existing UI test should regress; if `reviews.svelte.test.ts` asserts the config shape, update it to include `autopilotEnabled`).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/GitRail.svelte ui/src/lib/reviews.svelte.ts ui/src/lib
git commit -m "feat(autopilot): repo toggle, per-session toggle, paused badge"
```

---

## Task 10: Full validation + smoke

**Files:** none (validation only)

- [ ] **Step 1: Root lint + typecheck + tests**

Run: `bun install && bun run lint && bunx tsc --noEmit && bun test ./test`
Expected: all PASS.

- [ ] **Step 2: UI checks**

Run: `cd ui && bun install && bun run check:i18n && bun run check && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 3: Boot smoke test**

Start the server locally and confirm it boots without throwing on the new wiring:

Run: `bun run src/index.ts` (or the project's start script) and confirm the `shepherd core on http://localhost:...` line prints and no `[autopilot]` errors appear. Stop it.

- [ ] **Step 4: Manual scenario verification (house rule: verify the exact targeted scenario)**

With a repo that has autopilot enabled (toggle it in the UI), launch a session whose agent will pause on a procedural gate ("shall I write the spec first?"). Confirm:
1. Autopilot auto-proceeds the gate (a `PROCEED_STEER` lands; the agent resumes without you).
2. A genuine question (e.g. force the agent to ask a product decision) pauses the session with the distinct "Autopilot paused — needs you" badge + a push notification carrying the summary.
3. Answering the question clears the pause and the loop re-arms.
4. The session reaches a PR; once the PR opens, autopilot stands down and the critic loop takes over.

- [ ] **Step 5: Final commit / branch is ready for PR**

```bash
git status   # clean
git log --oneline origin/main..HEAD
```

Open the PR per the repo's PR-first workflow (branch already cut from main; keep it linear).

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** opt-in scope (Task 1 repo config + Task 7/8/9 toggles), LLM classifier (Task 3), loud surfacing (Task 5 push + Task 9 badge), step cap (Task 4 + Task 2 config), shape gating / menus-always-surface (Task 4 `STEERABLE_SHAPES` + tests), handoff at PR-open (Task 4 `onPrOpen` + Task 6 wiring), server-owned English steer text (Task 4 `PROCEED_STEER`/`OPEN_PR_STEER`), classifier never authors pane text (Task 3/4).
- **Type consistency:** `setAutopilotState(id, {enabled?,stepCount?,paused?,question?})` — same shape in store (Task 1), service deps (Task 4), and server route (Task 7). `AutopilotVerdict {kind,summary}` — Task 1 type, Task 3 output, Task 4 input. `hasOpenPr` reads `prPoller.snapshot()[id]?.state === "open"` (Task 6) matching `PrCache.snapshot()` (`src/pr-poller.ts:199`).
- **i18n:** every new key added to BOTH catalogs in Task 8; steer templates deliberately excluded (agent-facing, commented in Task 4).
