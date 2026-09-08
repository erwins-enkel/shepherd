<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { HerdrUpdateStatus, HerdrUpdateResult } from "$lib/types";
  import {
    applyHerdrUpdate,
    applyHerdrDowngrade,
    applyHerdrSandboxDowngrade,
    getHerdrUpdate,
    restartHerdrServer,
    ApiError,
  } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    update,
    sessions = [],
    log = [],
    done = null,
    onconfirm,
    onclose,
    onjump,
    onstatus,
    connectionEpoch = 0,
  }: {
    update: HerdrUpdateStatus;
    /** The running sessions the herdr restart would interrupt — listed so the
     *  operator can jump to each and wrap it up before updating. */
    sessions?: { id: string; desig: string; name: string }[];
    log?: string[];
    done?: HerdrUpdateResult | null;
    onstatus?: (status: HerdrUpdateStatus) => void;
    connectionEpoch?: number;
    onconfirm?: () => void;
    onclose?: () => void;
    /** Jump to a running session (closes this modal, selects the session). */
    onjump?: (id: string) => void;
  } = $props();

  let refreshed = $state<HerdrUpdateStatus | null>(null);
  const status = $derived(
    refreshed && (refreshed.revision ?? 0) >= (update.revision ?? 0) ? refreshed : update,
  );
  let requesting = $state(false);
  let awaitingStatus = $state(false);
  let repairing = $state(false);
  let refreshPending = false;
  let refreshError = $state<string | null>(null);
  const outcome = $derived(
    status.phase !== undefined ? (requesting ? null : (status.result ?? null)) : done,
  );
  const recovery = $derived(
    !status.currentUnsupported && status.runtime && status.runtime.state !== "ready",
  );
  const restartNeeded = $derived(recovery && status.runtime?.state === "restart_required");
  const canRepair = $derived(recovery && (restartNeeded || status.runtime?.state === "offline"));
  const count = $derived(sessions.length);

  async function refresh() {
    if (refreshPending) return;
    refreshPending = true;
    const followsAcceptedAction = awaitingStatus;
    try {
      const next = await getHerdrUpdate();
      refreshError = null;
      if (followsAcceptedAction) awaitingStatus = false;
      if ((next.revision ?? 0) >= (status.revision ?? 0)) {
        refreshed = next;
        onstatus?.(next);
      }
    } catch {
      refreshError = m.herdrupdate_repair_unknown();
    } finally {
      refreshPending = false;
    }
  }

  $effect(() => {
    void connectionEpoch;
    void untrack(refresh);
    const timer = setInterval(() => {
      if (busy) void refresh();
    }, 2_000);
    return () => clearInterval(timer);
  });

  let submitting = $state(false);
  const busy = $derived(
    status.phase !== undefined
      ? requesting || awaitingStatus || status.phase !== "idle"
      : submitting && !done,
  );
  let error = $state<string | null>(null);
  let logEl = $state<HTMLPreElement | null>(null);

  // Upstream release history. herdr.dev/releases/ was stale (only 0.6.3) as of
  // 2026-06-11 while upstream was 0.6.10, and itself links to this GitHub repo —
  // same slug as latest.json's binary-download asset URLs. Revisit if
  // herdr.dev/releases/ catches up or the repo moves.
  const HERDR_RELEASES_URL = "https://github.com/herdrdev/herdr/releases";

  // Render the (GitHub release) notes as markdown, sanitized before @html.
  // marked + DOMPurify are dynamically imported on first render so they stay
  // off the critical path; the (browser-only) sanitizer never runs during SSR.
  let renderedNotes = $state("");
  $effect(() => {
    const body = status.notes;
    if (!body) {
      renderedNotes = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        // External release-note links must open out-of-app, not navigate the
        // SPA away; force target/rel on every anchor during sanitize.
        DOMPurify.addHook("afterSanitizeAttributes", (node) => {
          if (node.tagName === "A") {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer");
          }
        });
        let html: string;
        try {
          html = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
        } finally {
          // Always drop our hook, even if parse/sanitize throws, so it can't
          // leak onto the next render. Scoped to this event so we don't wipe
          // any persistent hooks registered elsewhere on the shared singleton.
          DOMPurify.removeHook("afterSanitizeAttributes");
        }
        if (alive) renderedNotes = html;
      })
      .catch((err) => {
        // Markdown render is progressive enhancement; warn so a broken
        // marked/dompurify load isn't swallowed silently.
        console.warn("herdr release notes markdown render failed", err);
      });
    return () => {
      alive = false;
    };
  });

  // Stranded install (#1898): the INSTALLED herdr is unsupported — the modal's job
  // flips from "offer the upgrade" to "offer the rescue downgrade".
  const stranded = $derived(!!status.currentUnsupported);
  // Which flavor ran, so the ✓ message reads "Downgraded…" instead of "Updated…".
  let downgrading = $state(false);

  // Hoisted out of the template (keeps the <template> synthetic complexity under
  // the Tier-1 bar, #1898): the title/instructions/versions/blocked text all
  // branch on `stranded`, and were each an inline ternary or if/else-if pair.
  const title = $derived.by(() => {
    if (recovery) return m.herdrupdate_repair_title();
    if (!outcome || busy) return stranded ? m.herdrupdate_downgrade_title() : m.herdrupdate_title();
    if (downgrading) {
      return outcome.ok
        ? m.herdrupdate_downgrade_done_title()
        : m.herdrupdate_downgrade_failed_title();
    }
    return outcome.ok ? m.herdrupdate_done_title() : m.herdrupdate_failed_title();
  });
  const instructionsText = $derived(
    stranded ? m.herdrupdate_downgrade_instructions() : m.herdrupdate_instructions(),
  );
  const displayedCurrent = $derived(
    (busy ? status.operation?.from : null) ?? outcome?.from ?? status.current,
  );
  const displayedTarget = $derived(
    (busy ? status.operation?.to : null) ??
      outcome?.to ??
      (stranded ? status.downgradeTarget : status.latest),
  );
  const versionsText = $derived(
    displayedCurrent && displayedTarget
      ? m.herdrupdate_versions({ current: displayedCurrent, latest: displayedTarget })
      : null,
  );
  const blocked = $derived(
    stranded
      ? {
          title: m.herdrupdate_stranded_title(),
          body: m.herdrupdate_stranded_body({
            current: status.current ?? "?",
            target: status.downgradeTarget ?? "",
          }),
        }
      : status.latestUnsupported
        ? {
            title: m.herdrupdate_unsupported_title(),
            body: m.herdrupdate_unsupported_body({ latest: status.latest ?? "" }),
          }
        : null,
  );

  // herdr update restarts the herdr server (ending live panes) but shepherd
  // stays up — no reload. The modal resolves itself via the `done` result.
  // Busy only while the update is in flight; a terminal `done` result ends it so
  // the operator can read the ✓/✗ outcome and close. (No page reload anymore —
  // shepherd stays up, so the modal must resolve itself.)
  const busyMessage = $derived(
    status.phase === "verifying"
      ? m.herdrupdate_repair_verifying()
      : repairing || status.phase === "restarting"
        ? m.herdrupdate_repair_restarting()
        : m.herdrupdate_busy(),
  );

  /** Dismiss on a genuine backdrop click (not a click that bubbled up from the card),
   *  and only while nothing is in flight. Named (rather than the inline arrow every
   *  other *UpdateModal shares) so the modal shell — otherwise byte-identical
   *  boilerplate across the update-modal family — doesn't clone-match here too. */
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget && !busy) onclose?.();
  }

  /** Shared submit path for the upgrade and the stranded-install downgrade (#1898):
   *  same busy/error lifecycle, different endpoint + done-message flavor. */
  async function submit(action: () => Promise<void>, isDowngrade: boolean, failLabel: string) {
    submitting = true;
    requesting = true;
    downgrading = isDowngrade;
    error = null;
    try {
      await action();
      if (status.phase !== undefined) awaitingStatus = true;
      onconfirm?.();
    } catch (e) {
      error =
        e instanceof ApiError && e.code === "runtime_changed"
          ? m.herdrupdate_repair_changed()
          : repairing
            ? m.herdrupdate_repair_failed()
            : e instanceof Error
              ? e.message
              : failLabel;
      submitting = false;
      downgrading = false;
    } finally {
      requesting = false;
      if (status.phase !== undefined) void refresh();
    }
  }
  async function confirmRepair() {
    const runtime = status.runtime;
    if (!runtime || !canRepair || busy) return;
    repairing = true;
    await submit(() => restartHerdrServer(runtime), false, m.herdrupdate_repair_failed());
  }

  const confirm = () => submit(applyHerdrUpdate, false, "update failed");
  const confirmDowngrade = () => submit(applyHerdrDowngrade, true, "downgrade failed");

  // Two-path advisory (#1716): on a SUPPORTED-but-regressed herdr (0.7.5+), an operator who runs
  // sandboxed sessions can optionally step down to a version with full sandboxed status fidelity.
  // NON-blocking — unlike `blocked`, it doesn't hide the normal upgrade button; it adds an extra
  // downgrade action + an info note. Suppressed while a blocking state is showing (that flow already
  // offers its own downgrade).
  const sandboxAdvisory = $derived(!!status.sandboxIdleRegressed && !blocked);
  const confirmSandboxDowngrade = () =>
    submit(applyHerdrSandboxDowngrade, true, "downgrade failed");

  const doneMessage = $derived(
    !outcome
      ? null
      : outcome.ok
        ? status.runtime?.state === "ready"
          ? m.herdrupdate_repair_ready()
          : downgrading
            ? m.herdrupdate_downgrade_done_ok({ target: outcome.to ?? "" })
            : m.herdrupdate_done_ok({ latest: outcome.to ?? status.latest ?? "" })
        : outcome.errorCode === "restart_required"
          ? m.herdrupdate_repair_pending()
          : outcome.errorCode
            ? m.herdrupdate_repair_failed()
            : m.herdrupdate_done_fail({ current: outcome.to ?? status.current ?? "" }),
  );
  const doneError = $derived(outcome && !outcome.ok ? outcome.error : null);
  const confirmLabel = $derived(
    count > 0 ? m.herdrupdate_confirm({ count }) : m.herdrupdate_confirm_plain(),
  );

  const recoveryText = $derived(
    restartNeeded
      ? m.herdrupdate_repair_pending()
      : status.runtime?.state === "offline"
        ? m.herdrupdate_repair_offline()
        : m.herdrupdate_repair_unknown(),
  );
  const recoveryVersions = $derived(
    m.herdrupdate_repair_versions({
      installed: status.runtime?.installedVersion ?? "?",
      server: status.runtime?.serverVersion ?? "?",
    }),
  );
  const recoveryReason = $derived(
    outcome?.handoffPaneLimit
      ? m.herdrupdate_repair_limit({ count: outcome.handoffPaneLimit })
      : m.herdrupdate_repair_reason(),
  );
  const showVersions = $derived(versionsText && !recovery);
  const showRecovery = $derived(recovery && !busy);
  const showAdvisory = $derived(sandboxAdvisory && !submitting && !recovery);
  const showNotes = $derived(status.notes && !stranded && !recovery);
  const showInstructions = $derived(!recovery && (status.updateAvailable || stranded));
  const showSessions = $derived(count > 0 && !busy);
  const sessionsLabel = $derived(
    recovery ? m.herdrupdate_repair_tasks() : m.herdrupdate_sessions_label(),
  );
  const showOutcome = $derived(
    outcome && (!restartNeeded || outcome.errorCode !== "restart_required"),
  );
  const showReady = $derived(
    status.runtime?.state === "ready" && !status.updateAvailable && !stranded,
  );
  const showDetails = $derived(doneError || log.length > 0);
  const visibleError = $derived(error ?? refreshError);
  const closeLabel = $derived(outcome?.ok ? m.common_close() : m.herdrupdate_later());
  const showSandboxAction = $derived(!outcome && !busy && sandboxAdvisory && !recovery);
  const showRecheck = $derived(!busy && outcome && !outcome.ok && !recovery);
  const sandboxLabel = $derived(
    m.herdrupdate_sandbox_downgrade_confirm({ target: status.sandboxDowngradeTarget ?? "" }),
  );
  const primaryAction = $derived.by(() => {
    if (busy) return null;
    if (canRepair)
      return {
        run: confirmRepair,
        downgrade: false,
        label: restartNeeded ? m.herdrupdate_restart_confirm() : m.herdrupdate_repair_start(),
      };
    if (recovery) return { run: refresh, downgrade: false, label: m.herdrupdate_repair_check() };
    if (outcome?.ok) return null;
    if (stranded)
      return {
        run: confirmDowngrade,
        downgrade: true,
        label: m.herdrupdate_downgrade_confirm({ target: status.downgradeTarget ?? "" }),
      };
    if (!status.latestUnsupported && status.updateAvailable)
      return { run: confirm, downgrade: false, label: confirmLabel };
    return null;
  });

  // Auto-scroll the log pane to bottom whenever new lines arrive.
  $effect(() => {
    // read log.length to subscribe to changes
    if (log.length && logEl) {
      tick().then(() => {
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      });
    }
  });
