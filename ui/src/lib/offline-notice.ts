/**
 * Tells the operator the UI isn't live: one sticky toast while the herd on screen is a frozen
 * snapshot (store.offline). It starts as a calm "Reconnecting to Shepherd …" and only turns into
 * "Can't reach Shepherd" with a Retry once reconnecting has failed for a while (store.unreachable).
 * Each phase change offers the toast again; closing it silences only the current phase. When the
 * link returns the toast goes and a brief "Reconnected." confirms it — only if a notice was shown.
 */
import { toasts } from "#lib/toasts.svelte.js";
import { m } from "#lib/paraglide/messages.js";

const KEY = "conn-offline";

type OfflinePhase = "reconnecting" | "unreachable";

/** The phase last offered this outage; null = no notice shown. */
let shown: OfflinePhase | null = null;

function offerUnreachable(since: number, retry: () => void): void {
  const time = new Date(since).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  toasts.info(m.conn_offline_title(), {
    sticky: true,
    alert: true,
    key: KEY,
    detail: { reason: m.conn_offline_reason({ time }), sections: [] },
    action: { label: m.conn_offline_retry(), run: retry },
  });
}

/** The UI is offline, in `phase`. `since` = when data was last live. */
export function showOfflineNotice(phase: OfflinePhase, since: number, retry: () => void): void {
  if (shown === phase) return;
  shown = phase;
  if (phase === "reconnecting")
    toasts.info(m.conn_reconnecting_title(), { sticky: true, key: KEY });
  else offerUnreachable(since, retry);
}

/** The link is back: drop the notice, and confirm only if the operator was told it was gone. */
export function clearOfflineNotice(): void {
  if (shown === null) return;
  shown = null;
  toasts.dismissKey(KEY);
  toasts.info(m.conn_back_online());
}
