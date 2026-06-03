# Shepherd v5 — Responsive / Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Every `.svelte`/`.svelte.ts` edit MUST go through the `svelte-code-writer` skill (Svelte 5 runes).**

**Goal:** Make the Shepherd HUD fully usable on phones via a mobile drill-down layout (Herd list → full-screen unit detail → back), without regressing the desktop 2-column grid.

**Architecture:** `+page.svelte` becomes a reactive layout controller. A `MediaQuery('max-width: 768px')` (`svelte/reactivity`) drives an `isMobile` flag; a `mobileScreen: 'list' | 'detail'` state picks which single column renders on mobile. Above 768px the existing 2-col grid is untouched. All other changes are scoped, media-query-gated CSS + small prop additions per component. Pure UI — no backend/API/data-flow changes.

**Tech Stack:** SvelteKit 5 (runes), Tailwind 4 (`@theme` in `app.css`), xterm.js + FitAddon, vitest (logic only), `agent-browser` (visual acceptance).

**Spec:** `docs/superpowers/specs/2026-05-30-shepherd-v5-responsive-design.md`

## Verification model (read before starting)

This repo's tests (`ui/test/*.test.ts`) cover **logic modules only** (store, api, format) — there is no jsdom/component-testing infra, and we will not add one for layout work. Responsive layout is verified the way the handoff mandates:

- **Per task:** `cd ui && bunx prettier --write <changed .svelte files>` (`.svelte` is NOT in lint-staged globs), then `cd ui && bun run check` (svelte-check — catches rune/type errors) must be green.
- **Visual tasks:** `bun run build` green, then an `agent-browser` screenshot at the relevant viewport, **actually viewed**, before commit.
- **Final acceptance (Task 10):** `agent-browser` at **390×844**, **768**, **~1280** against a running instance with a real (bash-backed) session.

Commit after each task (husky/lint-staged runs prettier+eslint on staged JS/TS; `.svelte` already prettier-formatted by the manual step above).

The exact `svelte/reactivity` `MediaQuery` API (constructor arg without surrounding parens; `.current` reactive getter) must be confirmed via the `svelte-code-writer` skill / Context7 before use in Task 2.

---

### Task 1: Touch base styles in `app.css`

**Files:**

- Modify: `ui/src/app.css`

- [ ] **Step 1: Add touch niceties to the global stylesheet**

Append to `ui/src/app.css` (after the `@media (prefers-reduced-motion)` block):

```css
/* touch ergonomics (mobile) */
* {
  -webkit-tap-highlight-color: transparent;
}

button {
  touch-action: manipulation;
}
```

- [ ] **Step 2: Verify build is green**

Run: `cd ui && bun run check && bun run build`
Expected: PASS, no new warnings.

- [ ] **Step 3: Commit**

```bash
git add ui/src/app.css
git commit -m "feat(ui): touch base styles (tap-highlight, touch-action)"
```

---

### Task 2: `+page.svelte` — responsive nav controller

**Files:**

- Modify: `ui/src/routes/+page.svelte`

The single source of layout truth. Adds `isMobile` (reactive media query), `mobileScreen` state, conditional rendering (desktop grid unchanged; mobile renders Herd OR Viewport), responsive shell, and back-navigation wiring.

- [ ] **Step 1: Add nav state and select/back handlers (script block)**

In the `<script lang="ts">` of `ui/src/routes/+page.svelte`, add the import and state. Confirm the `MediaQuery` import path/usage with `svelte-code-writer` first.

```ts
import { MediaQuery } from "svelte/reactivity";
```

After the existing `const selected = $derived(...)` line, add:

```ts
const mobile = new MediaQuery("max-width: 768px");
let mobileScreen = $state<"list" | "detail">("list");

function selectUnit(id: string) {
  selectedId = id;
  if (mobile.current) mobileScreen = "detail";
}

// if the selected unit disappears while in mobile detail, fall back to the list
$effect(() => {
  if (mobile.current && mobileScreen === "detail" && !selected) {
    mobileScreen = "list";
  }
});
```

