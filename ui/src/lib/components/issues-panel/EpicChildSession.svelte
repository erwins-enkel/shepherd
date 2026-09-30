<script lang="ts">
  import type { DrainRunSummary, EpicChild, GitState, Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { sessionEnvironment } from "$lib/session-env";
  import { slotHeldBy } from "../epic-panel";
  import { childPrUrl } from "../epic-child";
  import SessionPhaseBar from "./SessionPhaseBar.svelte";

  // Body of an epic child's "Sitzung" run area (#2622): phase bar, agent, start time, PR link,
  // "Open session", and — while it holds an agent slot — who gets that slot next. Without a
  // live session in the store (archived / not loaded) only the PR link and open action remain.
  let {
    child,
    live = null,
    runSummary = null,
    onopensession = undefined,
  }: {
    child: EpicChild;
    live?: { session: Session; git?: GitState } | null;
    runSummary?: DrainRunSummary | null;
    onopensession?: (sessionId: string) => void;
  } = $props();

  const prUrl = $derived(childPrUrl(child, live?.git?.url));
  const agent = $derived.by(() => {
    if (!live) return "";
    const s = live.session;
    const cli = s.agentProvider === "codex" ? m.agent_provider_codex() : m.agent_provider_claude();
    return [cli, ...sessionEnvironment(s).segments].join(" · ");
  });
  const started = $derived(
    live ? m.childrun_started({ age: formatAgo(clock.current - live.session.createdAt) }) : "",
  );

  // Handover note: only while this child holds a slot — the slot then goes to the run's next
  // startable issue (the leading epic's next child).
  const handover = $derived.by(() => {
    if (!slotHeldBy(runSummary, child.number) || !runSummary) return "";
    const next = runSummary.next.find((n) => n !== child.number) ?? null;
    if (next == null) return m.childrun_then({ handover: m.epic_run_handover_free() });
    const text =
      runSummary.leadingEpic == null
        ? m.epic_run_handover_issue({ issue: next })
        : m.epic_run_handover({ issue: next, epic: runSummary.leadingEpic });
    return m.childrun_then({ handover: text });
  });
</script>

{#if live}
  <SessionPhaseBar session={live.session} git={live.git} />
{/if}

<div class="meta">
  {#if agent}<span class="agent">{agent}</span>{/if}
  {#if started}<span class="faint">{started}</span>{/if}
  {#if prUrl}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
    <a class="pr-link" href={prUrl} target="_blank" rel="noopener noreferrer"
      >{m.childrun_pr_link({ number: child.prNumber ?? 0 })} ↗</a
    >
  {/if}
  {#if child.sessionId && onopensession}
    <button class="link" type="button" onclick={() => onopensession(child.sessionId!)}
      >{m.epic_run_open_session()}</button
    >
  {/if}
</div>

{#if handover}
  <p class="note">{handover}</p>
{/if}

<style>
  .meta {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 10px;
  }

  .agent {
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }

  .faint,
  .note {
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .note {
    margin: 0;
  }

  .pr-link {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    text-decoration: none;
  }
  .pr-link:hover {
    color: var(--color-amber);
    text-decoration: underline;
  }

  /* Text-link recipe (as EpicRunSteps' .link). */
  .link {
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover,
  .link:focus-visible {
    color: var(--color-amber);
    outline: none;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .link {
      min-height: 32px;
    }
  }
</style>
