<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { approveEpicNext, overrideEpicBaseHold, reworkEpicBase, updateEpic } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import { scopeLabel } from "../epic-auto-fix";
  import {
    baseReworkFailedText,
    holdActionLabel,
    type DrainHoldView,
    type HoldAction,
  } from "../epic-hold";
  import "./halt-controls.css";

  // #3457: a drain hold the epic's run area explains, as one line at the epic's list row and in
  // the repo overview — the same halt line as the sandbox gates' (#3455) with its scope chip, red
  // while it stops the run, amber while it waits on the operator — and the action that already
  // exists for it, one click away. The line goes once the drain no longer reports the hold;
  // without one (`view` null) it renders nothing.
  let {
    repoPath,
    parent,
    view,
    onopensession = undefined,
    onopenautomation = undefined,
  }: {
    repoPath: string;
    /** The epic the drain runs; null in label mode (only a repo hold shows then). */
    parent: number | null;
    view: DrainHoldView | null;
    onopensession?: (sessionId: string) => void;
    /** Switch to the Automation tab — where the project bootstrap lives. */
    onopenautomation?: () => void;
  } = $props();

  // A way out shows only where it can run: a callback from the host, or an epic to act on.
  const actions = $derived(view?.actions.filter(available) ?? []);
  let busy = $state(false);

  function available(action: HoldAction): boolean {
    if (action.kind === "bootstrap_view") return !!onopenautomation;
    if (action.kind === "open_session") return !!onopensession;
    if (action.kind === "bootstrap_override") return true;
    return parent != null;
  }

  function failed(text: string, key: string) {
    toasts.info(text, { alert: true, key });
  }

  async function perform(action: HoldAction, epic: number) {
    switch (action.kind) {
      case "usage_lift":
        return updateEpic(repoPath, epic, { ignoreUsageCeiling: true }).catch(() =>
          failed(m.epic_update_failed(), "epic-update-fail"),
        );
      case "base_resolve":
        return reworkEpicBase(repoPath, epic).catch((err: unknown) =>
          failed(baseReworkFailedText(err), "epic-base-fail"),
        );
      case "base_continue":
        return overrideEpicBaseHold(repoPath, epic, action.override).catch(() =>
          failed(m.epic_base_action_failed(), "epic-base-fail"),
        );
      case "approve":
        return approveEpicNext(repoPath, epic).catch(() =>
          failed(m.epic_approve_failed(), "epic-approve-fail"),
        );
    }
  }

  async function run(action: HoldAction) {
    if (action.kind === "bootstrap_view") return onopenautomation?.();
    if (action.kind === "open_session") return onopensession?.(action.sessionId);
    if (busy) return;
    busy = true;
    try {
      if (action.kind === "bootstrap_override") await repoBootstrap.setOverride(repoPath, true);
      else if (parent != null) await perform(action, parent);
    } finally {
      busy = false;
    }
  }
</script>

{#if view}
  <div
    class={["hold", view.tone === "wait" && "wait"]}
    data-epic-hold={view.code}
    data-tone={view.tone}
    data-scope={view.scope}
  >
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
      {#if view.tone === "wait"}
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      {:else}
        <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" />
        <path d="M12 7.5v5.5M12 16.6h.01" />
      {/if}
    </svg>
    <span class={["hc-chip", "hc-own", view.tone === "wait" && "wait"]}
      >{scopeLabel(view.scope)}</span
    >
    <span class="text"><span class="what">{view.what}</span> {view.text}</span>
    {#if actions.length}
      <span class="acts">
        {#each actions as action (action.kind)}
          <!-- Inside the list row's option: neither its click nor its keys may select the row or
             move the list. -->
          <button
            class={["hc-gbtn", action.kind === "approve" && "hc-primary"]}
            type="button"
            disabled={busy}
            aria-busy={busy}
            data-epic-hold-action={action.kind}
            onclick={(e) => {
              e.stopPropagation();
              void run(action);
            }}
            onkeydown={(e) => e.stopPropagation()}>{holdActionLabel(action)}</button
          >
        {/each}
      </span>
    {/if}
  </div>
{/if}

<style>
  /* EpicRowHalt's line (#3455): the red wash that reads as the reason nothing starts. */
  .hold {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 6px 8px;
    background: var(--wash-attention);
    border: 1px solid color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    border-radius: 2px;
    cursor: default;
  }
  /* Waiting on the operator, not stopped: amber. */
  .hold.wait {
    background: color-mix(in srgb, var(--color-amber) 7%, var(--color-panel));
    border-color: color-mix(in srgb, var(--color-amber) 45%, var(--color-line));
  }
  .mark {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--color-red);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .wait .mark {
    stroke: var(--color-amber);
  }
  .hc-chip.wait {
    border-color: color-mix(in srgb, var(--color-amber) 45%, var(--color-line));
    color: color-mix(in srgb, var(--color-amber) 80%, var(--color-ink-bright));
  }
  .text {
    flex: 1 1 170px;
    min-width: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
  .what {
    color: var(--color-ink-bright);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* On the wash amber alone misses 4.5:1 in the light theme: pulled toward the text colour (as
     EpicRowHalt's Fix). */
  .hc-gbtn.hc-primary,
  .hc-gbtn.hc-primary:hover:not(:disabled) {
    color: color-mix(in srgb, var(--color-amber) 80%, var(--color-ink-bright));
  }
</style>
