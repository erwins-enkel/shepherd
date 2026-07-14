<script lang="ts">
  import type { Session } from "$lib/types";
  import type { HerdFilter } from "$lib/components/herd-partition";
  import { repos } from "$lib/repos.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { displayStatus } from "$lib/display-status";
  import { statusLabel } from "$lib/format";
  import { dialog } from "$lib/a11yDialog";
  import { lensGlyph } from "$lib/components/herd/lens-glyphs";
  import { DOCS_URL } from "$lib/build-info";
  import { DOCS_PAGES } from "$lib/docs-manifest";
  import type { Command } from "$lib/command-registry";
  import { fuzzyScore } from "$lib/fuzzy";
  import { jumpDigitIndex } from "$lib/components/herd-keynav";
  import { sortBlocked, type BlockState } from "$lib/triage";
  import { m } from "$lib/paraglide/messages";
  import { untrack } from "svelte";

  let {
    sessions,
    workingBlocked,
    blocks = {},
    commands,
    onselectsession,
    onselectrepo,
    onfilterrepo,
    onselectlens,
    onclose,
    // Demo-only seed for the scripted showcase (see $lib/demo/showcase.ts) — the
    // real ⌘K path never passes this, so `filter` seeds to "" exactly as before.
    initialFilter = undefined,
  }: {
    sessions: Session[];
    workingBlocked: Record<string, boolean>;
    blocks?: Record<string, BlockState>;
    commands: Command[];
    onselectsession: (id: string) => void;
    onselectrepo: (path: string) => void;
    onfilterrepo: (path: string) => void;
    onselectlens: (lens: HerdFilter) => void;
    onclose: () => void;
    initialFilter?: string;
  } = $props();

  // Docs open externally (docs.shepherd.run) in a new tab. DOCS_URL carries a trailing
  // slash and manifest paths a leading one — strip one so the join never doubles up.
  const docUrl = (path: string) => DOCS_URL.replace(/\/$/, "") + path;

  // Row unions the navigation and action targets. `rank` is comparable across every kind
  // for a typed query; `oid` (assigned only after groups are relevance-ordered) is the row's
  // index within the SELECTABLE-only sequence, so roving navigation skips group headers.
  type Row =
    | {
        kind: "session";
        id: string;
        title: string;
        designation: string;
        repoPath: string;
        repoName: string | null;
        status: string;
        hl: number[];
        designationHl: number[];
        repoHl: number[];
        promptMatch: boolean;
        rank: number;
      }
    | {
        kind: "repo";
        // `path` is the raw entry path (backlog is keyed on it); `realPath` is the
        // realpath'd form that session.repoPath / the herd repoFilter use — they differ
        // for a symlinked repo root, so the filter action keys on realPath, backlog on path.
        path: string;
        realPath: string;
        name: string;
        display: string;
        hl: number[];
        displayHl: number[];
        hasLiveSession: boolean;
        rank: number;
      }
    | { kind: "lens"; lens: HerdFilter; label: string; icon: string; hl: number[]; rank: number }
    | { kind: "command"; id: string; label: string; run: () => void; hl: number[]; rank: number }
    | { kind: "doc"; title: string; url: string; hl: number[]; rank: number };
  type OptRow = Row & { oid: number };

  type MatchSource = "title" | "designation" | "session-repo" | "repo-name" | "repo-display";
  type FieldMatch = { source: MatchSource; rank: number; positions: number[] };

  function bestFieldMatch(
    query: string,
    fields: { source: MatchSource; text: string; penalty?: number }[],
  ): FieldMatch | null {
    let best: FieldMatch | null = null;
    for (const field of fields) {
      const result = fuzzyScore(query, field.text);
      if (result === null) continue;
      const match = {
        source: field.source,
        rank: result.score - (field.penalty ?? 0),
        positions: result.positions,
      };
      if (best === null || match.rank > best.rank) best = match;
    }
    return best;
  }

  function isPresent<T>(value: T | null): value is T {
    return value !== null;
  }

  let filter = $state(untrack(() => initialFilter) ?? "");
  let activeIdx = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  // True while Alt is held — reveals the digit jump-hints on the first ten rows. Alt is the
  // browser-viable substitute for the requested Cmd/Ctrl+digit (which the browser reserves for
  // tab-switch / reset-zoom). Tracked off keyboard/blur events since the DOM can't be polled
  // for modifier state; window blur resets it so a held Alt can't get stuck when the user
  // switches apps mid-hold. Only the first ten rows (oid 0–9) get a hint.
  let altHeld = $state(false);
  const HINT_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

  const q = $derived(filter.trim().toLowerCase());

  // The six herd lenses, "all" included (the default all-sessions view). Labels reuse the
  // `herd_seg_*` keys and glyphs come from the shared lensGlyph map, so both dimensions stay
  // single-sourced with the HerdLensStrip and can't drift.
  const LENSES: { id: HerdFilter; label: () => string }[] = [
    { id: "all", label: () => m.herd_seg_all() },
    { id: "next", label: () => m.herd_seg_next() },
    { id: "ready", label: () => m.herd_seg_ready() },
    { id: "done", label: () => m.herd_seg_done() },
    { id: "rundown", label: () => m.herd_seg_rundown() },
    { id: "owed", label: () => m.herd_seg_owed() },
  ];

  const needsInputIds = $derived(
    new Set([
      ...sortBlocked(sessions, blocks)
        .filter((e) => !workingBlocked[e.session.id])
        .map((e) => e.session.id),
      ...sessions.filter((s) => s.autopilotPaused && !workingBlocked[s.id]).map((s) => s.id),
    ]),
  );

  const autopilotPausedLabel = $derived(m.session_autopilot_paused_label().toLocaleUpperCase());

  // Match each short visible field independently: a query can never start in a title and
  // finish in a designation/repository. Long prompt text remains substring-only and ranks
  // below every visible compact fuzzy match. A blank query gives every primary field rank 0,
  // preserving needs-input + recency as the session ordering signals.
  const sessionRows = $derived<Row[]>(
    sessions
      .map((s) => {
        const title = s.name || s.desig;
        const repoName = repos.nameFor(s.repoPath);
        const match = bestFieldMatch(q, [
          { source: "title", text: title },
          { source: "designation", text: s.desig, penalty: 100 },
          { source: "session-repo", text: repoName ?? "", penalty: 100 },
        ]);
        const promptMatch = match === null && q !== "" && s.prompt.toLowerCase().includes(q);
        if (match === null && !promptMatch) return null;
        return {
          s,
          title,
          repoName,
          match,
          promptMatch,
          rank: match?.rank ?? 500,
        };
      })
      .filter(isPresent)
      .sort(
        (a, b) =>
          b.rank - a.rank ||
          Number(needsInputIds.has(b.s.id)) - Number(needsInputIds.has(a.s.id)) ||
          b.s.updatedAt - a.s.updatedAt,
      )
      .map(({ s, title, repoName, match, promptMatch, rank }): Row => ({
        kind: "session",
        id: s.id,
        title,
        designation: s.desig,
        repoPath: s.repoPath,
        repoName,
        status: s.autopilotPaused
          ? autopilotPausedLabel
          : statusLabel(displayStatus(s, workingBlocked)),
        hl: match?.source === "title" ? match.positions : [],
        designationHl: match?.source === "designation" ? match.positions : [],
        repoHl: match?.source === "session-repo" ? match.positions : [],
        promptMatch,
        rank,
      })),
  );

  // A repo can be filtered onto the session list only if it has a live (non-archived)
  // session — same liveness rule as repoChipRows. Filtering a session-less repo would be
  // pruned by the page (staleFilterRepos) and strand an empty herd, so the
  // secondary action + its hint are gated on this. Keyed on session.repoPath (the
  // realpath'd form), so the repo lookup below must compare r.realPath, not r.path.
  const liveRepoPaths = $derived(
    new Set(sessions.filter((s) => s.status !== "archived").map((s) => s.repoPath)),
  );
  const repoRows = $derived<Row[]>(
    repos.entries
      .map((r) => {
        const match = bestFieldMatch(q, [
          { source: "repo-name", text: r.name },
          { source: "repo-display", text: r.display, penalty: 100 },
        ]);
        return match === null ? null : { r, match };
      })
      .filter(isPresent)
      .sort((a, b) => b.match.rank - a.match.rank || (b.r.lastUsedAt ?? 0) - (a.r.lastUsedAt ?? 0))
      .map(({ r, match }): Row => ({
        kind: "repo",
        path: r.path,
        realPath: r.realPath,
        name: r.name,
        display: r.display,
        hl: match.source === "repo-name" ? match.positions : [],
        displayHl: match.source === "repo-display" ? match.positions : [],
        hasLiveSession: liveRepoPaths.has(r.realPath),
        rank: match.rank,
      })),
  );

  const lensRows = $derived<Row[]>(
    LENSES.map((l, i) => ({ l, i, label: l.label(), res: fuzzyScore(q, l.label()) }))
      .filter((e) => e.res !== null)
      .sort((a, b) => b.res!.score - a.res!.score || a.i - b.i)
      .map(({ l, label, res }): Row => ({
        kind: "lens",
        lens: l.id,
        label,
        icon: lensGlyph[l.id],
        hl: res!.positions, // the whole label is the primary text
        rank: res!.score,
      })),
  );

  // Commands + Docs are search-driven, so they stay hidden until the user types: with an
  // empty query every command (≤6) and doc (~14) would match and flood the bar on open,
  // burying the recency-ordered sessions/repos/lenses that make it a quick-switcher.
  // Labels/titles use the same compact scorer as navigation rows. Long keyword haystacks stay
  // substring-only at rank 500, so synonyms remain discoverable without outranking visible text.
  const commandRows = $derived<Row[]>(
    q === ""
      ? []
      : commands
          .map((c, order) => {
            const label = c.label();
            const result = fuzzyScore(q, label);
            const keywordMatch =
              result === null && (c.keywords?.() ?? "").toLowerCase().includes(q);
            if (result === null && !keywordMatch) return null;
            return { c, order, label, result, rank: result?.score ?? 500 };
          })
          .filter(isPresent)
          .sort((a, b) => b.rank - a.rank || a.order - b.order)
          .map(({ c, label, result, rank }): Row => ({
            kind: "command",
            id: c.id,
            label,
            run: c.run,
            hl: result?.positions ?? [],
            rank,
          })),
  );

  const docRows = $derived<Row[]>(
    q === ""
      ? []
      : DOCS_PAGES.map((d, order) => {
          const result = fuzzyScore(q, d.title);
          const keywordMatch = result === null && d.keywords.includes(q);
          if (result === null && !keywordMatch) return null;
          return { d, order, result, rank: result?.score ?? 500 };
        })
          .filter(isPresent)
          .sort((a, b) => b.rank - a.rank || a.order - b.order)
          .map(({ d, result, rank }): Row => ({
            kind: "doc",
            title: d.title,
            url: docUrl(d.path),
            hl: result?.positions ?? [],
            rank,
          })),
  );

  // Typed queries order groups by their strongest row. Blank queries retain the established
  // Sessions → Repositories → Lenses order. Global option ids are assigned only after that
  // final group order, so Arrow/Enter/Alt+digit always target the rendered sequence.
  const groups = $derived.by(() => {
    const build = (key: string, label: string, rows: Row[], order: number) => ({
      key,
      label,
      rows,
      rank: rows.reduce((max, row) => Math.max(max, row.rank), Number.NEGATIVE_INFINITY),
      order,
    });
    const ranked = [
      build("sessions", m.commandbar_group_sessions(), sessionRows, 0),
      build("repos", m.commandbar_group_repos(), repoRows, 1),
      build("lenses", m.commandbar_group_lenses(), lensRows, 2),
      build("commands", m.commandbar_group_commands(), commandRows, 3),
      build("docs", m.commandbar_group_docs(), docRows, 4),
    ].filter((g) => g.rows.length > 0);
    if (q !== "") ranked.sort((a, b) => b.rank - a.rank || a.order - b.order);

    let oid = 0;
    return ranked.map(({ key, label, rows }) => ({
      key,
      label,
      rows: rows.map((row): OptRow => ({ ...row, oid: oid++ })),
    }));
  });

  const options = $derived<OptRow[]>(groups.flatMap((g) => g.rows));

  // Focus the search field on open (the a11yDialog action would otherwise land on the
  // header ✕, which precedes the input in the DOM). Mirrors RepoSelect's focus effect.
  $effect(() => {
    inputEl?.focus({ preventScroll: true });
  });

  // Keep the cursor in range if an async update (WS poll) shrinks the option list.
  $effect(() => {
    if (activeIdx > options.length - 1) activeIdx = Math.max(0, options.length - 1);
  });

  function stableKey(row: OptRow): string {
    switch (row.kind) {
      case "session":
        return "s:" + row.id;
      case "repo":
        return "r:" + row.path;
      case "lens":
        return "l:" + row.lens;
      case "command":
        return "c:" + row.id;
      case "doc":
        return "d:" + row.url;
    }
  }

  // Split text into on/off runs at the matched positions, so matched chars can be wrapped
  // in <mark> for highlighting. The rendered text is unchanged (runs concatenate back to the
  // original), so a row's accessible name is preserved.
  function segs(text: string, hl: number[]): { t: string; on: boolean }[] {
    if (hl.length === 0) return [{ t: text, on: false }];
    const on = new Set(hl);
    const out: { t: string; on: boolean }[] = [];
    let cur = "";
    let curOn = on.has(0);
    for (let i = 0; i < text.length; i++) {
      const isOn = on.has(i);
      if (isOn === curOn) cur += text[i];
      else {
        out.push({ t: cur, on: curOn });
        cur = text[i];
        curOn = isOn;
      }
    }
    out.push({ t: cur, on: curOn });
    return out;
  }

  // `secondary` (a modifier held with Enter/click) picks a row's secondary verb. Today
  // only repo rows have one — filter the session list to that repo — and only when it has
  // a live session; every other row (and a session-less repo) ignores the modifier and
  // runs its primary action.
  function selectOption(row: OptRow, secondary = false) {
    if (row.kind === "session") onselectsession(row.id);
    else if (row.kind === "repo") {
      // Filter keys on realPath (matches session.repoPath / herd repoFilter); backlog
      // keys on the raw path.
      if (secondary && row.hasLiveSession) onfilterrepo(row.realPath);
      else onselectrepo(row.path);
    } else if (row.kind === "lens") onselectlens(row.lens);
    else if (row.kind === "command") {
      // run() mutates page state (opens an overlay / jumps); the bar closes itself since
      // firing the verb doesn't flip showCommandBar the way the navigation callbacks do.
      row.run();
      onclose();
    } else {
      window.open(row.url, "_blank", "noopener,noreferrer");
      onclose();
    }
  }

  function scrollActiveIntoView() {
    const el = listEl?.querySelector(`#cb-opt-${activeIdx}`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }

  function onKey(e: KeyboardEvent) {
    if (options.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, options.length - 1);
        scrollActiveIntoView();
        break;
      case "ArrowUp":
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        scrollActiveIntoView();
        break;
      case "Enter": {
        e.preventDefault();
        const row = options[activeIdx];
        // Shift / Cmd / Ctrl + Enter fires the row's secondary action (repo → filter).
        if (row) selectOption(row, e.shiftKey || e.metaKey || e.ctrlKey);
        break;
      }
      // Escape is handled by use:dialog (focus-trap + onclose).
    }
  }

  // Reveal/hide the digit hints as Alt is pressed/released, AND run the Alt+digit jump — both
  // at window scope so reveal and action cover the same focus states: the jump fires no matter
  // which element inside the focus-trapped dialog holds focus (search field, a row, or the ✕
  // button), matching the window-scoped hint reveal. The combo is always preventDefault-ed
  // (suppressing the macOS Option-glyph) even with no row to jump to; activation is
  // Enter-equivalent only when options[jump] exists. Safe globally while the bar is open:
  // +page's own Alt+1-9 session-switch bails on anyOverlayOpen() (which includes the command
  // bar), so there is no double action. keydown/keyup both carry the live modifier via
  // getModifierState; window blur resets it so a held Alt can't stick when focus leaves the tab.
  function onWindowKeydown(e: KeyboardEvent) {
    altHeld = e.getModifierState("Alt");
    const jump = jumpDigitIndex(e);
    if (jump !== null) {
      e.preventDefault();
      const row = options[jump];
      if (row) selectOption(row);
    }
  }
  function onWindowKeyup(e: KeyboardEvent) {
    altHeld = e.getModifierState("Alt");
  }
