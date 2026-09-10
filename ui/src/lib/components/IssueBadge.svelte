<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { issueRef } from "$lib/issue-ref.svelte";

  let { session }: { session: Session } = $props();

  // Read into a local so the message calls below see a non-null number.
  const number = $derived(session.issueNumber);
</script>

<!-- Deliberately NOT a `statusTip` chip: that action raises its trigger above the card's
     full-area `.unit-hit` overlay and swallows the click, which would turn a read-only
     identifier into a dead zone in the middle of the chip row. The number IS the
     information here, so a native title carries the word "issue" at no such cost —
     the same trade CliBadge makes. -->
{#if number != null && issueRef.shown}
  <span
    class="issue-badge"
    role="img"
    aria-label={m.issuebadge_label({ number })}
    title={m.issuebadge_title({ number })}>#{number}</span
  >
{/if}

<style>
  /* Quiet identifier chip, deliberately the same recipe as the open-PR badge it sits beside
     (--color-line border, --color-muted ink, no hue): issue and PR are the two forge
     references a card carries, and they should read as one pair. Accent hues stay reserved
     for state that wants acting on. No `text-transform`: the value is a bare number, so
     there is no casing to normalise. */
  .issue-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    white-space: nowrap;
    font-weight: 600;
  }
</style>
