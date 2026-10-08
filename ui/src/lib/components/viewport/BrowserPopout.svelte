<script lang="ts">
  // Browser View pop-out (#2896): the session's BrowserPanel full-window in its own browser tab,
  // no HUD chrome. Same cookie auth (the layout gate) and the same token-gated view socket; the
  // server lets one view per session stream, so opening this takes over from the HUD panel.
  import { m } from "$lib/paraglide/messages";
  import { listSessions, loginRequestStates } from "$lib/api";
  import { HerdStore } from "$lib/store.svelte";
  import type { Session } from "$lib/types";
  import BrowserPanel from "./BrowserPanel.svelte";

  let {
    sessionId,
    makeEventsWs,
    makeWs,
  }: {
    sessionId: string;
    /** Test seam: the /events socket factory (defaults to the store's real socket). */
    makeEventsWs?: () => WebSocket;
    /** Test seam: the view socket factory, passed to BrowserPanel. */
    makeWs?: (path: string) => WebSocket;
  } = $props();

  const store = new HerdStore();
  let loaded = $state(false);
  const session = $derived<Session | null>(store.sessions.find((s) => s.id === sessionId) ?? null);

  $effect(() => {
    let live = true;
    listSessions()
      .then((list) => {
        if (live) store.setAll(list);
      })
      .catch(() => {})
      .finally(() => {
        if (live) loaded = true;
      });
    const dispose = store.connect(makeEventsWs);
    return () => {
      live = false;
      dispose();
    };
  });

  // Login Requests on every (re)connect: an answer or new request missed while offline resyncs.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep: resync
    store.connectionEpoch;
    loginRequestStates()
      .then((map) => store.setLoginRequests(map))
      .catch(() => {});
  });
</script>

<svelte:head>
  <title>{m.browser_popout_title({ name: session?.name ?? sessionId })}</title>
</svelte:head>

<main class="popout" id="main-content">
  {#if session && !session.archivedAt}
    <BrowserPanel
      {session}
      loginRequest={store.loginRequests[session.id] ?? null}
      popout
      {makeWs}
    />
  {:else}
    <p class="state">{loaded ? m.browser_popout_not_found() : m.browser_popout_loading()}</p>
  {/if}
</main>

<style>
  .popout {
    position: fixed;
    inset: 0;
    background: var(--color-bg);
  }
  .state {
    margin: 0;
    padding: 24px 16px;
    text-align: center;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
</style>
