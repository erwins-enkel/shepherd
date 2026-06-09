<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { DEFAULT_CONFIG, loadConfig, saveSignals } from "../lib/config";
  import { persistConfig } from "../lib/config-persist.svelte";
  import { localizeError } from "../lib/localize-error";
  import { disableRecorder, enableRecorder, hasAllUrls } from "../lib/recorder-control";
  import { hostKind, releaseStaleHost, requestHostPermission } from "../lib/remote-host";
  import { ping } from "../lib/transport";
  import { TransportError, type CaptureConfig } from "../lib/types";

  let config = $state<CaptureConfig>({ ...DEFAULT_CONFIG });
  let saved = $state(false);
  let saveError = $state(false);
  let recorderOn = $state(false);
  let recorderDenied = $state(false);
  let hostDenied = $state(false);
  let hostUnsupported = $state(false);

  // Connection-test state. `testing` disables the button; exactly one of
  // testOk / testError is set after a run (fail-closed: any failure becomes a
  // visible testError, never a silent success).
  let testing = $state(false);
  let testOk = $state(false);
  let testError = $state("");

  // The extension's own ID — the value to add to SHEPHERD_ALLOWED_HOSTS. Read at
  // runtime (the manifest key pins it) rather than hardcoded.
  const extensionId = chrome.runtime.id;
  const pairingCommand = `SHEPHERD_ALLOWED_HOSTS=${extensionId} bun run start`;
  let copied = $state(false);
  let copyFailed = $state(false);

  loadConfig().then((c) => (config = c));
  hasAllUrls().then((on) => (recorderOn = on));

  const models: CaptureConfig["model"][] = ["default", "opus", "sonnet", "haiku"];

  // Signal toggles persist immediately (only the signals sub-object, via
  // saveSignals — so they don't flush unsaved edits to the text fields, which
  // persist on Save). Console + network share one recorder behind one <all_urls>
  // permission.
  async function toggleRecorder(e: Event) {
    const wanted = (e.target as HTMLInputElement).checked;
    recorderDenied = false;
    if (wanted) {
      const granted = await enableRecorder();
      if (!granted) {
        recorderDenied = true;
        recorderOn = false;
        config.signals.console = false;
        config.signals.network = false;
        return;
      }
      recorderOn = true;
      config.signals.console = true;
      config.signals.network = true;
    } else {
      await disableRecorder();
      recorderOn = false;
      config.signals.console = false;
      config.signals.network = false;
    }
    await saveSignals($state.snapshot(config.signals));
  }

  async function toggleA11y(e: Event) {
    config.signals.a11y = (e.target as HTMLInputElement).checked;
    await saveSignals($state.snapshot(config.signals));
  }

  // A remote (ts.net) base URL needs the optional host permission before it can
  // be reached. Request it FIRST — chrome.permissions.request requires a live
  // user gesture, which an earlier await would break. localhost needs nothing;
  // any other host is rejected (not declared in the manifest).
  async function onSave(e: Event) {
    e.preventDefault();
    // Clear the full shared status set so only this action's outcome shows.
    saved = false;
    saveError = false;
    hostDenied = false;
    hostUnsupported = false;
    testOk = false;
    testError = "";
    const kind = hostKind(config.baseUrl);
    if (kind === "unsupported") {
      hostUnsupported = true;
      return;
    }
    // requestHostPermission MUST be the first await so the user gesture survives.
    if (kind === "remote" && !(await requestHostPermission(config.baseUrl))) {
      hostDenied = true;
      return;
    }
    // Drop incomplete routing rows (either field blank). resolveRepo skips a rule
    // missing a pattern or a repoPath anyway, so persisting a half-filled row would
    // be a silently-dead rule — require both fields to keep one.
    config.routingRules = config.routingRules.filter(
      (r) => r.pattern.trim() !== "" && r.repoPath.trim() !== "",
    );
    // persistConfig snapshots the $state proxy to plain data before it reaches
    // chrome.storage — a proxied array (routingRules) degrades across the
    // serializer and loadConfig's Array.isArray guard would then wipe it to [].
    // prevBaseUrl is read inside the try (before the write) so the whole persist
    // is fail-closed together.
    let prevBaseUrl: string;
    try {
      prevBaseUrl = (await loadConfig()).baseUrl;
      await persistConfig(config);
    } catch {
      // Fail closed: a failed write must surface, never silently flash "Saved".
      saveError = true;
      return;
    }
    // Save succeeded. Releasing the previous remote host's grant is best-effort
    // cleanup (remove needs no gesture, so it runs after Save) — a revoke failure
    // must NOT read as a save failure, since the config is already persisted.
    try {
      await releaseStaleHost(prevBaseUrl, config.baseUrl);
    } catch {
      // A lingering stale ts.net grant is harmless permission hygiene.
    }
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }

  // Ping the configured core and show inline status. Mirrors onSave's gesture
  // handling: for a remote host, requestHostPermission MUST be the first await
  // (a prior await would void the user gesture). A denied/unsupported host stops
  // BEFORE ping — otherwise Chrome blocks the fetch and it misclassifies as
  // "unreachable". All failures route through the shared localizeError path.
  async function onTest(e: Event) {
    e.preventDefault();
    // Clear the full shared status set so only this action's outcome shows.
    saved = false;
    saveError = false;
    hostDenied = false;
    hostUnsupported = false;
    testOk = false;
    testError = "";
    const kind = hostKind(config.baseUrl);
    if (kind === "unsupported") {
      testError = m.options_host_unsupported();
      return;
    }
    testing = true;
    try {
      if (kind === "remote" && !(await requestHostPermission(config.baseUrl))) {
        testError = m.options_host_denied();
        return;
      }
      await ping(fetch, config);
      testOk = true;
    } catch (err) {
      if (err instanceof TransportError) {
        testError = localizeError(err.kind, err.message, config.baseUrl);
      } else {
        testError = localizeError(
          "unknown",
          err instanceof Error ? err.message : "",
          config.baseUrl,
        );
      }
    } finally {
      testing = false;
    }
  }

  async function copyExtensionId() {
    copied = false;
    copyFailed = false;
    try {
      await navigator.clipboard.writeText(extensionId);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard write can reject (denied permission / non-secure context);
      // fail-closed with visible feedback rather than a silent no-op.
      copyFailed = true;
      setTimeout(() => (copyFailed = false), 3000);
    }
  }
