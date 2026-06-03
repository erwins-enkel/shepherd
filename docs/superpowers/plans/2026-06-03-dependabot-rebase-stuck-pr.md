# Opt-in "@dependabot rebase" for stuck backlog PRs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click, opt-in "Dependabot rebase" action to backlog PR rows that posts `@dependabot rebase` when a Dependabot PR is stuck (merge blocked or a merge attempt failed).

**Architecture:** A new optional `comment` method on the `GitForge` interface (GitHub-only) backs a purpose-built `POST /api/prs/dependabot-rebase` endpoint that posts a fixed `@dependabot rebase` string. The UI detects Dependabot authorship and offers the action client-side via extracted, unit-tested logic; the Svelte row wires it up.

**Tech Stack:** Bun + TypeScript (root server, `gh` CLI forge), SvelteKit + Paraglide i18n (UI), `bun test` (server) / vitest (UI).

**Spec:** `docs/superpowers/specs/2026-06-03-dependabot-rebase-stuck-pr-design.md`

---

## File Structure

- `src/forge/types.ts` — add optional `comment?` to `GitForge` + `DEPENDABOT_REBASE_COMMAND` constant.
- `src/forge/github.ts` — implement `comment` via `gh pr comment`.
- `test/forge/github.test.ts` — test `comment`.
- `src/server.ts` — add `handleDependabotRebase`, register in `ROUTE_HANDLERS`, value-import the constant.
- `test/server-prs.test.ts` — test the endpoint.
- `ui/src/lib/components/pr-row.ts` — **new**: `isDependabotAuthor` + `showRebaseOffer` pure logic.
- `ui/src/lib/components/pr-row.test.ts` — **new**: vitest for the above.
- `ui/messages/en.json`, `ui/messages/de.json` — 5 new `prspanel_*` keys each.
- `ui/src/lib/api.ts` — `requestDependabotRebase` client.
- `ui/src/lib/components/PrRow.svelte` — wire state, button, inline states, styles.

---

## Task 0: Install deps (fresh worktree)

**Files:** none

- [ ] **Step 1: Install both packages**

Run:
```bash
bun install && (cd ui && bun install)
```
Expected: both complete without error (worktrees start without `node_modules`).

---

## Task 1: Forge `comment` method + command constant

**Files:**
- Modify: `src/forge/types.ts`
- Modify: `src/forge/github.ts`
- Test: `test/forge/github.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/forge/github.test.ts`:

```ts
test("GithubForge.comment: posts a PR comment via gh pr comment", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.comment(7, "@dependabot rebase");
  expect(calls).toEqual([["pr", "comment", "7", "--repo", "o/r", "--body", "@dependabot rebase"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/forge/github.test.ts`
Expected: FAIL — `forge.comment is not a function`.

- [ ] **Step 3: Add the constant + interface method in `src/forge/types.ts`**

After the `AUTHOR_RESPONSE_MARKER` block (around line 22), add:

```ts
/** The opt-in command a maintainer posts on a Dependabot PR to make Dependabot
 *  rebase it onto the base branch. Posted by the dependabot-rebase endpoint. */
export const DEPENDABOT_REBASE_COMMAND = "@dependabot rebase";
```

In the `GitForge` interface, just below the `merge(...)` line (around line 166), add:

```ts
  /** Post a plain issue comment on a PR (`gh pr comment`). Optional: only hosts
   *  with a comment API (GitHub) implement it; others omit it and the
   *  dependabot-rebase endpoint 400s. */
  comment?(prNumber: number, body: string): Promise<void>;
```

- [ ] **Step 4: Implement in `src/forge/github.ts`**

Immediately after the `merge(...)` method (ends ~line 333), add:

