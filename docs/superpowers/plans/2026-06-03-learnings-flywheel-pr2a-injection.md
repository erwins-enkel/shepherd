# Learnings Flywheel PR2(a): Injection + Per-Repo Toggle + State Machine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the learnings flywheel's core loop — prepend a repo's curated `active`/`promoted` rules into every new agent's prompt at `SessionService.create`, gated by a per-repo `learningsEnabled` toggle, with `setLearningStatus` enforcing the documented state machine.

**Architecture:** Three server-side store additions (state-machine guard, `listActiveLearnings`, `learningsEnabled` in `repo_config`), one injection seam in `SessionService.create`, distiller `consider` gating, and a UI per-repo toggle beside the existing critic toggle. Injection works end-to-end with the default-ON toggle before any UI lands, so the flywheel turns from Task 6 onward.

**Tech Stack:** Bun + TypeScript (root server), SvelteKit + Svelte 5 runes + Paraglide i18n (`ui/`), `bun:sqlite`, `bun:test` (root) / vitest (`ui/`).

**Scope note:** This is sub-PR (a) of issue #228. Sub-PR (b) — promote-to-`CLAUDE.md` PR + self-audit/ineffective detection — is a separate follow-up plan and is NOT covered here. Item 1 (injection) alone makes the flywheel turn.

**Design source of truth:** `docs/superpowers/specs/2026-06-02-learnings-flywheel-design.md` §4a (injection), §3 (state machine), §7 (per-repo config).

