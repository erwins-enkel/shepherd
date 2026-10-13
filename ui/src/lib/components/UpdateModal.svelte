<script lang="ts">
  import type { UpdateStatus, DeployState, DirtyStatus, MachineUpdate } from "#lib/types.js";
  import { applyUpdate, getInstance, getUpdateDirty, StaleDirtyError } from "#lib/api.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { m } from "#lib/paraglide/messages.js";
  import { machineReachable, type MachinePhase } from "#lib/machine-updates.js";
  import SvgFlockOverlay from "#lib/components/SvgFlockOverlay.svelte";
  import UpdateRow from "#lib/components/update/UpdateRow.svelte";
  import UpdateDirty from "#lib/components/update/UpdateDirty.svelte";
  import UpdateMachineRow from "#lib/components/update/UpdateMachineRow.svelte";

  let {
    update,
    machines = [],
    updating = false,
    deploy = null,
    onconfirm,
    onclose,
  }: {
    /** This Shepherd's own update; null before the first check. */
    update: UpdateStatus | null;
    /** Connected machines. With any, the window lists every machine instead of one commit list. */
    machines?: MachineUpdate[];
    updating?: boolean;
    /** set once a launched deploy reports failure → show the captured reason */
    deploy?: DeployState | null;
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();

  const NO_UPDATE: UpdateStatus = {
    behind: 0,
    current: null,
    latest: null,
    commits: [],
    checkedAt: 0,
  };
  const local = $derived(update ?? NO_UPDATE);

  let submitting = $state(false);
  let error = $state<string | null>(null);
  // commit subjects truncate to one line by default; tapping a row expands it to
  // the full width so the whole message is readable — on a phone the single line
  // otherwise cuts off with an ellipsis and you never see the end
  let expanded = $state<Record<string, boolean>>({});
  const toggle = (sha: string) => (expanded[sha] = !expanded[sha]);

  const busy = $derived(submitting || updating);
  const failed = $derived(deploy?.phase === "failed");
  // while the deploy is in flight, show its captured output so the user sees
  // real progress (install → build → restart) instead of a frozen spinner
  const liveLog = $derived(busy && !failed && deploy?.log ? deploy.log : null);

  // ── dirty-repo flow ────────────────────────────────────────────────────────
  // The tracked dirty state is volatile, so we always fetch it FRESH (never from
  // the cached update status): once proactively when the dialog opens, and again
  // reactively if a deploy fails because the tree blocked the pull / drifted.
  let dirtyProbe = $state<"idle" | "pending" | "clean" | "dirty" | "error">("idle");
  let dirty = $state<DirtyStatus | null>(null);
  // two-click destructive confirm: the first click only arms (no API call)
  let arming = $state(false);
  // shown when the deploy failed because the tree changed since confirmation
  let staleHint = $state(false);

  const displayedSig = $derived(dirty?.sig ?? undefined);

  async function probe() {
    dirtyProbe = "pending";
    arming = false;
    try {
      const d = await getUpdateDirty();
      dirty = d;
      dirtyProbe = d.dirty ? "dirty" : "clean";
    } catch {
      dirty = null;
      dirtyProbe = "error"; // degrade to the normal update UI — never a stuck button
    }
  }

  // proactive: probe once when the dialog mounts on an available update
  $effect(() => {
    if (local.behind > 0 && dirtyProbe === "idle") void probe();
  });

  // reactive: a failed deploy classified dirty/stale → re-probe fresh and route
  // through the same dirty UI (with a "changed since shown" hint for stale)
  $effect(() => {
    if (failed && (deploy?.reason === "dirty" || deploy?.reason === "stale")) {
      staleHint = deploy?.reason === "stale";
      void probe();
    }
  });

  const dirtyReactive = $derived(
    failed && (deploy?.reason === "dirty" || deploy?.reason === "stale"),
  );

  type Mode = "progress" | "loading" | "clean" | "dirty" | "toolarge" | "nowclean" | "rawlog";
  // once a fresh probe has resolved: still pending → loading; dirty → dirty (or
  // toolarge when the signature was unavailable); anything else → the normal update UI
  const probeMode = (): Mode => {
    if (dirtyProbe === "pending" || dirtyProbe === "idle") return "loading";
    if (dirtyProbe === "dirty") return dirty?.sig == null ? "toolarge" : "dirty";
    return "clean";
  };
  const mode = $derived.by((): Mode => {
    if (busy) return "progress";
    if (dirtyReactive) {
      if (dirtyProbe === "error") return "rawlog"; // couldn't probe → raw log fallback
      if (dirtyProbe === "clean") return "nowclean"; // tree got cleaned meanwhile
      return probeMode();
    }
    if (failed) return "rawlog";
    return probeMode(); // probe error degrades to the normal (clean) update UI
  });

  /** Clean/retry path: a plain (non-destructive) update. */
  async function runUpdate() {
    submitting = true;
    error = null;
    try {
      await applyUpdate(false);
      onconfirm?.(); // store marks `updating`; the page reloads once the new build is live
    } catch (e) {
      error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      submitting = false;
    }
  }

  /** Destructive path, second click: send the discard with the DISPLAYED sig. */
  async function confirmDiscard() {
    submitting = true;
    error = null;
    try {
      await applyUpdate(true, displayedSig);
      onconfirm?.();
    } catch (e) {
      submitting = false;
      if (e instanceof StaleDirtyError) {
        // the tree drifted since we showed the list → re-render fresh + re-confirm
        dirty = e.dirty;
        dirtyProbe = e.dirty.dirty ? "dirty" : "clean";
        arming = false;
        staleHint = true;
      } else {
        error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      }
    }
  }

  // ── every machine (only with connected machines) ───────────────────────────
  // This Shepherd is one row among its machines. "Update all" starts every machine that is behind
  // at once and runs this one last: its update restarts the server and reloads this page, which
  // would end the following of the others.
  const fleet = $derived(machines.length > 0);
  let self = $state<{ name: string; platform: string } | null>(null);
  $effect(() => {
    if (fleet && self === null) {
      getInstance()
        .then((i) => (self = { name: i.name, platform: i.platform }))
        .catch(() => {});
    }
  });

  let phases = $state<Record<string, MachinePhase>>({});
  const rows: Record<string, ReturnType<typeof UpdateMachineRow> | undefined> = {};
  const phaseOf = (id: string): MachinePhase => phases[id] ?? "idle";
  // this machine is queued behind the others in an "update all"
  let localQueued = $state(false);

  const remoteRunning = $derived(Object.values(phases).some((p) => p === "updating"));
  // still running, or blocked on the operator's decision about a dirty tree
  const remoteUnsettled = $derived(
    Object.values(phases).some((p) => p === "updating" || p === "dirty"),
  );
  const blocking = $derived(busy || remoteRunning || localQueued);

  const remotesReady = $derived(
    machines.filter(
      (mc) =>
        machineReachable(mc) && (mc.update?.behind ?? 0) > 0 && phaseOf(mc.instanceId) === "idle",
    ),
  );
  const localReady = $derived(
    local.behind > 0 &&
      !localQueued &&
      (mode === "clean" || mode === "nowclean" || mode === "rawlog"),
  );
  const readyCount = $derived(remotesReady.length + (localReady ? 1 : 0));
  const selfName = $derived(self?.name ?? m.updatemodal_this_machine());
  const primaryLabel = $derived(
    readyCount === 1
      ? m.updatemodal_update_named({ name: localReady ? selfName : remotesReady[0]!.name })
      : m.updatemodal_update_all({ count: readyCount }),
  );

  const total = $derived(machines.length + 1);
  const remotePending = $derived(
    machines.filter(
      (mc) =>
        machineReachable(mc) &&
        (mc.update?.behind ?? 0) > 0 &&
        phaseOf(mc.instanceId) !== "done" &&
        phaseOf(mc.instanceId) !== "skipped",
    ).length,
  );
  const pending = $derived(remotePending + (local.behind > 0 ? 1 : 0));
  const doneCount = $derived(Object.values(phases).filter((p) => p === "done").length);

  function runAll() {
    const remotes = remotesReady;
    for (const mc of remotes) {
      phases[mc.instanceId] = "updating"; // now, so the queue below already sees them running
      void rows[mc.instanceId]?.start();
    }
    if (!localReady) return;
    if (remotes.length > 0 || remoteUnsettled) localQueued = true;
    else void runUpdate();
  }

  // the others are through (or set aside) → this machine's turn
  $effect(() => {
    if (localQueued && !remoteUnsettled) {
      localQueued = false;
      void runUpdate();
    }
  });

  const lastLine = (log: string): string | null =>
    log
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1)
      ?.slice(0, 160) ?? null;
