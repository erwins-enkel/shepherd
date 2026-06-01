import webpush from "web-push";
import { config } from "./config";
import type { SessionStore, PushSubInput, StoredPushSub } from "./store";
import type { EventHub } from "./events";
import type { BlockReason } from "./blocked";

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  kind: "blocked" | "done" | "review";
  tag: string;
}

/** A notification described by intent, not text — localized per device at send time. */
export interface NotifyInput {
  kind: "blocked" | "done" | "review";
  sessionId: string;
  tag: string;
  name: string;
  reason?: BlockReason;
}

export type SendResult = { statusCode?: number };
export type SendFn = (sub: PushSubInput, payload: string) => Promise<SendResult>;
type GenKeys = () => { publicKey: string; privateKey: string };

const defaultSend: SendFn = (sub, payload) =>
  webpush.sendNotification(sub as webpush.PushSubscription, payload) as Promise<SendResult>;

// Notification copy lives server-side (the UI's Paraglide catalog isn't reachable
// from the server package). Keep EN+DE in sync with ui/messages by hand — it's a
// handful of strings. Locale comes from the subscribing device (push_subscriptions.locale).
type NotifyLocale = "en" | "de";
const NOTIFY_TEXT = {
  en: {
    doneTitle: (name: string) => `${name} — waiting`,
    doneBody: "Agent finished its turn.",
    blockedTitle: (name: string) => `${name} — needs you`,
    menu: "Waiting on a menu choice.",
    "yes-no": "Waiting on a yes/no.",
    stall: "Quiet — no recent activity; may be stuck.",
    other: "Waiting on your input.",
    reviewTitle: (name: string) => `${name} — review`,
    reviewBody: "Critic requested changes on the PR.",
  },
  de: {
    doneTitle: (name: string) => `${name} — wartet`,
    doneBody: "Agent hat seinen Zug beendet.",
    blockedTitle: (name: string) => `${name} — braucht dich`,
    menu: "Wartet auf eine Menüauswahl.",
    "yes-no": "Wartet auf ein Ja/Nein.",
    stall: "Ruhig — keine Aktivität; möglicherweise hängengeblieben.",
    other: "Wartet auf deine Eingabe.",
    reviewTitle: (name: string) => `${name} — Review`,
    reviewBody: "Kritiker fordert Änderungen am PR an.",
  },
} as const;

function asLocale(l: string | undefined): NotifyLocale {
  return l === "de" ? "de" : "en";
}

/** Short human line describing why an agent is blocked, for the notification body. */
export function blockSummary(reason: BlockReason, locale: string = "en"): string {
  const t = NOTIFY_TEXT[asLocale(locale)];
  switch (reason.shape) {
    case "menu":
      return t.menu;
    case "yes-no":
      return t["yes-no"];
    case "stall":
      return t.stall;
    default:
      return t.other;
  }
}

/** Build the device-facing payload for a notification in the subscriber's locale. */
export function buildPayload(input: NotifyInput, locale: string): PushPayload {
  const t = NOTIFY_TEXT[asLocale(locale)];
  const base = { sessionId: input.sessionId, kind: input.kind, tag: input.tag };
  if (input.kind === "done") {
    return { ...base, title: t.doneTitle(input.name), body: t.doneBody };
  }
  if (input.kind === "review") {
    return { ...base, title: t.reviewTitle(input.name), body: t.reviewBody };
  }
  return {
    ...base,
    title: t.blockedTitle(input.name),
    body: input.reason ? blockSummary(input.reason, locale) : t.other,
  };
}

export class PushService {
  private pub: string;
  /** Last *successful-send* timestamp per `${kind}:${sessionId}`, for cooldown debouncing. */
  private lastNotified = new Map<string, number>();

  constructor(
    private store: SessionStore,
    private send: SendFn = defaultSend,
    genKeys: GenKeys = () => webpush.generateVAPIDKeys(),
    private now: () => number = () => Date.now(),
    /** True while a window is actively in use; such pushes are suppressed. */
    private isActive: () => boolean = () => false,
  ) {
    let pub = config.vapidPublic ?? store.getSetting("vapidPublic");
    let priv = config.vapidPrivate ?? store.getSetting("vapidPrivate");
    if (!pub || !priv) {
      const k = genKeys();
      pub = k.publicKey;
      priv = k.privateKey;
      store.setSetting("vapidPublic", pub);
      store.setSetting("vapidPrivate", priv);
    }
    this.pub = pub;
    const subject = config.vapidSubject;
    if (subject.includes("localhost") || !/^(mailto:|https:\/\/)/.test(subject)) {
      console.warn(
        `[push] VAPID subject ${JSON.stringify(subject)} is invalid — Apple/iOS will ` +
          "reject pushes with HTTP 403 BadJwtToken. Set SHEPHERD_VAPID_SUBJECT to a " +
          "valid https: or mailto: URL (e.g. https://example.com or mailto:you@example.com).",
      );
    }
    try {
      webpush.setVapidDetails(subject, pub, priv);
    } catch (err) {
      console.warn("[push] setVapidDetails failed:", err);
    }
  }

