<script lang="ts">
  import type { Session, SessionUsage } from "$lib/types";
  import { environmentLabel } from "$lib/reviewer-env";
  import { formatTokens, elapsedCoarse } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";

  let { session, usage }: { session: Session; usage: SessionUsage | null } = $props();

  // Identity reads the session row's model/effort as AUTHORITATIVE: null explicitly means
  // "provider default" (it's what a replace/relaunch with provider defaults writes), so it
  // must render as "default" — falling back to the original launch metadata here would
  // resurrect the pre-replacement model forever. Only fields that can be genuinely ABSENT
  // (provider on pre-field rows; effort is optional in the client mirror) fall back.
  // environmentLabel is the same formatter ReviewInFlightBanner uses for the reviewer, so
  // the task strip and the reviewer strip can never drift apart in wording.
  //
  // These are the CONFIGURED values, labeled as such via the hover title: the runtime may
  // substitute at spawn time without rewriting them — pushModelFlag applies usage-downgrade/
  // availability fallbacks argv-only, and Codex clamps unsupported effort tiers (max → high)
  // while the stored intent keeps the un-clamped tier. Surfacing the EFFECTIVE spawn values
  // needs server-side persistence across every spawn path and is tracked separately.
  const launch = $derived(session.launchMetadata ?? null);
  const provider = $derived(session.agentProvider ?? launch?.agent.provider ?? "claude");
  const identity = $derived(
    environmentLabel(
      provider,
      session.model,
      session.effort === undefined ? (launch?.resolvedLaunch.effort ?? null) : session.effort,
    ),
  );
  const identityTitle = $derived(m.statusbar_identity_title({ identity }));

  // The elapsed segment is SESSION AGE — wall-clock since createdAt (to archive time for
  // archived sessions; archivedAt ?? updatedAt matches DoneRecapPanel's finishedAt
  // fallback) — and its titles say so explicitly: idle stretches and pre-restore downtime
  // are included, because no active-interval tracking exists server-side. Live sessions
  // tick on the shared 30s clock; elapsedCoarse has no seconds, so the tick never reads
  // as a frozen counter.
  const archived = $derived(session.status === "archived");
  const elapsedText = $derived(
    elapsedCoarse(
      session.createdAt,
      archived ? (session.archivedAt ?? session.updatedAt) : clock.current,
    ),
  );
  const elapsedTitle = $derived(
    archived
      ? m.statusbar_elapsed_done_title({ elapsed: elapsedText })
      : m.statusbar_elapsed_live_title({ elapsed: elapsedText }),
  );

  // available:false is a known boundary (Codex, pre-feature, cleaned transcript) — an
  // explained "—", never a fake 0. A true zero reading renders "0 tok".
  const tokensKnown = $derived(usage != null && usage.available);
  const tokensText = $derived(
    usage != null && usage.available
      ? m.viewport_tokens_label({ tokens: formatTokens(usage.total) })
      : "",
  );
  const tokensUnavailableTitle = $derived(
    provider === "codex"
      ? m.statusbar_tokens_unavailable_codex_title()
      : m.statusbar_tokens_unavailable_title(),
  );
</script>

<!-- Deliberately NOT a live region (no role="status"/aria-live): the elapsed tick and the
     usage poll would re-announce to screen readers continuously.
     The group name and the identity segment's accessible name both carry the configured-
     intent caveat (not just the mouse-only hover title), so keyboard/touch/AT users get it
     too — the runtime may substitute model/effort at spawn without rewriting the row. -->
<div class="ssb" role="group" aria-label={m.statusbar_aria()}>
  <span class="ssb-identity" title={identityTitle} aria-label={identityTitle}>{identity}</span>
  <span class="ssb-sep" aria-hidden="true">·</span>
  {#if tokensKnown}
    <span class="ssb-tokens">{tokensText}</span>
  {:else}
    <span
      class="ssb-tokens ssb-unavailable"
      title={tokensUnavailableTitle}
      aria-label={tokensUnavailableTitle}>—</span
    >
  {/if}
  <span class="ssb-sep" aria-hidden="true">·</span>
  <span class="ssb-elapsed" title={elapsedTitle}>{elapsedText}</span>
</div>

<style>
  /* Same chrome recipe as .vp-foot: head wash, hairline top border, meta type. */
  .ssb {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    flex-shrink: 0;
    white-space: nowrap;
    min-width: 0;
  }

  .ssb-identity {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .ssb-sep {
    color: var(--color-faint);
  }

  .ssb-tokens,
  .ssb-elapsed {
    flex-shrink: 0;
  }

  .ssb-unavailable {
    color: var(--color-faint);
    cursor: help;
  }
</style>
