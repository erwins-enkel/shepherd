<script lang="ts">
  import { deleteApnsConfig } from "$lib/api";
  import type { ApnsStatus } from "$lib/types";
  import NotificationsApnsForm from "./NotificationsApnsForm.svelte";
  import "./settings-controls.css";
  import { m } from "$lib/paraglide/messages";

  // The iOS-push part of Settings → Notifications (#2696): what is wrong (an unusable key, the
  // last APNs refusal), what is on file — never the key itself — and replace / remove. With no
  // key on file the setup form shows directly.
  let { apns = $bindable() }: { apns: ApnsStatus } = $props();

  let editing = $state(false);
  let confirmRemove = $state(false);
  let removing = $state(false);
  let removeFailed = $state(false);

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function keyErrorText(e: NonNullable<ApnsStatus["keyError"]>): string {
    if (e === "unreadable") return m.settings_notify_key_error_unreadable();
    if (e === "not_p256") return m.settings_notify_key_error_not_p256();
    return m.settings_notify_key_error_invalid();
  }

  function keySummary(s: ApnsStatus): string {
    if (s.env.key) return m.settings_notify_key_env();
    if (s.keySavedAt === null) return m.settings_notify_key_stored_undated();
    const date = new Date(s.keySavedAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    return m.settings_notify_key_stored({ date });
  }

  function saved(s: ApnsStatus) {
    apns = s;
    editing = false;
  }

  async function remove() {
    if (removing) return;
    removing = true;
    removeFailed = false;
    try {
      apns = await deleteApnsConfig();
      confirmRemove = false;
      editing = false;
    } catch {
      removeFailed = true;
    } finally {
      removing = false;
    }
  }
</script>

{#if apns.keyError}
  <p class="hint err" role="alert">{keyErrorText(apns.keyError)}</p>
{/if}
{#if apns.lastError && apns.state === "error"}
  <p class="hint err" role="alert">
    {m.settings_notify_last_error({
      reason: apns.lastError.reason ?? "—",
      status: apns.lastError.status,
      time: formatTime(apns.lastError.at),
    })}
  </p>
{/if}
{#if apns.lastDeliveredAt}
  <p class="hint">{m.settings_notify_last_delivered({ time: formatTime(apns.lastDeliveredAt) })}</p>
{/if}

{#if !apns.hasKey || editing}
  <NotificationsApnsForm
    {apns}
    replacing={apns.hasKey}
    onsaved={saved}
    oncancel={() => (editing = false)}
  />
{:else}
  <dl class="facts">
    <dt>{m.settings_notify_key_label()}</dt>
    <dd>{keySummary(apns)}</dd>
    <dt>{m.settings_notify_key_id_label()}</dt>
    <dd><code>{apns.keyId ?? "—"}</code></dd>
    <dt>{m.settings_notify_team_id_label()}</dt>
    <dd><code>{apns.teamId ?? "—"}</code></dd>
    <dt>{m.settings_notify_topic_label()}</dt>
    <dd><code>{apns.topic}</code></dd>
  </dl>
  <div class="btns">
    <button type="button" class="set-gbtn" onclick={() => (editing = true)}
      >{m.settings_notify_replace()}</button
    >
    {#if apns.keySavedAt !== null && confirmRemove}
      <button type="button" class="set-gbtn danger" disabled={removing} onclick={remove}
        >{m.settings_notify_remove_yes()}</button
      >
      <button type="button" class="set-gbtn" onclick={() => (confirmRemove = false)}
        >{m.common_cancel()}</button
      >
    {:else if apns.keySavedAt !== null}
      <button type="button" class="set-gbtn" onclick={() => (confirmRemove = true)}
        >{m.settings_notify_remove()}</button
      >
    {/if}
  </div>
  {#if removeFailed}<p class="hint err" role="alert">{m.settings_notify_remove_failed()}</p>{/if}
{/if}

<style>
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .hint.err {
    color: var(--color-red);
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 14px;
    margin: 4px 0 0;
  }
  .facts dt {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
  }
  .facts dd {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .facts code {
    font-family: var(--font-mono);
  }
  .btns {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
</style>
