<script lang="ts">
  import { epicDrafts } from "$lib/epic-draft.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    sessionId,
    epicAuthoring,
    folded = false,
    onreview,
  }: {
    sessionId: string;
    /** Whether this session is an epic-authoring session (drives whether the bar shows). */
    epicAuthoring: boolean;
    /**
     * Whether the Viewport's secondary chrome is folded away (phone). A draft awaiting review
     * survives the fold — `headerCollapsed` is persisted, so a folded operator would otherwise
     * have no path to approve/abort at all.
     */
    folded?: boolean;
    /** Open the review dialog. Hosted by Viewport (outside .viewport), never by this bar. */
    onreview: () => void;
  } = $props();

  // Load the draft once when the bar mounts / the session changes (survives a page reload);
  // WS `session:epic-draft` events keep it fresh thereafter.
  $effect(() => {
    if (epicAuthoring) void epicDrafts.load(sessionId);
  });

  const draft = $derived(epicDrafts.get(sessionId) ?? null);
  const status = $derived(draft?.status ?? null);
  const children = $derived(draft?.children ?? []);
  const awaiting = $derived(status === "draft" && children.length > 0);
  const hasDraft = $derived(draft !== null && children.length > 0);
  const visible = $derived((epicAuthoring || draft !== null) && (!folded || awaiting));

  const statusChip = $derived(
    status === "approved"
      ? m.epicdraft_status_approved()
      : status === "materializing"
        ? m.epicdraft_status_materializing()
        : awaiting
          ? m.epicdraft_awaiting_chip()
          : "",
  );
</script>

{#if visible}
  <!-- One row, never more: the draft itself lives in EpicDraftModal, so the terminal keeps the
       column. Everything here is a summary + the way in. -->
  <div
    class="edp"
    class:is-awaiting={awaiting}
    role="region"
    aria-label={m.epicdraft_panel_title()}
  >
    <span class="edp-title">{m.epicdraft_panel_title()}</span>
    {#if statusChip}
      <span
        class="edp-chip"
        class:edp-chip-awaiting={awaiting}
        class:edp-chip-busy={status === "materializing"}
        class:edp-chip-done={status === "approved"}
      >
        {#if awaiting}<span class="edp-dot" aria-hidden="true"></span>{/if}{statusChip}
      </span>
    {/if}

    {#if hasDraft}
      <span class="edp-count">{m.epicdraft_children_label({ count: children.length })}</span>
      <button type="button" class="edp-cta" class:is-awaiting={awaiting} onclick={onreview}>
        {awaiting ? m.epicdraft_review_cta() : m.epicdraft_view_cta()}
      </button>
    {:else}
      <span class="edp-empty">{m.epicdraft_empty()}</span>
    {/if}
  </div>
{/if}

<style>
  .edp {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
    padding: 4px 10px;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    min-width: 0;
  }
  .is-awaiting {
    background: color-mix(in oklab, var(--color-amber) 6%, var(--color-panel));
  }

  .edp-title {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .edp-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .edp-chip-awaiting {
    color: var(--color-amber);
  }
  .edp-chip-busy {
    color: var(--color-faint);
  }
  .edp-chip-done {
    color: var(--status-done);
  }
  .edp-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
  }

  .edp-count,
  .edp-empty {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .edp-cta {
    margin-left: auto;
    flex: none;
    min-height: 44px;
    background: none;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 2px 12px;
    cursor: pointer;
    line-height: 1.4;
  }
  .edp-cta:hover,
  .edp-cta:focus-visible {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }
  .edp-cta.is-awaiting {
    color: var(--color-amber);
    border-color: var(--color-amber);
    font-weight: 600;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .edp-cta.is-awaiting:hover,
  .edp-cta.is-awaiting:focus-visible {
    color: var(--color-amber);
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 22px -8px var(--color-amber);
  }
</style>
