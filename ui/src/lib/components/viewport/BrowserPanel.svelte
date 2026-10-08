<script lang="ts">
  // Browser View (#2881): the session's Shared Browser tab, live. Frames arrive as JPEGs over
  // /browser-view/<id>; pointer, keys and pasted text go back as typed messages the server
  // turns into CDP input. Works over Tailscale, so a remote operator can do a Handoff Login.
  import { m } from "$lib/paraglide/messages";
  import { ApiError, openRepoBrowser, resolveLoginRequest } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import {
    connectBrowserView,
    keyMessage,
    modifiersOf,
    mouseButton,
    navigableUrl,
    toPageCoords,
    type BrowserViewConn,
    type BrowserViewMessage,
    type BrowserViewTarget,
  } from "$lib/browserView";
  import type { LoginRequest, Session } from "$lib/types";
  import { untrack } from "svelte";

  let {
    session,
    loginRequest = null,
    makeWs,
  }: {
    session: Session;
    /** The session's open Login Request (#2882): shows the reason and the Done / Cancel answer. */
    loginRequest?: LoginRequest | null;
    /** Test seam: the socket factory (defaults to the real `/browser-view/<id>` socket). */
    makeWs?: (path: string) => WebSocket;
  } = $props();

  const CLOSE_TRY_AGAIN = 1013;
  const DOUBLE_CLICK_MS = 500;
  const VIEWPORT_DEBOUNCE_MS = 150;

  let conn: BrowserViewConn | null = null;
  let targets = $state<BrowserViewTarget[]>([]);
  let selected = $state<string | null>(null);
  let listed = $state(false);
  let frameSrc = $state<string | null>(null);
  /** Last frame's page viewport (CSS px) — the coordinate space input is sent in. */
  let pageSize = { width: 0, height: 0 };
  let closed = $state<"cap" | "stopped" | "other" | null>(null);
  let attempt = $state(0);
  let urlDraft = $state("");
  let urlFocused = $state(false);
  let pasteDraft = $state("");
  let error = $state<string | null>(null);
  let opening = $state(false);
  let imgEl = $state<HTMLImageElement | null>(null);
  let surfaceEl = $state<HTMLDivElement | null>(null);

  const sessionId = $derived(session.id);
  const current = $derived(targets.find((t) => t.id === selected) ?? null);

  // Follow the selected tab's URL as it changes, unless the operator is editing the field. Only
  // the URL is tracked: blurring (e.g. clicking Go) must not revert an unsent edit.
  $effect(() => {
    const url = current?.url ?? "";
    if (!untrack(() => urlFocused)) urlDraft = url;
  });

  $effect(() => {
    const id = sessionId;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep: Reconnect
    attempt;
    targets = [];
    selected = null;
    listed = false;
    frameSrc = null;
    closed = null;
    error = null;
    const c = connectBrowserView(
      id,
      {
        onTargets(next, sel) {
          if (sel !== selected) frameSrc = null;
          targets = next;
          selected = sel;
          listed = true;
        },
        onFrame(frame) {
          pageSize = { width: frame.width, height: frame.height };
          const src = `data:image/jpeg;base64,${frame.data}`;
          // An identical frame leaves src unchanged, so no load event would ack it.
          if (src === frameSrc) onFrameSettled();
          else frameSrc = src;
        },
        onError(message) {
          error = message;
        },
        onOpen() {
          if (lastViewport) c.send({ type: "viewport", ...lastViewport });
        },
        onClose(code, reason) {
          if (code === CLOSE_TRY_AGAIN || reason === "cap") closed = "cap";
          else if (reason === "browser stopped" || reason === "browser exited") closed = "stopped";
          else closed = "other";
        },
      },
      makeWs,
    );
    conn = c;
    return () => {
      c.close();
      if (conn === c) conn = null;
    };
  });

  const send = (msg: BrowserViewMessage) => conn?.send(msg);

  // The page is laid out at the surface's CSS size (#2895), so frames render ~1:1 instead of a
  // small host window blown up to fill the panel. Sent on settle, and again on every (re)connect.
  let lastViewport: { width: number; height: number; dpr: number } | null = null;
  $effect(() => {
    const el = surfaceEl;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(([entry]) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = {
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
          dpr: window.devicePixelRatio || 1,
        };
        const prev = lastViewport;
        if (
          prev &&
          prev.width === next.width &&
          prev.height === next.height &&
          prev.dpr === next.dpr
        )
          return;
        lastViewport = next;
        send({ type: "viewport", ...next });
      }, VIEWPORT_DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  });

  // Ack only once the frame is painted: the server sends the next one after the ack, so a slow
  // link backs off instead of queueing frames.
  // A frame that fails to decode is acked too: a missing ack stalls the screencast.
  function onFrameSettled() {
    send({ type: "frameAck" });
  }

  function pagePoint(e: MouseEvent): { x: number; y: number } | null {
    if (!imgEl) return null;
    const rect = imgEl.getBoundingClientRect();
    return toPageCoords(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect,
      { width: imgEl.naturalWidth, height: imgEl.naturalHeight },
      pageSize,
    );
  }

  let lastDown = { at: 0, x: 0, y: 0, count: 0 };
  function clickCount(x: number, y: number): number {
    const now = performance.now();
    const near = Math.abs(x - lastDown.x) < 5 && Math.abs(y - lastDown.y) < 5;
    const count = near && now - lastDown.at < DOUBLE_CLICK_MS ? Math.min(lastDown.count + 1, 3) : 1;
    lastDown = { at: now, x, y, count };
    return count;
  }

  function mouse(e: PointerEvent, action: "down" | "up" | "move") {
    const p = pagePoint(e);
    if (!p) return;
    send({
      type: "mouse",
      action,
      ...p,
      button: action === "move" ? (e.buttons & 1 ? "left" : "none") : mouseButton(e.button),
      clickCount: action === "down" ? clickCount(p.x, p.y) : action === "up" ? lastDown.count : 0,
      modifiers: modifiersOf(e),
    });
  }

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    surfaceEl?.focus();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    mouse(e, "down");
  }

  // Moves are coalesced to one per animation frame.
  let pendingMove: PointerEvent | null = null;
  function onPointerMove(e: PointerEvent) {
    if (pendingMove === null)
      requestAnimationFrame(() => {
        if (pendingMove) mouse(pendingMove, "move");
        pendingMove = null;
      });
    pendingMove = e;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = pagePoint(e);
    if (!p) return;
    send({
      type: "mouse",
      action: "wheel",
      ...p,
      button: "none",
      clickCount: 0,
      modifiers: modifiersOf(e),
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }

  // `onwheel` attributes are passive in Svelte 5; scrolling the page must not scroll the HUD.
  $effect(() => {
    const el = imgEl;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  function onKey(e: KeyboardEvent, action: "down" | "up") {
    // Null: paste (the `paste` event below carries the text) or the HUD's command bar.
    const msg = keyMessage(e, action);
    if (!msg) return;
    // Keys belong to the page: keep them from the HUD's global shortcuts (n, r, j/k, …).
    e.preventDefault();
    e.stopPropagation();
    send(msg);
  }

  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    send({ type: "text", text });
  }

  function submitPaste(e: SubmitEvent) {
    e.preventDefault();
    if (!pasteDraft) return;
    send({ type: "text", text: pasteDraft });
    pasteDraft = "";
  }

  function submitUrl(e: SubmitEvent) {
    e.preventDefault();
    const url = navigableUrl(urlDraft);
    if (!url) {
      error = m.viewport_browser_url_invalid();
      return;
    }
    error = null;
    send({ type: "navigate", url });
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function selectTarget(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    if (id) send({ type: "select", targetId: id });
  }

  let answering = $state(false);
  async function answerLogin(outcome: "done" | "cancelled") {
    answering = true;
    try {
      await resolveLoginRequest(session.id, outcome);
    } catch (e) {
      // 404: already answered (another client, or the session ended) — the banner clears itself.
      if (!(e instanceof ApiError && e.status === 404))
        toasts.info(m.viewport_browser_login_answer_failed(), { alert: true });
    } finally {
      answering = false;
    }
  }

  async function openTab() {
    opening = true;
    try {
      await openRepoBrowser(session.repoPath, session.id);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      toasts.info(
        code === "missing-binary"
          ? m.automation_shared_browser_open_missing_binary()
          : code === "cap"
            ? m.automation_shared_browser_open_cap()
            : m.automation_shared_browser_open_failed(),
        { alert: true },
      );
    } finally {
      opening = false;
    }
  }
</script>

<div class="bv">
  {#if loginRequest}
    <!-- Agent text (reason, url) is rendered as plain text only. -->
    <div class="bv-login" role="status">
      <div class="bv-login-text">
        <strong>{m.viewport_browser_login_title()}</strong>
        <span class="bv-login-reason">{loginRequest.reason}</span>
        <span class="bv-login-url">{loginRequest.url}</span>
      </div>
      <button
        class="gbtn primary"
        type="button"
        disabled={answering}
        onclick={() => answerLogin("done")}>{m.viewport_browser_login_done()}</button
      >
      <button
        class="gbtn"
        type="button"
        disabled={answering}
        onclick={() => answerLogin("cancelled")}>{m.viewport_browser_login_cancel()}</button
      >
    </div>
  {/if}
  <div class="bv-bar">
    {#if targets.length > 0}
      <select
        class="bv-tabs"
        aria-label={m.viewport_browser_tabs_aria()}
        value={selected ?? ""}
        onchange={selectTarget}
      >
        {#each targets as t (t.id)}
          <option value={t.id}>{t.title || t.url}</option>
        {/each}
      </select>
    {/if}
    <form class="bv-url" onsubmit={submitUrl}>
      <input
        type="text"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        aria-label={m.viewport_browser_url_aria()}
        disabled={!current || closed !== null}
        bind:value={urlDraft}
        onfocus={() => (urlFocused = true)}
        onblur={() => (urlFocused = false)}
      />
      <button class="gbtn" type="submit" disabled={!current || closed !== null}
        >{m.viewport_browser_go()}</button
      >
    </form>
    <button
      class="gbtn"
      type="button"
      disabled={!current || closed !== null}
      onclick={() => send({ type: "reload" })}>{m.viewport_browser_reload()}</button
    >
    <button class="gbtn" type="button" disabled={opening || closed !== null} onclick={openTab}
      >{m.viewport_browser_open_tab()}</button
    >
  </div>

  <!-- A remote page surface (like a terminal): it takes focus and keys itself, so the
       application role + tabindex are deliberate. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="bv-surface"
    role="application"
    aria-label={m.viewport_browser_surface_aria()}
    tabindex="0"
    bind:this={surfaceEl}
    onkeydown={(e) => onKey(e, "down")}
    onkeyup={(e) => onKey(e, "up")}
    onpaste={onPaste}
  >
    {#if closed !== null}
      <div class="bv-state">
        <span
          >{closed === "cap"
            ? m.viewport_browser_closed_cap()
            : closed === "stopped"
              ? m.viewport_browser_closed_stopped()
              : m.viewport_browser_closed()}</span
        >
        <button class="gbtn primary" type="button" onclick={() => attempt++}
          >{m.viewport_browser_reconnect()}</button
        >
      </div>
    {:else if !listed}
      <div class="bv-state">{m.viewport_browser_connecting()}</div>
    {:else if !selected}
      <div class="bv-state">
        <span>{m.viewport_browser_no_tab()}</span>
        <button class="gbtn primary" type="button" disabled={opening} onclick={openTab}
          >{m.viewport_browser_open_tab()}</button
        >
      </div>
    {:else if frameSrc}
      <img
        class="bv-frame"
        src={frameSrc}
        alt=""
        draggable="false"
        bind:this={imgEl}
        onload={onFrameSettled}
        onerror={onFrameSettled}
        onpointerdown={onPointerDown}
        onpointerup={(e) => mouse(e, "up")}
        onpointermove={onPointerMove}
        oncontextmenu={(e) => e.preventDefault()}
      />
    {:else}
      <div class="bv-state">{m.viewport_browser_connecting()}</div>
    {/if}
  </div>

  <form class="bv-paste" onsubmit={submitPaste}>
    <label class="bv-paste-label" for="bv-paste-{sessionId}"
      >{m.viewport_browser_paste_label()}</label
    >
    <input
      id="bv-paste-{sessionId}"
      type="password"
      autocomplete="off"
      placeholder={m.viewport_browser_paste_placeholder()}
      disabled={!current || closed !== null}
      bind:value={pasteDraft}
    />
    <button class="gbtn" type="submit" disabled={!pasteDraft || !current || closed !== null}
      >{m.viewport_browser_paste_send()}</button
    >
    {#if error}
      <span class="bv-error" role="status">{error}</span>
    {:else}
      <span class="bv-hint">{m.viewport_browser_paste_note()}</span>
    {/if}
  </form>
</div>

<style>
  .bv {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
  }
  .bv-bar,
  .bv-paste {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    background: var(--color-head);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    min-width: 0;
  }
  .bv-bar {
    border-bottom: 1px solid var(--color-line);
  }
  .bv-login {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    border-left: 3px solid var(--color-amber);
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .bv-login-text {
    flex: 1 1 240px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .bv-login-text strong {
    color: var(--color-ink-bright);
  }
  .bv-login-reason,
  .bv-login-url {
    overflow-wrap: anywhere;
  }
  .bv-paste {
    border-top: 1px solid var(--color-line);
    flex-wrap: wrap;
  }
  .bv-url {
    flex: 1 1 auto;
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  input,
  select {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 3px 8px;
    border-radius: 2px;
    min-width: 0;
  }
  .bv-url input {
    flex: 1 1 auto;
  }
  .bv-tabs {
    flex: 0 1 220px;
  }
  .bv-paste input {
    flex: 1 1 160px;
  }
  .bv-surface {
    flex: 1 1 auto;
    position: relative;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    outline: none;
  }
  .bv-surface:focus-visible {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .bv-frame {
    width: 100%;
    height: 100%;
    object-fit: contain;
    user-select: none;
    touch-action: none;
    cursor: default;
  }
  .bv-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 16px;
    text-align: center;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .bv-paste-label {
    flex: none;
  }
  .bv-hint,
  .bv-error {
    flex: 1 1 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-micro);
  }
  .bv-hint {
    color: var(--color-faint);
  }
  .bv-error {
    color: var(--color-amber);
  }
  .gbtn {
    flex: none;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
