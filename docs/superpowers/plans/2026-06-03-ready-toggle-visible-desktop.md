# Ready Toggle Visible On Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-session Ready (ready-to-merge) toggle visible in the desktop primary header row, restoring the mobile/unfolded parity that #188's git-rail disclosure removed.

**Architecture:** Add a `showReady` prop to `GitRail` so a parent can suppress the rail's own Ready toggle. In `Viewport`, render the Ready toggle directly in the always-visible desktop primary header row (gated by a derived that mirrors GitRail's exact condition, using the already-populated `git` prop), and pass `showReady={compact}` to the disclosure `GitRail` so the toggle is never double-rendered on desktop.

**Tech Stack:** SvelteKit, Svelte 5 (runes), TypeScript, Paraglide JS i18n, Tailwind/scoped CSS. Package manager `bun`. Checks: `bun run check`, eslint, `bun run check:i18n` (all run from `ui/`).

---

## Context for the engineer

- Two-package repo. All work here is in `ui/`. A fresh worktree has **no** `node_modules` — run `cd ui && bun install` first.
- The Ready toggle currently lives only inside `GitRail.svelte` (`GitRail.svelte:323`), gated by:
  ```svelte
  {#if (git.state === "open" || ready) && status !== "running" && status !== "blocked"}
  ```
- `Viewport.svelte` mounts `GitRail` only when `{#if compact || gitOpen}` (`Viewport.svelte:1112`).
  - `compact = mobile || touch` (`Viewport.svelte:142`) → true on phone + unfolded fold.
  - `gitOpen` is the desktop "Git actions" disclosure, default `false` (`Viewport.svelte:95`).
  - So on desktop the rail (and Ready) is hidden until disclosure opens — the bug.
- `Viewport` already receives `git` as a prop (`Viewport.svelte:56,83`), fed from `store.git[id]` at both call sites (`src/routes/+page.svelte:571,624`). So `git?.state` is reliable on desktop.
- `session.readyToMerge` is the flag; `setReadyToMerge(id, ready)` (`src/lib/api.ts:260`) is the action — already used by GitRail.
- Messages already exist in **both** `messages/en.json` and `messages/de.json` (lines 104-107): `gitrail_ready`, `gitrail_ready_on_title`, `gitrail_ready_off_title`, `gitrail_ready_aria`. **No new keys needed.**

### Testing note (read before Task 1)

This repo has **no component-mount tests** for `Viewport`/`GitRail` — `Viewport` imports `@xterm/xterm`, which does not mount cleanly under the vitest/jsdom setup, and the existing component tests (`pr-badge.test.ts`, `critic-badge.test.ts`, …) cover **pure helpers only**. The Ready-visibility change is a 4-condition boolean `$derived` plus markup; extracting a module solely to unit-test inline boolean logic would be over-engineering against the established pattern.

Therefore verification for this plan is: **type-check (`bun run check`) + eslint + i18n parity gate + a manual visual check in the running app.** Each implementation step still ends in a commit. If during execution you find a clean, established way to assert visibility without mounting xterm, add it — but do not introduce a new test harness just for this.

---

## File Structure

