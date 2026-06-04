<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { isConfigured, loadConfig } from "../lib/config";
  import type {
    CaptureConfig,
    CaptureResult,
    TransportErrorKind,
    WorkerRequest,
    WorkerResponse,
  } from "../lib/types";

  type View = "loading" | "needs-config" | "ready" | "submitting" | "done" | "error";

  let view = $state<View>("loading");
  let config = $state<CaptureConfig | null>(null);
  let capture = $state<CaptureResult | null>(null);
  let prompt = $state("");
  let desig = $state("");
  let errorMsg = $state("");

  function send(req: WorkerRequest): Promise<WorkerResponse> {
    return chrome.runtime.sendMessage(req) as Promise<WorkerResponse>;
  }

  function localizeError(kind: TransportErrorKind | "capture", message: string): string {
    switch (kind) {
      case "origin":
        return m.err_origin();
      case "auth":
        return m.err_auth();
      case "confinement":
        return m.err_confinement();
      case "unreachable":
        return m.err_unreachable({ baseUrl: config?.baseUrl ?? "" });
      case "capture":
        return m.popup_cant_capture();
      default:
        return m.err_unknown({ message });
    }
  }

  async function init() {
    const cfg = await loadConfig();
    config = cfg;
    if (!isConfigured(cfg)) {
      view = "needs-config";
      return;
    }
    const res = await send({ type: "capture" });
    if (res.ok && res.type === "capture") {
      capture = res.result;
      view = "ready";
    } else if (!res.ok) {
      errorMsg = localizeError(res.errorKind, res.message);
      view = "error";
    }
  }

  async function submit() {
    if (!capture) return;
    if (prompt.trim() === "") {
      errorMsg = m.popup_empty_prompt();
      view = "error";
      return;
    }
    view = "submitting";
    const res = await send({
      type: "spawn",
      payload: {
        prompt,
        metadata: capture.metadata,
        screenshotDataUrl: capture.screenshotDataUrl,
      },
    });
    if (res.ok && res.type === "spawn") {
      desig = res.desig;
      view = "done";
    } else if (!res.ok) {
      errorMsg = localizeError(res.errorKind, res.message);
      view = "error";
    }
  }

  init();
</script>

<main class="flex w-[380px] flex-col gap-3 p-3 font-sans text-sm text-gray-900">
  <h1 class="font-semibold">{m.popup_title()}</h1>

  {#if view === "loading"}
    <p class="text-gray-500">{m.popup_capturing()}</p>
  {:else if view === "needs-config"}
    <p class="text-gray-600">{m.popup_no_config()}</p>
    <button
      class="self-start rounded bg-gray-900 px-3 py-1.5 text-white"
      onclick={() => chrome.runtime.openOptionsPage()}
    >
      {m.popup_open_options()}
    </button>
  {:else if view === "done"}
    <p class="rounded bg-green-50 px-3 py-2 text-green-700">{m.popup_success({ desig })}</p>
  {:else if capture}
    <img
      class="w-full rounded border border-gray-200"
      src={capture.screenshotDataUrl}
      alt={m.popup_screenshot_alt()}
    />

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.popup_prompt_label()}</span>
      <textarea
        class="min-h-20 rounded border border-gray-300 px-2 py-1"
        bind:value={prompt}
        placeholder={m.popup_prompt_placeholder()}
      ></textarea>
    </label>

    <p class="text-xs text-gray-500">
      {m.popup_repo_label()}: <span class="font-mono">{config?.repoPath}</span>
    </p>

    {#if view === "error"}
      <p class="rounded bg-red-50 px-3 py-2 text-red-700">{errorMsg}</p>
    {/if}

    <button
      class="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
      onclick={submit}
      disabled={view === "submitting"}
    >
      {view === "submitting" ? m.popup_submitting() : m.popup_submit()}
    </button>
  {:else if view === "error"}
    <p class="rounded bg-red-50 px-3 py-2 text-red-700">{errorMsg}</p>
  {/if}
</main>
