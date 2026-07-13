<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { Session } from "$lib/types";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";
  import { broadcast as apiBroadcast } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let { sessions, onclose }: { sessions: Session[]; onclose: () => void } = $props();

  let selected = new SvelteSet<string>();
  let text = $state("");
  // Id of the steer whose pick button set the current text (null once the operator
  // edits the field by hand). Tracked by id so the stale-clear below never wipes
  // free-form text that merely happens to equal a bound steer's text.
  let pickedId = $state<string | null>(null);
  let sending = $state(false);
  let result = $state<string | null>(null);
  let failed = $state(false);
  // Highest-blast-radius action in the app: one click arms, second (within 3s)
  // fires — mirrors the decommission/merge confirm so no fat-finger blasts the herd.
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  const allSelected = $derived(sessions.length > 0 && selected.size === sessions.length);
  const canSend = $derived(text.trim().length > 0 && selected.size > 0 && !sending);

  // Currently-selected target sessions, resolved from the id set.
  const selectedSessions = $derived(sessions.filter((s) => selected.has(s.id)));
  // A steer-bar steer is offerable iff it's universal, or every currently-selected
  // target's repo matches its allowlist (and there IS at least one target selected —
  // otherwise a bound steer would show with nothing to validate it against).
  const availableSteers = $derived(
    steers.list.filter(
      (s) =>
        s.inSteerBar &&
        (!s.repos?.length ||
          (selectedSessions.length > 0 &&
            selectedSessions.every((sess) =>
              steerAppliesToRepo(s, repos.nameFor(sess.repoPath), sess.agentProvider ?? "claude"),
            ))),
    ),
  );

  // Any change to who/what is sent invalidates the confirm — re-arm from scratch.
  function disarm() {
    clearTimeout(armTimer);
    armed = false;
  }

  // If the target selection changes underneath a picked bound steer (e.g. a
  // flowagent-only steer was picked, then a non-flowagent target got added), the
  // picked steer may no longer be valid for every current target — clear it so a
  // broadcast can't fire a steer at a session it was never scoped for. Keyed by the
  // picked id, so only a genuinely-picked steer is cleared, never matching free-form text.
  $effect(() => {
    if (pickedId == null) return;
    if (!availableSteers.some((s) => s.id === pickedId)) {
      text = "";
      pickedId = null;
      disarm();
    }
  });

  function toggle(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    disarm();
  }
  function toggleAll() {
    if (allSelected) {
      selected.clear();
    } else {
      for (const s of sessions) selected.add(s.id);
    }
    disarm();
  }

  async function send() {
    if (!canSend) return;
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    sending = true;
    result = null;
    failed = false;
    try {
      const r = await apiBroadcast(text.trim(), [...selected]);
      if (r.delivered + r.queued === 0) {
        // Nothing reached any agent (all targets offline/dead-pane) — a literal no-op.
        // Surface it like a failure so the dialog stays open with Retry, not a "sent 0" toast.
        result = m.broadcast_failed();
        failed = true;
        sending = false;
        return;
      }
      // Confirmation outlives the dialog: a toast names the reach after close. Honest about
      // queued-on-busy (those agents act only after their current turn) so a busy-herd
      // broadcast no longer reads as a no-op.
      if (r.queued === 0 && r.offline === 0) {
        toasts.info(m.toast_broadcast_delivered({ delivered: r.delivered }));
      } else {
        toasts.info(
          m.toast_broadcast_result({
            delivered: r.delivered,
            queued: r.queued,
            offline: r.offline,
          }),
        );
      }
      onclose();
    } catch {
      result = m.broadcast_failed();
      failed = true;
      sending = false;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.broadcast_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.broadcast_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <div class="row-head">
      <span class="micro">{m.broadcast_targets()}</span>
      <button type="button" class="link" onclick={toggleAll}>
        {allSelected ? m.broadcast_clear_all() : m.broadcast_select_all()}
      </button>
    </div>
    <div class="targets">
      {#if sessions.length === 0}
        <div class="placeholder">{m.broadcast_no_sessions()}</div>
      {:else}
        {#each sessions as s (s.id)}
          <label class="target">
            <input type="checkbox" checked={selected.has(s.id)} onchange={() => toggle(s.id)} />
            <span class="nm">{s.name}</span>
          </label>
        {/each}
      {/if}
    </div>

    <span class="micro">{m.broadcast_steer()}</span>
    <div class="picks">
      <!-- broadcast steers running sessions, so only steer-bar-scoped entries apply,
           further gated so a repo-bound steer only offers when every current target matches -->
      {#each availableSteers as s (s.id)}
        <button
          type="button"
          class="pick"
          class:on={pickedId === s.id}
          onclick={() => {
            pickedId = s.id;
            text = s.text;
          }}
        >
          {#if s.emoji}<span aria-hidden="true">{s.emoji}</span>{/if}
          {s.label}
        </button>
      {/each}
    </div>
    <textarea
      bind:value={text}
      oninput={() => {
        pickedId = null;
        disarm();
      }}
      rows="2"
      data-1p-ignore
      placeholder={m.broadcast_placeholder()}
      aria-label={m.broadcast_textarea_aria()}></textarea>

    {#if result}
      <div class="result" class:failed>
        <span>{result}</span>
        {#if failed}
          <button type="button" class="retry" disabled={!canSend} onclick={send}
            >{m.common_retry()}</button
          >
        {/if}
      </div>
    {/if}

    <button class="run" class:armed type="button" disabled={!canSend} onclick={send}>
      {#if sending}
        {m.broadcast_sending()}
      {:else if armed}
        {m.broadcast_confirm_send({ count: selected.size })}
      {:else}
        {m.broadcast_send_to({ count: selected.size })}
      {/if}
    </button>
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
    z-index: 20;
  }
  .card {
    width: min(460px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .link {
    background: transparent;
    border: 0;
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
  }
  .targets {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .target {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .target:last-child {
    border-bottom: 0;
  }
  .placeholder {
    padding: 14px 12px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }
  .picks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pick {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    padding: 5px 10px;
    cursor: pointer;
  }
  .pick.on {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  textarea {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px;
    resize: vertical;
  }
  .result {
    color: var(--color-amber);
    font-size: var(--fs-meta);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .result.failed {
    color: var(--color-red);
  }
  .retry {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 8px;
    cursor: pointer;
  }
  .retry:hover:not(:disabled) {
    border-color: var(--color-amber);
  }
  .retry:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
  }
  .run {
    margin-top: 4px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* armed: the same inset-glow confirm state used for decommission/merge */
  .run.armed:not(:disabled) {
    box-shadow: inset 0 0 22px -10px var(--color-amber);
    background: var(--color-hover);
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
  }
</style>
