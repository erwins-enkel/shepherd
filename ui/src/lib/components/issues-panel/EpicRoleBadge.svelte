<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { EpicRole } from "../epic-panel";

  // Neutral role badge of an epic in its repo's run (#2620): "leads" / "winding down" / "queued (k.)"
  // (#2624). Deliberately no status color — the role says who owns the run, not how it is going.
  let { role, position = null }: { role: EpicRole; position?: number | null } = $props();

  const label = $derived(
    role === "leading"
      ? m.epic_role_leading()
      : role === "winding"
        ? m.epic_role_winding()
        : m.epic_role_queued({ position: position ?? 1 }),
  );
</script>

<span class="role-badge" data-role={role}>{label}</span>

<style>
  .role-badge {
    flex: none;
    padding: 0 5px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    line-height: 1.5;
    text-transform: uppercase;
    white-space: nowrap;
  }
</style>
