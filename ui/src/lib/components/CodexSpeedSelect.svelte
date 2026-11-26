<script lang="ts">
  import {
    getCodexSpeedOptions,
    putDefaultCodexSpeed,
    putSessionCodexSpeed,
    ApiError,
  } from "#lib/api.js";
  import type { CodexSpeed, CodexSpeedOptions, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { codexSpeedReason } from "#lib/codex-speed.js";

  let {
    session,
    defaultSpeed = "codex",
    modelKey = null,
  }: {
    session?: Session;
    defaultSpeed?: Exclude<CodexSpeed, "standard">;
    modelKey?: string | null;
  } = $props();

  const configured = $derived(session?.codexSpeed ?? defaultSpeed);
  let saved = $state<CodexSpeed | null>(null);
  let options = $state<CodexSpeedOptions | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  const value = $derived(saved ?? configured);
  const launch = $derived(session?.codexSpeedLaunch);
  const pending = $derived(!!session && (launch?.applied ?? "codex") !== value);

  $effect(() => {
    void configured;
    void session?.id;
    saved = null;
  });

  $effect(() => {
    const id = session?.id;
    void session?.model;
    void session?.providerSessionId;
    options = null;
    if (!id && modelKey === null) return;
    let current = true;
    void getCodexSpeedOptions(id).then(
      (result) => {
        if (current) options = result;
      },
      () => {
        if (current) options = { fastUnavailable: "unknown" };
      },
    );
    return () => {
      current = false;
    };
  });

  async function save(select: HTMLSelectElement) {
    if (busy) return;
    const speed = select.value as CodexSpeed;
    const id = session?.id;
    busy = true;
    failure = null;
    try {
      if (id) {
        saved = (await putSessionCodexSpeed(id, speed)).codexSpeed ?? configured;
      } else if (speed !== "standard") {
        saved = (await putDefaultCodexSpeed(speed)).defaultCodexSpeed;
      }
    } catch (error) {
      failure =
        error instanceof ApiError && error.status === 409
          ? codexSpeedReason(error.code)
          : m.codex_speed_save_failed();
      select.value = value;
    } finally {
      busy = false;
    }
  }
</script>

<div class="speed-picker">
  <label>
    <span>{session ? m.codex_speed_session_label() : m.codex_speed_default_label()}</span>
    <select {value} disabled={busy} onchange={(event) => void save(event.currentTarget)}>
      <option value="codex">{m.codex_speed_inherit()}</option>
      {#if session}<option value="standard">{m.codex_speed_standard()}</option>{/if}
      <option value="fast" disabled={options === null || options.fastUnavailable !== null}>
        {m.codex_speed_fast()}
      </option>
    </select>
  </label>
  <p>
    {m.codex_speed_cost()}
    <a
      href="https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex"
      target="_blank"
      rel="noopener"
    >
      {m.codex_speed_pricing()}
    </a>
    <a
      href="https://developers.openai.com/api/docs/guides/fast-mode"
      target="_blank"
      rel="noopener"
    >
      {m.codex_speed_api_pricing()}
    </a>
  </p>
  {#if options?.fastUnavailable}
    <p>{codexSpeedReason(options.fastUnavailable)}</p>
  {:else if options === null}
    <p>{m.codex_speed_checking()}</p>
  {/if}
  {#if value === "standard" && (session?.codexStandardBlocked || options?.standardAvailable === false)}
    <p role="status">{m.codex_speed_standard_refused()}</p>
  {:else if pending}
    <p role="status">
      {session?.status === "archived" ? m.codex_speed_pending_archived() : m.codex_speed_pending()}
    </p>
  {/if}
  {#if value === "fast" && launch?.reason}
    <p>{m.codex_speed_fallback({ reason: codexSpeedReason(launch.reason) })}</p>
  {/if}
  {#if failure}<p role="alert">{failure}</p>{/if}
</div>

<style>
  .speed-picker {
    display: grid;
    gap: 4px;
    padding: 6px 12px;
    font-size: var(--fs-meta);
  }
  label {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  select {
    border: 1px solid var(--color-line);
    border-radius: 4px;
    background: var(--color-head);
    color: inherit;
    font: inherit;
    padding: 3px 6px;
  }
  p {
    margin: 0;
    color: var(--color-muted);
  }
  a {
    color: inherit;
    text-decoration: underline;
  }
</style>
