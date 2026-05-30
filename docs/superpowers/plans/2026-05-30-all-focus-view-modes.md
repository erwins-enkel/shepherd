# All / Focus View Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the decorative `All ▦` / `Focus ⌖` buttons to a real desktop view-mode toggle: Focus = current Herd-list + single Viewport; All = full-width grid of every session's read-only live terminal.

**Architecture:** Add `viewMode` state to `+page.svelte` driving the desktop pane. `ActionBar` buttons become a toggle. A new `HerdGrid` renders a responsive grid of new `UnitTile` components — each a stripped, read-only xterm mirroring `Viewport`'s PTY/fit/teardown discipline. Clicking a tile selects the unit and drops back to Focus. Mobile is untouched (buttons stay desktop-only).

**Tech Stack:** Svelte 5 (runes), `@xterm/xterm` v6 + `@xterm/addon-fit`, existing `$lib/pty` (`connectPty`) and `$lib/format` (`STATUS_COLOR`, `statusLabel`, `elapsed`).

> **Svelte note:** When creating/editing any `.svelte` file, use the `svelte-code-writer` skill / `svelte-core-bestpractices` skill per project guidelines. All components use Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`) — never legacy syntax.

> **Testing note:** The UI test suite is pure-logic only (`ui/test/{api,format,store}.test.ts`); there are no Svelte component/DOM tests and no `@testing-library` dependency. Per repo convention this plan adds **no component tests**. Each task is verified with `bun run check` (svelte-check + types) and a final manual run. Do not add a DOM test harness.

---

### Task 1: `UnitTile` — read-only live terminal tile

**Files:**
- Create: `ui/src/lib/components/UnitTile.svelte`

This is the core new unit: a lightweight, read-only version of `Viewport`'s terminal. It streams PTY output but never sends keystrokes (`disableStdin: true`, no `term.onData → send`). It mirrors `Viewport.svelte:80-169` for the xterm + FitAddon + ResizeObserver lifecycle and teardown, but drops the header tabs, todo/issues panels, control bar, usage polling, and decommission logic.

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import type { Session } from "$lib/types";
  import { STATUS_COLOR, statusLabel, elapsed } from "$lib/format";
  import { connectPty } from "$lib/pty";

  let {
    session,
    selected = false,
    nowMs = Date.now(),
    onselect,
  }: {
    session: Session;
    selected?: boolean;
    nowMs?: number;
    onselect: (id: string) => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();

  // read-only live terminal: stream PTY output, never send input.
  // mirrors Viewport's xterm/fit/resize/teardown discipline (Viewport.svelte:80-169)
  // minus input wiring (no term.onData → send) and disableStdin.
  $effect(() => {
    const id = session.id;
    if (!el) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      disableStdin: true,
      cursorBlink: false,
      theme: { background: "#070a09", foreground: "#b9c7c1" },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const c = connectPty(
      id,
      (d) => term.write(d),
      () => {},
    );
    // intentionally no term.onData → send: tiles are read-only monitors

    requestAnimationFrame(() => {
      fit.fit();
      c.resize(term.cols, term.rows);
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      c.resize(term.cols, term.rows);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      c.close();
      term.dispose();
    };
  });
</script>

<button
  class="tile"
  class:sel={selected}
  style="--rule:{STATUS_COLOR[session.status]}"
  type="button"
  onclick={() => onselect(session.id)}
>
  <div class="t-head">
    <span class="desig">{session.desig}</span>
    <span class="name">{session.name}</span>
    <span class="spacer"></span>
    {#if session.status === "running"}
      <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    {/if}
    <span class="badge">{statusLabel(session.status)}</span>
  </div>
  <div class="t-body">
    <div class="t-mount" bind:this={el}></div>
  </div>
</button>

<style>
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 240px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: #070a09;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    text-align: left;
    overflow: hidden;
  }
  .tile::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--rule, var(--color-faint));
    z-index: 2;
  }
  .tile:hover {
    border-color: var(--color-line-bright);
  }
  .tile.sel {
    border-color: var(--color-line-bright);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }

  .t-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    background: #0a0f0d;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .desig {
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .name {
    color: var(--color-ink-bright);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1;
  }
  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
    font-size: 10.5px;
  }
  .badge {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 2px 6px;
    border: 1px solid var(--rule);
    color: var(--rule);
    border-radius: 2px;
    flex-shrink: 0;
  }

  .t-body {
    position: relative;
    flex: 1;
    overflow: hidden;
  }
  .t-mount {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .t-mount :global(.xterm) {
    height: 100%;
  }
</style>
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd ui && bun run check`
Expected: PASS (no errors). `UnitTile.svelte` is not yet imported anywhere — that's fine; svelte-check still type-checks it.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/UnitTile.svelte
git commit -m "feat(ui): read-only live terminal tile for All view"
```

---

### Task 2: `HerdGrid` — responsive grid of tiles

**Files:**
- Create: `ui/src/lib/components/HerdGrid.svelte`

Full-width responsive grid, one `UnitTile` per session, with an empty state. Mirrors the empty-state copy from `Herd.svelte:25` (`No units — + New Task`).

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { Session } from "$lib/types";
  import UnitTile from "./UnitTile.svelte";

  let {
    sessions,
    selectedId,
    nowMs,
    onselect,
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
  } = $props();
</script>

{#if sessions.length === 0}
  <div class="empty">No units — + New Task</div>
{:else}
  <div class="herd-grid">
    {#each sessions as session (session.id)}
      <UnitTile {session} selected={session.id === selectedId} {nowMs} {onselect} />
    {/each}
  </div>
{/if}

<style>
  .herd-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    grid-auto-rows: 240px;
    gap: 12px;
    overflow: auto;
    padding: 2px;
    align-content: start;
  }
  .empty {
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-faint);
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
</style>
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd ui && bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/HerdGrid.svelte
git commit -m "feat(ui): HerdGrid responsive tile grid for All view"
```