- [ ] **Step 2: Replace the markup with responsive layout**

Replace the `<div class="shell">…</div>` block (lines ~44–62) with:

```svelte
<div class="shell" class:mobile={mobile.current}>
  <TopBar sessions={store.sessions} {nowMs} connected={store.connected} {mobile} />

  {#if mobile.current}
    {#if mobileScreen === "list"}
      <div class="col">
        <Herd
          sessions={store.sessions}
          {selectedId}
          {nowMs}
          onselect={(id) => selectUnit(id)}
        />
      </div>
      <ActionBar onnew={() => (showNew = true)} {mobile} />
    {:else if selected}
      <div class="col">
        <Viewport
          session={selected}
          {mobile}
          onback={() => (mobileScreen = "list")}
          onnewtask={(repoPath, prompt) => {
            composeRepoPath = repoPath;
            composePrompt = prompt;
            showNew = true;
          }}
        />
      </div>
    {/if}
  {:else}
    <div class="grid">
      <Herd
        sessions={store.sessions}
        {selectedId}
        {nowMs}
        onselect={(id) => selectUnit(id)}
      />
      {#if selected}
        <Viewport
          session={selected}
          onnewtask={(repoPath, prompt) => {
            composeRepoPath = repoPath;
            composePrompt = prompt;
            showNew = true;
          }}
        />
      {:else}
        <div class="empty">NO UNIT SELECTED</div>
      {/if}
    </div>
  {/if}

  <ActionBar onnew={() => (showNew = true)} {mobile} desktopOnly />
</div>
```

> Note: the desktop `ActionBar` is the last child (as today) but gated `desktopOnly` so it does not double-render on mobile (mobile renders its own ActionBar inside the list branch). Implement `desktopOnly`/`mobile` props in Task 5; until then ActionBar ignores unknown props harmlessly, but do Task 5 before visual check.

- [ ] **Step 3: Add responsive shell styles**

In the `<style>` block, keep `.shell`/`.grid`/`.empty` and add:

```css
.col {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.shell.mobile {
  max-width: none;
  padding: 10px;
  height: 100dvh;
  gap: 10px;
}
```

- [ ] **Step 4: Prettier + svelte-check**

