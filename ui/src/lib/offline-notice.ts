/**
 * Tells the operator the UI can't reach the server: one sticky toast while the herd on screen is
 * a frozen snapshot (store.offline), with a Retry that reconnects now. Closing it silences it for
 * the rest of the outage; a Retry that fails brings it back. When the link returns the toast goes
 * and a brief "Back online." confirms it — only if the notice was ever shown.
 */
import { toasts } from "#lib/toasts.svelte.js";
import { m } from "#lib/paraglide/messages.js";

const KEY = "conn-offline";

let shown = false;
let retryPending = false;

function offer(since: number, retry: () => void): void {
  const time = new Date(since).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  toasts.info(m.conn_offline_title(), {
    sticky: true,
    alert: true,
    key: KEY,
    detail: { reason: m.conn_offline_reason({ time }), sections: [] },
    action: {
      label: m.conn_offline_retry(),
      run: () => {
        retryPending = true;
        retry();
      },
    },
  });
}

/** The UI is offline (again, or a reconnect attempt just failed). `since` = when data was last live. */
export function showOfflineNotice(since: number, retry: () => void): void {
  if (shown && !retryPending) return;
  shown = true;
  retryPending = false;
  offer(since, retry);
}

/** The link is back: drop the notice, and confirm only if the operator was told it was gone. */
export function clearOfflineNotice(): void {
  if (!shown) return;
  shown = retryPending = false;
  toasts.dismissKey(KEY);
  toasts.info(m.conn_back_online());
}