  publicKey(): string {
    return this.pub;
  }

  subscribe(sub: PushSubInput, ua: string): void {
    this.store.putPushSub(sub, ua);
  }

  unsubscribe(endpoint: string): void {
    this.store.deletePushSub(endpoint);
  }

  async notify(input: NotifyInput): Promise<void> {
    // Suppress while the app is actively in use: the live UI already surfaces
    // every status change, so an OS banner is pure noise. Decided server-side —
    // by simply not sending — because a service worker can't reliably drop a
    // push under userVisibleOnly:true (Android substitutes its own banner). We
    // don't touch the cooldown clock here: nothing was sent.
    if (this.isActive()) return;
    const cooldownMs = config.pushCooldownMs;
    const key = `${input.kind}:${input.sessionId}`;
    const t = this.now();
    // Suppress repeats within the window of the last send that actually fired; a
    // sustained flap stays suppressed until a full quiet window passes. Distinct
    // kinds (done vs blocked) live under separate keys and never collapse.
    if (cooldownMs > 0) {
      const last = this.lastNotified.get(key);
      if (last !== undefined && t - last < cooldownMs) return;
    }
    let sent = false;
    for (const row of this.store.listPushSubs()) {
      if (await this.deliver(row, input)) sent = true;
    }
    if (sent && cooldownMs > 0) this.lastNotified.set(key, t);
  }

  /** Send one notification; prune dead subs, log diagnostics. Returns true if delivered. */
  private async deliver(row: StoredPushSub, input: NotifyInput): Promise<boolean> {
    const sub: PushSubInput = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    const data = JSON.stringify(buildPayload(input, row.locale));
    try {
      const code = (await this.send(sub, data))?.statusCode;
      if (code === 404 || code === 410) {
        this.store.deletePushSub(row.endpoint);
        return false;
      }
      return true;
    } catch (err) {
      this.onSendError(row.endpoint, (err as { statusCode?: number })?.statusCode, err);
      return false;
    }
  }

  /** Prune gone subs (404/410); surface the 403 BadJwtToken misconfig distinctly. */
  private onSendError(endpoint: string, code: number | undefined, err: unknown): void {
    if (code === 404 || code === 410) {
      this.store.deletePushSub(endpoint);
    } else if (code === 403) {
      console.warn(
        `[push] 403 for ${endpoint} — likely an invalid VAPID subject ` +
          `(Apple BadJwtToken). Check SHEPHERD_VAPID_SUBJECT (currently ` +
          `${JSON.stringify(config.vapidSubject)}); it must be a valid https: ` +
          "or mailto: URL with no localhost.",
      );
    } else {
      console.warn(`[push] send failed for ${endpoint}:`, code ?? err);
    }
  }
}

/** Push when a critic requests changes (an attention signal, like a block). */
export function attachReviewPush(events: EventHub, store: SessionStore, push: PushService): void {
  events.subscribe((event, data) => {
    if (event !== "session:review") return;
    const { id, review } = data as { id: string; review: { decision: string } | null };
    if (review?.decision !== "changes_requested") return;
    const name = store.get(id)?.name ?? id;
    void push.notify({ kind: "review", sessionId: id, tag: `review:${id}`, name });
  });
}

/** Bridge F3 state events to push notifications. Both events are already edge-triggered. */
export function attachPush(events: EventHub, store: SessionStore, push: PushService): void {
  events.subscribe((event, data) => {
    if (event === "session:status") {
      const { id, status } = data as { id: string; status: string };
      if (status !== "done") return;
      const name = store.get(id)?.name ?? id;
      void push.notify({ kind: "done", sessionId: id, tag: id, name });
    } else if (event === "session:block") {
      const { id, block } = data as { id: string; block: BlockReason | null };
      if (!block) return;
      const name = store.get(id)?.name ?? id;
      void push.notify({ kind: "blocked", sessionId: id, tag: id, name, reason: block });
    }
  });
}