Run: `cd ui && bunx prettier --write src/routes/+page.svelte && bun run check`
Expected: PASS. (Visual verification deferred to Task 5/Task 10 once ActionBar/Viewport props land.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/routes/+page.svelte
git commit -m "feat(ui): responsive nav controller (mobile drill-down)"
```

---

### Task 3: `Viewport.svelte` — mobile detail header + terminal

**Files:**

- Modify: `ui/src/lib/components/Viewport.svelte`

Adds `onback` + `mobile` props. On mobile: header collapses to back-button + desig + status + tab row (branch/model/elapsed hidden); terminal font 13px; tap-to-focus; refit when shown.

- [ ] **Step 1: Add props**

In `$props()` destructure, add `onback` and `mobile`:

```ts
let {
  session,
  nowMs = Date.now(),
  onnewtask,
  onback,
  mobile = false,
}: {
  session: Session;
  nowMs?: number;
  onnewtask?: (repoPath: string, prompt: string) => void;
  onback?: () => void;
  mobile?: boolean;
} = $props();
```

- [ ] **Step 2: Terminal font + tap-to-focus + refit**

In the `$effect`, make `fontSize` depend on `mobile` and focus on tap. Read `mobile` once before constructing (it is a prop; the effect re-runs if `mobile` changes, which re-creates the terminal — acceptable). Change the `Terminal({...})` `fontSize: 12.5` to:

```ts
      fontSize: mobile ? 13 : 12.5,
```

After `fit.fit();` add a focus-on-tap handler and an initial deferred refit (covers display:none→visible transitions):

```ts
const onTap = () => term.focus();
el.addEventListener("click", onTap);

// refit after layout settles (mount may start hidden on mobile nav)
requestAnimationFrame(() => {
  fit.fit();
  conn.resize(term.cols, term.rows);
});
```

In the cleanup return, add `el?.removeEventListener("click", onTap);` before `ro.disconnect();`.

- [ ] **Step 3: Back button + conditional header fields (markup)**

Replace the `<div class="vp-head">…</div>` block with one that renders a back button when `onback` is set and hides branch/model/elapsed on mobile:

```svelte
  <div class="vp-head" class:mobile>
    {#if onback}
      <button class="back" type="button" onclick={onback} aria-label="Back to herd">‹ Herd</button>
    {/if}
    <span class="desig">{session.desig}</span>
    {#if !mobile}
      <span class="sep">·</span>
      <span class="branch">{session.branch ?? session.worktreePath}</span>
      <span class="sep">·</span>
      <span class="model">{modelHint}</span>
    {/if}
    <div class="spacer"></div>
    <span
      class="status-badge"
      style="color:{STATUS_COLOR[session.status]};border-color:{STATUS_COLOR[session.status]}"
    >
      {#if session.status === "running"}⠿{/if}
      {statusLabel(session.status)}
    </span>
    {#if session.status === "running" && !mobile}
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    {/if}
    <div class="tab-group" class:mobile>
      <button class="tab-btn" class:active={tab === "term"} onclick={() => (tab = "term")}>Terminal</button>
      <button class="tab-btn" class:active={tab === "todo"} onclick={() => (tab = "todo")}>To-Do</button>
      <button class="tab-btn" class:active={tab === "issues"} onclick={() => (tab = "issues")}>Issues</button>
    </div>
  </div>
```

> On mobile the `.vp-head` wraps; the `.tab-group` drops to a full second row (CSS below). On desktop layout is unchanged (tab-group sits between spacer and status as before — verify desktop visually in Task 10).

- [ ] **Step 4: Header CSS — back button + mobile wrap**

In `<style>`, add:

```css
.back {
  background: transparent;
  border: 1px solid var(--color-line-bright);
  border-radius: 2px;
  color: var(--color-ink);
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.08em;
  padding: 4px 9px;
  cursor: pointer;
  flex-shrink: 0;
}
.back:hover {
  background: #0c1110;
}

.vp-head.mobile {
  flex-wrap: wrap;
  row-gap: 6px;
  padding: 8px 10px;
}
.tab-group.mobile {
  flex-basis: 100%;
  gap: 4px;
}
.vp-head.mobile .tab-btn {
  flex: 1;
  text-align: center;
  padding: 8px 6px;
  font-size: 11px;
}
```

- [ ] **Step 5: Prettier + svelte-check**

Run: `cd ui && bunx prettier --write src/lib/components/Viewport.svelte && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/Viewport.svelte
git commit -m "feat(ui): mobile viewport header (back nav, collapsed meta, tap-to-focus)"
```

---

### Task 4: `TopBar.svelte` — compact on mobile

**Files:**

- Modify: `ui/src/lib/components/TopBar.svelte`

- [ ] **Step 1: Add `mobile` prop**

In `$props()`:

```ts
let {
  sessions,
  nowMs,
  connected = false,
  mobile = false,
}: {
  sessions: Session[];
  nowMs: number;
  connected?: boolean;
  mobile?: boolean;
} = $props();
```

- [ ] **Step 2: Gate the "Mission Control" label + its separators on mobile**

Wrap the "Mission Control" micro label and its flanking `.sep` in `{#if !mobile}`:

```svelte
<div class="hud bracket" class:mobile>
  <div class="logo">SHEP<b>HERD</b></div>
  {#if !mobile}
    <div class="sep"></div>
    <div class="micro">Mission&nbsp;Control</div>
  {/if}
  <div class="sep"></div>
  <div class="tallies">
    <div class="tally"><span class="micro">Herd</span><span class="n">{sessions.length}</span></div>
    <div class="tally">
      <span class="micro" style="color:var(--color-amber)">Working</span><span class="n">{working}</span>
    </div>
    <div class="tally"><span class="micro">Idle</span><span class="n">{idle}</span></div>
    <div class="tally">
      <span class="micro" style="color:var(--color-red)">Blocked</span><span class="n">{blocked}</span>
    </div>
  </div>
  <div class="clock">
    <span class="dot" class:on={connected}>●</span><span>{clock}</span>
  </div>
</div>
```

- [ ] **Step 3: Compact CSS for mobile**

In `<style>`, add:

```css
.hud.mobile {
  gap: 12px;
  padding: 10px 12px;
}
.hud.mobile .tallies {
  gap: 12px;
}
.hud.mobile .logo {
  font-size: 13px;
  letter-spacing: 0.22em;
}
```

- [ ] **Step 4: Prettier + svelte-check**

Run: `cd ui && bunx prettier --write src/lib/components/TopBar.svelte && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/TopBar.svelte
git commit -m "feat(ui): compact topbar on mobile"
```

---

### Task 5: `ActionBar.svelte` — mobile + desktopOnly props

**Files:**

- Modify: `ui/src/lib/components/ActionBar.svelte`

On mobile show only a full-width `+ New Task`; hide `All`/`Focus`/hint. `desktopOnly` suppresses the trailing desktop instance when in mobile mode.

- [ ] **Step 1: Props + render-nothing guard**

Replace the `<script>` and add a guard:

```svelte
<script lang="ts">
  let {
    onnew,
    mobile = false,
    desktopOnly = false,
  }: {
    onnew: () => void;
    mobile?: boolean;
    desktopOnly?: boolean;
  } = $props();
</script>

{#if !(desktopOnly && mobile)}
  <div class="actions" class:mobile>
    <button class="btn primary" type="button" onclick={onnew}>+ New Task</button>
    {#if !mobile}
      <button class="btn" type="button">All ▦</button>
      <button class="btn" type="button">Focus ⌖</button>
      <span class="hint">node-pty ⇄ herdr · sub · skip-permissions</span>
    {/if}
  </div>
{/if}
```

- [ ] **Step 2: Mobile CSS (full-width primary)**

In `<style>`, add:

```css
.actions.mobile {
  padding: 10px;
}
.actions.mobile .btn.primary {
  flex: 1;
  text-align: center;
  padding: 12px;
  font-size: 12px;
}
```

- [ ] **Step 3: Prettier + svelte-check + build, then visual smoke**

Run: `cd ui && bunx prettier --write src/lib/components/ActionBar.svelte && bun run check && bun run build`
Expected: PASS. Now do a first mobile screenshot to sanity-check Tasks 2–5 together (instance restart per "Commands" in handoff, then `agent-browser` at 390×844 of the list screen). View it.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/ActionBar.svelte
git commit -m "feat(ui): mobile actionbar (new-task only, full-width)"
```

---

### Task 6: `Herd.svelte` + `UnitRow.svelte` — tap targets

**Files:**

- Modify: `ui/src/lib/components/UnitRow.svelte`
- Modify: `ui/src/lib/components/Herd.svelte` (only if it constrains row height; otherwise no change)

- [ ] **Step 1: Read `UnitRow.svelte`**

Run: open `ui/src/lib/components/UnitRow.svelte` and identify the root clickable element and its padding/min-height.

- [ ] **Step 2: Add a 44px min tap target on mobile**

Add a `@media (max-width: 768px)` rule to `UnitRow.svelte`'s `<style>` targeting the root row element (use the actual class name found in Step 1; example assumes `.row`):

```css
@media (max-width: 768px) {
  .row {
    min-height: 44px;
    padding-block: 10px;
  }
}
```

- [ ] **Step 3: Prettier + svelte-check**

Run: `cd ui && bunx prettier --write src/lib/components/UnitRow.svelte && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/UnitRow.svelte
git commit -m "feat(ui): 44px unit-row tap targets on mobile"
```

---

### Task 7: `NewTask.svelte` — full-screen sheet on mobile

**Files:**

- Modify: `ui/src/lib/components/NewTask.svelte`

- [ ] **Step 1: Read `NewTask.svelte`**

Identify the overlay/backdrop element and the dialog/panel element class names and their current centering styles.

- [ ] **Step 2: Add `mobile` media rule turning the dialog into a full-screen sheet**

Add to `NewTask.svelte`'s `<style>` (use the actual dialog class found in Step 1; example assumes `.dialog`):

```css
@media (max-width: 768px) {
  .dialog {
    position: fixed;
    inset: 0;
    max-width: none;
    width: 100%;
    height: 100dvh;
    max-height: none;
    border-radius: 0;
    animation: sheet-up 0.18s ease-out;
  }
}

@keyframes sheet-up {
  from {
    transform: translateY(12px);
    opacity: 0.6;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
```

> If the dialog is centered via a flex backdrop, the `position:fixed; inset:0` on the dialog overrides that on mobile. Verify the backdrop still dims behind on mobile (it will, being `position:fixed` itself). Confirm fields/textarea grow to fill width.

- [ ] **Step 3: Ensure inputs/buttons have ≥44px touch height on mobile**

Add within the same media query, targeting the form controls (adapt selectors to the file):

```css
.dialog input,
.dialog textarea,
.dialog button {
  min-height: 44px;
  font-size: 16px; /* prevents iOS zoom-on-focus */
}
```

- [ ] **Step 4: Prettier + svelte-check + build, visual at 390×844**

Run: `cd ui && bunx prettier --write src/lib/components/NewTask.svelte && bun run check && bun run build`
Expected: PASS. Restart instance, `agent-browser` 390×844, open New Task, screenshot, view.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/NewTask.svelte
git commit -m "feat(ui): full-screen new-task sheet on mobile"
```

---

### Task 8: `RepoSelect.svelte` — touch dropdown

**Files:**

- Modify: `ui/src/lib/components/RepoSelect.svelte`

- [ ] **Step 1: Read `RepoSelect.svelte`**

Identify the trigger control class and the dropdown option row class.

- [ ] **Step 2: Add a mobile media rule enlarging trigger + option rows**

Add to `<style>` (adapt selectors; example assumes `.trigger` and `.option`):

```css
@media (max-width: 768px) {
  .trigger {
    min-height: 44px;
    font-size: 16px;
  }
  .option {
    min-height: 40px;
    display: flex;
    align-items: center;
  }
}
```

- [ ] **Step 3: Prettier + svelte-check**

Run: `cd ui && bunx prettier --write src/lib/components/RepoSelect.svelte && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/RepoSelect.svelte
git commit -m "feat(ui): touch-sized repo dropdown on mobile"
```

---

### Task 9: `TodoPanel.svelte` + `IssuesPanel.svelte` — scroll + tap sizing

**Files:**

- Modify: `ui/src/lib/components/TodoPanel.svelte`
- Modify: `ui/src/lib/components/IssuesPanel.svelte`

- [ ] **Step 1: Read both panels**

Confirm each has a scroll container that fills the full-screen detail body, and identify interactive rows (todo items / issue rows, the "new task from issue" button).

- [ ] **Step 2: Ensure scroll fills + interactive rows ≥40px on mobile**

In each panel's `<style>`, add (adapt selectors to actual classes; ensure the scroll root uses `overflow:auto` + `-webkit-overflow-scrolling: touch`):

```css
@media (max-width: 768px) {
  .scroll {
    -webkit-overflow-scrolling: touch;
  }
  .item,
  .issue,
  button {
    min-height: 40px;
  }
}
```

> If a panel already has the right behavior, make the minimal addition only (touch scrolling + tap height). Do not restructure working layout.

- [ ] **Step 3: Prettier + svelte-check**

Run: `cd ui && bunx prettier --write src/lib/components/TodoPanel.svelte src/lib/components/IssuesPanel.svelte && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/TodoPanel.svelte ui/src/lib/components/IssuesPanel.svelte
git commit -m "feat(ui): touch scroll + tap sizing in todo/issues panels"
```

---

### Task 10: Acceptance — visual verification + desktop regression

**Files:** none (verification only; fixes folded back into the relevant task's file if a defect is found).

- [ ] **Step 1: Full check + build**

Run: `cd ~/Work/shepherd && bun run test && bun run lint && bunx tsc --noEmit`
Run: `cd ~/Work/shepherd/ui && bun run check && bun run test && bun run build`
Expected: all PASS.

- [ ] **Step 2: Boot an instance with a real (bash-backed) session**

Per handoff "Commands" + e2e notes: boot on a temp port/DB with `SHEPHERD_REPO_ROOT=/tmp/...`, `herdr agent start <name> --cwd <dir> --no-focus -- bash`, insert a session row via `SessionStore`, so the terminal actually renders. (Reuse the V4-T5 e2e harness pattern.) Ensure `SHEPHERD_ALLOWED_HOSTS` includes the serving host.

- [ ] **Step 3: Screenshot the mobile flow at 390×844 — actually view each**

Using `agent-browser --viewport 390x844`:

1. List screen (Herd + compact TopBar + full-width New Task).
2. Tap a unit → detail (terminal fills, header = back+desig+status, tabs as 2nd row).
3. Terminal renders text and is fit to width (no clipping/overflow).
4. To-Do tab, Issues tab — scroll + tap sizing.
5. `‹ Herd` returns to list.
6. `+ New Task` → full-screen sheet; repo dropdown opens with large rows.

Expected: each screenshot looks correct. Fix defects in the owning component and re-shoot.

- [ ] **Step 4: Breakpoint check at 768 and tablet**

`agent-browser --viewport 768x1024` and `820x1180`: confirm the layout flips cleanly at the boundary (≤768 mobile, >768 desktop grid).

- [ ] **Step 5: Desktop regression at ~1280**

`agent-browser --viewport 1280x800`: confirm the desktop 2-col grid, viewport header (branch/model/elapsed/tabs inline), TopBar (with "Mission Control"), and ActionBar (All/Focus/hint) are all unchanged from before.

- [ ] **Step 6: Teardown the e2e instance**

Stop the bash agent (`herdr pane close` / stop), kill the temp-port backend, remove temp repoRoot/DB.

- [ ] **Step 7: Final commit (if any fixes were made beyond per-task commits)**

```bash
git add -A
git commit -m "fix(ui): v5 responsive visual polish from acceptance pass"
```

---

## Post-plan

- Update `TODO.md`: move v5 from "Next" to done.
- Merge to `main` + `git push origin main` **only when the user says "merge"** (per handoff).

## Self-review notes

- **Spec coverage:** breakpoint (T2), drill-down nav (T2), mobile detail header collapse + 13px terminal + tap-to-focus + refit (T3), compact TopBar (T4), mobile ActionBar (T5), tap targets (T6/T8/T9), full-screen New Task sheet (T7), touch panels (T9), `app.css` touch niceties + `100dvh` (T1/T2), acceptance gate 390/768/1280 + desktop regression + e2e terminal (T10). All spec sections mapped.
- **Placeholders:** selector names in T6–T9 are explicitly "confirm the actual class in Step 1, adapt example" — the read step precedes the edit so this is a real instruction, not a TODO.
- **Type consistency:** `mobile?: boolean` prop added consistently to TopBar/ActionBar/Viewport; `onback?: () => void` and `desktopOnly?: boolean` used identically where referenced; `selectUnit(id)` used by both Herd render branches.