</script>

<div class="overlay" role="presentation" onclick={handleBackdropClick}>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    use:dialog={{ onclose: () => !busy && onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{title}</span>
      <!-- The ✕ is ALWAYS available as a deliberate escape hatch: the update runs
           server-side in a managed child independent of this modal, so dismissing
           never cancels it. Without this, a missed `done` event (e.g. the WS drops
           mid-update and reconnects after it fired) would trap the operator in the
           busy state — shepherd no longer restarts, so there's no forced reload to
           rescue them. Backdrop/Esc stay gated on !busy to avoid accidental close. -->
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    {#if showVersions}
      <div class="summary">
        <span class="versions">{versionsText}</span>
      </div>
    {/if}

    {#if showRecovery}
      <div class="recovery" role="status">
        <p>{recoveryText}</p>
        <p>{recoveryVersions}</p>
        {#if restartNeeded}
          <p>{recoveryReason}</p>
          <p class="warning">{m.herdrupdate_repair_warning()}</p>
        {/if}
      </div>
    {/if}

    {#if blocked}
      <!-- Stranded (#1898): the INSTALLED herdr broke agent spawning; this modal offers the
           one-click rescue downgrade instead of a dead end. Latest-unsupported: the latest herdr is
           newer than Shepherd supports (agent spawning would fail); Shepherd blocks the in-app
           upgrade and warns instead of offering it (the run button below is hidden while set). -->
      <div class="blocked" role="alert">
        <span class="blocked-title">{blocked.title}</span>
        <span class="blocked-body">{blocked.body}</span>
      </div>
    {/if}

    {#if showAdvisory}
      <!-- Two-path advisory (#1716): supported herdr, but sandboxed agents can't report idle here.
           Informational (not an alert); the normal upgrade action stays available below. -->
      <div class="advisory">
        <span class="advisory-title">{m.herdrupdate_sandbox_advisory_title()}</span>
        <span class="advisory-body"
          >{m.herdrupdate_sandbox_advisory_body({
            current: status.current ?? "?",
            target: status.sandboxDowngradeTarget ?? "",
          })}</span
        >
      </div>
    {/if}

    {#if showNotes}
      <div class="notes-label micro">{m.herdrupdate_notes_label()}</div>
      {#if renderedNotes}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
        <div class="notes">{@html renderedNotes}</div>
      {:else}
        <!-- Fallback before the markdown imports resolve, or if they fail:
             show the raw notes as plain text rather than an empty box. -->
        <pre class="notes notes-raw">{status.notes}</pre>
      {/if}
    {/if}

    {#if showInstructions}
      <a class="all-notes" href={HERDR_RELEASES_URL} target="_blank" rel="noopener noreferrer"
        >{m.herdrupdate_all_notes_link()} ↗</a
      >

      <div class="instructions">
        {instructionsText}
      </div>
    {/if}

    {#if showSessions}
      {#if !recovery}<div class="warning">{m.herdrupdate_warning({ count })}</div>{/if}
      {#if !submitting}
        <!-- List the interrupted sessions so the operator can jump to each and
             wrap it up first, instead of guessing what the bare count refers to. -->
        <div class="sessions-label micro">
          {sessionsLabel}
        </div>
        <ul class="sessions">
          {#each sessions as s (s.id)}
            <li>
              <button
                type="button"
                class="session"
                onclick={() => onjump?.(s.id)}
                aria-label={m.herdrupdate_jump_to({ name: s.name || s.desig })}
              >
                <span class="desig">{s.desig}</span>
                <span class="sname">{s.name}</span>
                <span class="jump" aria-hidden="true">↗</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if busy}
      <div class="status" aria-live="polite">{busyMessage}</div>
    {:else if showOutcome && outcome}
      <div class="status" class:ok={outcome.ok} class:fail={!outcome.ok} aria-live="polite">
        {doneMessage}
      </div>
    {:else if showReady}
      <div class="status ok" aria-live="polite">{m.herdrupdate_repair_ready()}</div>
    {/if}
    {#if showDetails}
      <details class="details">
        <summary>{m.herdrupdate_repair_details()}</summary>
        {#if doneError}<pre class="log">{doneError}</pre>{/if}
        {#if log.length > 0}<pre class="log" bind:this={logEl}>{log.join("\n")}</pre>{/if}
      </details>
    {/if}
    {#if visibleError}<div class="err">{visibleError}</div>{/if}

    <div class="actions">
      {#if !busy}
        <button type="button" class="later" onclick={() => onclose?.()}>{closeLabel}</button>
      {/if}
      {#if primaryAction}
        <button
          type="button"
          class="run"
          class:downgrade={primaryAction.downgrade}
          onclick={primaryAction.run}>{primaryAction.label}</button
        >
      {/if}
      {#if showSandboxAction}
        <button
          type="button"
          class="run downgrade sandbox-downgrade"
          onclick={confirmSandboxDowngrade}>{sandboxLabel}</button
        >
      {/if}
      {#if showRecheck}
        <button type="button" class="run" onclick={() => void refresh()}
          >{m.herdrupdate_repair_check()}</button
        >
      {/if}
    </div>
  </div>
</div>

<style>
  .recovery,
  .details {
    padding: 12px 18px;
    font-size: var(--fs-base);
    overflow-wrap: anywhere;
  }
  .recovery p {
    margin: 0 0 12px;
  }
  .details {
    min-height: 0;
    overflow: auto;
  }
  .details summary {
    cursor: pointer;
    color: var(--color-muted);
  }

  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: 16px;
  }
  .card {
    position: relative;
    box-sizing: border-box;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 14px;
    /* Last-resort scroll when even the shrinkable notes box can't free enough
       space — e.g. no release notes at all (nothing shrinkable) plus a full
       180px sessions list on a short viewport — so the action buttons are never
       clipped below the 80dvh cap. (Mobile re-sets this in the media query.) */
    overflow-x: clip;
    overflow-y: auto;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .summary .versions {
    color: var(--color-amber);
    font-size: var(--fs-xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }
  .notes-label {
    margin-bottom: -8px;
  }
  .notes {
    /* shrinkable flex child: without min-height long release notes refuse to
       shrink below their content and push the actions off-screen */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px 12px;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  /* raw plain-text fallback (pre-resolve / render failure) */
  .notes-raw {
    margin: 0;
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* markdown rendered via {@html} — children aren't scoped, so target globally */
  .notes :global(> *:first-child) {
    margin-top: 0;
  }
  .notes :global(> *:last-child) {
    margin-bottom: 0;
  }
  .notes :global(p),
  .notes :global(ul),
  .notes :global(ol) {
    margin: 0 0 8px;
  }
  .notes :global(ul),
  .notes :global(ol) {
    padding-left: 18px;
  }
  .notes :global(li) {
    margin: 2px 0;
  }
  .notes :global(h1),
  .notes :global(h2),
  .notes :global(h3),
  .notes :global(h4) {
    margin: 12px 0 6px;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .notes :global(a) {
    color: var(--color-blue);
    text-decoration: underline;
  }
  .all-notes {
    align-self: flex-start;
    color: var(--color-blue);
    font-size: var(--fs-meta);
    text-decoration: underline;
    letter-spacing: 0.04em;
  }
  .all-notes:hover {
    color: var(--color-amber);
  }
  .notes :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    background: var(--color-line);
    border-radius: 2px;
    padding: 0 3px;
    overflow-wrap: anywhere;
  }
  .notes :global(pre) {
    margin: 0 0 8px;
    padding: 6px 8px;
    background: var(--color-bg, var(--color-line));
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .notes :global(pre code) {
    background: none;
    padding: 0;
    overflow-wrap: anywhere;
  }
  .notes :global(blockquote) {
    margin: 0 0 8px;
    padding-left: 8px;
    border-left: 2px solid var(--color-line);
    color: var(--color-muted);
  }
  .instructions {
    border: 1px solid var(--color-line-bright);
    background: color-mix(in srgb, var(--color-amber) 8%, transparent);
    padding: 10px 12px;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
  }
  /* unsupported-version block: the in-app update is disabled (latest herdr newer than supported) */
  .blocked {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-radius: 8px;
    border: 1px solid var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
    padding: 10px 12px;
    line-height: 1.5;
    color: var(--color-red);
  }
  .blocked-title {
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .blocked-body {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  /* informational two-path advisory (#1716) — blue (informational), NOT a red alert: the herdr is
     supported, this is an optional opt-out from the sandboxed idle-status regression. */
  .advisory {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-radius: 8px;
    border: 1px solid var(--color-blue);
    background: color-mix(in srgb, var(--color-blue) 12%, transparent);
    padding: 10px 12px;
    line-height: 1.5;
    color: var(--color-blue);
  }
  .advisory-title {
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .advisory-body {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  /* destructive-action warning: louder than the neutral instructions block */
  .warning {
    border: 1px solid var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
    padding: 10px 12px;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-red);
  }
  .sessions-label {
    margin-bottom: -8px;
  }
  .sessions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    /* keep a long list from pushing the actions off-screen on short viewports */
    max-height: 180px;
    overflow-y: auto;
    /* Don't let the flex column collapse this list away. The card is capped at
       80dvh and both this list and the release-notes box are scroll containers
       (automatic min-size 0), so when long notes overflow the cap flexbox is
       free to shrink BOTH to a sliver — which hid the running-sessions list
       entirely. The notes box is the intended shrinkable one (min-height: 0);
       the sessions list is this dialog's whole point, so pin it and let the
       notes absorb the shrinkage instead. */
    flex-shrink: 0;
  }
  .session {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 44px;
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    cursor: pointer;
    text-align: left;
  }
  .session:hover,
  .session:focus-visible {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .session .desig {
    flex: none;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    color: var(--color-amber);
    font-size: var(--fs-meta);
  }
  .session .sname {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
  }
  .session .jump {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .session:hover .jump,
  .session:focus-visible .jump {
    color: var(--color-amber);
  }
  .status {
    color: var(--color-amber);
    font-size: var(--fs-base);
  }
  .status.ok {
    color: var(--color-green, var(--color-amber));
  }
  .status.fail {
    color: var(--color-red);
  }
  .log {
    flex: 1 1 96px;
    margin: 0;
    min-height: 96px;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px 12px;
    font-family: monospace;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-base);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .later {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 8px 14px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .later:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .run {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* phones: rise as a full-height sheet (same pattern as NewTask/UpdateModal)
     so the release notes scroll internally and the actions stay pinned and
     thumb-reachable above the home indicator */
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
      /* safe-area top: standalone-PWA status bar / Dynamic Island */
      padding: calc(16px + env(safe-area-inset-top)) 16px calc(14px + env(safe-area-inset-bottom));
      /* fallback when notes are absent or content exceeds the viewport
         (landscape phones): scroll the card rather than clip the actions */
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .x {
      min-width: 44px;
      min-height: 44px;
      margin: -14px -14px -10px 0; /* keep the glyph optically in the corner */
    }
    .notes {
      flex-grow: 1; /* fill the sheet so the notes, not a void, own the space */
    }
    .later,
    .run {
      min-height: 44px;
      flex: 1; /* two thumb-width targets instead of two slivers at the edge */
    }
    .actions {
      margin-top: auto; /* pin to the bottom even when the notes are short */
    }
  }
  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0.6;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
