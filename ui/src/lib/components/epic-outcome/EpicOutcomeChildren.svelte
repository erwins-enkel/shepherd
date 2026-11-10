<script lang="ts">
  import type { CompletedEpicChild } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { firstSafeHttpUrl } from "#lib/url.js";

  // #3838: a finished epic's sub-tasks, each with its issue and PR link.
  let { children }: { children: CompletedEpicChild[] } = $props();
  let open = $state(false);
  const included = $derived(children.filter((c) => c.integrated).length);
  const rows = $derived(
    children.map((c) => ({
      ...c,
      issueHref: firstSafeHttpUrl(c.url),
      prHref: c.integrated ? firstSafeHttpUrl(c.prUrl) : null,
      prLabel:
        c.prNumber != null
          ? m.integrated_epics_pr_ref({ number: c.prNumber })
          : m.integrated_epics_pr_ref_nonum(),
      showPr: c.integrated && (c.prUrl != null || c.prNumber != null),
      named: c.title !== `#${c.number}`,
    })),
  );
</script>

<section>
  <button class="toggle" type="button" aria-expanded={open} onclick={() => (open = !open)}
    ><span aria-hidden="true">{open ? "▾" : "▸"}</span>
    {m.succeeded_epics_children_heading({ included, total: children.length })}</button
  >
  {#if open}
    <ul>
      {#each rows as c (c.number)}
        <li>
          <div class="line">
            <span class="mark" class:excluded={!c.integrated} aria-hidden="true"
              >{c.integrated ? "✓" : "–"}</span
            >
            <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URLs -->
            <a class="ref" href={c.issueHref ?? undefined} target="_blank" rel="noopener noreferrer"
              >#{c.number}</a
            >
            {#if c.showPr}<a
                class="ref"
                href={c.prHref ?? undefined}
                target="_blank"
                rel="noopener noreferrer">{c.prLabel}</a
              >{/if}
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {#if !c.integrated}<span class="excluded">{m.integrated_epics_child_closed()}</span
              >{/if}
          </div>
          {#if c.named}<div class="title">{c.title}</div>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .toggle {
    display: inline-flex;
    gap: 5px;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-micro);
    text-align: left;
    cursor: pointer;
  }
  .toggle:focus-visible {
    outline: 2px solid var(--color-ink-bright);
    outline-offset: 2px;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    font-size: var(--fs-micro);
  }
  .mark {
    color: var(--color-muted);
  }
  .ref {
    font-family: var(--font-mono);
    color: var(--color-ink);
    text-decoration: none;
  }
  a.ref[href]:hover {
    color: var(--color-ink-bright);
    text-decoration: underline;
  }
  .excluded {
    color: var(--color-amber);
  }
  .title {
    margin: 3px 0 0 15px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  @media (pointer: coarse) {
    .toggle {
      min-height: 44px;
    }
  }
</style>