```ts
  async comment(prNumber: number, body: string): Promise<void> {
    this.run(["pr", "comment", String(prNumber), "--repo", this.slug, "--body", body]);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/forge/github.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Commit**

```bash
git add src/forge/types.ts src/forge/github.ts test/forge/github.test.ts
git commit -m "feat(forge): add GitHub comment method + @dependabot rebase command"
```

---

## Task 2: Server `POST /api/prs/dependabot-rebase` endpoint

**Files:**
- Modify: `src/server.ts`
- Test: `test/server-prs.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/server-prs.test.ts`, add a request helper after the existing `mergeReq` function:

```ts
function rebaseReq(body: unknown): Request {
  return new Request("http://localhost/api/prs/dependabot-rebase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
```

Append these tests at the end of the file:

```ts
test("POST /api/prs/dependabot-rebase posts @dependabot rebase by number", async () => {
  let commented: { number: number; body: string } | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        comment: async (number, body) => {
          commented = { number, body };
        },
      }),
    ),
  );
  const res = await app.fetch(rebaseReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(commented).toEqual({ number: 12, body: "@dependabot rebase" });
});

test("POST /api/prs/dependabot-rebase without a number → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ comment: async () => {} })));
  const res = await app.fetch(rebaseReq({ repo: repoDir }));
  expect(res.status).toBe(400);
});

test("POST /api/prs/dependabot-rebase on a forge without comment support → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(rebaseReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("comment");
});

test("POST /api/prs/dependabot-rebase surfaces forge failure → 502", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        comment: async () => {
          throw new Error("gh exploded");
        },
      }),
    ),
  );
  const res = await app.fetch(rebaseReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("gh exploded");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/server-prs.test.ts`
Expected: FAIL — the new endpoint 404/null-routes, so success test gets a non-200 and `comment` is never called.

- [ ] **Step 3: Value-import the constant in `src/server.ts`**

The existing forge-types import (line ~34) is `import type { ... }`. Add a separate **value** import directly below it:

```ts
import { DEPENDABOT_REBASE_COMMAND } from "./forge/types";
```

- [ ] **Step 4: Add the handler in `src/server.ts`**

Immediately after `handlePrMerge` (ends ~line 1253), add:

```ts
// POST /api/prs/dependabot-rebase — post the opt-in "@dependabot rebase" command on
// a stuck Dependabot PR by repo + number. The body is fixed server-side. GitHub
// only (forge must expose `comment`); other forges 400 and the UI never offers it.
async function handleDependabotRebase({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "prs" ||
    parts[2] !== "dependabot-rebase"
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; number?: number };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.number !== "number") return json({ error: "number required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.comment) return json({ error: "no comment support" }, 400);
  try {
    await forge.comment(body.number, DEPENDABOT_REBASE_COMMAND);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "comment failed" }, 502);
  }
}
```

- [ ] **Step 5: Register in `ROUTE_HANDLERS`**

In the `ROUTE_HANDLERS` array (~line 1417), add `handleDependabotRebase` on the line right after `handlePrMerge,`:

```ts
  handlePrMerge,
  handleDependabotRebase,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/server-prs.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/server-prs.test.ts
git commit -m "feat(server): POST /api/prs/dependabot-rebase posts the rebase command"
```

---

## Task 3: UI detection + offer logic (extracted, unit-tested)

**Files:**
- Create: `ui/src/lib/components/pr-row.ts`
- Test: `ui/src/lib/components/pr-row.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/components/pr-row.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isDependabotAuthor, showRebaseOffer } from "./pr-row";

describe("isDependabotAuthor", () => {
  it("matches gh's app/dependabot login", () => {
    expect(isDependabotAuthor("app/dependabot")).toBe(true);
  });
  it("matches dependabot[bot]", () => {
    expect(isDependabotAuthor("dependabot[bot]")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isDependabotAuthor("App/Dependabot")).toBe(true);
  });
  it("rejects a human author", () => {
    expect(isDependabotAuthor("alice")).toBe(false);
  });
});

