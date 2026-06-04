<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../lib/config";
  import { disableRecorder, enableRecorder, hasAllUrls } from "../lib/recorder-control";
  import type { CaptureConfig } from "../lib/types";

  let config = $state<CaptureConfig>({ ...DEFAULT_CONFIG });
  let saved = $state(false);
  let recorderOn = $state(false);
  let recorderDenied = $state(false);

  loadConfig().then((c) => (config = c));
  hasAllUrls().then((on) => (recorderOn = on));

  const models: CaptureConfig["model"][] = ["default", "opus", "sonnet", "haiku"];

  // Console + network share one recorder behind one <all_urls> permission.
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
    await saveConfig(config);
  }

  async function onSave(e: Event) {
    e.preventDefault();
    await saveConfig(config);
    saved = true;
    setTimeout(() => (saved = false), 1500);
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
        <input type="checkbox" bind:checked={config.signals.a11y} />
        <span>{m.options_signals_a11y_label()}</span>
      </label>
    </fieldset>

    <div class="mt-2 flex items-center gap-3">
      <button class="rounded bg-gray-900 px-3 py-1.5 text-white" type="submit">
        {m.options_save()}
      </button>
      {#if saved}<span class="text-green-600">{m.options_saved()}</span>{/if}
    </div>
  </form>
</main>