</script>

<svelte:window
  onkeydown={onWindowKeydown}
  onkeyup={onWindowKeyup}
  onblur={() => (altHeld = false)}
/>

<!-- Primary text with fuzzy-matched chars wrapped in <mark> for highlighting. Shared by the
     fuzzy-matched navigation rows (session / repo / lens); the split runs concatenate back to
     the original, so the accessible name is preserved. -->
{#snippet primary(text: string, hl: number[])}{#each segs(text, hl) as seg, i (i)}{#if seg.on}<mark
        class="cb-hl">{seg.t}</mark
      >{:else}{seg.t}{/if}{/each}{/snippet}

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.commandbar_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.commandbar_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <input
      bind:this={inputEl}
      bind:value={filter}
      class="cb-input"
      placeholder={m.commandbar_placeholder()}
      aria-label={m.commandbar_placeholder()}
      type="text"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      aria-expanded="true"
      aria-controls="cb-listbox"
      aria-autocomplete="list"
      aria-activedescendant={options.length ? `cb-opt-${activeIdx}` : undefined}
      oninput={() => (activeIdx = 0)}
      onkeydown={onKey}
    />

    <ul
      class="cb-list"
      id="cb-listbox"
      role="listbox"
      aria-label={m.commandbar_title()}
      bind:this={listEl}
    >
      {#each groups as g (g.key)}
        <li class="cb-group" role="presentation">{g.label}</li>
        {#each g.rows as row (stableKey(row))}
          <li
            id={`cb-opt-${row.oid}`}
            class="cb-row"
            class:kbd-active={row.oid === activeIdx}
            role="option"
            aria-selected={row.oid === activeIdx}
            aria-keyshortcuts={row.oid < 10 ? `Alt+${HINT_LABELS[row.oid]}` : undefined}
            tabindex="-1"
            onclick={(e) => selectOption(row, e.shiftKey || e.metaKey || e.ctrlKey)}
            onkeydown={(e) => {
              if (e.key === "Enter") selectOption(row, e.shiftKey || e.metaKey || e.ctrlKey);
              else if (e.key === " ") selectOption(row);
            }}
          >
            {#if row.kind === "session"}
              <span class="cb-ic" aria-hidden="true"
                >{projectIcons.iconFor(row.repoPath) ?? "▣"}</span
              >
              <b class="cb-primary">{@render primary(row.title, row.hl)}</b>
              <span class="cb-sub">
                {#if row.designationHl.length > 0}{@render primary(
                    row.designation,
                    row.designationHl,
                  )} ·
                {/if}{#if row.repoName}{@render primary(row.repoName, row.repoHl)} ·
                {/if}{row.status}{#if row.promptMatch && row.hl.length === 0}
                  · {m.commandbar_prompt_match()}{/if}
              </span>
            {:else if row.kind === "repo"}
              <span class="cb-ic" aria-hidden="true">{projectIcons.iconFor(row.path) ?? "▣"}</span>
              <b class="cb-primary">{@render primary(row.name, row.hl)}</b>
              <span class="cb-sub"
                >{@render primary(row.display, row.displayHl)} · {m.commandbar_repo_affordance()}</span
              >
              {#if row.hasLiveSession}
                <!-- Secondary-action hint. Separate non-shrinking element so a long
                     display path truncates .cb-sub, never this discoverability cue. -->
                <span class="cb-hint">{m.commandbar_repo_filter_affordance()}</span>
              {/if}
            {:else if row.kind === "lens"}
              <span class="cb-ic" aria-hidden="true">{row.icon}</span>
              <b class="cb-primary">{@render primary(row.label, row.hl)}</b>
            {:else if row.kind === "command"}
              <span class="cb-ic" aria-hidden="true">⌘</span>
              <b class="cb-primary">{@render primary(row.label, row.hl)}</b>
            {:else}
              <span class="cb-ic" aria-hidden="true">📄</span>
              <b class="cb-primary">{@render primary(row.title, row.hl)}</b>
              <span class="cb-sub">{m.commandbar_docs_affordance()}</span>
            {/if}
            <!-- Digit jump-hint, first ten rows only, revealed while Alt is held. Decorative
                 (aria-hidden) — the shortcut is exposed to AT via the row's aria-keyshortcuts. -->
            {#if row.oid < 10 && altHeld}
              <kbd class="cb-kbd" aria-hidden="true">{HINT_LABELS[row.oid]}</kbd>
            {/if}
          </li>
        {/each}
      {/each}
    </ul>

    <!-- Live region so screen readers hear an empty result set; .filled gives it a
         footprint only when shown (mirrors RepoSelect's .rs-empty). -->
    <div class="cb-empty" class:filled={options.length === 0} role="status" aria-live="polite">
      {options.length === 0 ? m.commandbar_no_matches() : ""}
    </div>
  </div>
</div>

<style>
  /* Component-scoped backdrop; the global `.overlay` (app.css) layers the canonical
     blur on top of this dim, satisfying the modal blur+dim rule. */
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    z-index: 20;
    padding: 10vh 16px 16px;
  }
  .card {
    width: min(560px, 94vw);
    max-height: 70vh;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }

  /* Search well — bare input on the inset surface. --fs-lg (16px) meets the body-text
     a11y floor (--fs-base is 13px) and avoids iOS focus-zoom. */
  .cb-input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-lg);
    padding: 10px 12px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .cb-input:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  .cb-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* Group header — presentational, never a roving target. */
  .cb-group {
    padding: 8px 10px 4px;
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
  }

  .cb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 8px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    overflow: hidden;
  }
  .cb-row:last-child {
    border-bottom: 0;
  }
  .cb-row:hover {
    background: var(--color-hover);
  }
  /* Virtual keyboard cursor — same amber inset ring RepoSelect + EmojiPicker use. */
  .cb-row.kbd-active {
    background: var(--color-sel);
    outline: 1.5px solid var(--color-amber);
    outline-offset: -1.5px;
  }

  .cb-ic {
    flex-shrink: 0;
    font-size: var(--fs-lg);
    line-height: 1;
  }
  /* Primary text at --fs-lg (16px) to meet the body-text floor. */
  .cb-primary {
    font-weight: 600;
    font-size: var(--fs-lg);
    flex-shrink: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Matched-character highlight. Reset the UA <mark> yellow fill; emphasize with the amber
     accent (the same attention hue as the keyboard cursor) — token-only per the design system. */
  .cb-hl {
    background: transparent;
    color: var(--color-amber);
    font-weight: 700;
  }
  /* Secondary detail — meta size is a precedented exception for dim sub-text. */
  .cb-sub {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* Secondary-action cue, pinned to the row's right edge and never clipped —
     margin-left:auto pushes it right, flex-shrink:0 protects it when .cb-sub truncates. */
  .cb-hint {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    white-space: nowrap;
  }

  /* Digit jump-hint badge — pinned to the row's trailing edge, after the .cb-hint cue when
     both are present. --fs-meta is below the 16px body floor, the same precedented exception as
     .cb-sub: this is a keyboard-shortcut affordance (and aria-hidden), not body copy. Uses the
     :last-child margin-left:auto so a row with BOTH a .cb-hint and a badge doesn't split the
     free space across two auto margins. Token-only per the design system. */
  .cb-kbd {
    flex-shrink: 0;
    font: inherit;
    font-size: var(--fs-meta);
    line-height: 1;
    color: var(--color-muted);
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 3px 7px;
    min-width: 1.5em;
    text-align: center;
  }
  /* Only push off free space when the badge is the first trailing element — i.e. no .cb-hint
     already claimed the auto-margin (session / lens / doc rows). On a repo row the .cb-hint
     owns margin-left:auto and the badge just follows it flush. */
  .cb-kbd:not(.cb-hint + .cb-kbd) {
    margin-left: auto;
  }

  .cb-empty {
    color: var(--color-muted);
    font-size: var(--fs-base);
    font-style: italic;
    text-align: center;
  }
  .cb-empty.filled {
    padding: 14px 10px;
  }

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
    }
  }
</style>