**Branch:** Cut from latest `origin/main` (PR1 #224 is already merged). One feature, linear off main — rebase, never merge main in.

**Decision — injected header is NOT i18n'd:** The house-rules block is agent-facing prompt text (instructions to `claude`), not operator-facing UI chrome. It follows the precedent of `distillPrompt()` in `src/distiller.ts` and the critic spawn prompt — both hardcoded English constants. The CLAUDE.md i18n rule covers "chrome the app itself authors" shown to the user; data/instructions passed through to an agent are not translated. Only the UI toggle (Task 7) gets EN+DE keys. (Spec §8 lists "the injected-block header" aspirationally, but the operator never sees it and the agent prompt is language-neutral.)

---

## File Structure

**Modified:**
- `src/store.ts` — `RepoConfig` type + `learningsEnabled` column/migration/get/set; `listActiveLearnings`; state-machine guard in `setLearningStatus`.
- `src/service.ts` — house-rules injection in `create`.
- `src/distiller.ts` — `getRepoConfig` in `DistillerDeps` store Pick; gate `consider`.
- `src/server.ts` — accept `learningsEnabled` in `PUT /api/repo-config`.
- `ui/src/lib/types.ts` — `RepoConfig.learningsEnabled`.
- `ui/src/lib/api.ts` — `putRepoConfig` takes a patch object.
- `ui/src/lib/reviews.svelte.ts` — `RepoConfigStore` learnings cache + `toggleLearnings`.
- `ui/src/lib/components/GitRail.svelte` — learnings toggle button.
- `ui/messages/en.json` + `ui/messages/de.json` — 3 new keys.

**Test files touched:**
- `test/store-learnings.test.ts` — state-machine + `listActiveLearnings` tests.
- `test/store.test.ts` — update `repo_config` expectation to include `learningsEnabled`.
- `test/service.test.ts` (or new `test/learnings-injection.test.ts`) — injection tests.
- `test/distiller.test.ts` — `consider` gated off when disabled.
- `test/server-reviews.test.ts` — repo-config GET/PUT now returns `learningsEnabled`.
- `ui/src/lib/reviews.svelte.test.ts` — unchanged (verify still green).

---

## Pre-flight (run once before Task 1)

- [ ] **Verify install + clean baseline**

```bash
cd /home/patrick/Work/.shepherd-worktrees/tank-issue-relevant-gib-aktuellen
bun install
cd ui && bun install && cd ..
bun test ./test 2>&1 | tail -5
```
Expected: all root tests pass (baseline green before changes).

---

## Task 1: State-machine enforcement in `setLearningStatus`

**Files:**
- Modify: `src/store.ts` (the `setLearningStatus` method, currently lines 466-476; add a module-level transition table near the top of the file)
- Test: `test/store-learnings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/store-learnings.test.ts`:

```typescript
test("setLearningStatus enforces the state machine", () => {
  const s = new SessionStore(":memory:");

  // proposed → promoted is illegal (must go via active); returns null, row unchanged
  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  expect(s.setLearningStatus(a.id, "promoted")).toBeNull();
  expect(s.getLearning(a.id)?.status).toBe("proposed");

  // active → proposed is illegal
  const b = s.addLearning({ repoPath: "/r", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  expect(s.setLearningStatus(b.id, "proposed")).toBeNull();
  expect(s.getLearning(b.id)?.status).toBe("active");

  // active → promoted and active → dismissed are legal
  const c = s.addLearning({ repoPath: "/r", rule: "c", rationale: "", evidence: [] });
  s.setLearningStatus(c.id, "active");
  expect(s.setLearningStatus(c.id, "promoted")?.status).toBe("promoted");

  const d = s.addLearning({ repoPath: "/r", rule: "d", rationale: "", evidence: [] });
  s.setLearningStatus(d.id, "active");
  expect(s.setLearningStatus(d.id, "dismissed")?.status).toBe("dismissed");

  // terminal states are sticky: dismissed → active is illegal
  expect(s.setLearningStatus(d.id, "active")).toBeNull();
  expect(s.getLearning(d.id)?.status).toBe("dismissed");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/store-learnings.test.ts 2>&1 | tail -20`
Expected: FAIL — current `setLearningStatus` allows any→any, so the illegal-transition assertions (expecting `null`) fail.

- [ ] **Step 3: Add the transition table and guard**

In `src/store.ts`, add a module-level constant just below the imports (after line 4):

```typescript
/** Allowed learning status transitions (spec §3). Terminal states have no exits. */
const LEARNING_TRANSITIONS: Record<LearningStatus, LearningStatus[]> = {
  proposed: ["active", "dismissed"],
  active: ["promoted", "dismissed"],
  promoted: [],
  dismissed: [],
};
```

Replace `setLearningStatus` (lines 466-476) with:

```typescript
  setLearningStatus(id: string, status: LearningStatus, rule?: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur) return null;
    if (!LEARNING_TRANSITIONS[cur.status].includes(status)) return null;
    this.db.run(`UPDATE learnings SET status = ?, rule = ?, updatedAt = ? WHERE id = ?`, [
      status,
      rule ?? cur.rule,
      Date.now(),
      id,
    ]);
    return this.getLearning(id);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/store-learnings.test.ts 2>&1 | tail -20`
Expected: PASS — including the pre-existing transition test (proposed→active is legal) and the new state-machine test.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store-learnings.test.ts
git commit -m "feat(learnings): enforce status state machine in setLearningStatus"
```

---

## Task 2: `listActiveLearnings` (active + promoted union)

**Files:**
- Modify: `src/store.ts` (add method near `listLearnings`, after line 459)
- Test: `test/store-learnings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/store-learnings.test.ts`:

```typescript
test("listActiveLearnings returns active + promoted only, oldest-updated first", () => {
  const s = new SessionStore(":memory:");
  const act = s.addLearning({ repoPath: "/r", rule: "active rule", rationale: "", evidence: [] });
  s.setLearningStatus(act.id, "active");
  const prom = s.addLearning({ repoPath: "/r", rule: "promoted rule", rationale: "", evidence: [] });
  s.setLearningStatus(prom.id, "active");
  s.setLearningStatus(prom.id, "promoted");
  s.addLearning({ repoPath: "/r", rule: "still proposed", rationale: "", evidence: [] });
  const dis = s.addLearning({ repoPath: "/r", rule: "dismissed rule", rationale: "", evidence: [] });
  s.setLearningStatus(dis.id, "dismissed");
  // other repo's active rule must not leak in
  const other = s.addLearning({ repoPath: "/other", rule: "other", rationale: "", evidence: [] });
  s.setLearningStatus(other.id, "active");

  const rules = s.listActiveLearnings("/r").map((l) => l.rule);
  expect(rules.sort()).toEqual(["active rule", "promoted rule"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store-learnings.test.ts -t "listActiveLearnings" 2>&1 | tail -20`
Expected: FAIL — `listActiveLearnings is not a function`.

- [ ] **Step 3: Implement the method**

In `src/store.ts`, add after `listLearnings` (after line 459):

```typescript
  /** Active + promoted rules for a repo, for prompt injection (spec §4a). Oldest-updated first. */
  listActiveLearnings(repoPath: string): Learning[] {
    const rows = this.db
      .query(
        `SELECT * FROM learnings WHERE repoPath = ? AND status IN ('active','promoted')
         ORDER BY updatedAt ASC`,
      )
      .all(repoPath);
    return (rows as any[]).map((r) => this.hydrateLearning(r));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/store-learnings.test.ts -t "listActiveLearnings" 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store-learnings.test.ts
git commit -m "feat(learnings): add listActiveLearnings (active+promoted union)"
```

---

## Task 3: `learningsEnabled` in `repo_config`

**Files:**
- Modify: `src/store.ts` (`RepoConfig` interface lines 6-8; CREATE TABLE + migration lines 78-80; `getRepoConfig` lines 135-140; `setRepoConfig` lines 142-149)
- Test: `test/store.test.ts` (update existing `repo_config` test at lines 39-45)

- [ ] **Step 1: Update the existing failing test**

In `test/store.test.ts`, the `repo_config` test (lines 39-45) currently expects `{ criticEnabled: ... }`. Replace its body so every `toEqual` includes `learningsEnabled`, and add coverage that the two toggles are independent:

```typescript
test("repo_config: defaults to critic enabled, persists toggles", () => {
  const store = new SessionStore(":memory:");
  expect(store.getRepoConfig("/repo/a")).toEqual({ criticEnabled: true, learningsEnabled: true }); // absent → defaults on
  store.setRepoConfig("/repo/a", { criticEnabled: false, learningsEnabled: true });
  expect(store.getRepoConfig("/repo/a")).toEqual({ criticEnabled: false, learningsEnabled: true });
  store.setRepoConfig("/repo/a", { criticEnabled: true, learningsEnabled: false });
  expect(store.getRepoConfig("/repo/a")).toEqual({ criticEnabled: true, learningsEnabled: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store.test.ts -t "repo_config" 2>&1 | tail -20`
Expected: FAIL — `getRepoConfig` returns only `{ criticEnabled }`, missing `learningsEnabled`; `setRepoConfig` typed without it.

- [ ] **Step 3: Implement the schema + accessors**

In `src/store.ts`:

(a) Extend the interface (lines 6-8):

```typescript
export interface RepoConfig {
  criticEnabled: boolean;
  learningsEnabled: boolean;
}
```

(b) Update the CREATE TABLE and add a migration. Replace the `repo_config` CREATE (lines 78-80) with:

```typescript
    this.db.run(`CREATE TABLE IF NOT EXISTS repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      learningsEnabled INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL)`);
    // migrate older DBs that predate the learnings toggle (default on)
    const rcCols = this.db.query(`PRAGMA table_info(repo_config)`).all() as { name: string }[];
    if (!rcCols.some((c) => c.name === "learningsEnabled")) {
      this.db.run(`ALTER TABLE repo_config ADD COLUMN learningsEnabled INTEGER NOT NULL DEFAULT 1`);
    }
```

(c) Replace `getRepoConfig` (lines 135-140):

```typescript
  getRepoConfig(repoPath: string): RepoConfig {
    const r = this.db
      .query(`SELECT criticEnabled, learningsEnabled FROM repo_config WHERE repoPath = ?`)
      .get(repoPath) as { criticEnabled: number; learningsEnabled: number } | null;
    return {
      criticEnabled: r ? !!r.criticEnabled : true, // absent → enabled
      learningsEnabled: r ? !!r.learningsEnabled : true, // absent → enabled
    };
  }
```

(d) Replace `setRepoConfig` (lines 142-149):

```typescript
  setRepoConfig(repoPath: string, cfg: RepoConfig): void {
    this.db.run(
      `INSERT INTO repo_config (repoPath, criticEnabled, learningsEnabled, updatedAt) VALUES (?,?,?,?)
       ON CONFLICT(repoPath) DO UPDATE SET criticEnabled = excluded.criticEnabled,
         learningsEnabled = excluded.learningsEnabled, updatedAt = excluded.updatedAt`,
      [repoPath, cfg.criticEnabled ? 1 : 0, cfg.learningsEnabled ? 1 : 0, Date.now()],
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/store.test.ts -t "repo_config" 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat(learnings): add per-repo learningsEnabled to repo_config"
```

---

## Task 4: Accept `learningsEnabled` in `PUT /api/repo-config`

**Files:**
- Modify: `src/server.ts` (`handleRepoConfig`, lines 161-176)
- Test: `test/server-reviews.test.ts` (update repo-config GET/PUT expectations)

- [ ] **Step 1: Update the failing tests**

In `test/server-reviews.test.ts`, update the three `toEqual` assertions that hardcode `{ criticEnabled: ... }` (around lines 82, 113, 117) to include `learningsEnabled: true`, and add a PUT test for the learnings field. Concretely:

- Line 82: `expect(await res.json()).toEqual({ criticEnabled: true, learningsEnabled: true });`
- Line 113: `expect(await put.json()).toEqual({ criticEnabled: false, learningsEnabled: true });`
- Line 117: `expect(await get.json()).toEqual({ criticEnabled: false, learningsEnabled: true });`

Add after the existing PUT criticEnabled test (after line ~118):

```typescript
test("PUT /api/repo-config sets learningsEnabled independently of criticEnabled", async () => {
  const { app, repoDir } = await mk();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learningsEnabled: false }),
    }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ criticEnabled: true, learningsEnabled: false });
});
```

> Note: use the same harness factory the surrounding tests use (e.g. `mk()`/`makeApp()` — check the top of `test/server-reviews.test.ts` and mirror it exactly; the snippet above assumes a `mk()` returning `{ app, repoDir }`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/server-reviews.test.ts 2>&1 | tail -25`
Expected: FAIL — GET/PUT responses now carry `learningsEnabled` (so old `toEqual` mismatch) and the new PUT path isn't handled (the `learningsEnabled` body field is ignored, response keeps it `true`... actually the handler rejects non-`criticEnabled` bodies — see Step 3).

- [ ] **Step 3: Implement the overlay handler**

Replace the PUT branch in `handleRepoConfig` (`src/server.ts` lines 166-173) with a partial-overlay that validates any provided boolean field:

```typescript
    if (req.method === "PUT") {
      const body = (await req.json().catch(() => null)) as {
        criticEnabled?: unknown;
        learningsEnabled?: unknown;
      } | null;
      if (!body) return json({ error: "body must be a repo-config object" }, 400);
      const next = deps.store.getRepoConfig(dir);
      if ("criticEnabled" in body) {
        if (typeof body.criticEnabled !== "boolean") return json({ error: "criticEnabled must be boolean" }, 400);
        next.criticEnabled = body.criticEnabled;
      }
      if ("learningsEnabled" in body) {
        if (typeof body.learningsEnabled !== "boolean") return json({ error: "learningsEnabled must be boolean" }, 400);
        next.learningsEnabled = body.learningsEnabled;
      }
      deps.store.setRepoConfig(dir, next);
      return json(deps.store.getRepoConfig(dir));
    }
```

> Backward-compat check: the existing `{ criticEnabled: "yes" }` → 400 test still passes (`"criticEnabled" in body` true, non-boolean → 400). The `null` body → 400 test still passes. The `{ criticEnabled: false }` test now returns `{ criticEnabled: false, learningsEnabled: true }` (updated in Step 1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/server-reviews.test.ts 2>&1 | tail -25`
Expected: PASS (all repo-config GET/PUT tests including the new learnings one).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server-reviews.test.ts
git commit -m "feat(learnings): accept learningsEnabled in PUT /api/repo-config"
```

---

## Task 5: Gate the distiller's `consider` on `learningsEnabled`

**Files:**
- Modify: `src/distiller.ts` (`DistillerDeps` store Pick line 29; `consider` lines 61-67)
- Test: `test/distiller.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/distiller.test.ts`:

```typescript
test("consider does nothing when learnings disabled for the repo", () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 5);
  store.setRepoConfig("/r", { criticEnabled: true, learningsEnabled: false });
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  d.consider("/r");
  expect(started.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/distiller.test.ts -t "learnings disabled" 2>&1 | tail -20`
Expected: FAIL — `consider` spawns despite the toggle (started.length === 1).

- [ ] **Step 3: Add the gate**

In `src/distiller.ts`, widen the store Pick (line 29):

```typescript
  store: Pick<SessionStore, "listSignals" | "addLearning" | "listLearnings" | "getRepoConfig">;
```

Add the early-return at the top of `consider` (after the inflight guard, line 62):

```typescript
  consider(repoPath: string): void {
    if (this.inflight.has(repoPath)) return;
    if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return;
    const since = this.now() - this.windowMs;
    const signals = this.deps.store.listSignals(repoPath, { sinceTs: since });
    if (signals.length < this.minSignals) return;
    this.begin(repoPath, signals);
  }
```

> `distillNow` (the manual "distill now" button) is intentionally left ungated — an explicit operator action overrides the toggle. `index.ts` already passes the full `store`, so no wiring change is needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/distiller.test.ts 2>&1 | tail -20`
Expected: PASS (new gate test + all pre-existing distiller tests — they use a real `SessionStore` whose default `learningsEnabled` is true).

- [ ] **Step 5: Commit**

```bash
git add src/distiller.ts test/distiller.test.ts
git commit -m "feat(learnings): gate distiller consider on per-repo learningsEnabled"
```

---

## Task 6: Inject house rules at `SessionService.create` (the core value)

**Files:**
- Modify: `src/service.ts` (add `HOUSE_RULES_HEADER` const + `houseRules` helper; call it in `create` before argv build, lines 67-71)
- Test: `test/service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/service.test.ts` (it already imports `SessionStore`, `SessionService`, `spawnSettingsOverlay`):

```typescript
function injectDeps(store: SessionStore, captured: { argv?: string[] }) {
  return {
    store,
    namer: async () => "repo-task",
    worktree: {
      create: () => ({ worktreePath: "/wt/repo-task", branch: "shepherd/repo-task", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: (_n: string, _c: string, argv: string[]) => {
        captured.argv = argv;
        return { terminalId: "t1" };
      },
      list: () => [],
    } as any,
  };
}

test("create prepends active+promoted house rules to the prompt", async () => {
  const store = new SessionStore(":memory:");
  const a = store.addLearning({ repoPath: "/repo", rule: "Use bun, not npm", rationale: "", evidence: [] });
  store.setLearningStatus(a.id, "active");
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({ repoPath: "/repo", baseBranch: "main", prompt: "do the thing", model: null, images: [] });
  const promptArg = captured.argv!.at(-1)!;
  expect(promptArg).toContain("Project house rules");
  expect(promptArg).toContain("- Use bun, not npm");
  expect(promptArg.endsWith("do the thing")).toBe(true); // user text stays last
});

test("create omits the house-rules block when no active rules exist", async () => {
  const store = new SessionStore(":memory:");
  store.addLearning({ repoPath: "/repo", rule: "still proposed", rationale: "", evidence: [] }); // proposed, not injected
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({ repoPath: "/repo", baseBranch: "main", prompt: "do the thing", model: null, images: [] });
  expect(captured.argv!.at(-1)).toBe("do the thing");
});

test("create omits house rules when learnings disabled for the repo", async () => {
  const store = new SessionStore(":memory:");
  const a = store.addLearning({ repoPath: "/repo", rule: "Use bun", rationale: "", evidence: [] });
  store.setLearningStatus(a.id, "active");
  store.setRepoConfig("/repo", { criticEnabled: true, learningsEnabled: false });
  const captured: { argv?: string[] } = {};
  const svc = new SessionService(injectDeps(store, captured) as any);
  await svc.create({ repoPath: "/repo", baseBranch: "main", prompt: "do the thing", model: null, images: [] });
  expect(captured.argv!.at(-1)).toBe("do the thing");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/service.test.ts -t "house rules" 2>&1 | tail -20`
Expected: FAIL — `create` does not inject; `promptArg` equals the raw prompt.

- [ ] **Step 3: Implement injection**

In `src/service.ts`, add a module-level constant below the imports (after line 10):

```typescript
/** Header for the Shepherd-curated house-rules block prepended to every agent prompt.
 *  Agent-facing prompt text (not operator UI), so it is a fixed English constant —
 *  same precedent as the distiller/critic spawn prompts. */
const HOUSE_RULES_HEADER = "## Project house rules (curated by Shepherd)";
```

Add a private helper to the `SessionService` class (e.g. just before `create`, after line 42):

```typescript
  /** Active+promoted rules for the repo as a delimited prompt block, or null when
   *  none / learnings disabled. Prepended to every new agent's prompt (spec §4a). */
  private houseRules(repoPath: string): string | null {
    if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return null;
    const rules = this.deps.store.listActiveLearnings(repoPath);
    if (rules.length === 0) return null;
    return `${HOUSE_RULES_HEADER}\n${rules.map((r) => `- ${r.rule}`).join("\n")}`;
  }
```

In `create`, after the `issueRef` block and before the argv build (between lines 66 and 68), insert:

```typescript
      // Prepend Shepherd-curated house rules so every spawn (manual AND auto-spawned,
      // e.g. the work-queue drain #222) inherits the repo's learned corrections.
      const houseRules = this.houseRules(input.repoPath);
      if (houseRules) promptArg = `${houseRules}\n\n${promptArg}`;
```

> `ServiceDeps.store` is the full `SessionStore`, so `getRepoConfig` and `listActiveLearnings` are available with no Pick change. The existing `create` test uses a real `SessionStore` with no learnings → `houseRules` returns null → its argv assertion is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/service.test.ts 2>&1 | tail -20`
Expected: PASS (new injection tests + the original `createSession` argv test, which sees no rules).

- [ ] **Step 5: Commit**

```bash
git add src/service.ts test/service.test.ts
git commit -m "feat(learnings): inject curated house rules into every agent prompt"
```

---

## Task 7: UI — per-repo learnings toggle beside the critic toggle

**Files:**
- Modify: `ui/src/lib/types.ts` (`RepoConfig`, lines 134-136)
- Modify: `ui/src/lib/api.ts` (`putRepoConfig`, lines 493-501)
- Modify: `ui/src/lib/reviews.svelte.ts` (`RepoConfigStore`, lines 61-89)
- Modify: `ui/src/lib/components/GitRail.svelte` (add toggle ~after line 285)
- Modify: `ui/messages/en.json` + `ui/messages/de.json`
- Verify: `ui/src/lib/reviews.svelte.test.ts` stays green (no change expected)

- [ ] **Step 1: Add the i18n keys (both catalogs)**

In `ui/messages/en.json` add:

```json
"gitrail_learnings_toggle_aria": "Toggle Shepherd house-rule injection for this repo",
"gitrail_learnings_on_title": "House rules injected into new agents — click to disable",
"gitrail_learnings_off_title": "House rules NOT injected — click to enable"
```

In `ui/messages/de.json` add (same keys):

```json
"gitrail_learnings_toggle_aria": "Shepherd-Hausregeln für dieses Repo umschalten",
"gitrail_learnings_on_title": "Hausregeln werden in neue Agenten injiziert — zum Deaktivieren klicken",
"gitrail_learnings_off_title": "Hausregeln werden NICHT injiziert — zum Aktivieren klicken"
```

> Place each key in alphabetical/grouped position consistent with the surrounding `gitrail_*` keys in both files.

- [ ] **Step 2: Run the i18n gate to confirm parity**

Run: `cd ui && bun run check:i18n 2>&1 | tail -10`
Expected: PASS (identical non-empty key sets in EN + DE).

- [ ] **Step 3: Extend the `RepoConfig` UI type**

In `ui/src/lib/types.ts` (lines 134-136):

```typescript
export interface RepoConfig {
  criticEnabled: boolean;
  learningsEnabled: boolean;
}
```

- [ ] **Step 4: Change `putRepoConfig` to take a patch object**

In `ui/src/lib/api.ts`, replace `putRepoConfig` (lines 493-501):

```typescript
export async function putRepoConfig(
  repoPath: string,
  patch: Partial<Pick<RepoConfig, "criticEnabled" | "learningsEnabled">>,
): Promise<RepoConfig> {
  const r = await fetch(`/api/repo-config?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`repo-config put failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 5: Extend `RepoConfigStore` (cache learnings + shared optimistic put)**

In `ui/src/lib/reviews.svelte.ts`, replace the `RepoConfigStore` class body (lines 61-88) with:

```typescript
/** Per-repo critic + learnings on/off, cached lazily by repoPath. */
class RepoConfigStore {
  enabled = $state<Record<string, boolean>>({}); // critic
  learnings = $state<Record<string, boolean>>({});

  async ensure(repoPath: string) {
    if (repoPath in this.enabled) return;
    try {
      const c = await getRepoConfig(repoPath);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
      this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
    } catch {
      /* leave unset; UI shows default-on optimistically */
    }
  }

  /** Optimistically apply a patch, then reconcile from the server (or revert on error). */
  private async apply(
    repoPath: string,
    patch: Partial<Pick<RepoConfig, "criticEnabled" | "learningsEnabled">>,
    revert: () => void,
  ) {
    try {
      const c = await putRepoConfig(repoPath, patch);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
      this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
    } catch {
      revert();
    }
  }

  async toggle(repoPath: string) {
    const prev = this.enabled[repoPath];
    const next = !this.isEnabled(repoPath);
    this.enabled = { ...this.enabled, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { criticEnabled: next }, () => {
      this.enabled = { ...this.enabled, [repoPath]: prev };
    });
  }

  async toggleLearnings(repoPath: string) {
    const prev = this.learnings[repoPath];
    const next = !this.learningsOn(repoPath);
    this.learnings = { ...this.learnings, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { learningsEnabled: next }, () => {
      this.learnings = { ...this.learnings, [repoPath]: prev };
    });
  }

  isEnabled(repoPath: string): boolean {
    return this.enabled[repoPath] ?? true;
  }

  learningsOn(repoPath: string): boolean {
    return this.learnings[repoPath] ?? true;
  }
}
export const repoConfig = new RepoConfigStore();
```

Add `RepoConfig` to the type import at the top of `ui/src/lib/reviews.svelte.ts` if not already imported (check line 1-3; `putRepoConfig`/`getRepoConfig` are imported from `./api`, the `RepoConfig` type from `./types` — add `import type { RepoConfig } from "./types";` if absent).

- [ ] **Step 6: Run the UI store tests (must stay green unchanged)**

Run: `cd ui && bun run test src/lib/reviews.svelte.test.ts 2>&1 | tail -20`
Expected: PASS — the existing tests mock `putRepoConfig`/`getRepoConfig` (they don't assert call args) and use `repoConfig.enabled` directly, which still exists. `c.learningsEnabled` is `undefined` in their mocks → `learningsOn` falls back to `true`; no assertion touches it.

- [ ] **Step 7: Add the toggle button in GitRail**

In `ui/src/lib/components/GitRail.svelte`, add a derived value beside `criticOn` (after line 198):

```svelte
  const learningsOn = $derived(repoConfig.learningsOn(repoPath));
```

Add a toggle button immediately after the critic toggle's closing `{/if}` (after line 285), mirroring its structure:

```svelte
      {#if repoPath}
        <button
          class={["gbtn", "learn-toggle"]}
          type="button"
          aria-label={m.gitrail_learnings_toggle_aria()}
          aria-pressed={learningsOn}
          title={learningsOn ? m.gitrail_learnings_on_title() : m.gitrail_learnings_off_title()}
          onclick={() => repoConfig.toggleLearnings(repoPath)}
        >
          🎓<span class="crit-dot" class:on={learningsOn} aria-hidden="true"></span>
        </button>
      {/if}
```

> Reuses the existing `.crit-dot`/`.gbtn` styles (the `.on` modifier already exists). No new CSS strictly required; if a distinct class is wanted, add `.learn-toggle` rules mirroring `.crit-toggle`.

- [ ] **Step 8: Run the full UI gate**

Run: `cd ui && bun run check && bun run check:i18n && bun run test 2>&1 | tail -25`
Expected: PASS — svelte-check clean (types line up), i18n parity holds, all vitest suites green.

- [ ] **Step 9: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts ui/src/lib/reviews.svelte.ts ui/src/lib/components/GitRail.svelte ui/messages/en.json ui/messages/de.json
git commit -m "feat(learnings): per-repo house-rule injection toggle in GitRail"
```

---

## Final verification (run all gates before opening the PR)

- [ ] **Root gates**

```bash
cd /home/patrick/Work/.shepherd-worktrees/tank-issue-relevant-gib-aktuellen
bunx tsc --noEmit && bun test ./test && bun run lint
```
Expected: tsc clean, all root tests pass, lint clean.

- [ ] **UI gates**

```bash
cd ui && bun run check && bun run check:i18n && bun run test && cd ..
```
Expected: all pass.

- [ ] **Fallow gate (complexity + dead-code + duplication on changed files)**

```bash
bunx fallow audit
```
Expected: exit 0. If it flags complexity on the new `handleRepoConfig` PUT branch, extract a small `parseRepoConfigPatch(body, current)` helper. If it flags duplication in `RepoConfigStore`, the shared `apply()` helper should already cover it — verify the two toggle methods aren't otherwise near-identical.

- [ ] **Branch hygiene**

```bash
bash scripts/check-branch-hygiene.sh
```
Expected: pass (no merge commits relative to main).

- [ ] **Open the PR**

```bash
git push -u origin HEAD
gh pr create --repo erwins-enkel/shepherd --base main \
  --title "feat(learnings): close the flywheel — inject curated house rules into agents (PR2a)" \
  --body "$(cat <<'EOF'
Closes part of #228 (sub-PR a: injection + per-repo toggle + state machine).

## What
- **Injection (the core value):** `SessionService.create` now prepends the repo's `active`+`promoted` learnings as a `## Project house rules (curated by Shepherd)` block — applies to manual AND auto-spawned (#222) sessions. The flywheel turns.
- **Per-repo toggle:** `repo_config.learningsEnabled` (default ON) gates both injection and the distiller's `consider`; UI toggle beside the critic toggle in GitRail.
- **State machine:** `setLearningStatus` enforces `proposed→active`, `proposed|active→dismissed`, `active→promoted`; illegal transitions return null (deferred nit from #224 review).
- `store.listActiveLearnings(repoPath)` (active+promoted union).

## Not in this PR (sub-PR b, follow-up)
Promote-to-CLAUDE.md PR + self-audit/ineffective detection.

## Tests
Store state-machine + listActiveLearnings; distiller gate-off; create injects/omits; repo-config GET/PUT learningsEnabled. All root + UI + i18n + fallow gates green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed during planning)

**Spec coverage (§ of design doc / issue scope items):**
- §4a injection → Task 6 ✓
- §3 state machine / issue item 5 → Task 1 ✓
- §7 per-repo config / issue item 3 → Tasks 3, 4, 5, 7 ✓
- `listActiveLearnings` (issue item 1 prerequisite) → Task 2 ✓
- §8 i18n → Task 7 (UI toggle keys; injected header intentionally excluded, rationale documented) ✓
- **Out of sub-PR (a) scope:** §4b promote-to-CLAUDE.md (issue item 2) and §5 self-audit (issue item 4) — deferred to sub-PR (b). Stated in header.

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type consistency:** `RepoConfig` carries `{ criticEnabled, learningsEnabled }` everywhere (store, server, UI types, api, client store). `setLearningStatus` signature unchanged (guard added internally). `listActiveLearnings(repoPath): Learning[]`, `houseRules(repoPath): string | null`, `HOUSE_RULES_HEADER` const used in Task 6 test assertion (`"Project house rules"` substring). `putRepoConfig(repoPath, patch)` patch shape matches server overlay handler.

## Unresolved questions
- Inject order: active+promoted by `updatedAt ASC` (oldest first). OK? (assumed yes)
- Injected header English-only (not i18n). OK? (assumed yes — agent-facing, matches distiller-prompt precedent)
- `distillNow` (manual button) left ungated by the toggle. OK? (assumed yes — explicit operator action)
