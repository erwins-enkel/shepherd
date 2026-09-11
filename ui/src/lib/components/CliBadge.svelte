<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { session }: { session: Session } = $props();

  // Whenever it renders it renders on EVERY row, Claude included — a chip on the Codex rows alone
  // would make "no chip" an invisible convention. The rail decides whether to render it at all
  // (providersMixed): one CLI across the whole visible list needs no chip on any row, because there
  // is nothing to tell apart. An absent provider is a pre-field row, which was Claude.
  const codex = $derived((session.agentProvider ?? "claude") === "codex");
  const label = $derived(codex ? m.clibadge_label_codex() : m.clibadge_label_claude());
  const title = $derived(m.clibadge_title({ cli: label }));
</script>

<!-- Deliberately NOT a `statusTip` chip, unlike its neighbours. Those appear only in the states they
     describe, so their hover popover is transient; this one sits on every card of a mixed rail, and the shared
     tooltip takes pointer events on purpose (so it stays open when you move into it) — an always-on
     overlay at the head of a dense chip row would sit between the pointer and the chips after it.
     The label IS the information here, so a native title carries the rest at no such cost. -->
<span class="cli-badge" role="img" aria-label={title} {title}>
  {label}
</span>

<style>
  /* Quiet informational kind-marker — same slate tier as the research/sandbox badges, which is the
     design system's "noted info" level. Never green: that is reserved for actionable-complete. */
  .cli-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-slate);
    border-radius: 2px;
    color: var(--color-slate);
    white-space: nowrap;
    font-weight: 600;
  }
</style>
