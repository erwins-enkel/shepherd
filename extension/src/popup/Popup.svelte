<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { isConfigured, loadConfig } from "../lib/config";
  import { localizeError } from "../lib/localize-error";
  import { hasAllUrls } from "../lib/recorder-control";
  import { hasHostPermission, requestHostPermission } from "../lib/remote-host";
  import { resolveRepo } from "../lib/routing";
  import { takePendingCapture } from "../lib/picker-session";
  import {
    composeIssueBody,
    MAX_ISSUE_BODY_LEN,
    MAX_ISSUE_TITLE_LEN,
    ping,
  } from "../lib/transport";
  import type {
    CaptureConfig,
    CaptureMode,
    CaptureResult,
    DeliveryTarget,
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
  let titlePrefilled = $state(false);
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
  let mode = $state<CaptureMode>("visible");

  // Connection-status indicator: reflects whether the configured core is
  // reachable + authorized, surfaced in the header without opening Options.
  // "none" = not configured (indicator hidden — the needs-config view covers it).
  type ConnState = "none" | "checking" | "linked" | "not-linked";
  let conn = $state<ConnState>("none");

  // Fire-and-forget reachability probe. STRICTLY non-blocking: this is kicked off
  // WITHOUT await from init(), so it never delays config load, the screenshot, the
  // popup becoming interactive, or gates capture. Fail-closed — any throw (a
  // TransportError or otherwise) lands on "not-linked"; "linked" is only set on a
  // resolved ping.
  async function checkConnection(cfg: CaptureConfig) {
    conn = "checking";
    try {
      await ping(fetch, cfg);
      conn = "linked";
    } catch {
      conn = "not-linked";
    }
  }

  // Element/marquee captures arrive pre-gathered (signals run at pick time), so
  // the gather toggles are read-only — re-running them would replace the cropped
  // region with a fresh visible capture.
  let gatherLocked = $derived(capture?.mode === "element" || capture?.mode === "marquee");

  function send(req: WorkerRequest): Promise<WorkerResponse> {
    return chrome.runtime.sendMessage(req) as Promise<WorkerResponse>;
  }

  // Open the options page. Called from the popup, openOptionsPage() can fail to
  // find a tabbed window and reject with "Could not create an options page." —
  // use the callback form (which consumes chrome.runtime.lastError instead of
  // surfacing an uncaught rejection) and fall back to opening it in a tab.
  function openOptions(): void {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
      }
    });
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
    // Kick off the connection probe fire-and-forget (no await): it updates `conn`
    // when it settles and must never delay or gate the capture flow below. Gated
    // on the host-permission check above so a revoked-permission remote host shows
    // only the needs-host re-grant view, not a redundant "not-linked" badge — the
    // probe would fail anyway (Chrome blocks the fetch without the grant). A
    // successful re-grant re-runs init(), which then fires this probe.
    void checkConnection(cfg);
    toggles = { ...cfg.signals };
    recorderAvailable = await hasAllUrls();
    if (!recorderAvailable) {
      toggles.console = false;
      toggles.network = false;
    }

    // A pending element capture (from a prior "Pick element" gesture that closed
    // the popup) takes precedence over a fresh visible capture. MV3 can't reopen
    // the popup, so the worker stashed the result + flagged the toolbar badge;
    // consume both here — but only the capture that belongs to *this* tab, so a
    // capture made on another tab isn't hijacked (and its badge stays put).
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTabId = activeTab?.id;
    const pending = activeTabId !== undefined ? await takePendingCapture(activeTabId) : null;
    if (pending) {
      capture = pending;
      mode = pending.mode;
      toggles = derivedTogglesFor(pending);
      if (activeTabId !== undefined) {
        await chrome.action.setBadgeText({ text: "", tabId: activeTabId });
      }
      view = "ready";
      return;
    }

    await runCapture();
  }

  // Reflect which signals the user asked for in an element capture, so the
  // (read-only) checkboxes match their intent. A signal counts as requested
  // whether it succeeded (present in `signals`) or failed (in `signalErrors`) —
  // a failed gather shouldn't flip the box off. Screenshot stays on — it's the
  // cropped element image, attached on spawn.
  function derivedTogglesFor(result: CaptureResult): SignalToggles {
    const requested = (signal: GatherSignal) =>
      result.signals?.[signal] !== undefined || (result.signalErrors?.includes(signal) ?? false);
    return {
      screenshot: true,
      console: requested("console"),
      network: requested("network"),
      a11y: requested("a11y"),
    };
  }

  // Mode selector: visible/full-page recapture in place; "element"/"marquee" arm
  // an in-page overlay and close the popup (the overlay needs a page gesture, and
  // the popup would close on that gesture regardless).
  async function selectMode(next: CaptureMode) {
    mode = next;
    if (next === "element" || next === "marquee") {
      // Resolve the overlay label here (popup locale) so the overlay content
      // script needn't bundle Paraglide just for one string.
      const res = await send(
        next === "element"
          ? { type: "start-picker", toggles, instructions: m.picker_instructions() }
          : { type: "start-marquee", toggles, instructions: m.marquee_instructions() },
      );
      if (res.ok && res.type === "picker-started") {
        window.close();
      } else if (!res.ok) {
        // Injection failed (a restricted page — chrome://, the web store, …).
        // Surface it and keep the popup open instead of closing onto nothing.
        errorMsg = localizeError(res.errorKind, res.message, config?.baseUrl ?? "");
        view = "error";
      }
      return;
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
    // Only visible/full-page are captured synchronously; element goes through the
    // picker (selectMode), so map it to a visible recapture here as a safety net.
    const res = await send({
      type: "capture",
      toggles,
      mode: mode === "fullpage" ? "fullpage" : "visible",
    });
    if (res.ok && res.type === "capture") {
      capture = res.result;
      view = "ready";
    } else if (!res.ok) {
      errorMsg = localizeError(res.errorKind, res.message, config?.baseUrl ?? "");
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

  // Prefill the issue title from the page title once, the first time a capture is
  // available. A one-shot flag (not an `=== ""` guard) so a user who deliberately
  // clears the field isn't refilled on the next reactive tick.
  $effect(() => {
    if (!titlePrefilled && capture?.metadata.title) {
      issueTitle = capture.metadata.title;
      titlePrefilled = true;
    }
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
    // Mirror the server's POST /api/issues caps so an over-long title or body
    // gets a clear inline message instead of a generic 'invalid' rejection. The
    // body is prompt + the fenced context block, so large signals can blow the
    // cap even with a short prompt — validate the exact string fileIssue() sends.
    if (target === "issue" && issueTitle.trim().length > MAX_ISSUE_TITLE_LEN) {
      errorMsg = m.popup_issue_title_too_long();
      view = "error";
      return;
    }
    if (
      target === "issue" &&
      composeIssueBody(prompt, capture.metadata, capture.signals).length > MAX_ISSUE_BODY_LEN
    ) {
      errorMsg = m.popup_issue_body_too_long();
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
      errorMsg = localizeError(res.errorKind, res.message, config?.baseUrl ?? "");
      view = "error";
    }
  }

  init();
</script>

<main class="flex w-[380px] flex-col gap-3 p-3 font-sans text-sm text-gray-900">
  <div class="flex items-center justify-between gap-2">
    <h1 class="font-semibold">{m.popup_title()}</h1>
    {#if conn !== "none"}
      {@const tone =
        conn === "linked"
          ? "text-green-700"
          : conn === "not-linked"
            ? "text-red-700"
            : "text-gray-500"}
      {@const dot =
        conn === "linked" ? "bg-green-600" : conn === "not-linked" ? "bg-red-600" : "bg-gray-400"}
      <span class={["flex items-center gap-1 text-xs", tone]}>
        <span class={["h-2 w-2 rounded-full", dot]} aria-hidden="true"></span>
        <span>
          {conn === "linked"
            ? m.popup_conn_linked()
            : conn === "not-linked"
              ? m.popup_conn_unlinked()
              : m.popup_conn_checking()}
        </span>
      </span>
    {/if}
  </div>

  {#if view === "loading"}
    <p class="text-gray-500">{m.popup_capturing()}</p>
  {:else if view === "needs-config"}
    <p class="text-gray-600">{m.popup_no_config()}</p>
    <button class="self-start rounded bg-gray-900 px-3 py-1.5 text-white" onclick={openOptions}>
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
      class="max-h-72 w-full rounded border border-gray-200 object-contain"
      src={capture.screenshotDataUrl}
      alt={m.popup_screenshot_alt()}
    />
    {#if capture.mode === "element"}
      <span class="text-xs text-gray-500">{m.popup_element_hint()}</span>
    {/if}
    {#if capture.mode === "marquee"}
      <span class="text-xs text-gray-500">{m.popup_marquee_hint()}</span>
    {/if}
    {#if capture.fullPageTruncated}
      <span class="text-xs text-amber-600">{m.popup_fullpage_truncated()}</span>
    {/if}

    <div class="flex flex-col gap-0.5 text-xs text-gray-500">
      <span class="text-gray-600">{m.popup_metadata_label()}</span>
      <span class="truncate font-mono" title={capture.metadata.url}>{capture.metadata.url}</span>
      <span class="truncate">{capture.metadata.title}</span>
      <span>{capture.metadata.viewportW}×{capture.metadata.viewportH}</span>
    </div>

    <label class="flex flex-col gap-1 text-xs text-gray-600">
      <span>{m.popup_mode_label()}</span>
      <select
        class="rounded border border-gray-300 px-2 py-1 text-gray-900 disabled:opacity-50"
        value={mode}
        disabled={view === "submitting"}
        onchange={(e) => selectMode(e.currentTarget.value as CaptureMode)}
      >
        <option value="visible">{m.popup_mode_visible()}</option>
        <option value="fullpage">{m.popup_mode_fullpage()}</option>
        <option value="marquee">{m.popup_mode_marquee()}</option>
        <option value="element">{m.popup_mode_element()}</option>
      </select>
    </label>

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
      <label class="flex items-center gap-2" class:opacity-50={gatherLocked}>
        <input
          type="checkbox"
          checked={toggles.a11y}
          disabled={gatherLocked}
          onchange={(e) => setGather("a11y", e.currentTarget.checked)}
        />
        <span>{m.signal_a11y()}</span>
      </label>
      <label class="flex items-center gap-2" class:opacity-50={!recorderAvailable || gatherLocked}>
        <input
          type="checkbox"
          checked={toggles.console}
          disabled={!recorderAvailable || gatherLocked}
          onchange={(e) => setGather("console", e.currentTarget.checked)}
        />
        <span>{m.signal_console()}</span>
      </label>
      <label class="flex items-center gap-2" class:opacity-50={!recorderAvailable || gatherLocked}>
        <input
          type="checkbox"
          checked={toggles.network}
          disabled={!recorderAvailable || gatherLocked}
          onchange={(e) => setGather("network", e.currentTarget.checked)}
        />
        <span>{m.signal_network()}</span>
      </label>
      {#if !recorderAvailable}
        <button type="button" class="self-start text-blue-600 underline" onclick={openOptions}>
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
        placeholder={m.popup_prompt_placeholder()}></textarea>
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
