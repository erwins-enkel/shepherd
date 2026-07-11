<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { listRepos } from "$lib/api";
  import type { RepoEntry } from "$lib/types";
  import RepoSelect from "./RepoSelect.svelte";
  import GlossaryText from "./GlossaryText.svelte";
  import EpicDiagnosisModal from "./EpicDiagnosisModal.svelte";

  // Command-bar entry point (#1657): collect a repo + arbitrary parent issue number for a
  // would-be epic Shepherd shows nothing for (no candidate → no EpicPanel → no Diagnose
  // button), then hand them to the unchanged EpicDiagnosisModal. Kept separate so the modal
  // stays presentational (immediate-run against known-good props); this wrapper owns the
  // entry lifecycle + the repo-list fetch.
  let {
    initialRepo = undefined,
    onclose,
  }: { initialRepo?: string | undefined; onclose: () => void } = $props();

  // "entry" shows the repo+number form; "run" renders the diagnosis modal (its own overlay).
  // Only one overlay is on screen at a time, so there is no double-scrim.
  let phase = $state<"entry" | "run">("entry");

  let repos = $state<RepoEntry[]>([]);
  let recentRepoWindowDays = $state(0);
  // Seed once from the in-focus repo (a one-shot default, not a live binding — mirrors
  // CommandBar's initialFilter). onMount reconciles it against the fetched repo list.
  let repoPath = $state(untrack(() => initialRepo) ?? "");
  let issueInput = $state("");

  /** Most-recently-used repo; falls back to the first in the list. */
  function defaultRepoPath(list: RepoEntry[]): string {
    let best: RepoEntry | undefined;
    for (const r of list) {
      if (r.lastUsedAt != null && (best?.lastUsedAt == null || r.lastUsedAt > best.lastUsedAt)) {
        best = r;
      }
    }
    return best?.path ?? list[0]?.path ?? "";
  }

  onMount(() => {
    listRepos()
      .then(({ repos: r, recentWindowDays }) => {
        repos = r;
        recentRepoWindowDays = recentWindowDays;
        // initialRepo arrives as the realpath'd form (activeRepo / session.repoPath), but
        // RepoSelect keys on RepoEntry.path — which differs for a symlinked repo root. Match
        // on either and canonicalize to .path so a symlinked in-focus repo still preselects.
        // Fall back to the most-recently-used non-hidden repo when the seed isn't a known
        // repo, so the picker never opens on a stale/hidden repo.
        const match = r.find((repo) => repo.path === repoPath || repo.realPath === repoPath);
        repoPath =
          match?.path ?? (defaultRepoPath(r.filter((repo) => !repo.hidden)) || r[0]?.path || "");
      })
      .catch(() => {});
  });

  const parsedNumber = $derived(Number.parseInt(issueInput.trim(), 10));
  const valid = $derived(repoPath !== "" && Number.isInteger(parsedNumber) && parsedNumber > 0);

  function submit() {
    if (valid) phase = "run";
  }
</script>

{#if phase === "run"}
  <EpicDiagnosisModal {repoPath} parent={parsedNumber} {onclose} />
{:else}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onclose();
    }}
  >
    <div
      class="card bracket"
      role="dialog"
      aria-modal="true"
      aria-label={m.epic_diag_entry_title()}
      use:dialog={{ onclose }}
    >
      <div class="chead">
        <span class="micro">{m.epic_diag_entry_title()}</span>
        <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
      </div>

      <form
        class="content"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div class="field">
          <span class="flabel">{m.epic_diag_entry_repo_label()}</span>
          <RepoSelect
            {repos}
            windowDays={recentRepoWindowDays}
            value={repoPath}
            onchange={(p) => (repoPath = p)}
            hideHidden
          />
        </div>

        <div class="field">
          <label class="flabel" for="epic-diag-issue">{m.epic_diag_entry_issue_label()}</label>
          <input
            id="epic-diag-issue"
            class="num-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            placeholder={m.epic_diag_entry_issue_placeholder()}
            bind:value={issueInput}
          />
        </div>

        <p class="hint"><GlossaryText text={m.epic_diag_entry_hint()} /></p>

        <div class="actions">
          <button type="submit" class="gbtn primary" disabled={!valid}>
            {m.epic_diag_entry_submit()}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  /* Mirrors EpicDiagnosisModal's overlay/card/bracket recipe so the entry step and the
     diagnosis it opens read as one surface. */
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
    padding: 16px;
  }
  .card {
    position: relative;
    box-sizing: border-box;
    width: min(460px, 100%);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-blue);
    font-family: var(--font-mono);
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }
  .x:hover {
    color: var(--color-amber);
  }

  .content {
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .flabel {
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* --fs-lg (16px) meets the body-text a11y floor and avoids iOS focus-zoom (mirrors
     the command bar's search well). */
  .num-input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    padding: 10px 12px;
    border-radius: 2px;
  }
  .num-input:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  .hint {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }

  /* Canonical .gbtn recipe from /design-system (scoped-duplicated — Svelte scopes styles
     per-component and there is no global .gbtn in app.css). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Modal action a11y floor: 44×44px tap targets on mobile. */
  @media (max-width: 768px) {
    .gbtn {
      min-height: 44px;
      padding: 2px 14px;
    }
  }
</style>
