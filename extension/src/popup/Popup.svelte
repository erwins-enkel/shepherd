<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { isConfigured, loadConfig } from "../lib/config";
  import { hasAllUrls } from "../lib/recorder-control";
  import { hasHostPermission, requestHostPermission } from "../lib/remote-host";
  import { resolveRepo } from "../lib/routing";
  import type {
    CaptureConfig,
    CaptureResult,
    DeliveryTarget,
    TransportErrorKind,
    WorkerRequest,
    WorkerResponse,
  } from "../lib/types";
  import type { GatherSignal, SignalToggles } from "../lib/signals";

  type View = "loading" | "needs-config" | "needs-host" | "ready" | "submitting" | "done" | "error";

  let view = $state<View>("loading");
  let config = $state<CaptureConfig | null>(null);
  let capture = $state<CaptureResult | null>(null);
  let prompt = $state("");
  let desig = $state("");
  let errorMsg = $state("");
  let target = $state<DeliveryTarget>("session");
  let issueTitle = $state("");
  let issueUrl = $state("");
  let issueNumber = $state(0);
  let doneKind = $state<"session" | "issue">("session");
  let toggles = $state<SignalToggles>({
    screenshot: true,
    console: false,
    network: false,
    a11y: false,
  });
  let recorderAvailable = $state(false);

  function send(req: WorkerRequest): Promise<WorkerResponse> {
    return chrome.runtime.sendMessage(req) as Promise<WorkerResponse>;
  }

  function localizeError(kind: TransportErrorKind | "capture", message: string): string {
    switch (kind) {
      case "origin":
        return m.err_origin();
      case "auth":
        return m.err_auth();
      case "invalid":
        return m.err_invalid({ message });
      case "too_large":
        return m.err_too_large();
      case "unsupported":
        return m.err_unsupported();
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
    // A remote (ts.net) host's optional permission can be revoked from
    // chrome://extensions after it was configured; without it the spawn fetch
    // fails with a generic "unreachable". Detect it up front and offer a
    // re-grant (a popup button click is a valid user gesture for the request).
    if (!(await hasHostPermission(cfg.baseUrl))) {
      view = "needs-host";
      return;
    }
    toggles = { ...cfg.signals };
    recorderAvailable = await hasAllUrls();
    if (!recorderAvailable) {
      toggles.console = false;
      toggles.network = false;
    }
    await runCapture();
  }

  // Re-request the revoked remote host permission, then resume the normal flow.
  // Triggered by the needs-host button (user gesture); a denial leaves us on the
  // needs-host view so the user can retry.
  async function grantHost() {
    if (!config) return;
    if (await requestHostPermission(config.baseUrl)) await init();
  }

  async function runCapture() {
    view = "loading";
    const res = await send({ type: "capture", toggles });
    if (res.ok && res.type === "capture") {
      capture = res.result;
      view = "ready";
    } else if (!res.ok) {
      errorMsg = localizeError(res.errorKind, res.message);
      view = "error";
    }
  }

  async function setGather(key: GatherSignal, on: boolean) {
    toggles[key] = on;
    await runCapture();
  }

  /**
   * A " · "-joined count line listing only the signals that were actually
   * gathered (a present array — empty included). Signals that weren't gathered
   * (toggle off, or a gather failure) are omitted, so a clean-page a11y capture
   * shows "0 a11y" rather than "0 console · 0 failed · 0 a11y". "" when none.
   */
  function signalSummary(s: CaptureResult["signals"]): string {
    if (!s) return "";
    const parts: string[] = [];
    if (s.console !== undefined) parts.push(m.popup_count_console({ count: s.console.length }));
    if (s.network !== undefined) parts.push(m.popup_count_network({ count: s.network.length }));
    if (s.a11y !== undefined) parts.push(m.popup_count_a11y({ count: s.a11y.length }));
    return parts.join(" · ");
  }

  let summary = $derived(signalSummary(capture?.signals));

  // Routing-resolved effective repo: a matching rule overrides the configured
  // repoPath; with no capture or no match it falls back to the configured repo.
  let effectiveRepo = $derived(
    capture
      ? resolveRepo(capture.metadata.url, config?.routingRules ?? [], config?.repoPath ?? "")
      : (config?.repoPath ?? ""),
  );

  // Prefill the issue title from the page title once it's available, leaving any
  // user edit intact (only fills while still blank).
  $effect(() => {
    if (issueTitle === "" && capture?.metadata.title) issueTitle = capture.metadata.title;
  });

  async function submit() {
    if (!capture) return;
    if (prompt.trim() === "") {
      errorMsg = m.popup_empty_prompt();
      view = "error";
      return;
    }
    if (target === "issue" && issueTitle.trim() === "") {
      errorMsg = m.popup_issue_empty_title();
      view = "error";
      return;
    }
    view = "submitting";
    const req: WorkerRequest =
      target === "issue"
        ? {
            type: "file-issue",
            payload: {
              repoPath: effectiveRepo,
              title: issueTitle,
              prompt,
              metadata: capture.metadata,
              signals: capture.signals,
            },
          }
        : {
            type: "spawn",
            payload: {
              prompt,
              metadata: capture.metadata,
              screenshotDataUrl: capture.screenshotDataUrl,
              attachScreenshot: toggles.screenshot,
              signals: capture.signals,
              repoPath: effectiveRepo,
            },
          };
    const res = await send(req);
    if (res.ok && res.type === "spawn") {
      desig = res.desig;
      doneKind = "session";
      view = "done";
    } else if (res.ok && res.type === "issue") {
      issueNumber = res.number;
      issueUrl = res.url;
      doneKind = "issue";
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
  {:else if view === "needs-host"}
    <p class="text-gray-600">{m.popup_needs_host({ baseUrl: config?.baseUrl ?? "" })}</p>
    <button class="self-start rounded bg-gray-900 px-3 py-1.5 text-white" onclick={grantHost}>
      {m.popup_grant_host()}
    </button>
  {:else if view === "done"}
    {#if doneKind === "issue"}
      <p class="rounded bg-green-50 px-3 py-2 text-green-700">
        <a class="underline" href={issueUrl} target="_blank" rel="noreferrer">
          {m.popup_issue_success({ number: issueNumber })}
        </a>
      </p>
    {:else}
      <p class="rounded bg-green-50 px-3 py-2 text-green-700">{m.popup_success({ desig })}</p>
    {/if}
  {:else if capture}
    <img
      class="w-full rounded border border-gray-200"
      src={capture.screenshotDataUrl}
      alt={m.popup_screenshot_alt()}
    />

    <div class="flex flex-col gap-0.5 text-xs text-gray-500">
      <span class="text-gray-600">{m.popup_metadata_label()}</span>
      <span class="truncate font-mono" title={capture.metadata.url}>{capture.metadata.url}</span>
      <span class="truncate">{capture.metadata.title}</span>
      <span>{capture.metadata.viewportW}×{capture.metadata.viewportH}</span>
    </div>

    <label class="flex flex-col gap-1 text-xs text-gray-600">
      <span>{m.popup_target_label()}</span>
      <select class="rounded border border-gray-300 px-2 py-1 text-gray-900" bind:value={target}>
        <option value="session">{m.popup_target_session()}</option>
        <option value="issue">{m.popup_target_issue()}</option>
      </select>
    </label>

    {#if target === "issue"}
      <label class="flex flex-col gap-1 text-xs text-gray-600">
        <span>{m.popup_issue_title_label()}</span>
        <input
          class="rounded border border-gray-300 px-2 py-1 text-gray-900"
          type="text"
          bind:value={issueTitle}
        />
      </label>
    {/if}

    <fieldset class="flex flex-col gap-1 text-xs text-gray-600">
      <span>{m.popup_attach_label()}</span>
      <label class="flex items-center gap-2" class:opacity-50={target === "issue"}>
        <input type="checkbox" bind:checked={toggles.screenshot} disabled={target === "issue"} />
        <span>{m.signal_screenshot()}</span>
      </label>
      {#if target === "issue"}
        <span class="text-gray-500">{m.popup_issue_no_screenshot()}</span>
      {/if}
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          checked={toggles.a11y}
          onchange={(e) => setGather("a11y", e.currentTarget.checked)}
        />
        <span>{m.signal_a11y()}</span>
      </label>
      <label class="flex items-center gap-2" class:opacity-50={!recorderAvailable}>
        <input
          type="checkbox"
          checked={toggles.console}
          disabled={!recorderAvailable}
          onchange={(e) => setGather("console", e.currentTarget.checked)}
        />
        <span>{m.signal_console()}</span>
      </label>
      <label class="flex items-center gap-2" class:opacity-50={!recorderAvailable}>
        <input
          type="checkbox"
          checked={toggles.network}
          disabled={!recorderAvailable}
          onchange={(e) => setGather("network", e.currentTarget.checked)}
        />
        <span>{m.signal_network()}</span>
      </label>
      {#if !recorderAvailable}
        <button
          type="button"
          class="self-start text-blue-600 underline"
          onclick={() => chrome.runtime.openOptionsPage()}
        >
          {m.popup_signals_locked()}
        </button>
      {/if}
      {#if summary}
        <span class="text-gray-500">{summary}</span>
      {/if}
      {#if capture?.signalErrors?.some((s) => s === "console" || s === "network")}
        <span class="text-amber-600">{m.popup_recorder_reload()}</span>
      {/if}
      {#if capture?.signalErrors?.includes("a11y")}
        <span class="text-amber-600">{m.popup_a11y_failed()}</span>
      {/if}
    </fieldset>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.popup_prompt_label()}</span>
      <textarea
        class="min-h-20 rounded border border-gray-300 px-2 py-1"
        bind:value={prompt}
        placeholder={m.popup_prompt_placeholder()}
      ></textarea>
    </label>

    <p class="text-xs text-gray-500">
      {m.popup_repo_label()}: <span class="font-mono">{effectiveRepo}</span>
      {#if effectiveRepo !== config?.repoPath}
        <span class="text-gray-400">{m.popup_repo_routed()}</span>
      {/if}
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
