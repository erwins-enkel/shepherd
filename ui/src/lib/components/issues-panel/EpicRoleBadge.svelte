<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { EpicRole } from "../epic-panel";

  // Role badge of an epic in its repo's run (#2620): "leads" / "winding down" / "queued (k.)"
  // (#2624). Amber marks an epic as part of the run, not how it is going: filled while it leads,
  // outlined while it is queued; winding down stays neutral. `short` drops a queued epic's place
  // from the visible label where a rail beside the row shows it; screen readers still hear it.
  let {
    role,
    position = null,
    short = false,
  }: { role: EpicRole; position?: number | null; short?: boolean } = $props();

  const label = $derived(
    role === "leading"
      ? m.epic_role_leading()
      : role === "winding"
        ? m.epic_role_winding()
        : m.epic_role_queued({ position: position ?? 1 }),
  );
</script>

<span class="role-badge" data-role={role}
  >{#if short && role === "queued"}<span aria-hidden="true">{m.epic_role_queued_short()}</span><span
      class="sr-only">{label}</span
    >{:else}{label}{/if}</span
>

<style>
  .role-badge {
    flex: none;
    padding: 0 5px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    line-height: 1.5;
    text-transform: uppercase;
    white-space: nowrap;
  }
  /* Mixed toward ink-bright (lighter in dark, darker in light) so --color-bg on it stays legible. */
  .role-badge[data-role="leading"] {
    border-color: transparent;
    background: color-mix(in srgb, var(--status-running) 85%, var(--color-ink-bright));
    color: var(--color-bg);
    font-weight: 600;
  }
  .role-badge[data-role="queued"] {
    border-color: color-mix(in srgb, var(--status-running) 55%, var(--color-line-bright));
    color: color-mix(in srgb, var(--status-running) 80%, var(--color-ink-bright));
  }
  /* The full "queued (k.)" for screen readers (no .sr-only util in app.css). */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