describe("showRebaseOffer", () => {
  const base = { author: "app/dependabot", blocked: true, failed: false, requested: false };
  it("offers for a blocked dependabot PR", () => {
    expect(showRebaseOffer(base)).toBe(true);
  });
  it("offers after a failed merge", () => {
    expect(showRebaseOffer({ ...base, blocked: false, failed: true })).toBe(true);
  });
  it("hides for a non-dependabot blocked PR", () => {
    expect(showRebaseOffer({ ...base, author: "alice" })).toBe(false);
  });
  it("hides when neither blocked nor failed", () => {
    expect(showRebaseOffer({ ...base, blocked: false, failed: false })).toBe(false);
  });
  it("hides once a rebase has been requested", () => {
    expect(showRebaseOffer({ ...base, requested: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- pr-row`
Expected: FAIL — cannot resolve `./pr-row`.

- [ ] **Step 3: Create `ui/src/lib/components/pr-row.ts`**

```ts
/** True when a PR was opened by Dependabot. `gh` reports the login as
 *  `app/dependabot`; the substring match also covers `dependabot[bot]`. */
export function isDependabotAuthor(author: string): boolean {
  return author.toLowerCase().includes("dependabot");
}

/** Whether to offer the one-click "@dependabot rebase" action on a backlog PR
 *  row: only for Dependabot PRs that are stuck (merge blocked by conflicts/behind,
 *  or a merge attempt just failed) and not already asked to rebase. */
export function showRebaseOffer(o: {
  author: string;
  blocked: boolean;
  failed: boolean;
  requested: boolean;
}): boolean {
  return isDependabotAuthor(o.author) && (o.blocked || o.failed) && !o.requested;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test -- pr-row`
Expected: PASS (9 assertions).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/pr-row.ts ui/src/lib/components/pr-row.test.ts
git commit -m "feat(ui): dependabot detection + rebase-offer logic"
```

---

## Task 4: i18n keys (EN + DE)

**Files:**
- Modify: `ui/messages/en.json`
- Modify: `ui/messages/de.json`

- [ ] **Step 1: Add keys to `ui/messages/en.json`**

Add these 5 entries (place them next to the other `prspanel_*` keys; JSON key order is irrelevant):

```json
  "prspanel_rebase_button": "Dependabot rebase",
  "prspanel_rebase_button_title": "Ask Dependabot to rebase this PR",
  "prspanel_requesting": "requesting…",
  "prspanel_rebase_requested": "rebase requested",
  "prspanel_rebase_failed": "rebase failed",
```

- [ ] **Step 2: Add the matching keys to `ui/messages/de.json`**

```json
  "prspanel_rebase_button": "Dependabot-Rebase",
  "prspanel_rebase_button_title": "Dependabot bitten, diesen PR zu rebasen",
  "prspanel_requesting": "wird angefragt…",
  "prspanel_rebase_requested": "Rebase angefragt",
  "prspanel_rebase_failed": "Rebase fehlgeschlagen",
```

- [ ] **Step 3: Verify catalog parity + message compilation**

Run: `cd ui && bun run check:i18n`
Expected: PASS — both catalogs share an identical key set.

- [ ] **Step 4: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): i18n keys for dependabot rebase action"
```

---

## Task 5: API client `requestDependabotRebase`

**Files:**
- Modify: `ui/src/lib/api.ts`

(No unit test — thin `fetch` wrappers in `api.ts` are untested by convention, mirroring `mergeBacklogPr`. Verified by `bun run check` in Task 7.)

- [ ] **Step 1: Add the client function**

Directly after the `mergeBacklogPr` function (ends ~line 323), add:

```ts
/** Post the opt-in "@dependabot rebase" command on a stuck Dependabot backlog PR
 *  by repo + number. Resolves on success. */
export async function requestDependabotRebase(repoPath: string, number: number): Promise<void> {
  const r = await fetch("/api/prs/dependabot-rebase", JSON_POST({ repo: repoPath, number }));
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/lib/api.ts
git commit -m "feat(ui): requestDependabotRebase api client"
```

---

## Task 6: Wire `PrRow.svelte`

**Files:**
- Modify: `ui/src/lib/components/PrRow.svelte`

- [ ] **Step 1: Update imports**

Replace the api import line (line 5):

```svelte
  import { mergeBacklogPr } from "$lib/api";
```

with:

```svelte
  import { mergeBacklogPr, requestDependabotRebase } from "$lib/api";
  import { showRebaseOffer } from "./pr-row";
```

- [ ] **Step 2: Add rebase state + derived offer + handler**

After the `failed` state declaration (line 27, `let failed = $state(false);`), add:

```svelte
  // Stuck Dependabot PRs get a one-click "@dependabot rebase" opt-in. `requested`
  // is sticky for the row's lifetime so Dependabot is never asked twice.
  let requesting = $state(false);
  let requested = $state(false);
  let rebaseFailed = $state(false);
```

After the `blocked` derived (line 38), add:

```svelte
  const offerRebase = $derived(
    showRebaseOffer({ author: pr.author, blocked, failed, requested }),
  );
```

After the `onmerge` function (ends ~line 89), add:

```svelte
  async function onrebase() {
    if (requesting || requested) return;
    rebaseFailed = false;
    requesting = true;
    try {
      await requestDependabotRebase(repoPath, pr.number);
      requested = true;
    } catch {
      rebaseFailed = true;
    } finally {
      requesting = false;
    }
  }
```

- [ ] **Step 3: Add the affordance to the actions row**

In the `.pr-actions` block, replace this (lines 171-172):

```svelte
  <div class="pr-actions">
    {#if failed}<span class="merge-err">{m.prspanel_merge_failed()}</span>{/if}
```

with:

```svelte
  <div class="pr-actions">
    {#if failed}<span class="merge-err">{m.prspanel_merge_failed()}</span>{/if}
    {#if rebaseFailed}<span class="merge-err">{m.prspanel_rebase_failed()}</span>{/if}
    {#if requested}
      <span class="rebase-note">{m.prspanel_rebase_requested()}</span>
    {:else if offerRebase}
      <button
        class="rebase-btn"
        disabled={requesting}
        onclick={onrebase}
        title={m.prspanel_rebase_button_title()}
      >
        {requesting ? m.prspanel_requesting() : m.prspanel_rebase_button()}
      </button>
    {/if}
```

- [ ] **Step 4: Add styles**

In the `<style>` block, add `.rebase-btn` to the three shared button rules:

Change `.review-btn,\n  .merge-btn {` (line ~391) to:

```css
  .review-btn,
  .merge-btn,
  .rebase-btn {
```

Change `.review-btn:hover,\n  .merge-btn:hover:not(:disabled) {` (line ~408) to:

```css
  .review-btn:hover,
  .rebase-btn:hover:not(:disabled),
  .merge-btn:hover:not(:disabled) {
```

In the `@media (max-width: 768px)` block, change `.review-btn,\n    .merge-btn {` (line ~429) to:

```css
    .review-btn,
    .merge-btn,
    .rebase-btn {
```

Then add a disabled rule + the note style after the `.merge-err` rule (after line ~389):

```css
  .rebase-btn:disabled {
    color: var(--color-faint);
    border-color: var(--color-line);
    cursor: not-allowed;
  }

  /* "rebase requested" — a settled, non-alarming confirmation (muted, not red). */
  .rebase-note {
    margin-right: auto;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
```

- [ ] **Step 5: Verify type-check + lint pass**

Run: `cd ui && bun run check`
Expected: PASS — no type or Svelte errors; `m.prspanel_rebase_*` resolve.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/PrRow.svelte
git commit -m "feat(ui): offer @dependabot rebase on stuck backlog PR rows"
```

---

## Task 7: Full verification

**Files:** none

- [ ] **Step 1: Root lint + tests**

Run:
```bash
bun run lint && bun test ./test
```
Expected: lint clean; all server tests pass (including the new forge + endpoint tests).

- [ ] **Step 2: UI check, i18n parity, tests**

Run:
```bash
cd ui && bun run check && bun run check:i18n && bun run test
```
Expected: all pass (including the new `pr-row` tests).

- [ ] **Step 3: Confirm no stray changes**

Run: `git status`
Expected: clean working tree; all work committed across Tasks 1-6.

---

## Notes for the implementer

- **Trust model:** the endpoint posts a fixed `@dependabot rebase` and does **not** re-verify authorship server-side — intentional (harmless body, UI-gated, loopback single-user tool). Do not add a server-side author check.
- **Sticky `requested`:** local row state by design — the row does not refetch after a rebase request (only after a successful merge), so the confirmation persists and prevents duplicate comments.
- **Gitea:** no `comment` implementation; the endpoint 400s and the UI never offers the button (no Gitea author is "dependabot"). Do not add Gitea support.
- **`bun run test -- pr-row`** filters vitest to the new file; the full UI suite runs in Task 7.