---

### Task 3: `ActionBar` — All/Focus toggle buttons

**Files:**
- Modify: `ui/src/lib/components/ActionBar.svelte`

Add `mode` + `onmode` props. The two desktop buttons set the mode and show `.active` styling when current. `+ New Task` and mobile behavior unchanged. Provide safe defaults so the mobile/desktopOnly instance (which doesn't pass these) still compiles.

- [ ] **Step 1: Replace the `<script>` block**

Replace `ActionBar.svelte:1-11` with:

```svelte
<script lang="ts">
  let {
    onnew,
    mode = "focus",
    onmode,
    mobile = false,
    desktopOnly = false,
  }: {
    onnew: () => void;
    mode?: "focus" | "all";
    onmode?: (m: "focus" | "all") => void;
    mobile?: boolean;
    desktopOnly?: boolean;
  } = $props();
</script>
```

- [ ] **Step 2: Replace the two decorative buttons**

Replace `ActionBar.svelte:17-18` (the `All ▦` and `Focus ⌖` buttons) with:

```svelte
      <button
        class="btn"
        class:active={mode === "all"}
        type="button"
        onclick={() => onmode?.("all")}>All ▦</button
      >
      <button
        class="btn"
        class:active={mode === "focus"}
        type="button"
        onclick={() => onmode?.("focus")}>Focus ⌖</button
      >
```

- [ ] **Step 3: Add `.active` style**

Add this rule to the `<style>` block, immediately after the `.btn:hover` rule (after `ActionBar.svelte:51`):

```css
  .btn.active {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: #0c1110;
  }
```

- [ ] **Step 4: Verify it type-checks**

Run: `cd ui && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/ActionBar.svelte
git commit -m "feat(ui): wire All/Focus toggle buttons in ActionBar"
```

---

### Task 4: `+page.svelte` — drive the desktop pane with `viewMode`

**Files:**
- Modify: `ui/src/routes/+page.svelte`

Add `viewMode` state, render `HerdGrid` full-width when `all`, and make tile clicks drop back to Focus. Wire the bottom `ActionBar` toggle.

- [ ] **Step 1: Add state + import**

Add to the imports (after `+page.svelte:10`):

```svelte
  import HerdGrid from "$lib/components/HerdGrid.svelte";
```

Add the state declaration after `let showNew = $state(false);` (`+page.svelte:14`):

```svelte
  let viewMode = $state<"focus" | "all">("focus");
```

- [ ] **Step 2: Render the grid in the desktop branch**

Replace the desktop `.grid` block (`+page.svelte:107-125`, the `{:else} ... {/if}` covering the non-mobile layout) with:

```svelte
  {:else if viewMode === "all"}
    <div class="grid-all">
      <HerdGrid
        sessions={store.sessions}
        {selectedId}
        {nowMs}
        onselect={(id) => {
          selectedId = id;
          viewMode = "focus";
        }}
      />
    </div>
  {:else}
    <div class="grid" class:compact={touch.current}>
      <Herd sessions={store.sessions} {selectedId} {nowMs} onselect={(id) => selectUnit(id)} />
      {#if selected}
        <Viewport
          session={selected}
          touch={touch.current}
          {onarchive}
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
```

- [ ] **Step 3: Wire the bottom ActionBar toggle**

Replace the bottom `ActionBar` (`+page.svelte:127`) with:

```svelte
  <ActionBar
    onnew={() => (showNew = true)}
    mode={viewMode}
    onmode={(m) => (viewMode = m)}
    mobile={mobile.current}
    desktopOnly
  />
```

- [ ] **Step 4: Add `.grid-all` layout style**

Add to the `<style>` block, immediately after the `.grid.compact` rule (after `+page.svelte:169`):

```css
  .grid-all {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .grid-all :global(.herd-grid) {
    flex: 1;
  }
```

- [ ] **Step 5: Verify it type-checks**

Run: `cd ui && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/routes/+page.svelte
git commit -m "feat(ui): toggle desktop pane between Focus and All grid"
```

---

### Task 5: Manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full check**

Run: `cd ui && bun run check`
Expected: PASS, zero errors/warnings.

- [ ] **Step 2: Lint/format**

Run from repo root: `bunx prettier --check "ui/src/**/*.{svelte,ts}"` (or the repo's configured prettier/eslint command).
Expected: PASS. If it reports formatting, run the `--write` variant and re-commit.

- [ ] **Step 3: Run the app and exercise the feature**

Start the dev server (`cd ui && bun run dev`, with the backend running per README) and verify in a desktop-width browser:

- Default load shows **Focus** mode (Herd list + Viewport); `Focus ⌖` button is highlighted.
- Click `All ▦`: pane switches to a full-width grid of tiles, one per session, each streaming live output read-only. `All ▦` is highlighted.
- Typing does nothing in a tile (read-only).
- Click a tile: returns to **Focus** mode with that unit selected and its Viewport live.
- With zero sessions, All mode shows `No units — + New Task`.
- Resize the window: tiles reflow (min 280px) and terminals refit.
- Narrow the window below 768px (mobile): no All/Focus buttons; layout unchanged from before.

- [ ] **Step 4: Final commit (only if Step 2 reformatted files)**

```bash
git commit -am "style(ui): prettier formatting for All/Focus view modes"
```
