# Learnings Flywheel PR2b — Promote-to-CLAUDE.md + Self-Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining half of issue #228 — let operators promote a proven house rule into the repo's `CLAUDE.md` via an auto-opened PR, and let the distiller flag active rules that aren't working (ineffective self-audit).

**Architecture:** PR2a (DB→prompt injection, per-repo `learningsEnabled` toggle, status state machine) already merged on `main` (#249/#253). This PR adds: (B) a `Promoter` service (`src/promote.ts`) that creates a worktree off the repo default branch, upserts a managed `<!-- shepherd:learnings -->` block in `CLAUDE.md`, commits/pushes, opens a PR via the existing `GitForge`, and marks the rule `promoted` with the PR url; and (A) distiller self-audit that returns `ineffective` rule ids and increments `learnings.ineffectiveCount`, surfaced as a drawer badge.

**Tech Stack:** Bun + TypeScript (server/store/forge), SvelteKit 5 + Paraglide i18n (UI), `bun test` (server) / vitest (UI). Forge ops via `gh` (GitHub) / REST (Gitea). Git ops via async `execFile`.

---

## Context the engineer needs (read before starting)

- **What is DONE on main (do NOT rebuild):** prompt injection at `SessionService.create` (`src/service.ts` `houseRules`), `learningsEnabled` per-repo toggle in `repo_config`, `setLearningStatus` state machine (`LEARNING_TRANSITIONS` in `src/store.ts`), `listActiveLearnings`, the Learnings drawer with the injectable budget view, EN+DE i18n for all of the above.
- **What this PR adds:** promote route + service + forge `defaultBranch`, `CLAUDE.md` marker upsert, `promotedPrUrl` column, distiller `ineffective` handling + `incrementLearningIneffective`, UI promote button + ineffective badge.
- **State machine (already enforced):** `LEARNING_TRANSITIONS` in `src/store.ts` is `{ proposed:["active","dismissed"], active:["promoted","dismissed"], promoted:[], dismissed:[] }`. Promote = `active → promoted`.
- **Injectable payload already carries `ineffectiveCount`:** `/api/learnings/injectable` spreads the full `Learning` into each rule (`src/server.ts` `handleLearningsGet`), and `RepoInjectable.rules` is `(Learning & { injected })[]` (`ui/src/lib/types.ts`). So the ineffective badge needs **no** payload change — only a UI render + a store method to bump the count.
- **Gates (run from worktree root unless noted):**
  - Root: `bun install` → `bunx tsc --noEmit` → `bun test ./test` → `bun run lint` → `bunx fallow audit` (must exit 0; `maxCyclomatic 20` / `maxCognitive 15`, flags unused exports + dupes on changed files — keep new functions small).
  - UI: `cd ui && bun install` → `bun run check` → `bun run check:i18n` → `bun run test`.
- **i18n rule:** every new user-facing string needs a key in BOTH `ui/messages/en.json` and `ui/messages/de.json` (snake_case, component-prefixed). Agent-facing prompt text (distiller prompt, PR title/body, commit message) stays English-only — it is not chrome the app authors for the operator.
- **Spawn/forge precedent:** the PR-create handler already does `await forge.openPr(...)` inline in an async handler (`src/server.ts:703`); `forge` methods shell out synchronously. The promote git ops (fetch/commit/push) use **async** `execFile` so the single-process event loop isn't blocked (house rule: no blocking subprocess fan-out in handlers).

---

## File Structure

**Create:**
- `src/promote.ts` — `Promoter` service + pure `upsertLearningsBlock` helper + marker constants.
- `test/promote.test.ts` — unit tests for `upsertLearningsBlock` and `Promoter.promote` (stubbed deps).

**Modify:**
- `src/types.ts` — add `promotedPrUrl: string | null` to `Learning`.
- `src/store.ts` — `promotedPrUrl` column + migration, hydrate it, `promoteLearning(id, prUrl)`, `incrementLearningIneffective(id)`.
- `src/forge/types.ts` — add `defaultBranch(): Promise<string>` to `GitForge`.
- `src/forge/github.ts` — implement `defaultBranch`.
- `src/forge/gitea.ts` — implement `defaultBranch`.
- `src/distiller.ts` — pass active rules (id+rule) into signals payload, extend prompt + `RawProposals` with `ineffective`, apply in `finalize`.
- `src/server.ts` — `POST /api/learnings/:id/promote` route; `promoter?` on `AppDeps`.
- `src/index.ts` — instantiate `Promoter`, pass into server deps.
- `test/store-learnings.test.ts` — tests for `promoteLearning` + `incrementLearningIneffective`.
- `test/distiller.test.ts` — test self-audit increments ineffective.
- `ui/src/lib/types.ts` — add `promotedPrUrl: string | null` to `Learning`.
- `ui/src/lib/api.ts` — `promoteLearning(id)`.
- `ui/src/lib/components/learnings-drawer.ts` — `showIneffective(rule)` helper.
- `ui/src/lib/components/learnings-drawer.test.ts` — test the helper.
- `ui/src/lib/components/LearningsDrawer.svelte` — promote button + ineffective badge + `onpromote` prop.
- `ui/src/routes/+page.svelte` — wire `onpromote`.
- `ui/messages/en.json` + `ui/messages/de.json` — new keys.

---

## PART A — Self-audit / ineffective flag

### Task A1: `incrementLearningIneffective` store method

**Files:**
- Modify: `src/store.ts` (add method near `setLearningStatus`)
- Test: `test/store-learnings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/store-learnings.test.ts`:

```ts
test("incrementLearningIneffective bumps active rules, no-ops others", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "use bun", rationale: "", evidence: [] });
  // proposed → no-op
  expect(s.incrementLearningIneffective(l.id)).toBeNull();
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(0);
  // activate, then bump twice
  s.setLearningStatus(l.id, "active");
  expect(s.incrementLearningIneffective(l.id)!.ineffectiveCount).toBe(1);
  expect(s.incrementLearningIneffective(l.id)!.ineffectiveCount).toBe(2);
  // missing id → null
  expect(s.incrementLearningIneffective("nope")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store-learnings.test.ts -t "incrementLearningIneffective"`
Expected: FAIL — `s.incrementLearningIneffective is not a function`.

- [ ] **Step 3: Implement the method**

In `src/store.ts`, immediately after the `setLearningStatus` method, add:

```ts
  /** Bump ineffectiveCount for an active/promoted rule (self-audit, spec §5). A
   *  no-op returning null for proposed/dismissed/missing rules — only live rules
   *  can be "not working". */
  incrementLearningIneffective(id: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || (cur.status !== "active" && cur.status !== "promoted")) return null;
    this.db.run(
      `UPDATE learnings SET ineffectiveCount = ineffectiveCount + 1, updatedAt = ? WHERE id = ?`,
      [Date.now(), id],
    );
    return this.getLearning(id);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/store-learnings.test.ts -t "incrementLearningIneffective"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store-learnings.test.ts
git commit -m "feat(learnings): add incrementLearningIneffective store method"
```

---

### Task A2: Distiller self-audit (return + apply `ineffective` ids)

**Files:**
- Modify: `src/distiller.ts`
- Test: `test/distiller.test.ts`

Background: `begin()` currently passes `existing` (all rule strings, for dedup) into `writeSignals(dir, signals, existing)`. We add a 4th arg `activeRules` (`{id, rule}[]`) so the distiller can cite ids. `finalize()` reads `raw.ineffective` and bumps each valid active id.

- [ ] **Step 1: Write the failing test**

First inspect `test/distiller.test.ts` to match its deps-stub style (it stubs `store`, `herdr`, `scratch`, `writeSignals`, `readProposals`). Append a test that drives `finalize` via a `readProposals` returning an `ineffective` array:

```ts
test("distiller increments ineffective for cited active rule ids", async () => {
  const bumped: string[] = [];
  const active = [{ id: "rule-1", rule: "use bun", status: "active" }];
  const svc = new DistillerService({
    store: {
      listSignals: () => [{ id: "s1", repoPath: "/r", sessionId: null, kind: "critic", payload: "ran npm", ts: 1 }],
      addLearning: () => ({}) as never,
      listLearnings: () => [],
      listActiveLearnings: () => active as never,
      getRepoConfig: () => ({ criticEnabled: true, autoAddressEnabled: false, learningsEnabled: true }),
      incrementLearningIneffective: (id: string) => { bumped.push(id); return {} as never; },
    },
    herdr: { start: () => ({ terminalId: "t1" }) as never, stop: () => {} },
    scratch: { create: () => ({ dir: "/tmp/x" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    writeSignals: () => {},
    // first tick: proposals ready with one ineffective id + one (ignored) bogus id
    readProposals: () => ({ rules: [], ineffective: ["rule-1", "bogus"] }),
  });
  svc.distillNow("/r");
  await svc.tick();
  expect(bumped).toEqual(["rule-1"]); // only the real active id is bumped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/distiller.test.ts -t "increments ineffective"`
Expected: FAIL — `incrementLearningIneffective`/`listActiveLearnings` not in the stub type, or not called.

- [ ] **Step 3: Implement distiller changes**

In `src/distiller.ts`:

1. Widen the deps `store` Pick:

```ts
  store: Pick<
    SessionStore,
    | "listSignals"
    | "addLearning"
    | "listLearnings"
    | "listActiveLearnings"
    | "getRepoConfig"
    | "incrementLearningIneffective"
  >;
```

2. Change the `writeSignals` dep type and field to carry active rules:

```ts
  writeSignals?: (
    dir: string,
    signals: Signal[],
    existingRules: string[],
    activeRules: { id: string; rule: string }[],
  ) => void;
```

3. Add `ineffective?: unknown;` to `interface RawProposals`.

4. In `begin()`, compute and pass active rules:

```ts
    const existing = this.deps.store.listLearnings(repoPath).map((l) => l.rule);
    const activeRules = this.deps.store
      .listActiveLearnings(repoPath)
      .map((l) => ({ id: l.id, rule: l.rule }));
    try {
      this.writeSignals(dir, signals, existing, activeRules);
    } catch (err) {
```

5. Update `defaultWriteSignals`:

```ts
function defaultWriteSignals(
  dir: string,
  signals: Signal[],
  existingRules: string[],
  activeRules: { id: string; rule: string }[],
): void {
  const payload = {
    signals: signals.map((s) => ({ kind: s.kind, payload: s.payload, ts: s.ts, id: s.id })),
    existingRules,
    activeRules,
  };
  writeFileSync(join(dir, "signals.json"), JSON.stringify(payload, null, 2));
}
```

6. Update `distillPrompt()` — append, after the existing existingRules sentence:

```ts
    "It also has `activeRules` — currently-active house rules as {id, rule} objects.",
    "If a NEW signal shows an activeRule was violated or did not prevent the mistake,",
    "add its id to an `ineffective` array (the rule is not working — flag it).",
```

and change the output-shape line to include the field:

```ts
    '{"rules": [{"rule": "<=160 char imperative", "rationale": "why", "evidence": ["signalId", ...]}], "ineffective": ["activeRuleId", ...]}',
```

7. In `finalize()`, after the `for (const r of rules)` loop and before `this.deps.herdr.stop(...)`, add:

```ts
    let flagged = 0;
    const activeIds = new Set(
      this.deps.store.listActiveLearnings(f.repoPath).map((l) => l.id),
    );
    const ineffective = Array.isArray(raw?.ineffective) ? raw!.ineffective : [];
    for (const id of ineffective) {
      if (typeof id !== "string" || !activeIds.has(id)) continue;
      if (this.deps.store.incrementLearningIneffective(id)) flagged++;
    }
```

and change the final emit condition:

```ts
    if (added > 0 || flagged > 0) this.deps.onChange();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/distiller.test.ts`
Expected: PASS (new test + all existing distiller tests; the spawn-contract assertions must still hold).

- [ ] **Step 5: Commit**

```bash
git add src/distiller.ts test/distiller.test.ts
git commit -m "feat(learnings): distiller self-audit flags ineffective active rules"
```

---

### Task A3: Drawer ineffective badge

**Files:**
- Modify: `ui/src/lib/components/learnings-drawer.ts`
- Test: `ui/src/lib/components/learnings-drawer.test.ts`
- Modify: `ui/src/lib/components/LearningsDrawer.svelte`
- Modify: `ui/messages/en.json`, `ui/messages/de.json`

- [ ] **Step 1: Write the failing helper test**

Append to `ui/src/lib/components/learnings-drawer.test.ts`:

```ts
import { showIneffective } from "./learnings-drawer";

test("showIneffective true only when ineffectiveCount > 0", () => {
  expect(showIneffective({ ineffectiveCount: 0 } as never)).toBe(false);
  expect(showIneffective({ ineffectiveCount: 3 } as never)).toBe(true);
});
```

(Match the existing import/test style at the top of that file — it likely already imports `vitest` globals or `bun:test`; reuse whatever is there. If the file imports specific helpers, add `showIneffective` to that import instead of a second import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- learnings-drawer`
Expected: FAIL — `showIneffective` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `ui/src/lib/components/learnings-drawer.ts`:

```ts
/** Whether to show the "not working" badge on an active rule (self-audit, §5). */
export function showIneffective(rule: { ineffectiveCount: number }): boolean {
  return rule.ineffectiveCount > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test -- learnings-drawer`
Expected: PASS.

- [ ] **Step 5: Add i18n keys**

In `ui/messages/en.json` add (alphabetical-ish near other `learnings_` keys):

```json
  "learnings_ineffective_badge": "Not working ({count})",
  "learnings_ineffective_title": "A new mistake matched this rule — the distiller flagged it as not working. Reword, strengthen, or dismiss it.",
```

In `ui/messages/de.json` add:

```json
  "learnings_ineffective_badge": "Wirkungslos ({count})",
  "learnings_ineffective_title": "Ein neuer Fehler passte zu dieser Regel — der Distiller markierte sie als wirkungslos. Umformulieren, verschärfen oder verwerfen.",
```

- [ ] **Step 6: Render the badge**

In `ui/src/lib/components/LearningsDrawer.svelte`:

1. Add `showIneffective` to the existing import from `./learnings-drawer`.
2. In the injectable rule footer (`.ifoot`), after the injection badge block and before `<span class="spacer">`, add:

```svelte
                  {#if showIneffective(r)}
                    <span class="badge bad" title={m.learnings_ineffective_title()}>
                      ⚠ {m.learnings_ineffective_badge({ count: r.ineffectiveCount })}
                    </span>
                  {/if}
```

3. In `<style>`, add a `.badge.bad` rule near `.badge.warn`:

```css
  .badge.bad {
    border-color: var(--color-red, var(--color-amber));
    color: var(--color-red, var(--color-amber));
    cursor: help;
  }
```

(If `--color-red` doesn't exist in the theme, the fallback to `--color-amber` keeps it valid; check `ui/src/app.css`/theme tokens and use the project's existing danger token if one exists, e.g. `--color-rose`.)

- [ ] **Step 7: Verify UI gates**

Run: `cd ui && bun run check && bun run check:i18n && bun run test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/components/learnings-drawer.ts ui/src/lib/components/learnings-drawer.test.ts ui/src/lib/components/LearningsDrawer.svelte ui/messages/en.json ui/messages/de.json
git commit -m "feat(learnings): show ineffective badge on active rules in drawer"
```

---

## PART B — Promote → CLAUDE.md PR

### Task B1: `promotedPrUrl` column + `promoteLearning` store method

**Files:**
- Modify: `src/types.ts`, `src/store.ts`
- Test: `test/store-learnings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/store-learnings.test.ts`:

```ts
test("promoteLearning records PR url and enforces active→promoted", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "rebase onto main", rationale: "", evidence: [] });
  // proposed cannot promote
  expect(s.promoteLearning(l.id, "https://pr/1")).toBeNull();
  s.setLearningStatus(l.id, "active");
  const promoted = s.promoteLearning(l.id, "https://pr/1");
  expect(promoted!.status).toBe("promoted");
  expect(promoted!.promotedPrUrl).toBe("https://pr/1");
  // already promoted → no further transition
  expect(s.promoteLearning(l.id, "https://pr/2")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store-learnings.test.ts -t "promoteLearning"`
Expected: FAIL — method missing / `promotedPrUrl` undefined.

- [ ] **Step 3: Add the type field**

In `src/types.ts`, in `interface Learning`, after `lastEvidenceAt: number | null;` add:

```ts
  /** URL of the CLAUDE.md promote PR, set when status becomes `promoted`. */
  promotedPrUrl: string | null;
```

- [ ] **Step 4: Add column + migration + hydrate + method (`src/store.ts`)**

1. In the `CREATE TABLE IF NOT EXISTS learnings` statement, add the column (before the closing `)`):

```
  promotedPrUrl TEXT,
```

so the trailing line reads `... lastEvidenceAt INTEGER, promotedPrUrl TEXT)`.

2. Right after the `learnings_repo_status` index creation, add a migration for existing DBs (mirror the `reviews seenNoteIds` migration pattern):

```ts
    const learnCols = this.db.query(`PRAGMA table_info(learnings)`).all() as { name: string }[];
    if (!learnCols.some((c) => c.name === "promotedPrUrl")) {
      this.db.run(`ALTER TABLE learnings ADD COLUMN promotedPrUrl TEXT`);
    }
```

3. In `hydrateLearning`, add to the returned object:

```ts
      promotedPrUrl: r.promotedPrUrl ?? null,
```

4. After `setLearningStatus`, add:

```ts
  /** active → promoted, recording the CLAUDE.md PR url (spec §4b). Returns null
   *  when the rule is missing or not in a state that allows promotion. */
  promoteLearning(id: string, prUrl: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || !LEARNING_TRANSITIONS[cur.status].includes("promoted")) return null;
    this.db.run(
      `UPDATE learnings SET status = 'promoted', promotedPrUrl = ?, updatedAt = ? WHERE id = ?`,
      [prUrl, Date.now(), id],
    );
    return this.getLearning(id);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test ./test/store-learnings.test.ts`
Expected: PASS (new test + existing learnings/signal tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store.ts test/store-learnings.test.ts
git commit -m "feat(learnings): add promotedPrUrl column + promoteLearning transition"
```

---

### Task B2: `GitForge.defaultBranch()` (interface + both impls)

**Files:**
- Modify: `src/forge/types.ts`, `src/forge/github.ts`, `src/forge/gitea.ts`

Per house rule "fix the whole class across GitHub AND Gitea", implement on both.

- [ ] **Step 1: Add to the interface**

In `src/forge/types.ts`, inside `interface GitForge`, after `openPr(...)`:

```ts
  /** The repo's default branch name (the promote PR's base). */
  defaultBranch(): Promise<string>;
```

- [ ] **Step 2: Implement on GitHub**

In `src/forge/github.ts`, add a method (place it near `openPr`):

```ts
  async defaultBranch(): Promise<string> {
    const out = this.run(["repo", "view", this.slug, "--json", "defaultBranchRef"]);
    const name = (JSON.parse(out || "{}") as { defaultBranchRef?: { name?: string } })
      .defaultBranchRef?.name;
    if (!name) throw new Error("could not resolve default branch");
    return name;
  }
```

(Optional DRY: `listWorkflowRuns` resolves the default branch the same way at `src/forge/github.ts:166-169`; leave it as-is to avoid behavior change — it tolerates a missing branch by returning `[]`, whereas `defaultBranch` throws.)

- [ ] **Step 3: Implement on Gitea**

In `src/forge/gitea.ts`, add (near `openPr`):

```ts
  async defaultBranch(): Promise<string> {
    const repo = (await this.req("GET", `/api/v1/repos/${this.slug}`)) as {
      default_branch?: string;
    };
    if (!repo.default_branch) throw new Error("could not resolve default branch");
    return repo.default_branch;
  }
```

- [ ] **Step 4: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors (any test fake implementing `GitForge` is updated in Task B4/B5; if a pre-existing test fake breaks here, add `defaultBranch: async () => "main"` to it).

- [ ] **Step 5: Commit**

```bash
git add src/forge/types.ts src/forge/github.ts src/forge/gitea.ts
git commit -m "feat(forge): add defaultBranch() to GitForge (github + gitea)"
```

---

### Task B3: `upsertLearningsBlock` pure helper

**Files:**
- Create: `src/promote.ts`
- Test: `test/promote.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/promote.test.ts`:

```ts
import { test, expect } from "bun:test";
import { upsertLearningsBlock, LEARNINGS_START, LEARNINGS_END } from "../src/promote";

test("upsertLearningsBlock appends a block when none exists", () => {
  const out = upsertLearningsBlock("# Repo\n\nintro\n", ["use bun", "rebase onto main"]);
  expect(out).toContain(LEARNINGS_START);
  expect(out).toContain("- use bun");
  expect(out).toContain("- rebase onto main");
  expect(out.trimEnd().endsWith(LEARNINGS_END)).toBe(true);
});

test("upsertLearningsBlock replaces block contents idempotently", () => {
  const first = upsertLearningsBlock("# Repo\n", ["a"]);
  const second = upsertLearningsBlock(first, ["a"]);
  expect(second).toBe(first); // applying same rules twice is a no-op
  const third = upsertLearningsBlock(first, ["a", "b"]);
  expect(third).toContain("- b");
  // exactly one managed block, never duplicated
  expect(third.split(LEARNINGS_START).length - 1).toBe(1);
  expect(third.split(LEARNINGS_END).length - 1).toBe(1);
});

test("upsertLearningsBlock handles empty file", () => {
  const out = upsertLearningsBlock("", ["only rule"]);
  expect(out.startsWith(LEARNINGS_START)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/promote.test.ts`
Expected: FAIL — module `../src/promote` not found.

- [ ] **Step 3: Implement the helper (create `src/promote.ts` with just this for now)**

```ts
export const LEARNINGS_START = "<!-- shepherd:learnings:start -->";
export const LEARNINGS_END = "<!-- shepherd:learnings:end -->";

/** Insert or replace the managed shepherd:learnings block in CLAUDE.md content.
 *  Idempotent: replaces the existing block's contents rather than appending a
 *  duplicate; appends a fresh block when no markers are present. Each rule is one
 *  `- <rule>` bullet. */
export function upsertLearningsBlock(content: string, rules: string[]): string {
  const body = [LEARNINGS_START, ...rules.map((r) => `- ${r}`), LEARNINGS_END].join("\n");
  const start = content.indexOf(LEARNINGS_START);
  const end = content.indexOf(LEARNINGS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + body + content.slice(end + LEARNINGS_END.length);
  }
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + body + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/promote.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/promote.ts test/promote.test.ts
git commit -m "feat(learnings): add idempotent CLAUDE.md learnings-block upsert"
```

---

### Task B4: `Promoter` service

**Files:**
- Modify: `src/promote.ts` (add the service)
- Test: `test/promote.test.ts`

The service does: resolve forge → resolve default branch → fetch → create worktree off `origin/<base>` → upsert `CLAUDE.md` (managed block = already-promoted rules + this one) → add/commit/push (async git) → `forge.openPr` → `store.promoteLearning(id, url)`. All git ops are injectable for testing.

- [ ] **Step 1: Write the failing test**

Append to `test/promote.test.ts`:

```ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Promoter } from "../src/promote";
import { SessionStore } from "../src/store";

function fakeForge(over: Partial<any> = {}) {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    defaultBranch: async () => "main",
    openPr: async () => ({ state: "open", number: 7, url: "https://pr/7", checks: "none", deployConfigured: false }),
    ...over,
  } as never;
}

test("Promoter.promote opens a PR and marks the rule promoted", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "rebase onto main", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-test-"));
  const gitCalls: string[][] = [];
  const removed: string[] = [];

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "shepherd/learnings-promote-x", isolated: true }),
      remove: (path: string) => removed.push(path),
    },
    resolveForge: () => fakeForge(),
    git: async (_cwd, args) => { gitCalls.push(args); },
  });

  const res = await p.promote(l.id);
  expect(res).toEqual({ ok: true, url: "https://pr/7" });
  expect(store.getLearning(l.id)!.status).toBe("promoted");
  expect(store.getLearning(l.id)!.promotedPrUrl).toBe("https://pr/7");
  // CLAUDE.md written with the rule inside the managed block
  expect(readFileSync(join(wtDir, "CLAUDE.md"), "utf8")).toContain("- rebase onto main");
  // git push happened; worktree cleaned up
  expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
  expect(removed).toContain(wtDir);
});

test("Promoter.promote rejects non-active rules", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  const p = new Promoter({
    store,
    worktree: { create: () => ({ worktreePath: "/x", branch: "b", isolated: true }), remove: () => {} },
    resolveForge: () => fakeForge(),
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(409);
});

test("Promoter.promote 400s when no forge configured", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const p = new Promoter({
    store,
    worktree: { create: () => ({ worktreePath: "/x", branch: "b", isolated: true }), remove: () => {} },
    resolveForge: () => null,
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/promote.test.ts -t "Promoter"`
Expected: FAIL — `Promoter` not exported.

- [ ] **Step 3: Implement the service**

Add to `src/promote.ts` (top imports + class). Keep each method small (fallow: cyclomatic ≤ 20 / cognitive ≤ 15):

```ts
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionStore } from "./store";
import type { WorktreeMgr } from "./worktree";
import type { GitForge } from "./forge/types";
import type { Learning } from "./types";

const execFileP = promisify(execFile);

/** Async git runner — keeps the single-process event loop unblocked during the
 *  fetch/commit/push (house rule: no blocking subprocess in request handlers). */
async function defaultGit(cwd: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

export interface PromoterDeps {
  store: Pick<SessionStore, "getLearning" | "listLearnings" | "promoteLearning">;
  worktree: Pick<WorktreeMgr, "create" | "remove">;
  resolveForge: (repoPath: string) => GitForge | null;
  git?: (cwd: string, args: string[]) => Promise<void>;
  /** Injectable CLAUDE.md IO (default: node fs at <worktree>/CLAUDE.md). */
  readClaudeMd?: (path: string) => string;
  writeClaudeMd?: (path: string, content: string) => void;
}

export type PromoteResult =
  | { ok: true; url: string }
  | { ok: false; error: string; status: number };

export class Promoter {
  private git: (cwd: string, args: string[]) => Promise<void>;
  private readClaudeMd: (path: string) => string;
  private writeClaudeMd: (path: string, content: string) => void;

  constructor(private deps: PromoterDeps) {
    this.git = deps.git ?? defaultGit;
    this.readClaudeMd = deps.readClaudeMd ?? ((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""));
    this.writeClaudeMd = deps.writeClaudeMd ?? ((p, c) => writeFileSync(p, c));
  }

  async promote(id: string): Promise<PromoteResult> {
    const learning = this.deps.store.getLearning(id);
    if (!learning) return { ok: false, error: "not found", status: 404 };
    if (learning.status !== "active") {
      return { ok: false, error: "only active rules can be promoted", status: 409 };
    }
    const forge = this.deps.resolveForge(learning.repoPath);
    if (!forge) return { ok: false, error: "no forge configured for repo", status: 400 };

    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      return { ok: false, error: "could not resolve default branch", status: 502 };
    }
    // best-effort: pull the latest base so the branch is cut from origin head
    try {
      await this.git(learning.repoPath, ["fetch", "origin", "--", base]);
    } catch {
      /* offline / no origin — fall back to the local base ref */
    }

    const name = `learnings-promote-${id.slice(0, 8)}`;
    const wt = this.deps.worktree.create(learning.repoPath, `origin/${base}`, name);
    if (!wt.isolated || !wt.branch) {
      if (wt.worktreePath !== learning.repoPath) this.deps.worktree.remove(wt.worktreePath);
      return { ok: false, error: "worktree creation failed", status: 500 };
    }
    try {
      return await this.commitAndOpen(forge, learning, base, wt.worktreePath, wt.branch);
    } catch (err) {
      return { ok: false, error: String(err), status: 500 };
    } finally {
      this.deps.worktree.remove(wt.worktreePath, { branch: wt.branch });
    }
  }

  private async commitAndOpen(
    forge: GitForge,
    learning: Learning,
    base: string,
    worktreePath: string,
    branch: string,
  ): Promise<PromoteResult> {
    const claudePath = join(worktreePath, "CLAUDE.md");
    // Managed block = every already-promoted rule for the repo plus this one,
    // so the in-repo copy stays the full curated set and the upsert is idempotent.
    const promoted = this.deps.store
      .listLearnings(learning.repoPath, { status: "promoted" })
      .map((l) => l.rule);
    const rules = [...new Set([...promoted, learning.rule])];
    this.writeClaudeMd(claudePath, upsertLearningsBlock(this.readClaudeMd(claudePath), rules));

    await this.git(worktreePath, ["add", "CLAUDE.md"]);
    await this.git(worktreePath, ["commit", "-m", "chore(learnings): promote house rule to CLAUDE.md"]);
    await this.git(worktreePath, ["push", "-u", "origin", branch]);

    const status = await forge.openPr({
      head: branch,
      base,
      title: "chore(learnings): promote curated house rule",
      body: `Promoting a Shepherd-curated house rule into CLAUDE.md:\n\n> ${learning.rule}\n\n${learning.rationale ?? ""}`.trim(),
    });
    if (!status.url) return { ok: false, error: "PR opened but no url returned", status: 502 };
    this.deps.store.promoteLearning(learning.id, status.url);
    return { ok: true, url: status.url };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/promote.test.ts`
Expected: PASS (all upsert + Promoter tests).

- [ ] **Step 5: Commit**

```bash
git add src/promote.ts test/promote.test.ts
git commit -m "feat(learnings): Promoter service opens CLAUDE.md promote PR"
```

---

### Task B5: `POST /api/learnings/:id/promote` route

**Files:**
- Modify: `src/server.ts`
- Test: `test/server-reviews.test.ts` is the closest server-handler test harness; if learnings server tests don't exist, add the test inline in a new `test/server-learnings.test.ts` mirroring the request-construction style used in `test/server-reviews.test.ts`.

First read `src/server.ts` around `AppDeps`/`Ctx` (the `distiller?` field, ~line 97-100) and the routing (`handleLearningsPost`, ~line 284) to match style.

- [ ] **Step 1: Add `promoter?` to `AppDeps`**

In `src/server.ts`, beside the `distiller?` dep:

```ts
  /** Promote a curated rule into the repo's CLAUDE.md via an auto-opened PR. */
  promoter?: { promote: (id: string) => Promise<import("./promote").PromoteResult> };
```

- [ ] **Step 2: Add the route in `handleLearningsPost`**

In `src/server.ts` `handleLearningsPost`, after the `distill` branch and before the approve/dismiss branch, add:

```ts
  // POST /api/learnings/:id/promote — open a CLAUDE.md PR for an active rule
  if (parts[2] && parts[3] === "promote") {
    if (!deps.promoter) return json({ error: "promote unavailable" }, 503);
    const res = await deps.promoter.promote(parts[2]);
    if (!res.ok) return json({ error: res.error }, res.status);
    deps.events.emit("learnings:update", { pending: deps.store.pendingLearningCount() });
    return json({ url: res.url });
  }
```

- [ ] **Step 3: Write a handler test**

Create `test/server-learnings.test.ts` (mirror `test/server-reviews.test.ts` for how it builds `AppDeps` + dispatches a `Request` through the app handler; reuse its store/events fakes). Minimum coverage:

```ts
// pseudo-shape — adapt to the actual handler entrypoint used in server-reviews.test.ts
test("POST /api/learnings/:id/promote returns the PR url on success", async () => {
  // arrange: a store with one active learning, a promoter stub returning { ok:true, url:"https://pr/7" }
  // act: dispatch POST /api/learnings/<id>/promote
  // assert: 200 + body { url: "https://pr/7" }, and events.emit("learnings:update", ...) called
});

test("POST /api/learnings/:id/promote propagates the service error status", async () => {
  // promoter stub returns { ok:false, error:"only active rules can be promoted", status:409 }
  // assert: response status 409
});
```

- [ ] **Step 4: Run the gates**

Run: `bunx tsc --noEmit && bun test ./test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server-learnings.test.ts
git commit -m "feat(learnings): POST /api/learnings/:id/promote route"
```

---

### Task B6: Wire `Promoter` in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Instantiate and inject**

In `src/index.ts`:

1. Add import near the other service imports:

```ts
import { Promoter } from "./promote";
```

2. After the `distiller` instantiation (it already has `store`, `worktree`, `resolveForge` in scope), add:

```ts
const promoter = new Promoter({ store, worktree, resolveForge });
```

3. In the object passed to the server (where `distiller,` is listed in deps), add:

```ts
  promoter,
```

- [ ] **Step 2: Verify it compiles + boots**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(learnings): wire Promoter into server deps"
```

---

### Task B7: UI promote button + handler

**Files:**
- Modify: `ui/src/lib/types.ts` (add `promotedPrUrl`), `ui/src/lib/api.ts`, `ui/src/lib/components/LearningsDrawer.svelte`, `ui/src/routes/+page.svelte`, `ui/messages/en.json`, `ui/messages/de.json`

- [ ] **Step 1: Add `promotedPrUrl` to the UI `Learning` type**

In `ui/src/lib/types.ts`, in `interface Learning`, after `lastEvidenceAt`:

```ts
  promotedPrUrl: string | null;
```

- [ ] **Step 2: Add the API client function**

In `ui/src/lib/api.ts`, after `distillRepo`:

```ts
/** Promote an active rule into the repo's CLAUDE.md via an auto-opened PR.
 *  Returns the PR url; the rule flips to `promoted` server-side. */
export async function promoteLearning(id: string): Promise<{ url: string }> {
  const r = await fetch(`/api/learnings/${id}/promote`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "promote");
  return r.json();
}
```

- [ ] **Step 3: Add i18n keys**

`ui/messages/en.json`:

```json
  "learnings_promote": "Promote",
  "learnings_promote_aria": "Promote this rule into CLAUDE.md via a pull request",
  "learnings_promote_started": "Opened a CLAUDE.md PR for the rule",
  "learnings_promote_failed": "Could not open the promote PR",
  "learnings_promoted_pr": "View PR",
```

`ui/messages/de.json`:

```json
  "learnings_promote": "Übernehmen",
  "learnings_promote_aria": "Diese Regel per Pull Request in CLAUDE.md übernehmen",
  "learnings_promote_started": "CLAUDE.md-PR für die Regel geöffnet",
  "learnings_promote_failed": "Promote-PR konnte nicht geöffnet werden",
  "learnings_promoted_pr": "PR ansehen",
```

- [ ] **Step 4: Add the button + PR link to the drawer**

In `ui/src/lib/components/LearningsDrawer.svelte`:

1. Add `onpromote` to the props block:

```ts
    onpromote,
```
and to the props type:
```ts
    onpromote: (id: string) => void;
```

2. In the injectable rule footer (`.ifoot`), replace the `active`-only dismiss block with dismiss + promote, and add a PR link for promoted rules:

```svelte
                  <span class="spacer"></span>
                  {#if r.status === "active"}
                    <button class="dismiss" onclick={() => ondismiss(r.id)}>
                      {m.learnings_dismiss()}
                    </button>
                    <button
                      class="promote"
                      onclick={() => onpromote(r.id)}
                      aria-label={m.learnings_promote_aria()}
                    >
                      {m.learnings_promote()}
                    </button>
                  {:else if r.status === "promoted" && r.promotedPrUrl}
                    <a class="prlink" href={r.promotedPrUrl} target="_blank" rel="noopener">
                      {m.learnings_promoted_pr()}
                    </a>
                  {/if}
```

3. In `<style>`, add (near `.approve`):

```css
  .promote {
    font-size: 12px;
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-green);
    background: none;
    color: var(--color-green);
  }
  .prlink {
    font-size: 12px;
    color: var(--color-green);
    text-decoration: none;
  }
```

- [ ] **Step 5: Wire the handler in `+page.svelte`**

In `ui/src/routes/+page.svelte`:

1. Add `promoteLearning` to the `api` import block (beside `distillRepo`).
2. Add the `onpromote` prop to the `<LearningsDrawer ... />` instance:

```svelte
      onpromote={(id) =>
        promoteLearning(id)
          .then(() => {
            toasts.info(m.learnings_promote_started());
            return learnings.load();
          })
          .catch(() => toasts.error(m.learnings_promote_failed()))}
```

(Check the existing toast API in this file — it uses `toasts.info(...)` for distill; use the matching `toasts.error`/`toasts.danger` method that already exists. If only `toasts.info` exists, use it for both and drop `learnings_promote_failed` from both catalogs to keep i18n parity.)

- [ ] **Step 6: Run UI gates**

Run: `cd ui && bun run check && bun run check:i18n && bun run test`
Expected: all PASS (esp. `check:i18n` — EN and DE key sets identical).

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts ui/src/lib/components/LearningsDrawer.svelte ui/src/routes/+page.svelte ui/messages/en.json ui/messages/de.json
git commit -m "feat(learnings): promote button + PR link in learnings drawer"
```

---

## Final verification (run all gates before PR)

- [ ] **Root gates**

```bash
bun install
bunx tsc --noEmit
bun test ./test
bun run lint
bunx fallow audit
```
Expected: all green; `fallow audit` exits 0.

- [ ] **UI gates**

```bash
cd ui && bun install && bun run check && bun run check:i18n && bun run test
```
Expected: all green.

- [ ] **Branch hygiene + PR**

```bash
git fetch origin
git rebase origin/main        # never merge main in
scripts/check-branch-hygiene.sh
git push -u origin HEAD
gh pr create --fill --base main
```
PR body: reference #228, note PR2a (#249/#253) already landed injection/toggle/state-machine; this PR adds promote-to-CLAUDE.md + self-audit. List the gate results.

---

## Self-Review notes (spec coverage)

- **#228 item 1 (injection):** DONE on main (#249) — not in this plan.
- **#228 item 2 (promote → CLAUDE.md):** Tasks B1–B7.
- **#228 item 3 (per-repo distiller toggle):** DONE on main (#249) — not in this plan.
- **#228 item 4 (self-audit / ineffective):** Tasks A1–A3.
- **#228 item 5 (state-machine enforcement):** DONE on main (a393cce) — `promoteLearning`/`incrementLearningIneffective` reuse `LEARNING_TRANSITIONS`, extending the same guard rather than re-implementing it.
- **Spec §4b markers / idempotency:** Task B3 (`upsertLearningsBlock`) + B4 (managed block = all promoted rules).
- **Spec §5 self-audit matching at propose time:** Task A2 (distiller `activeRules` + `ineffective`).
- **Spec §6 drawer (promote action, ineffective badge, promoted PR link):** Tasks A3, B7.
- **House rules honored:** both forges get `defaultBranch` (B2); promote git ops are async (no blocking fan-out, B4); new server value (`status`) flows from service not hardcoded in UI; i18n EN+DE parity for every operator-facing string; prompt/PR/commit text English-only.

## Unresolved questions

- Promote PR base = repo default branch via `forge.defaultBranch()` — assumed correct (vs. a session's `baseBranch`, which a learning has none of). OK?
- Managed-block content = **all** promoted rules rebuilt each promote (keeps `CLAUDE.md` the full curated set, idempotent). OK vs. appending only the single newly-promoted rule?
- Leave the local `shepherd/learnings-promote-*` branch after push (remote branch backs the open PR; not deleting since it's unmerged). Acceptable?