- **Modify** `ui/src/lib/components/GitRail.svelte` — add `showReady` prop; gate the existing Ready `{#if}` on it. (No new responsibility; just makes the rail's Ready toggle suppressible.)
- **Modify** `ui/src/lib/components/Viewport.svelte` — import `setReadyToMerge`; add `readyVisible` derived; render the desktop primary-row Ready toggle; add `.ready-toggle` styles; pass `showReady={compact}` to the disclosure `GitRail`.

No new files. No new i18n keys.

---

## Task 1: Make GitRail's Ready toggle suppressible

**Files:**
- Modify: `ui/src/lib/components/GitRail.svelte` (props block ~9-25; Ready `{#if}` line 323)

- [ ] **Step 1: Add the `showReady` prop**

In the destructured props (currently lines 9-25), add `showReady` with a default of `true` and its type. The block becomes:

```svelte
  let {
    sessionId,
    repoPath = "",
    name = "",
    prompt = "",
    mobile = false,
    ready = false,
    status = "idle",
    showReady = true,
  }: {
    sessionId: string;
    repoPath?: string;
    name?: string;
    prompt?: string;
    mobile?: boolean;
    ready?: boolean;
    status?: SessionStatus;
    showReady?: boolean;
  } = $props();
```

- [ ] **Step 2: Gate the Ready toggle on `showReady`**

Change the Ready toggle condition (line 323) from:

```svelte
      {#if (git.state === "open" || ready) && status !== "running" && status !== "blocked"}
```

to:

```svelte
      {#if showReady && (git.state === "open" || ready) && status !== "running" && status !== "blocked"}
```

- [ ] **Step 3: Type-check**

Run: `cd ui && bun run check`
Expected: PASS (0 errors). `showReady` defaults `true`, so every existing `<GitRail>` usage is unchanged behaviourally.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/GitRail.svelte
git commit -m "feat(gitrail): add showReady prop to suppress rail's ready toggle"
```

---

## Task 2: Render the Ready toggle in Viewport's desktop primary row

**Files:**
- Modify: `ui/src/lib/components/Viewport.svelte` (import block 13-19; derived near 236; `{#if !compact}` block 1045-1063; `<GitRail>` at 1114-1122; styles near `.git-toggle` 1483-1523)

- [ ] **Step 1: Import `setReadyToMerge`**

Extend the existing `$lib/api` import (lines 13-19) to include `setReadyToMerge`:

```svelte
  import {
    getSessionUsage,
    uploadImage,
    resumeSession as apiResumeSession,
    renameSession,
    getLeftovers,
    setReadyToMerge,
  } from "$lib/api";
```

- [ ] **Step 2: Add the `readyVisible` derived**

Immediately after the `prReady` derived (line 236), add a desktop-only gate that mirrors GitRail's exact condition. Insert:

```svelte
  // desktop parity for the rail's Ready toggle: #188 moved the git rail behind the
  // "Git actions" disclosure, hiding ready-to-merge on desktop while mobile (always-on
  // rail) still showed it. Surface just this one high-frequency control in the primary
  // row. Gate mirrors GitRail's own ({git open || already ready} & not running/blocked),
  // desktop-only — on compact the rail itself still owns the toggle (see showReady below).
  const readyVisible = $derived(
    !compact &&
      (git?.state === "open" || session.readyToMerge) &&
      session.status !== "running" &&
      session.status !== "blocked",
  );
```

- [ ] **Step 3: Render the toggle in the `{#if !compact}` block**

Inside the existing `{#if !compact}` block, immediately **after** the closing `</button>` of `.git-toggle` (line 1062) and **before** the block's `{/if}` (line 1063), add:

```svelte
      {#if readyVisible}
        <!-- desktop: the ready-to-merge toggle graduates out of the git-actions
             disclosure into the always-visible primary row (mobile shows it in the
             rail unconditionally). Gate + action mirror GitRail's ready toggle. -->
        <button
          class="ready-toggle"
          class:on={session.readyToMerge}
          type="button"
          aria-pressed={session.readyToMerge}
          aria-label={m.gitrail_ready_aria()}
          title={session.readyToMerge ? m.gitrail_ready_on_title() : m.gitrail_ready_off_title()}
          onclick={() => setReadyToMerge(session.id, !session.readyToMerge)}
        >
          {session.readyToMerge ? "✓ " : ""}{m.gitrail_ready()}
        </button>
      {/if}
```

- [ ] **Step 4: Suppress the rail's own Ready toggle on desktop**

In the disclosure `<GitRail>` (lines 1114-1122), add `showReady={compact}` so the rail shows Ready only on compact layouts (where the primary-row toggle is hidden), preventing a double-render when the desktop disclosure is open. The element becomes:

```svelte
      <GitRail
        sessionId={session.id}
        repoPath={session.repoPath}
        name={session.name}
        prompt={session.prompt}
        ready={session.readyToMerge}
        status={session.status}
        showReady={compact}
        mobile
      />
```

- [ ] **Step 5: Add `.ready-toggle` styles**

After the `.git-toggle` style rules (immediately following line 1523, the closing of the `.gt-caret` ruleset), add styling consistent with `.git-toggle`, plus a green "on" state mirroring GitRail's `.ready-on` (marked-ready = done/green):

```svelte
  .ready-toggle {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .ready-toggle:hover {
    color: var(--color-ink);
  }
  .ready-toggle.on {
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 55%, transparent);
  }
```

- [ ] **Step 6: Type-check, lint, i18n**

Run: `cd ui && bun run check && bun run lint && bun run check:i18n`
Expected: all PASS. (No new message keys; `check:i18n` confirms EN/DE parity is intact.)

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/components/Viewport.svelte
git commit -m "feat(viewport): surface ready-to-merge toggle in desktop header row"
```

---

## Task 3: Visual verification in the running app

**Files:** none (verification only)

- [ ] **Step 1: Build/serve and exercise the desktop layout**

Run the UI (project's standard dev/preview path) and, in a **non-touch desktop** viewport, select a session:
- **No PR, not ready:** Ready toggle absent from header (gate false). Correct.
- **Open PR (or `readyToMerge` already true):** Ready toggle visible in the primary header row beside "Git actions".
- **Running / blocked status:** Ready toggle absent. Correct.

- [ ] **Step 2: Confirm no double-render**

With an open PR on desktop, click "Git actions" to open the disclosure. Expected: exactly **one** Ready toggle (the header-row one); the rail shows PR/CI/merge/critic/verdict but **no** Ready toggle.

- [ ] **Step 3: Confirm toggle works + state reflects**

Click the header Ready toggle. Expected: `setReadyToMerge` fires; on the next session refresh the button gains the `✓ ` prefix + green `.on` styling and its `title` switches to `gitrail_ready_on_title`; clicking again clears it. Behaviour matches the mobile rail toggle.

- [ ] **Step 4: Confirm mobile/unfolded unchanged**

In a phone / unfolded-fold (compact) viewport: Ready toggle still appears **in the rail** (via `showReady={compact}` → `true`), and is **not** duplicated in the header (gate `!compact` → false).

- [ ] **Step 5: Mark verification complete**

No commit (no file changes). If any check fails, return to the relevant task — do not claim completion without observing the expected behaviour.

---

## Self-Review

- **Spec coverage:**
  - GitRail `showReady` prop + gate → Task 1. ✓
  - Viewport import `setReadyToMerge` → Task 2 Step 1. ✓
  - `readyVisible` derived mirroring GitRail's gate, desktop-only → Task 2 Step 2. ✓
  - Primary-row Ready toggle with aria/title/action/label → Task 2 Step 3. ✓
  - `showReady={compact}` to suppress double-render → Task 2 Step 4. ✓
  - `.ready-toggle` styling incl. green "on" → Task 2 Step 5. ✓
  - i18n reuse, no new keys, parity gate → Task 2 Step 6. ✓
  - Visual verification of all scenarios from spec → Task 3. ✓
- **Placeholder scan:** none — every code step shows complete code; commands have expected outcomes.
- **Type consistency:** prop name `showReady` consistent (Task 1 ↔ Task 2 Step 4); class `.ready-toggle` / `.ready-toggle.on` consistent (markup Step 3 ↔ styles Step 5); `setReadyToMerge(session.id, !session.readyToMerge)` matches `api.ts:260` signature `(id: string, ready: boolean)`. ✓
