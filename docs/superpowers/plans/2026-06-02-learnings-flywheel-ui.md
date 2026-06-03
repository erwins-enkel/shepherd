# Learnings Flywheel — UI (drawer + approve) Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface proposed house rules in the UI: a Learnings drawer (list across repos, approve-with-edit / dismiss / distill-now), a top-bar pending badge, and live updates via the `learnings:update` WS event. Completes PR1 (backend = Plan A, already on this branch).

**Architecture:** Mirror the existing `reviews.svelte.ts` runes module → a `learnings.svelte.ts` client cache loaded once on mount and refreshed on the `learnings:update` event. A new `LearningsDrawer.svelte` (sibling to `TriageDrawer.svelte`) groups proposed rules by repo. One small server addition: `GET /api/learnings/pending` (all proposed across repos) + `store.listPendingLearnings()`.

**Tech Stack:** SvelteKit, Svelte 5 runes, Tailwind, Paraglide i18n (EN+DE), vitest (`cd ui && bun run test`), checks `cd ui && bun run check` + `bun run check:i18n`. Server: Bun, `bun test ./test`. Spec: `docs/superpowers/specs/2026-06-02-learnings-flywheel-design.md`.

**Conventions (verified):**
- UI mirrors server types manually in `ui/src/lib/types.ts`. WS event union is `WsEvent` there; `store.svelte.ts` `apply(ev)` switches on `ev.event` and delegates review events to the `reviews` module (`ui/src/lib/reviews.svelte.ts`).
- API client `ui/src/lib/api.ts`: `JSON_HEADERS = { "content-type": "application/json" }`, `failed(r, label)` error helper, fetch wrappers return `r.json()`.
- Drawer pattern: `ui/src/lib/components/TriageDrawer.svelte` — `$props()` callbacks, `fly` transition, `.drawer` fixed-right CSS using `var(--color-*)`, `m.*` i18n. Mounted conditionally in `ui/src/routes/+page.svelte` after `</main>` behind a `$state` flag; opened from `TopBar.svelte` via a callback prop.
- Top-bar count badge pattern: the `needsYou` button in `TopBar.svelte`.
- i18n: keys in BOTH `ui/messages/en.json` and `ui/messages/de.json` (snake_case, component-prefixed); `m.key()` / `m.key({param})`; `import { m } from "$lib/paraglide/messages"`. `cd ui && bun run check:i18n` enforces identical non-empty key sets.

---

## File Structure

- **Modify** `src/store.ts` (server) — add `listPendingLearnings()`.
- **Modify** `src/server.ts` (server) — add `GET /api/learnings/pending` branch to `handleLearnings`.
- **Modify** `test/store-learnings.test.ts`, `test/server.test.ts` — cover the above.
- **Modify** `ui/src/lib/types.ts` — add `Learning`, `LearningStatus`; add `learnings:update` to `WsEvent`.
- **Modify** `ui/src/lib/api.ts` — `getPendingLearnings`, `approveLearning`, `dismissLearning`, `distillRepo`.
- **Create** `ui/src/lib/learnings.svelte.ts` — `LearningsStore` (mirror `reviews.svelte.ts`).
- **Modify** `ui/src/lib/store.svelte.ts` — route `learnings:update` to the module.
- **Create** `ui/src/lib/components/LearningsDrawer.svelte` — the drawer.
- **Create** `ui/src/lib/components/LearningsDrawer.test.ts` — component/render test.
- **Modify** `ui/src/lib/components/TopBar.svelte` — pending badge + open callback.
- **Modify** `ui/src/routes/+page.svelte` — mount drawer, load on mount, wire callbacks + badge.
- **Modify** `ui/messages/en.json` + `ui/messages/de.json` — new keys.

---

## Task 1: Server — `listPendingLearnings()` + `GET /api/learnings/pending`

**Files:** `src/store.ts`, `src/server.ts`, `test/store-learnings.test.ts`, `test/server.test.ts`.

- [ ] **Step 1: Failing store test** — append to `test/store-learnings.test.ts`:

```typescript
test("listPendingLearnings returns proposed across all repos, newest first", () => {
  const s = new SessionStore(":memory:");
  s.addLearning({ repoPath: "/a", rule: "a1", rationale: "", evidence: [] });
  const b = s.addLearning({ repoPath: "/b", rule: "b1", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active"); // no longer proposed
  s.addLearning({ repoPath: "/b", rule: "b2", rationale: "", evidence: [] });
  const pending = s.listPendingLearnings();
  expect(pending.map((l) => l.rule).sort()).toEqual(["a1", "b2"]);
  expect(pending.every((l) => l.status === "proposed")).toBe(true);
});
```

