<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../lib/config";
  import type { CaptureConfig } from "../lib/types";

  let config = $state<CaptureConfig>({ ...DEFAULT_CONFIG });
  let saved = $state(false);

  loadConfig().then((c) => (config = c));

  const models: CaptureConfig["model"][] = ["default", "opus", "sonnet", "haiku"];

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

    <div class="mt-2 flex items-center gap-3">
      <button class="rounded bg-gray-900 px-3 py-1.5 text-white" type="submit">
        {m.options_save()}
      </button>
      {#if saved}<span class="text-green-600">{m.options_saved()}</span>{/if}
    </div>
  </form>
</main>
