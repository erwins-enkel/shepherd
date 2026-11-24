<script lang="ts">
  import type { GhGrant, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { anchorPopover } from "#lib/floating-anchor.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { revokeGhGrant } from "#lib/gh-grant.js";

  // #4119: an opt-in gh permission the operator granted this sandboxed session, beside the
  // plan-gate chip. Hover/focus explains it (statusTip); a click opens a small non-modal
  // popover with Revoke, so revoking is one deliberate step and never a hover accident.
  let {
    session,
    coach = false,
  }: {
    session: Pick<Session, "id" | "ghGrants">;
    coach?: boolean;
  } = $props();

  const grants = $derived(session.ghGrants ?? []);

  let openFor = $state<GhGrant["permission"] | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let btnEls = $state<Record<string, HTMLButtonElement | undefined>>({});
  let popEl = $state<HTMLDivElement | null>(null);
  const popId = $props.id();

  const grantedByLabel = (by: string) =>
    by.startsWith("token:")
      ? m.gh_grant_by_token({ name: by.slice("token:".length) })
      : m.gh_grant_by_operator();

  const when = (at: number) =>
    new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  function tip(g: GhGrant): TooltipExplanation {
    return {
      title: m.gh_grant_tip_title({ permission: g.permission }),
      summary: m.gh_grant_tip_summary({
        time: when(g.grantedAt),
        who: grantedByLabel(g.grantedBy),
      }),
      sections: [
        { label: m.gh_grant_tip_allows(), text: m.gh_grant_tip_allows_body() },
        { label: m.gh_grant_tip_revoke(), text: m.gh_grant_tip_revoke_body() },
      ],
      footer: [m.gh_grant_tip_click()],
    };
  }

  function toggle(permission: GhGrant["permission"]) {
    error = null;
    openFor = openFor === permission ? null : permission;
  }

  function close() {
    const opener = openFor ? btnEls[openFor] : undefined;
    openFor = null;
    error = null;
    if (opener?.isConnected) opener.focus();
  }

  async function revoke(permission: GhGrant["permission"]) {
    busy = true;
    error = null;
    const r = await revokeGhGrant(session.id, permission);
    busy = false;
    if (r.ok) close();
    else error = r.error;
  }

  // The grant went away (revoked elsewhere, archive) → drop a stale popover.
  $effect(() => {
    if (openFor && !grants.some((g) => g.permission === openFor)) openFor = null;
  });

  $effect(() => {
    const ref = openFor ? btnEls[openFor] : undefined;
    if (!ref || !popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return;
    }
    popEl.querySelector<HTMLButtonElement>(".ggb-revoke")?.focus();
    return anchorPopover(ref, popEl, 6, "bottom-start");
  });

  // Esc and outside pointerdown dismiss (deferred a tick so the opening click can't close it).
  $effect(() => {
    if (!openFor) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onPointerdown(e: PointerEvent) {
      const t = e.target as Node;
      const opener = openFor ? btnEls[openFor] : undefined;
      if (!popEl?.contains(t) && !opener?.contains(t)) close();
    }
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKeydown);
      window.addEventListener("pointerdown", onPointerdown);
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
    };
  });
</script>

{#each grants as g (g.permission)}
  <button
    bind:this={btnEls[g.permission]}
    class="gh-grant-chip"
    type="button"
    aria-label={m.gh_grant_badge_aria({ permission: g.permission })}
    aria-haspopup="dialog"
    aria-expanded={openFor === g.permission}
    aria-controls={openFor === g.permission ? popId : undefined}
    onclick={() => toggle(g.permission)}
    use:statusTip={{ text: tip(g), navigates: true }}
    use:coachTarget={coach ? "gh-workflows-grant" : ""}
  >
    {g.permission}
  </button>
{/each}

{#if openFor}
  {@const permission = openFor}
  <!-- Small anchored, non-blocking popover (no scrim per the design-system rule). -->
  <div
    bind:this={popEl}
    id={popId}
    class="ggb-pop"
    role="dialog"
    aria-label={m.gh_grant_menu_label({ permission })}
    popover="manual"
  >
    <button
      class="ggb-revoke"
      type="button"
      disabled={busy}
      aria-busy={busy}
      onclick={() => revoke(permission)}
    >
      {m.gh_grant_revoke_action({ permission })}
    </button>
    {#if error}
      <p class="ggb-error" role="alert">{error}</p>
    {/if}
  </div>
{/if}

<style>
  /* Same chip geometry as the plan-gate / goal chips beside it. Amber: a widened credential is
     a live "watch this" state, not a verdict — never green. */
  .gh-grant-chip {
    display: inline-block;
    font: inherit;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, var(--color-amber) 70%, var(--color-line));
    border-radius: 2px;
    background: transparent;
    color: var(--color-amber);
    white-space: nowrap;
    cursor: pointer;
  }
  .gh-grant-chip:hover,
  .gh-grant-chip[aria-expanded="true"] {
    background: var(--color-hover);
  }
  .gh-grant-chip:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }
  [popover].ggb-pop {
    position: fixed;
    inset: auto;
    margin: 0;
    max-width: min(320px, calc(100vw - 16px));
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--color-bg) 70%, transparent);
  }
  .ggb-revoke {
    display: block;
    width: 100%;
    padding: 9px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-red);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .ggb-revoke:hover:not(:disabled),
  .ggb-revoke:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .ggb-revoke:disabled {
    cursor: progress;
    opacity: 0.7;
  }
  .ggb-error {
    margin: 4px 11px 6px;
    color: var(--color-red);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
  @media (pointer: coarse) {
    .ggb-revoke {
      min-height: 44px;
    }
  }
</style>