- [ ] **Step 2: Run → fail** — `bun test ./test/store-learnings.test.ts` → FAIL (`listPendingLearnings is not a function`).

- [ ] **Step 3: Implement** — in `src/store.ts`, after `pendingLearningCount()`:

```typescript
listPendingLearnings(): Learning[] {
  const rows = this.db
    .query(`SELECT * FROM learnings WHERE status = 'proposed' ORDER BY updatedAt DESC`)
    .all();
  return (rows as any[]).map((r) => this.hydrateLearning(r));
}
```

- [ ] **Step 4: Run → pass** — `bun test ./test/store-learnings.test.ts` → PASS.

- [ ] **Step 5: Failing server test** — append to `test/server.test.ts` (reuse the same harness helpers the other learnings tests use — `makeDeps`/`makeApp`/`harness`, auth + allowed `Origin`):

```typescript
test("GET /api/learnings/pending lists proposed across repos", async () => {
  const store = new SessionStore(":memory:");
  store.addLearning({ repoPath: "/x", rule: "p1", rationale: "", evidence: [] });
  const app = makeApp(makeDeps({ store })); // adapt to real harness signature
  const res = await app(new Request("http://x/api/learnings/pending", { headers: authHeaders() }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rule: string }[];
  expect(body.length).toBe(1);
  expect(body[0]!.rule).toBe("p1");
});
```

> Implementer: adapt the request plumbing to the file's actual harness (as the existing learnings tests do); keep the assertions.

- [ ] **Step 6: Run → fail** — `bun test ./test/server.test.ts` → FAIL (404).

- [ ] **Step 7: Implement route** — in `src/server.ts` `handleLearnings`, add this branch BEFORE the existing `GET && !parts[2]` list branch:

```typescript
// GET /api/learnings/pending — all proposed rules across repos (drawer + badge)
if (req.method === "GET" && parts[2] === "pending") {
  return json(deps.store.listPendingLearnings());
}
```

- [ ] **Step 8: Run → pass + suite** — `bun test ./test/server.test.ts && bun test ./test && bunx tsc --noEmit && bun run lint` → all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/store.ts src/server.ts test/store-learnings.test.ts test/server.test.ts
git commit -m "feat(learnings): list pending learnings across repos + GET pending route"
```

---

## Task 2: UI types + API client

**Files:** `ui/src/lib/types.ts`, `ui/src/lib/api.ts`.

- [ ] **Step 1: Add types** — append to `ui/src/lib/types.ts` (mirror the server `Learning`):

```typescript
export type LearningStatus = "proposed" | "active" | "promoted" | "dismissed";
export interface Learning {
  id: string;
  repoPath: string;
  rule: string;
  rationale: string;
  evidence: string[];
  status: LearningStatus;
  evidenceCount: number;
  ineffectiveCount: number;
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
}
```

- [ ] **Step 2: Add `learnings:update` to `WsEvent`** — in the `WsEvent` union in `ui/src/lib/types.ts`, add a member (before the closing `;`):

```typescript
  | { event: "learnings:update"; data: { pending: number } }
```

- [ ] **Step 3: Add API functions** — in `ui/src/lib/api.ts`, add `Learning` to the type import from `./types`, then add:

```typescript
export async function getPendingLearnings(): Promise<Learning[]> {
  const r = await fetch("/api/learnings/pending");
  if (!r.ok) throw await failed(r, "learnings");
  return r.json();
}

export async function approveLearning(id: string, rule?: string): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/approve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(rule !== undefined ? { rule } : {}),
  });
  if (!r.ok) throw await failed(r, "approve");
  return r.json();
}

