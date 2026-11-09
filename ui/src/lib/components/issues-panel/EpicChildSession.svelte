<script lang="ts">
  import { firstSafeHttpUrl } from "#lib/url.js";
  import type { DrainRunSummary, EpicChild, GitState, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { formatAgo } from "#lib/format.js";
  import { clock } from "#lib/now.svelte.js";
  import { sessionEnvironment } from "#lib/session-env.js";
  import { slotHeldBy } from "../epic-panel";
  import { childPrUrl } from "../epic-child";
  import SessionPhaseBar from "./SessionPhaseBar.svelte";
  import MachineBadge from "../MachineBadge.svelte";
  import { childSessionId } from "../epic-child";
  import { qualifiedDesig } from "#lib/remote-sessions.js";

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

  // A child on another machine: its PR and session are the ones there.
  const prNumber = $derived(child.prNumber ?? child.elsewhere?.prNumber ?? null);
  const prUrl = $derived(childPrUrl({ url: child.url, prNumber }, live?.git?.url));
  const sessionId = $derived(childSessionId(child));
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
  {#if child.elsewhere}<MachineBadge host={child.elsewhere.host} />{/if}
  {#if agent}<span class="agent">{agent}</span>{/if}
  {#if started}<span class="faint">{started}</span>{/if}
  {#if prUrl}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
    <a
      class="pr-link"
      href={firstSafeHttpUrl(prUrl) ?? undefined}
      target="_blank"
      rel="noopener noreferrer">{m.childrun_pr_link({ number: prNumber ?? 0 })} ↗</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {/if}
  {#if sessionId && onopensession}
    <!-- Leads with the task ID, so the operator sees which session it opens. -->
    <button
      class="gbtn open"
      type="button"
      aria-label={live
        ? m.childrun_open_session_desig({ desig: qualifiedDesig(live.session) })
        : undefined}
      onclick={() => onopensession(sessionId)}
      >{#if live}<span class="desig">{live.session.desig}</span
        >{/if}{m.epic_run_open_session()}</button
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
    font-family: var(--font-mono);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    text-decoration: none;
  }
  .pr-link:hover {
    color: var(--color-amber);
    text-decoration: underline;
  }

  /* Canonical .gbtn recipe (/design-system) — scoped copy, as in IssueTaskBox. */
  .gbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .open {
    margin-left: auto;
  }
  .desig {
    font-family: var(--font-mono);
    letter-spacing: 0;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .gbtn {
      min-height: 44px;
    }
  }
</style>
