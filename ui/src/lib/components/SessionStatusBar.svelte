<script lang="ts">
  import type { Session, SessionActivity, SessionUsage } from "$lib/types";
  import { providerLabel } from "$lib/reviewer-env";
  import { sessionEnvironment } from "$lib/session-env";
  import { formatTokens, elapsedCoarse } from "$lib/format";
  import { formatUnits } from "$lib/components/usage/format";
  import { isColdResume } from "$lib/cold-resume";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import GlossaryText from "./GlossaryText.svelte";

  // `activity` is the LIVE runtime-identity carrier: the poller persists what it observes, but that
  // write raises no session patch, so a running session's fresh model/effort reaches the client only
  // on this SSE signal. Optional — DoneRecapPanel renders this bar for a concluded session, which
  // has no live signal and reads the persisted `session.runtime*` instead.
  let {
    session,
    usage,
    activity,
  }: { session: Session; usage: SessionUsage | null; activity?: SessionActivity } = $props();

  // Identity shows what the agent ACTUALLY ran wherever that is known (#1823): the model/effort a
  // spawn resolves to is not necessarily what was configured — pushModelFlag applies usage-downgrade
  // and availability fallbacks argv-only, and a session left on "default" passes no flag at all, so
  // only the provider's own runtime log ever names the concrete choice. `sessionEnvironment` is the
  // same resolver the task card uses, so the two surfaces cannot disagree about one run, and it
  // carries the hover title too — one sentence per segment, each naming where THAT segment came
  // from, since a mixed identity (observed model, configured effort) is the ordinary Claude case.
  //
  // The session row's model/effort remain AUTHORITATIVE as the configured fallback: null explicitly
  // means "provider default" (what a replace/relaunch with provider defaults writes), so it must
  // render as "default" rather than resurrecting the pre-replacement model from launch metadata.
  // Only genuinely ABSENT fields (provider on pre-field rows; effort is optional in the client
  // mirror) fall back to launch metadata.
  const launch = $derived(session.launchMetadata ?? null);
  const provider = $derived(session.agentProvider ?? launch?.agent.provider ?? "claude");
  const environment = $derived(
    sessionEnvironment(
      {
        model: session.model,
        effort:
          session.effort === undefined ? (launch?.resolvedLaunch.effort ?? null) : session.effort,
        runtimeModel: session.runtimeModel,
        runtimeEffort: session.runtimeEffort,
      },
      activity,
    ),
  );
  const identity = $derived([providerLabel(provider), ...environment.segments].join(" · "));
  const identityTitle = $derived(environment.tooltip);

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

  // Cold-resume marker (#2042). Priced server-side at the moment the session parked; the only
  // client-side judgement is "has that instant passed", against the same 30s clock the elapsed
  // segment ticks on — so the marker appears when the cache actually expires, not at the next poll.
  const cold = $derived(isColdResume(session, clock.current));
  const coldLabel = $derived(
    m.coldresume_label({ units: formatUnits(session.resumeCostUnits ?? 0) }),
  );
  const coldTitle = $derived(
    m.coldresume_title({
      context: formatTokens(session.contextTokens ?? 0),
      units: formatUnits(session.resumeCostUnits ?? 0),
    }),
  );
</script>

<!-- Deliberately NOT a live region (no role="status"/aria-live): the elapsed tick and the
     usage poll would re-announce to screen readers continuously.
     The group name and the identity segment's accessible name both carry the configured-
     intent caveat (not just the mouse-only hover title), so keyboard/touch/AT users get it
     too — the runtime may substitute the model at spawn without rewriting the row. -->
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
  {#if cold}
    <span class="ssb-sep" aria-hidden="true">·</span>
    <span class="ssb-cold" title={coldTitle}>
      <span aria-hidden="true">⚠</span>
      <GlossaryText text={coldLabel} />
    </span>
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

  /* Cold-resume marker (#2042): the one segment allowed to break the muted meta row, because it
     names money the operator is about to spend by typing into the box below this bar. */
  .ssb-cold {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    color: var(--color-warn);
    cursor: help;
  }
</style>
