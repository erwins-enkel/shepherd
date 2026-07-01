import { getLocale } from "$lib/i18n";

const JSON_HEADERS = { "content-type": "application/json" };

/** Current UI locale for tagging the subscription; never let detection break enable. */
function currentLocale(): string {
  try {
    return getLocale();
  } catch {
    return "en";
  }
}

export interface PushStatus {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}

/** Per-device notification category selection (mirrors the server's PushPrefs). */
export interface PushCategories {
  agent: boolean;
  reviews: boolean;
  ci: boolean;
}

const ALL_CATEGORIES: PushCategories = { agent: true, reviews: true, ci: true };

/** Endpoint of this device's current push subscription, or null if none. */
async function currentEndpoint(): Promise<string | null> {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

/** Read this device's category selection; defaults to all-on when unknown/unsupported. */
export async function getPushCategories(): Promise<PushCategories> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return { ...ALL_CATEGORIES };
  try {
    const r = await fetch(`/api/push/prefs?endpoint=${encodeURIComponent(endpoint)}`);
    if (!r.ok) return { ...ALL_CATEGORIES };
    const { categories } = await r.json();
    return categories ?? { ...ALL_CATEGORIES };
  } catch {
    return { ...ALL_CATEGORIES };
  }
}

/** Persist this device's category selection. Returns false if no subscription exists. */
export async function setPushCategories(categories: PushCategories): Promise<boolean> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return false;
  const r = await fetch("/api/push/prefs", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ endpoint, categories }),
  });
  return r.ok;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function supported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

/** Register the service worker (idempotent). Safe to call on every mount. */
export async function registerSW(): Promise<void> {
  // Demo mode never registers a SW — a stale cached demo build must not be served
  // to a returning visitor (install.ts also unregisters any existing SW).
  if (__DEMO__) return;
  if (!supported()) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    /* registration failures shouldn't break the app */
  }
}

export async function pushState(): Promise<PushStatus> {
  if (!supported()) return { supported: false, permission: "unsupported", subscribed: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { supported: true, permission: Notification.permission, subscribed: !!sub };
}

export async function enablePush(): Promise<boolean> {
  // Demo mode has no push backend and must not touch serviceWorker.ready.
  if (__DEMO__) return false;
  if (!supported()) return false;
  const perm =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") return false;
  const res = await fetch("/api/push/vapid");
  if (!res.ok) return false;
  const { publicKey } = await res.json();
  if (!publicKey) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const r = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: JSON_HEADERS,
    // device locale drives the language of server-built notification payloads
    body: JSON.stringify({ ...sub.toJSON(), locale: currentLocale() }),
  });
  return r.ok;
}

export async function disablePush(): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}

/** Subscribe to "select-session" messages posted by the SW on notification click.
 *  Returns a disposer. */
export function onSelectSession(cb: (id: string) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const handler = (e: MessageEvent) => {
    if (e.data?.type === "select-session" && typeof e.data.id === "string") cb(e.data.id);
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}

/** Subscribe to "open-learnings" messages posted by the SW when a learnings-retire
 *  notification is clicked (issue #852). Returns a disposer. */
export function onOpenLearnings(cb: () => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const handler = (e: MessageEvent) => {
    if (e.data?.type === "open-learnings") cb();
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