</script>

<main class="mx-auto max-w-md p-6 font-sans text-sm text-gray-900">
  <h1 class="mb-4 text-lg font-semibold">{m.options_title()}</h1>
  <form class="flex flex-col gap-3" onsubmit={onSave}>
    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_baseurl_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="url"
        bind:value={config.baseUrl}
        placeholder={m.options_baseurl_placeholder()}
      />
      <span class="text-xs text-gray-500">{m.options_baseurl_hint()}</span>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_token_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="password"
        bind:value={config.token}
        autocomplete="off"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_repopath_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="text"
        bind:value={config.repoPath}
        placeholder={m.options_repopath_placeholder()}
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_basebranch_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="text"
        bind:value={config.baseBranch}
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_model_label()}</span>
      <select class="rounded border border-gray-300 px-2 py-1" bind:value={config.model}>
        {#each models as model (model)}
          <option value={model}>{model === "default" ? m.options_model_default() : model}</option>
        {/each}
      </select>
    </label>

    <fieldset class="mt-2 flex flex-col gap-2 border-t border-gray-200 pt-3">
      <legend class="text-gray-600">{m.options_signals_title()}</legend>

      <label class="flex items-center gap-2">
        <input type="checkbox" checked={recorderOn} onchange={toggleRecorder} />
        <span>{m.options_recorder_label()}</span>
      </label>
      <span class="text-xs text-gray-500">{m.options_recorder_allsites_note()}</span>
      {#if recorderDenied}
        <span class="text-xs text-red-600">{m.options_recorder_denied()}</span>
      {/if}

      <label class="flex items-center gap-2">
        <input type="checkbox" checked={config.signals.a11y} onchange={toggleA11y} />
        <span>{m.options_signals_a11y_label()}</span>
      </label>
    </fieldset>

    <fieldset class="mt-2 flex flex-col gap-2 border-t border-gray-200 pt-3">
      <legend class="text-gray-600">{m.options_routing_title()}</legend>
      <span class="text-xs text-gray-500">{m.options_routing_hint()}</span>

      {#each config.routingRules as rule (rule)}
        <div class="flex items-center gap-2">
          <input
            class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1"
            type="text"
            bind:value={rule.pattern}
            placeholder={m.options_routing_pattern_ph()}
          />
          <input
            class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1"
            type="text"
            bind:value={rule.repoPath}
            placeholder={m.options_routing_repo_ph()}
          />
          <button
            type="button"
            class="shrink-0 text-red-600"
            aria-label={m.options_routing_remove()}
            onclick={() => (config.routingRules = config.routingRules.filter((r) => r !== rule))}
          >
            {m.options_routing_remove()}
          </button>
        </div>
      {/each}

      <button
        type="button"
        class="self-start text-blue-600 underline"
        onclick={() =>
          (config.routingRules = [...config.routingRules, { pattern: "", repoPath: "" }])}
      >
        {m.options_routing_add()}
      </button>
    </fieldset>

    <div class="mt-2 flex items-center gap-3">
      <button class="rounded bg-gray-900 px-3 py-1.5 text-white" type="submit">
        {m.options_save()}
      </button>
      <button
        type="button"
        class="rounded border border-gray-300 px-3 py-1.5 disabled:opacity-50"
        onclick={onTest}
        disabled={testing}
      >
        {testing ? m.options_testing() : m.options_test_connection()}
      </button>
      {#if saved}<span class="text-green-600">{m.options_saved()}</span>{/if}
    </div>
    {#if testOk}
      <span class="text-xs text-green-600">{m.options_conn_ok()}</span>
    {/if}
    {#if testError}
      <span class="text-xs text-red-600">{testError}</span>
    {/if}
    {#if hostUnsupported}
      <span class="text-xs text-red-600">{m.options_host_unsupported()}</span>
    {/if}
    {#if hostDenied}
      <span class="text-xs text-red-600">{m.options_host_denied()}</span>
    {/if}
    {#if saveError}
      <span class="text-xs text-red-600">{m.options_save_failed()}</span>
    {/if}

    <fieldset class="mt-2 flex flex-col gap-2 border-t border-gray-200 pt-3">
      <legend class="text-gray-600">{m.options_pairing_title()}</legend>
      <span class="text-xs text-gray-500">{m.options_pairing_hint()}</span>

      <span class="text-gray-600">{m.options_extension_id_label()}</span>
      <div class="flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded bg-gray-100 px-2 py-1 text-xs">
          {extensionId}
        </code>
        <button
          type="button"
          class="shrink-0 rounded border border-gray-300 px-2 py-1"
          onclick={copyExtensionId}
        >
          {copied ? m.options_copied() : m.options_copy()}
        </button>
      </div>
      {#if copyFailed}
        <span class="text-xs text-red-600">{m.options_copy_failed()}</span>
      {/if}

      <span class="text-gray-600">{m.options_pairing_command_label()}</span>
      <code class="block overflow-x-auto rounded bg-gray-100 px-2 py-1 text-xs"
        >{pairingCommand}</code
      >
    </fieldset>
  </form>
</main>