export async function dismissLearning(id: string): Promise<Learning> {
  const r = await fetch(`/api/learnings/${id}/dismiss`, { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) throw await failed(r, "dismiss");
  return r.json();
}

export async function distillRepo(repoPath: string): Promise<void> {
  const r = await fetch(`/api/learnings/distill?repo=${encodeURIComponent(repoPath)}`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await failed(r, "distill");
}
```

- [ ] **Step 4: Typecheck** — `cd ui && bun run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts
git commit -m "feat(learnings): ui types + api client for learnings"
```

---

## Task 3: `learnings.svelte.ts` store module + route the event

**Files:** Create `ui/src/lib/learnings.svelte.ts`; modify `ui/src/lib/store.svelte.ts`; test `ui/src/lib/learnings.svelte.test.ts`.

- [ ] **Step 1: Failing test** — create `ui/src/lib/learnings.svelte.test.ts`:

```typescript
import { test, expect } from "vitest";
import { learnings } from "./learnings.svelte";
import type { Learning } from "./types";

function L(id: string): Learning {
  return {
    id, repoPath: "/r", rule: "r", rationale: "", evidence: [], status: "proposed",
    evidenceCount: 0, ineffectiveCount: 0, createdAt: 0, updatedAt: 0, lastEvidenceAt: null,
  };
}

test("set populates items and pending reflects count", () => {
  learnings.set([L("1"), L("2")]);
  expect(learnings.items.length).toBe(2);
  expect(learnings.pending).toBe(2);
  learnings.set([]);
  expect(learnings.pending).toBe(0);
});
```

- [ ] **Step 2: Run → fail** — `cd ui && bun run test learnings` → FAIL (module missing).

- [ ] **Step 3: Implement module** — create `ui/src/lib/learnings.svelte.ts` (mirror `reviews.svelte.ts`):

```typescript
import type { Learning } from "./types";
import { getPendingLearnings } from "./api";

/** Client cache of PROPOSED learnings across all repos. Loaded once on app start;
 *  live updates arrive via the `learnings:update` WS event (see store.svelte.ts),
 *  which triggers a reload. */
class LearningsStore {
  items = $state<Learning[]>([]);

  async load() {
    try {
      this.items = await getPendingLearnings();
    } catch {
      /* best-effort; live events still trigger reloads */
    }
  }

  /** A learnings:update event just signals "something changed" — reload the list. */
  apply(_d: { pending: number }) {
    void this.load();
  }

  set(items: Learning[]) {
    this.items = items;
  }

  get pending(): number {
    return this.items.length;
  }
}
export const learnings = new LearningsStore();
```

- [ ] **Step 4: Route the event** — in `ui/src/lib/store.svelte.ts`: add `import { learnings } from "./learnings.svelte";` near the `reviews` import, and add a case in `apply()` next to the review cases:

```typescript
      case "learnings:update":
        learnings.apply(ev.data);
        break;
```

- [ ] **Step 5: Run → pass + check** — `cd ui && bun run test learnings && bun run check` → PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/learnings.svelte.ts ui/src/lib/learnings.svelte.test.ts ui/src/lib/store.svelte.ts
git commit -m "feat(learnings): client learnings store + ws routing"
```

---

## Task 4: i18n keys

**Files:** `ui/messages/en.json`, `ui/messages/de.json`.

- [ ] **Step 1: Add EN keys** — add to `ui/messages/en.json` (anywhere; keep valid JSON):

```json
"learnings_title": "Learnings",
"learnings_open_aria": "Open learnings ({count} proposed)",
"learnings_close_aria": "Close",
"learnings_empty": "No proposed rules yet. The distiller surfaces recurring patterns from agent activity.",
"learnings_rationale_label": "Why",
"learnings_evidence": "{count} signals",
"learnings_rule_aria": "Edit proposed rule",
"learnings_approve": "Approve",
"learnings_dismiss": "Dismiss",
"learnings_distill": "Distill now",
"learnings_distill_aria": "Run the distiller now for {repo}",
"learnings_distill_started": "Distiller started for {repo}"
```

- [ ] **Step 2: Add DE keys** — add the SAME keys to `ui/messages/de.json`:

```json
"learnings_title": "Erkenntnisse",
"learnings_open_aria": "Erkenntnisse öffnen ({count} vorgeschlagen)",
"learnings_close_aria": "Schließen",
"learnings_empty": "Noch keine vorgeschlagenen Regeln. Der Destillierer erkennt wiederkehrende Muster aus der Agentenaktivität.",
"learnings_rationale_label": "Warum",
"learnings_evidence": "{count} Signale",
"learnings_rule_aria": "Vorgeschlagene Regel bearbeiten",
"learnings_approve": "Übernehmen",
"learnings_dismiss": "Verwerfen",
"learnings_distill": "Jetzt destillieren",
"learnings_distill_aria": "Destillierer jetzt für {repo} ausführen",
"learnings_distill_started": "Destillierer für {repo} gestartet"
```

- [ ] **Step 3: Verify parity + compile** — `cd ui && bun run check:i18n && bun run check` → PASS (identical key sets; paraglide compiles `m.learnings_*`).

- [ ] **Step 4: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json
git commit -m "feat(learnings): i18n keys for learnings drawer (EN+DE)"
```

---

## Task 5: `LearningsDrawer.svelte` (+ extracted logic)

**Files:** Create `ui/src/lib/components/learnings-drawer.ts` (pure logic) + `ui/src/lib/components/learnings-drawer.test.ts`; create `ui/src/lib/components/LearningsDrawer.svelte`.

> **Convention:** this repo does NOT render `.svelte` in tests (no `@testing-library`). Component tests target pure logic extracted into a sibling `.ts` (see `critic-badge.ts`/`critic-badge.test.ts`, `pr-badge.ts`/`pr-badge.test.ts`). So extract grouping into `learnings-drawer.ts`, unit-test that, and import it in the component.

- [ ] **Step 1: Failing logic test** — create `ui/src/lib/components/learnings-drawer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { basename, groupByRepo } from "./learnings-drawer";
import type { Learning } from "../types";

function L(id: string, repo: string): Learning {
  return {
    id, repoPath: repo, rule: "r", rationale: "", evidence: [], status: "proposed",
    evidenceCount: 0, ineffectiveCount: 0, createdAt: 0, updatedAt: 0, lastEvidenceAt: null,
  };
}

describe("basename", () => {
  it("takes the last path segment", () => expect(basename("/home/u/acme")).toBe("acme"));
  it("tolerates trailing slash", () => expect(basename("/home/u/acme/")).toBe("acme"));
});

describe("groupByRepo", () => {
  it("groups by repoPath preserving first-seen order", () => {
    const g = groupByRepo([L("1", "/a"), L("2", "/b"), L("3", "/a")]);
    expect(g.map(([repo]) => repo)).toEqual(["/a", "/b"]);
    expect(g[0]![1].map((l) => l.id)).toEqual(["1", "3"]);
  });
  it("returns [] for no items", () => expect(groupByRepo([])).toEqual([]));
});
```

- [ ] **Step 2: Run → fail** — `cd ui && bun run test learnings-drawer` → FAIL (module missing).

- [ ] **Step 3a: Implement the logic module** — create `ui/src/lib/components/learnings-drawer.ts`:

```typescript
import type { Learning } from "../types";

/** Last non-empty path segment (repo display name). */
export function basename(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
}

/** Group learnings by repoPath, preserving first-seen order. */
export function groupByRepo(items: Learning[]): [string, Learning[]][] {
  const map = new Map<string, Learning[]>();
  for (const l of items) {
    const g = map.get(l.repoPath);
    if (g) g.push(l);
    else map.set(l.repoPath, [l]);
  }
  return [...map.entries()];
}
```

- [ ] **Step 3b: Run → pass** — `cd ui && bun run test learnings-drawer` → PASS.

- [ ] **Step 3c: Implement the component** — create `ui/src/lib/components/LearningsDrawer.svelte`:

```svelte
<script lang="ts">
  import { fly } from "svelte/transition";
  import { m } from "$lib/paraglide/messages";
  import type { Learning } from "$lib/types";
  import { basename, groupByRepo } from "./learnings-drawer";

  let {
    items,
    onapprove,
    ondismiss,
    ondistill,
    onclose,
  }: {
    items: Learning[];
    onapprove: (id: string, rule: string) => void;
    ondismiss: (id: string) => void;
    ondistill: (repoPath: string) => void;
    onclose: () => void;
  } = $props();

  // Working copies of the editable rule text, keyed by learning id.
  let drafts = $state<Record<string, string>>({});
  const draft = (l: Learning) => drafts[l.id] ?? l.rule;

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const slide = { x: 440, duration: reduceMotion ? 0 : 220, opacity: 1 };

  const groups = $derived(groupByRepo(items));
</script>

<aside class="drawer" transition:fly={slide} aria-label={m.learnings_title()}>
  <header class="bar">
    <span class="title">{m.learnings_title()}</span>
    <button class="close" onclick={() => onclose()} aria-label={m.learnings_close_aria()}>✕</button>
  </header>

  {#if items.length === 0}
    <p class="empty">{m.learnings_empty()}</p>
  {:else}
    {#each groups as [repoPath, rules] (repoPath)}
      <section class="group">
        <div class="ghead">
          <span class="repo">{basename(repoPath)}</span>
          <button
            class="distill"
            onclick={() => ondistill(repoPath)}
            aria-label={m.learnings_distill_aria({ repo: basename(repoPath) })}
          >
            {m.learnings_distill()}
          </button>
        </div>
        {#each rules as l (l.id)}
          <article class="rule">
            <textarea
              class="text"
              rows="2"
              bind:value={
                () => draft(l), (v) => (drafts = { ...drafts, [l.id]: v })
              }
              aria-label={m.learnings_rule_aria()}
            ></textarea>
            {#if l.rationale}
              <p class="why"><span>{m.learnings_rationale_label()}:</span> {l.rationale}</p>
            {/if}
            <div class="foot">
              <span class="evi">{m.learnings_evidence({ count: l.evidenceCount })}</span>
              <span class="spacer"></span>
              <button class="dismiss" onclick={() => ondismiss(l.id)}>{m.learnings_dismiss()}</button>
              <button class="approve" onclick={() => onapprove(l.id, draft(l))}>
                {m.learnings_approve()}
              </button>
            </div>
          </article>
        {/each}
      </section>
    {/each}
  {/if}
</aside>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(440px, 100vw);
    height: 100dvh;
    background: var(--color-panel);
    border-left: 1px solid var(--color-line-bright);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    overflow-y: auto;
    z-index: 50;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    letter-spacing: 0.14em;
    font-size: 12px;
    text-transform: uppercase;
    color: var(--color-text-dim);
  }
  .close {
    background: none;
    border: none;
    color: var(--color-text-dim);
    cursor: pointer;
    font-size: 14px;
  }
  .empty {
    color: var(--color-text-dim);
    font-size: 13px;
    line-height: 1.5;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ghead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-line);
    padding-bottom: 4px;
  }
  .repo {
    font-size: 12px;
    color: var(--color-text);
    font-weight: 600;
  }
  .distill {
    font-size: 11px;
    background: none;
    border: 1px solid var(--color-line-bright);
    color: var(--color-text-dim);
    padding: 3px 8px;
    cursor: pointer;
  }
  .rule {
    border: 1px solid var(--color-line);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .text {
    width: 100%;
    resize: vertical;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-line);
    padding: 6px;
    font: inherit;
    font-size: 13px;
  }
  .why {
    font-size: 12px;
    color: var(--color-text-dim);
    line-height: 1.4;
  }
  .why span {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 10px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .evi {
    font-size: 11px;
    color: var(--color-text-dim);
  }
  .spacer {
    flex: 1;
  }
  .dismiss,
  .approve {
    font-size: 12px;
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-text-dim);
  }
  .approve {
    border-color: var(--color-green, #4 caf50);
    color: var(--color-green, #4caf50);
  }
</style>
```

> Implementer notes: (a) The `bind:value={() => get, (v) => set}` form is the Svelte 5 **function-binding** syntax — if this project's Svelte version predates it, fall back to `value={draft(l)} oninput={(e) => (drafts = { ...drafts, [l.id]: e.currentTarget.value })}`. Verify against the Svelte version in `ui/package.json` and use whichever compiles. (b) Fix the typo'd `--color-green, #4 caf50` → `#4caf50`; if a `--color-green` token already exists in the theme, drop the fallback. (c) Match whatever `--color-*` tokens actually exist (check `TriageDrawer.svelte` / app CSS); substitute the nearest existing token if one of these names is absent.

- [ ] **Step 4: Run → pass + check** — `cd ui && bun run test learnings-drawer && bun run check` → PASS (logic test passes; `bun run check` compiles the component + its `m.learnings_*` messages).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/LearningsDrawer.svelte ui/src/lib/components/learnings-drawer.ts ui/src/lib/components/learnings-drawer.test.ts
git commit -m "feat(learnings): learnings drawer component"
```

---

## Task 6: TopBar badge + wire into `+page.svelte`

**Files:** `ui/src/lib/components/TopBar.svelte`, `ui/src/routes/+page.svelte`.

- [ ] **Step 1: TopBar — add prop + badge** — in `TopBar.svelte`, add to the `$props()` destructure + type:

```typescript
    learnings = 0,
    onlearnings,
```
```typescript
    learnings?: number;
    onlearnings?: () => void;
```

Then render a badge button near the `needsYou` button (same structure/classes; reuse a neutral style):

```svelte
{#if learnings > 0}
  <button
    class="learnings-badge"
    onclick={() => onlearnings?.()}
    aria-label={m.learnings_open_aria({ count: learnings })}
  >
    {m.learnings_title()} {learnings}
  </button>
{/if}
```

Add minimal CSS mirroring `.needsyou` but neutral-colored (use `var(--color-line-bright)` border / `var(--color-text-dim)` text):

```css
  .learnings-badge {
    background: none;
    border: 1px solid var(--color-line-bright);
    color: var(--color-text-dim);
    letter-spacing: 0.12em;
    font-size: 11px;
    padding: 5px 10px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
```

- [ ] **Step 2: +page — imports + state** — in `ui/src/routes/+page.svelte` `<script>`:
  - add to the `$lib/api` import: `getPendingLearnings, approveLearning, dismissLearning, distillRepo`
  - add: `import { learnings } from "$lib/learnings.svelte";`
  - add: `import LearningsDrawer from "$lib/components/LearningsDrawer.svelte";`
  - add state near the other drawer flags: `let showLearnings = $state(false);`

- [ ] **Step 3: +page — load on mount** — in the existing `onMount(() => { ... })`, next to `reviews.load();`, add:

```typescript
    learnings.load();
```

- [ ] **Step 4: +page — pass to TopBar** — on the `<TopBar ... />` usage, add:

```svelte
        learnings={learnings.items.length}
        onlearnings={() => (showLearnings = true)}
```

- [ ] **Step 5: +page — mount drawer** — after `</main>`, near the `{#if showTriage}...{/if}` block, add:

```svelte
{#if showLearnings}
  <LearningsDrawer
    items={learnings.items}
    onapprove={(id, rule) =>
      approveLearning(id, rule)
        .then(() => learnings.load())
        .catch(() => {})}
    ondismiss={(id) =>
      dismissLearning(id)
        .then(() => learnings.load())
        .catch(() => {})}
    ondistill={(repoPath) => distillRepo(repoPath).catch(() => {})}
    onclose={() => (showLearnings = false)}
  />
{/if}
```

- [ ] **Step 6: Auto-close when empty (optional parity with triage)** — near the triage auto-close `$effect`, add:

```typescript
  $effect(() => {
    if (showLearnings && learnings.items.length === 0) showLearnings = false;
  });
```

- [ ] **Step 7: Verify** — `cd ui && bun run check && bun run test && bun run check:i18n` → all PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/components/TopBar.svelte ui/src/routes/+page.svelte
git commit -m "feat(learnings): top-bar badge + mount learnings drawer"
```

---

## Task 7: Full verification (server + UI)

- [ ] **Step 1: UI gates** — `cd ui && bun run check && bun run check:i18n && bun run test` → all PASS.
- [ ] **Step 2: Server gates** — from repo root: `bunx tsc --noEmit && bun test ./test && bun run lint` → all PASS.
- [ ] **Step 3: Manual smoke (optional)** — start the app, confirm: with a proposed learning in the DB, the top bar shows a "Learnings N" badge; clicking opens the drawer grouped by repo; Approve removes it (badge decrements); Dismiss removes it; "Distill now" returns without error.
- [ ] **Step 4: Final commit (any formatting churn)** — `git add -A && git commit -m "chore(learnings): ui verification pass" || echo "clean"`

---

## Self-Review

**Spec coverage (UI slice):** drawer lists proposed rules (Task 5) ✓; approve-with-edit + dismiss (Tasks 5,6) ✓; distill-now per repo (Tasks 2,5,6) ✓; pending badge (Task 6) ✓; live `learnings:update` refresh (Tasks 2,3) ✓; i18n EN+DE (Task 4) ✓; `GET /api/learnings/pending` + `listPendingLearnings` (Task 1) ✓. Deferred to PR2: prompt injection, promote-to-CLAUDE.md, per-repo toggle, self-audit/ineffective flag (not in this plan).

**Type consistency:** `Learning`/`LearningStatus` mirror the server (Task 2) and are used in api (2), learnings module (3), drawer (5). `getPendingLearnings`/`approveLearning`/`dismissLearning`/`distillRepo` names consistent across api (2), module (3), page (6). Event `learnings:update` consistent: server emit (Plan A Task 8/9), `WsEvent` (Task 2), store route (Task 3).

**Placeholder scan:** Implementer notes in Tasks 1, 5 defer harness/Svelte-version specifics to the real files (assertions/behavior are concrete) — deliberate, not placeholders. The `#4caf50` typo in the drawer CSS is explicitly called out to fix in Task 5 note (b). Component testing follows the repo convention (extract pure logic to a sibling `.ts`, no `.svelte` rendering / no `@testing-library`).
