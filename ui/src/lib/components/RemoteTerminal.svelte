<script lang="ts">
  import type { Terminal } from "@xterm/xterm";
  import { untrack } from "svelte";
  import { openXterm, repaintXterm } from "#lib/xterm-setup.js";
  import { connectPty, type PtyConn, type PtyEndReason } from "#lib/pty.js";
  import { terminalFontSize } from "#lib/terminal-font-size.svelte.js";
  import { uiScale } from "#lib/ui-scale.svelte.js";
  import { onPageReturn } from "#lib/visibility.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { MirroredSession } from "#lib/remote-sessions.js";
  import type { TerminalClientInfo } from "#lib/types.js";
  import { altComboKey, isPtySuppressedChord } from "./herd-keynav";
  import ViewportTermBanners from "./viewport/ViewportTermBanners.svelte";

  // The live terminal of a session on a connected machine (#2764). This server bridges `/pty/:id`
  // to the machine, which attaches it and decides takeover and "gone" exactly as for a local
  // session, so the parked and reconnect prompts are the Viewport's own. What is new is the end
  // "machine unreachable": it re-attaches by itself once the machine's connection comes back.
  let {
    session,
    owner = undefined,
  }: { session: MirroredSession; owner?: TerminalClientInfo | null } = $props();
  // A string, so a fresh session object from every mirrored frame never recreates the terminal.
  const sessionId = $derived(session.id);

  let el = $state<HTMLDivElement>();
  let termRef = $state<Terminal | undefined>();
  let conn: PtyConn | undefined;
  let parked = $state(false);
  let ended = $state(false);
  let endReason = $state<PtyEndReason>("gone");
  // The machine's connection `since` when the terminal ended as unreachable: any later change of
  // it (a drop and a reconnect) is the machine coming back, compared without trusting clocks.
  let endedSince: number | null = null;
  // Bumped to tear the terminal down and attach afresh.
  let epoch = $state(0);

  function reattach() {
    ended = false;
    epoch++;
  }
  function takeover() {
    parked = false;
    conn?.takeover();
  }

  $effect(() => {
    const { state, since } = session.connection;
    if (ended && endReason === "machine" && state === "connected" && since !== endedSince)
      reattach();
  });

  $effect(() => {
    const id = sessionId;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    epoch; // a re-attach bumps this → rebuild the terminal
    if (!el) return;
    const mount = el;
    parked = false;
    // Untracked like the Viewport's: a theme, font or Text Size change never recreates the PTY.
    const initialTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const fontSize = (untrack(() => terminalFontSize.size) ?? 12.5) * untrack(() => uiScale.value);
    const { term, fit } = openXterm(mount, { fontSize, theme: initialTheme });
    termRef = term;

    // Only a visible mount has a real size: a hidden one would resize the PTY to 2 columns.
    const refit = () => {
      if (mount.offsetParent === null || mount.clientWidth === 0 || mount.clientHeight === 0)
        return;
      fit.fit();
      c.resize(term.cols, term.rows);
    };
    const c = connectPty(
      id,
      term.cols,
      term.rows,
      (d) => term.write(d),
      refit,
      () => (parked = true),
      (reason) => {
        endReason = reason;
        endedSince = untrack(() => session.connection.since);
        const line =
          reason === "machine"
            ? m.remote_terminal_lost_line({ machine: untrack(() => session.host.name) })
            : reason === "unreachable"
              ? m.viewport_herdr_unreachable()
              : m.viewport_session_ended();
        term.write(`\r\n\x1b[2m${line}\x1b[0m\r\n`);
        ended = true;
      },
    );
    conn = c;
    term.onData((d) => c.send(d));

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Shift+Enter is a newline for the agent, not a submit (xterm sends a bare CR for both).
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        c.send("\n");
        return false;
      }
      // Session-switch combos and the app's global chords belong to the window, never the PTY.
      const altCombo = e.altKey && !e.ctrlKey && !e.metaKey && altComboKey(e.code, true) !== null;
      if (altCombo || isPtySuppressedChord(e)) {
        e.preventDefault();
        return false;
      }
      return true;
    });

    // A backgrounded tab drops the socket; nudge a reconnect when it returns.
    const offPageReturn = onPageReturn(() => c.poke());
    const onTap = () => term.focus();
    mount.addEventListener("click", onTap);
    const ro = new ResizeObserver(refit);
    ro.observe(mount);
    requestAnimationFrame(refit);

    return () => {
      offPageReturn();
      mount.removeEventListener("click", onTap);
      ro.disconnect();
      c.close();
      conn = undefined;
      termRef = undefined;
      term.dispose();
    };
  });

  // repaint the live terminal when the active theme changes (no recreation)
  $effect(() => {
    if (termRef) repaintXterm(termRef);
  });
</script>

<div class="remote-term">
  <div
    class="mount"
    role="region"
    aria-label={m.remote_terminal_aria({ machine: session.host.name })}
    bind:this={el}
  ></div>
  <ViewportTermBanners
    tab="term"
    sessionId={session.id}
    scrolledUp={false}
    {parked}
    {owner}
    {ended}
    {endReason}
    machine={session.host.name}
    resuming={false}
    resumeFailed={false}
    resumable={false}
    scrollToTop={() => {}}
    scrollToBottom={() => {}}
    {takeover}
    {reattach}
    resumeSession={() => {}}
  />
</div>

<style>
  .remote-term {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-height: 240px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .mount {
    flex: 1;
    min-width: 0;
    padding: 4px;
  }
</style>
