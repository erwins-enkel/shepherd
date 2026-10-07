<script lang="ts">
  import { untrack } from "svelte";
  import { updatePushDevice, deletePushDevice, testPushDevice } from "$lib/api";
  import type { PushDevice, PushTestResult } from "$lib/types";
  import "./settings-controls.css";
  import { m } from "$lib/paraglide/messages";

  // One registered device in Settings → Notifications (#2696): what it is, its categories, a
  // test send that reports the push service's answer, and removal behind a confirm.
  let {
    device,
    thisBrowser = false,
    reducedPushMode = false,
    ontested,
    onremoved,
  }: {
    device: PushDevice;
    thisBrowser?: boolean;
    reducedPushMode?: boolean;
    /** After any test send — a send moves the server's last-error / last-delivered stamps. */
    ontested?: () => void;
    onremoved: () => void;
  } = $props();

  const categoryRows: { key: keyof PushDevice["categories"]; label: () => string }[] = [
    { key: "agent", label: () => m.settings_push_cat_agent() },
    { key: "reviews", label: () => m.settings_push_cat_reviews() },
    { key: "ci", label: () => m.settings_push_cat_ci() },
  ];

  let categories = $state(untrack(() => device.categories));
  let testing = $state(false);
  let result = $state<PushTestResult | "failed" | null>(null);
  let confirming = $state(false);
  let removing = $state(false);
  let error = $state("");

  const name = $derived(
    device.kind === "ios" ? m.settings_notify_kind_ios() : m.settings_notify_kind_web(),
  );
  const refused = $derived(result === "failed" || (result !== null && !result.delivered));

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function resultText(r: PushTestResult | "failed"): string {
    if (r === "failed") return m.settings_notify_test_failed();
    if (r.delivered === true) return m.settings_notify_test_delivered();
    if (r.reason === "not_configured") return m.settings_notify_test_not_configured();
    const reason = r.reason ?? (r.status ? `HTTP ${r.status}` : "—");
    return m.settings_notify_test_refused({ reason });
  }

  async function toggle(key: keyof PushDevice["categories"]) {
    const prev = categories;
    categories = { ...prev, [key]: !prev[key] }; // optimistic
    error = "";
    try {
      await updatePushDevice(device.id, categories);
    } catch {
      categories = prev;
      error = m.settings_notify_device_update_failed();
    }
  }

  async function sendTest() {
    if (testing) return;
    testing = true;
    try {
      result = await testPushDevice(device.id);
      ontested?.();
    } catch {
      result = "failed";
    } finally {
      testing = false;
    }
  }

  async function remove() {
    if (removing) return;
    removing = true;
    error = "";
    try {
      await deletePushDevice(device.id);
      onremoved();
    } catch {
      error = m.settings_notify_device_remove_failed();
      removing = false;
    }
  }
</script>

<li class="dev">
  <div class="main">
    <span class="head">
      <span class="name">{name}</span>
      {#if thisBrowser}<span class="badge">{m.settings_notify_this_browser()}</span>{/if}
      {#if device.environment === "sandbox"}
        <span class="badge">{m.settings_notify_env_sandbox()}</span>
      {:else if device.environment === "production"}
        <span class="badge">{m.settings_notify_env_production()}</span>
      {/if}
    </span>
    {#if device.userAgent}<span class="ua">{device.userAgent}</span>{/if}
    <span class="meta">
      {m.settings_notify_language({ locale: device.locale })} ·
      {m.settings_notify_registered({ date: formatTime(device.registeredAt) })}
    </span>
    <fieldset class="cats">
      <legend class="set-lbl">{m.settings_push_cat_title()}</legend>
      {#each categoryRows as row (row.key)}
        <label class="cat">
          <input
            type="checkbox"
            checked={categories[row.key]}
            disabled={reducedPushMode}
            onchange={() => toggle(row.key)}
          />
          <span>{row.label()}</span>
        </label>
      {/each}
    </fieldset>
    {#if result}
      <span class="hint" class:err={refused} role="status">{resultText(result)}</span>
    {/if}
    {#if error}<span class="hint err" role="alert">{error}</span>{/if}
  </div>
  <div class="btns">
    <button type="button" class="set-gbtn" disabled={testing} onclick={sendTest}
      >{testing ? m.settings_notify_testing() : m.settings_notify_test()}</button
    >
    {#if confirming}
      <button type="button" class="set-gbtn danger" disabled={removing} onclick={remove}
        >{m.settings_notify_device_remove_yes()}</button
      >
      <button type="button" class="set-gbtn" onclick={() => (confirming = false)}
        >{m.common_cancel()}</button
      >
    {:else}
      <button
        type="button"
        class="set-gbtn"
        aria-label={m.settings_notify_device_remove_aria({ name })}
        onclick={() => (confirming = true)}>{m.settings_notify_device_remove()}</button
      >
    {/if}
  </div>
</li>

<style>
  .dev {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 12px 0;
    border-top: 1px solid var(--color-line);
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1 1 260px;
  }
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .name {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .badge {
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 0 5px;
    border-radius: 2px;
  }
  .ua {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-faint);
    overflow-wrap: anywhere;
  }
  .meta,
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .hint.err {
    color: var(--color-red);
  }
  .cats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 14px;
    border: 0;
    margin: 2px 0 0;
    padding: 0;
  }
  .cats legend {
    padding: 0;
    margin-bottom: 2px;
  }
  .cat {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .btns {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
</style>