</script>

<!-- ── blocks shared by both layouts: this Shepherd's own update ── -->
{#snippet progressBlock()}
  <div class="status" aria-live="polite">{m.updatemodal_status()}</div>
  {#if liveLog}
    <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
    <!-- The concise .status line above is the polite announcement; the raw log
         stays silent so a fast-appending stream doesn't re-announce every line. -->
    <pre class="log">{liveLog}</pre>
  {/if}
{/snippet}

{#snippet rawlogBlock()}
  <div class="failure">
    <div class="err">
      {m.updatemodal_deploy_failed()}
      {#if deploy?.exitCode != null}
        <span class="code">{m.updatemodal_exit_code({ code: deploy.exitCode })}</span>
      {/if}
    </div>
    {#if deploy?.log}
      <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
      <pre class="log">{deploy.log}</pre>
    {/if}
  </div>
{/snippet}

{#snippet discardButton()}
  {#if arming}
    <button type="button" class="run danger" onclick={confirmDiscard} disabled={busy}>
      {m.updatemodal_discard_confirm_yes()}
    </button>
  {:else}
    <button type="button" class="run danger" onclick={() => (arming = true)}>
      {m.updatemodal_discard_and_update()}
    </button>
  {/if}
{/snippet}

<!-- ── the local row's state cell and detail (fleet layout) ── -->
{#snippet localStatus()}
  {#if localQueued}
    <span class="muted">{m.updatemodal_row_waiting()}</span>
  {:else if mode === "progress"}
    <span class="spin" aria-hidden="true"></span>
    <span class="amber">{m.updatemodal_updating()}</span>
  {:else if local.behind <= 0}
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
    >
    <span class="muted">{m.updatemodal_row_current()}</span>
  {:else if mode === "dirty" || mode === "toolarge"}
    <span class="err">{m.updatemodal_row_blocked()}</span>
  {:else if mode === "rawlog"}
    <span class="err">{m.updatemodal_row_failed()}</span>
  {:else}
    <button
      type="button"
      class="run small"
      aria-label={m.updatemodal_update_named({ name: selfName })}
      onclick={runUpdate}
      disabled={blocking || mode === "loading"}>{m.updatemodal_row_update()}</button
    >
  {/if}
{/snippet}

{#snippet localDetail()}
  <div class="local-detail">
    {#if mode === "progress"}
      {@render progressBlock()}
    {:else if mode === "dirty" || mode === "toolarge"}
      <UpdateDirty {dirty} body={m.updatemodal_dirty_body()} stale={staleHint} {arming}>
        {#snippet actions()}
          {#if arming}
            <button type="button" class="later small" onclick={() => (arming = false)}>
              {m.common_cancel()}
            </button>
          {/if}
          {#if mode === "dirty"}{@render discardButton()}{/if}
        {/snippet}
      </UpdateDirty>
    {:else if mode === "rawlog"}
      {@render rawlogBlock()}
      <div class="row-actions">
        <button type="button" class="run small" onclick={runUpdate} disabled={blocking}>
          {m.updatemodal_retry()}
        </button>
      </div>
    {:else if mode === "nowclean"}
      <div class="status">{m.updatemodal_now_clean()}</div>
    {/if}
    {#if error}<div class="err">{error}</div>{/if}
  </div>
{/snippet}

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !blocking) onclose?.();
  }}
>
  {#if busy}
    <SvgFlockOverlay placement="backdrop" />
  {/if}
  <div
    class="card bracket"
    class:fleet
    role="dialog"
    aria-modal="true"
    aria-label={m.updatemodal_available()}
    use:dialog={{ onclose: () => !blocking && onclose?.() }}
  >
    {#if busy}
      <SvgFlockOverlay placement="sheet" />
    {/if}
    <div class="card-content">
      <div class="chead">
        <span class="micro">{m.updatemodal_available()}</span>
        {#if !blocking}
          <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
            >✕</button
          >
        {/if}
      </div>

      {#if fleet}
        <div class="summary">
          {#if blocking}
            <span class="count">{doneCount}</span>
            <span class="micro"
              >{m.updatemodal_machines_running({ total: doneCount + pending })}</span
            >
          {:else if pending === 0}
            <span class="count">{total}</span>
            <span class="micro">{m.updatemodal_machines_all_current({ total })}</span>
          {:else}
            <span class="count">{pending}</span>
            <span class="micro"
              >{pending === 1
                ? m.updatemodal_machines_summary_one({ total })
                : m.updatemodal_machines_summary_other({ total })}</span
            >
          {/if}
          {#if local.latest}
            <span class="target">{m.updatemodal_target({ sha: local.latest })}</span>
          {/if}
        </div>

        <ul class="machines">
          <UpdateRow
            name={selfName}
            local={self !== null}
            platform={self?.platform ?? null}
            from={local.current}
            to={local.latest}
            behind={local.behind}
            at={local.current ? m.updatemodal_row_at({ sha: local.current }) : null}
            commits={local.commits}
            progress={liveLog ? lastLine(liveLog) : null}
            status={localStatus}
            detail={mode === "progress" ||
            mode === "dirty" ||
            mode === "toolarge" ||
            mode === "rawlog" ||
            mode === "nowclean" ||
            error
              ? localDetail
              : undefined}
          />
          {#each machines as mc (mc.instanceId)}
            <UpdateMachineRow
              bind:this={rows[mc.instanceId]}
              machine={mc}
              onphase={(p) => (phases[mc.instanceId] = p)}
            />
          {/each}
        </ul>

        {#if localReady && remotesReady.length > 0 && !blocking}
          <p class="note">
            <svg viewBox="0 0 24 24" aria-hidden="true"
              ><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></svg
            >
            <span>{m.updatemodal_local_last()}</span>
          </p>
        {/if}

        <div class="actions">
          {#if !blocking}
            <button type="button" class="later" onclick={() => onclose?.()}>
              {pending === 0 ? m.updatemodal_done() : m.updatemodal_later()}
            </button>
          {/if}
          {#if blocking}
            <button type="button" class="run" disabled>{m.updatemodal_updating()}</button>
          {:else if readyCount > 0}
            <button type="button" class="run" onclick={runAll}>{primaryLabel}</button>
          {/if}
        </div>
      {:else}
        <div class="summary">
          <span class="count">{local.behind}</span>
          <span class="micro"
            >{local.behind === 1
              ? m.updatemodal_commits_one()
              : m.updatemodal_commits_other()}</span
          >
          {#if local.current && local.latest}
            <span class="shas micro">{local.current} → {local.latest}</span>
          {/if}
        </div>

        <div class="commits">
          {#each local.commits as c (c.sha)}
            <button
              type="button"
              class="commit"
              class:expanded={expanded[c.sha]}
              aria-expanded={!!expanded[c.sha]}
              title={c.subject}
              onclick={() => toggle(c.sha)}
            >
              <span class="row">
                <span class="sha">{c.sha}</span>
                <span class="subject">{c.subject}</span>
              </span>
            </button>
          {/each}
        </div>

        {#if mode === "progress"}
          {@render progressBlock()}
        {/if}

        {#if mode === "dirty" || mode === "toolarge"}
          <UpdateDirty
            {dirty}
            body={m.updatemodal_dirty_body()}
            stale={staleHint}
            arming={arming && mode === "dirty"}
          />
        {/if}

        {#if mode === "nowclean"}
          <div class="status">{m.updatemodal_now_clean()}</div>
        {/if}

        {#if mode === "rawlog"}
          {@render rawlogBlock()}
        {/if}

        {#if error}<div class="err">{error}</div>{/if}

        <div class="actions">
          {#if !busy}
            <button
              type="button"
              class="later"
              onclick={() => (arming ? (arming = false) : onclose?.())}
            >
              {arming ? m.common_close() : m.updatemodal_later()}
            </button>
          {/if}

          {#if mode === "dirty"}
            {@render discardButton()}
          {:else if mode === "toolarge"}
            <!-- no destructive action offered; the operator resolves it manually -->
          {:else}
            <button
              type="button"
              class="run"
              onclick={runUpdate}
              disabled={busy || mode === "loading"}
            >
              {busy
                ? m.updatemodal_updating()
                : mode === "rawlog" || mode === "nowclean"
                  ? m.updatemodal_retry()
                  : m.updatemodal_update_now()}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
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
    z-index: 1;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    overflow-x: clip;
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .card-content {
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  .summary .count {
    color: var(--color-amber);
    font-size: var(--fs-2xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .summary .shas {
    margin-left: auto;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .commits {
    /* shrinkable flex child: without min-height the list refuses to shrink
       below its content and 16 commits push the actions off-screen */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .commit {
    display: block;
    width: 100%;
    margin: 0;
    padding: 2px 0;
    background: transparent;
    border: 0;
    text-align: left;
    font-family: inherit;
    font-size: var(--fs-base);
    color: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .commit .row {
    display: flex;
    gap: 9px;
    align-items: flex-start;
  }
  .commit:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 2px;
  }
  .commit .sha {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .commit .subject {
    color: var(--color-ink-bright);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* tapped open → wrap the full subject across the available width */
  .commit.expanded .subject {
    white-space: normal;
    word-break: break-word;
  }
  /* touch devices: roomier rows so a single commit is easy to hit and read */
  @media (pointer: coarse) {
    .commit {
      padding: 8px 0;
    }
    .commit .row {
      min-height: 28px;
      align-items: center;
    }
    .commit.expanded .row {
      align-items: flex-start;
    }
    .commits {
      gap: 0;
    }
    .commit + .commit {
      border-top: 1px solid var(--color-line);
    }
  }
  .status {
    color: var(--color-amber);
    font-size: var(--fs-base);
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-base);
  }
  .failure {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .failure .code {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    margin-left: 6px;
  }
  .loghead {
    color: var(--color-muted);
  }
  .log {
    flex: 1 1 96px;
    margin: 0;
    min-height: 96px;
    max-height: 200px;
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
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
  /* destructive variant: same recipe, danger hue (traffic-light semantics) */
  .run.danger {
    border-color: var(--color-red);
    color: var(--color-red);
    box-shadow: inset 0 0 18px -10px var(--color-red);
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* ── every machine ── */
  .card.fleet {
    width: min(640px, 100%);
  }
  .fleet .summary {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .target {
    margin-left: auto;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .machines {
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    padding: 0;
    border: 1px solid var(--color-line);
    background: var(--color-panel-2);
  }
  .local-detail {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .note {
    margin: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
  }
  .note svg {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .muted {
    color: var(--color-muted);
  }
  .amber {
    color: var(--color-amber);
  }
  .mark {
    width: 13px;
    height: 13px;
    flex: none;
    fill: none;
    stroke: var(--color-muted);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .spin {
    width: 11px;
    height: 11px;
    flex: none;
    border: 2px solid var(--color-amber);
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
  .later.small,
  .run.small {
    padding: 6px 12px;
    font-size: var(--fs-meta);
  }
  @media (pointer: coarse) {
    .later.small,
    .run.small {
      min-height: 44px;
    }
  }
  /* phones: rise as a full-height sheet (same pattern as NewTask) so the
     commit list gets the whole screen and scrolls internally while the
     actions stay pinned and thumb-reachable above the home indicator */
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
      /* fallback when even fully-shrunk content exceeds the viewport
         (landscape phones): scroll the card rather than clip the actions */
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    .card-content {
      min-height: 100%;
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
    .commits,
    .machines {
      flex-grow: 1; /* fill the sheet so the list, not a void, owns the space */
    }
    .actions .later,
    .actions .run {
      min-height: 44px;
      flex: 1; /* two thumb-width targets instead of two slivers at the edge */
    }
    .actions {
      margin-top: auto; /* pin to the bottom even when few commits */
    }
    /* the target drops under the count instead of squeezing the sentence */
    .target {
      flex-basis: 100%;
      margin-left: 0;
    }
    /* "Update all (3)" needs the wider half of the row */
    .fleet .actions .run {
      flex: 2;
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
