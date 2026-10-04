<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, getApnsConfig, listPushDevices } from "$lib/api";
  import { pushState, enablePush, disablePush, currentDeviceId, type PushStatus } from "$lib/push";
  import type { ApnsStatus, PushDevice } from "$lib/types";
  import HighlightText from "./HighlightText.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import NotificationsApnsBlock from "./NotificationsApnsBlock.svelte";
  import NotificationsDeviceRow from "./NotificationsDeviceRow.svelte";
  import "./settings-controls.css";
  import { m } from "$lib/paraglide/messages";

  // Notifications section (#2696): native iOS push set up without a shell — the APNs key is
  // uploaded here, validated by the server and never shown again — plus every device that
  // receives pushes, with its categories, a test send and removal. Reduced mode and this
  // browser's own subscription moved here from the Device section so push lives in one place.
  let {
    reducedPushMode = false,
    reducedPushBusy = false,
    onToggleReducedPush,
    query = "",
  }: {
    reducedPushMode?: boolean;
    reducedPushBusy?: boolean;
    onToggleReducedPush?: () => void;
    /** Active settings-search query — highlights this panel's indexed labels. */
    query?: string;
  } = $props();

  let apns = $state<ApnsStatus | null>(null);
  let devices = $state<PushDevice[]>([]);
  let loading = $state(true);
  /** "session": the server wants an interactive operator login, not a token. */
  let loadError = $state<"" | "failed" | "session">("");
  let thisDeviceId = $state<string | null>(null);
  let push = $state<PushStatus>({ supported: false, permission: "unsupported", subscribed: false });
  let pushBusy = $state(false);

  function stateLabel(s: ApnsStatus["state"]): string {
    if (s === "configured") return m.settings_notify_state_configured();
    if (s === "error") return m.settings_notify_state_error();
    return m.settings_notify_state_unconfigured();
  }

  async function load() {
    loading = true;
    loadError = "";
    try {
      const [cfg, list] = await Promise.all([getApnsConfig(), listPushDevices()]);
      apns = cfg;
      devices = list.devices ?? [];
    } catch (e) {
      loadError = e instanceof ApiError && e.status === 403 ? "session" : "failed";
    } finally {
      loading = false;
    }
  }

  async function refreshBrowser() {
    push = await pushState();
    thisDeviceId = push.subscribed ? await currentDeviceId() : null;
  }

  async function refreshApns() {
    apns = await getApnsConfig().catch(() => apns);
  }

  async function removed(d: PushDevice) {
    devices = devices.filter((x) => x.id !== d.id);
    if (d.id === thisDeviceId) await refreshBrowser();
  }

  async function toggleBrowser() {
    if (pushBusy) return;
    pushBusy = true;
    try {
      if (push.subscribed) await disablePush();
      else await enablePush();
      await refreshBrowser();
      devices = (await listPushDevices().catch(() => ({ devices }))).devices ?? devices;
    } finally {
      pushBusy = false;
    }
  }

  onMount(() => {
    void load();
    void refreshBrowser();
  });
</script>

<div class="block">
  <div class="head">
    <span class="micro"><HighlightText text={m.settings_notify_ios_title()} {query} /></span>
    {#if apns}
      <span
        class="badge"
        class:ok={apns.state === "configured"}
        class:bad={apns.state === "error"}
        data-testid="apns-state">{stateLabel(apns.state)}</span
      >
    {/if}
  </div>
  <p class="hint"><HighlightText text={m.settings_notify_ios_hint()} {query} /></p>
  {#if loading}
    <p class="hint">{m.common_loading()}</p>
  {:else if loadError === "session"}
    <p class="hint err" role="alert">{m.settings_notify_session_required()}</p>
  {:else if loadError}
    <p class="hint err" role="alert">{m.settings_notify_load_failed()}</p>
    <button type="button" class="set-gbtn retry" onclick={load}>{m.common_retry()}</button>
  {:else if apns}
    <NotificationsApnsBlock bind:apns />
  {/if}
</div>

<div class="block">
  <span class="micro"><HighlightText text={m.settings_notify_devices_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_notify_devices_hint()} {query} /></p>
  {#if reducedPushMode}<p class="hint">{m.settings_reduced_push_disabled_note()}</p>{/if}
  {#if !loading && !loadError && devices.length === 0}
    <p class="hint">{m.settings_notify_devices_empty()}</p>
  {:else if !loading && !loadError}
    <ul class="devices">
      {#each devices as d (d.id)}
        <NotificationsDeviceRow
          device={d}
          thisBrowser={d.id === thisDeviceId}
          {reducedPushMode}
          ontested={d.kind === "ios" ? refreshApns : undefined}
          onremoved={() => removed(d)}
        />
      {/each}
    </ul>
  {/if}
</div>

<div class="block">
  <span class="micro"><HighlightText text={m.settings_notify_browser_title()} {query} /></span>
  {#if !push.supported}
    <p class="hint">{m.settings_push_unsupported()}</p>
  {:else if push.permission === "denied"}
    <p class="hint">{m.settings_push_denied()}</p>
  {:else}
    <button type="button" class="set-run start" disabled={pushBusy} onclick={toggleBrowser}>
      {#if pushBusy}…{:else if push.subscribed}{m.settings_push_disable()}{:else}{m.settings_push_enable()}{/if}
    </button>
  {/if}
</div>

<div class="block">
  <span class="micro"><HighlightText text={m.settings_reduced_push_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_reduced_push_hint()} {query} /></p>
  <div class="start">
    <SettingToggle
      checked={reducedPushMode}
      disabled={reducedPushBusy}
      label={m.settings_reduced_push_title()}
      onchange={() => onToggleReducedPush?.()}
    />
  </div>
</div>

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .hint.err {
    color: var(--color-red);
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
  /* Bright ink, not green: a working transport is a state, not a READY call to action. */
  .badge.ok {
    border-color: var(--color-ink);
    color: var(--color-ink-bright);
  }
  .badge.bad {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .retry,
  .start {
    align-self: flex-start;
  }
  .devices {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
</style>
