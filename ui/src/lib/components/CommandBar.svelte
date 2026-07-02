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
  import { m } from "$lib/paraglide/messages";

  let {
    sessions,
    workingBlocked,
    commands,
    onselectsession,
    onselectrepo,
    onselectlens,
    onclose,
  }: {
    sessions: Session[];
    workingBlocked: Record<string, boolean>;
    commands: Command[];
    onselectsession: (id: string) => void;
    onselectrepo: (path: string) => void;
    onselectlens: (lens: HerdFilter) => void;
    onclose: () => void;
  } = $props();

  // Docs open externally (docs.shepherd.run) in a new tab. DOCS_URL carries a trailing
  // slash and manifest paths a leading one — strip one so the join never doubles up.
  const docUrl = (path: string) => DOCS_URL.replace(/\/$/, "") + path;

  // Row unions the three navigation targets. `oid` (assigned when the flat option
  // list is built) is a row's index within the SELECTABLE-only sequence — group
  // header rows are never part of it, so the roving cursor structurally skips them.
  type Row =
    | {
        kind: "session";
        id: string;
        title: string;
        repoPath: string;
        repoName: string | null;
        status: string;
      }
    | { kind: "repo"; path: string; name: string; display: string }
    | { kind: "lens"; lens: HerdFilter; label: string; icon: string }
    | { kind: "command"; id: string; label: string; run: () => void }
    | { kind: "doc"; title: string; url: string };
  type OptRow = Row & { oid: number };

  let filter = $state("");
  let activeIdx = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);

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

  // Recency-first, per group (see plan: updatedAt / lastUsedAt are the last-activity
  // signals — railOrder() is a stage/epic partition, not a recency sort).
  const sessionRows = $derived<Row[]>(
    sessions
      .filter((s) => {
        const repoName = repos.nameFor(s.repoPath) ?? "";
        return (s.name + " " + s.desig + " " + repoName).toLowerCase().includes(q);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        kind: "session",
        id: s.id,
        title: s.name || s.desig,
        repoPath: s.repoPath,
        repoName: repos.nameFor(s.repoPath),
        status: statusLabel(displayStatus(s, workingBlocked)),
      })),
  );

  const repoRows = $derived<Row[]>(
    repos.entries
      .filter((r) => (r.name + " " + r.display).toLowerCase().includes(q))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .map((r) => ({ kind: "repo", path: r.path, name: r.name, display: r.display })),
  );

  const lensRows = $derived<Row[]>(
    LENSES.filter((l) => l.label().toLowerCase().includes(q)).map((l) => ({
      kind: "lens",
      lens: l.id,
      label: l.label(),
      icon: lensGlyph[l.id],
    })),
  );

  // Commands + Docs are search-driven, so they stay hidden until the user types: with an
  // empty query every command (≤6) and doc (~14) would match and flood the bar on open,
  // burying the recency-ordered sessions/repos/lenses that make it a quick-switcher.
  // Commands match on label + optional localized keyword synonyms; docs on their title +
  // the generated keyword haystack (description + headings), so non-title queries resolve.
  const commandRows = $derived<Row[]>(
    q === ""
      ? []
      : commands
          .filter((c) => (c.label() + " " + (c.keywords?.() ?? "")).toLowerCase().includes(q))
          .map((c) => ({ kind: "command", id: c.id, label: c.label(), run: c.run })),
  );

  const docRows = $derived<Row[]>(
    q === ""
      ? []
      : DOCS_PAGES.filter((d) => (d.title.toLowerCase() + " " + d.keywords).includes(q)).map(
          (d) => ({ kind: "doc", title: d.title, url: docUrl(d.path) }),
        ),
  );

  // Non-empty groups, each row tagged with its global selectable index (`oid`).
  // Headers are rendered separately and carry no oid — so ArrowUp/Down (which walk
  // oids) and Enter (which acts on options[activeIdx]) can never land on one.
  const groups = $derived.by(() => {
    let i = 0;
    const build = (key: string, label: string, rows: Row[]) => ({
      key,
      label,
      rows: rows.map((r): OptRow => ({ ...r, oid: i++ })),
    });
    return [
      build("sessions", m.commandbar_group_sessions(), sessionRows),
      build("repos", m.commandbar_group_repos(), repoRows),
      build("lenses", m.commandbar_group_lenses(), lensRows),
      build("commands", m.commandbar_group_commands(), commandRows),
      build("docs", m.commandbar_group_docs(), docRows),
    ].filter((g) => g.rows.length > 0);
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

  function selectOption(row: OptRow) {
    if (row.kind === "session") onselectsession(row.id);
    else if (row.kind === "repo") onselectrepo(row.path);
    else if (row.kind === "lens") onselectlens(row.lens);
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
        if (row) selectOption(row);
        break;
      }
      // Escape is handled by use:dialog (focus-trap + onclose).
    }
  }
</script>

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
            tabindex="-1"
            onclick={() => selectOption(row)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") selectOption(row);
            }}
          >
            {#if row.kind === "session"}
              <span class="cb-ic" aria-hidden="true"
                >{projectIcons.iconFor(row.repoPath) ?? "▣"}</span
              >
              <b class="cb-primary">{row.title}</b>
              <span class="cb-sub">
                {#if row.repoName}{row.repoName} ·
                {/if}{row.status}
              </span>
            {:else if row.kind === "repo"}
              <span class="cb-ic" aria-hidden="true">{projectIcons.iconFor(row.path) ?? "▣"}</span>
              <b class="cb-primary">{row.name}</b>
              <span class="cb-sub">{row.display} · {m.commandbar_repo_affordance()}</span>
            {:else if row.kind === "lens"}
              <span class="cb-ic" aria-hidden="true">{row.icon}</span>
              <b class="cb-primary">{row.label}</b>
            {:else if row.kind === "command"}
              <span class="cb-ic" aria-hidden="true">⌘</span>
              <b class="cb-primary">{row.label}</b>
            {:else}
              <span class="cb-ic" aria-hidden="true">📄</span>
              <b class="cb-primary">{row.title}</b>
              <span class="cb-sub">{m.commandbar_docs_affordance()}</span>
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
  /* Secondary detail — meta size is a precedented exception for dim sub-text. */
  .cb-sub {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
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
