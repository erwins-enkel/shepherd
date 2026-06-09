import { wsUrl } from "./store.svelte";

// ── browser-side echo RTT profiling ──────────────────────────────────────────
// Enabled by setting localStorage key "shepherd:profile" = "1".
// Logs `[profile] echo-rtt <N>ms` to console.warn when RTT > 150ms.
// All cost is skipped when the flag is off.
const ECHO_RTT_THRESHOLD_MS = 150;
let _profileEnabled = false;
try {
  _profileEnabled = localStorage.getItem("shepherd:profile") === "1";
} catch {
  /* localStorage unavailable (e.g. SSR or sandboxed context) */
}

// Server closes a pty WS with this code when a newer client takes over the
// terminal. We park instead of reconnecting, so two devices on the same session
// don't ping-pong the attach. Keep in sync with PTY_SUPERSEDED_CODE in src/server.ts.
const PTY_SUPERSEDED_CODE = 4000;

// Server closes a pty WS with this code when the session has ended (its herdr
// agent is gone — the user quit claude / ctrl-c'd). We stop for good instead of
// reconnecting, which would loop on herdr's agent_not_found. Keep in sync with
// PTY_GONE_CODE in src/server.ts.
const PTY_GONE_CODE = 4001;

export interface PtyConn {
  send(data: string): void;
  resize(c: number, r: number): void;
  close(): void;
  /**
   * Reconnect now if the socket isn't already open — call on tab refocus.
   * Mobile suspends backgrounded tabs and drops the WS; the herdr agent keeps
   * running, so a fresh attach (`--takeover`) repaints the live session.
   */
  poke(): void;
  /** Re-attach after being parked (superseded) — makes this client the owner again. */
  takeover(): void;
}

export function connectPty(
  id: string,
  cols: number,
  rows: number,
  onData: (bytes: string) => void,
  // fired on every reconnect (not the first connect) — caller refits + resizes
  // so a fresh attach repaints at the current size
  onReconnect: () => void = () => {},
  // fired when the server hands this terminal to another device — caller shows a
  // "take over" affordance instead of fighting for the attach
  onParked: () => void = () => {},
  // fired when the connection stops for good and never reconnects. "gone" = the
  // herdr agent itself exited (user quit claude); "unreachable" = herdr is down
  // so no attach can succeed (e.g. its server was stopped by a failed update).
  // The caller shows a Resume vs. Reconnect affordance accordingly.
  onEnded: (reason: "gone" | "unreachable") => void = () => {},
  makeWs: (path: string) => WebSocket = (p) => new WebSocket(wsUrl(p)),
): PtyConn {
  let ws: WebSocket;
  let stopped = false;
  let parked = false;
  let everOpened = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  // track the latest fitted size so a reconnect attaches at the right dimensions
  // (the viewport may have changed — rotation, keyboard — while backgrounded)
  let lastCols = cols;
  let lastRows = rows;
  // Tell apart a herdr server that's gone for good (e.g. its server was stopped
  // by a failed `herdr update`) from a momentary blip. Every attach against a
  // dead herdr opens then drops within milliseconds, and reconnecting just spews
  // `Error: Os { code: 2, … NotFound }` forever (no agent socket to attach to).
  // We count consecutive attaches that die within FAST_FAIL_MS of opening; once
  // they pass MAX_FAST_FAILS we stop and surface the ended/Resume affordance
  // instead of looping. A connection that lived past the window (a real session
  // that later dropped) resets the counter, so a single herdr restart/handoff
  // rides through normally.
  let openedAt = 0;
  let fastFails = 0;
  const FAST_FAIL_MS = 4000;
  const MAX_FAST_FAILS = 8;
  // echo RTT: timestamp of the last real input send (0 = none pending). First
  // server message clears it, so an unsolicited server push (running process
  // output) may clear it early — send→first-echo is approximate.
  let _pendingSendTime = 0;

  const open = () => {
    parked = false;
    openedAt = 0;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    ws = makeWs(`/pty/${id}?cols=${lastCols}&rows=${lastRows}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (_profileEnabled && _pendingSendTime !== 0) {
        const rtt = Date.now() - _pendingSendTime;
        _pendingSendTime = 0;
        if (rtt > ECHO_RTT_THRESHOLD_MS) {
          console.warn(`[profile] echo-rtt ${rtt}ms`);
        }
      }
      onData(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
    };
    ws.onopen = () => {
      openedAt = Date.now();
      if (everOpened) onReconnect();
      everOpened = true;
    };
    ws.onclose = (e) => {
      // a newer client took the terminal → park; never auto-reconnect (that would
      // bump them right back, and they'd bump us: the takeover war)
      if (e && e.code === PTY_SUPERSEDED_CODE) {
        parked = true;
        onParked();
        return;
      }
      // the session ended (agent gone) → stop for good; reconnecting would just
      // loop on herdr's agent_not_found
      if (e && e.code === PTY_GONE_CODE) {
        stopped = true;
        onEnded("gone");
        return;
      }
      // conn.close() / a terminal state already stopped us → don't revive
      if (stopped || parked) return;
      // herdr unreachable? a dead-herdr attach opens then drops at once; a
      // connection that lived past the window was a real session → reset.
      const livedMs = openedAt ? Date.now() - openedAt : 0;
      fastFails = livedMs >= FAST_FAIL_MS ? 0 : fastFails + 1;
      if (fastFails >= MAX_FAST_FAILS) {
        // herdr is gone for good (not a blip) — stop the attach loop and let the
        // caller surface a Reconnect affordance instead of error spam.
        stopped = true;
        onEnded("unreachable");
        return;
      }
      if (!retry) retry = setTimeout(open, 1000);
    };
    ws.onerror = () => ws.close();
  };
  open();

  return {
    send: (d) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(d);
      if (_profileEnabled) _pendingSendTime = Date.now();
    },
    resize: (c, r) => {
      lastCols = c;
      lastRows = r;
      if (ws.readyState === ws.OPEN) ws.send(`\x00resize:${c}:${r}\n`);
    },
    close: () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws.close();
    },
    poke: () => {
      if (stopped || parked) return; // parked is deliberate — don't steal back on refocus
      // a scheduled retry → run it immediately; otherwise reconnect only if the
      // socket is actually gone (CLOSING/CLOSED), never disturb a live one
      if (retry || ws.readyState >= ws.CLOSING) open();
    },
    takeover: () => {
      if (stopped) return;
      open(); // re-attach → server makes us the owner and parks the other device
    },
  };
}
