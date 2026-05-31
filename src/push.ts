import webpush from "web-push";
import { config } from "./config";
import type { SessionStore, PushSubInput } from "./store";
import type { EventHub } from "./events";
import type { BlockReason } from "./blocked";

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  kind: "blocked" | "done";
  tag: string;
}

/** A notification described by intent, not text — localized per device at send time. */
export interface NotifyInput {
  kind: "blocked" | "done";
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
    doneTitle: (name: string) => `${name} — finished`,
    doneBody: "Agent finished its turn.",
    blockedTitle: (name: string) => `${name} — needs you`,
    menu: "Waiting on a menu choice.",
    "yes-no": "Waiting on a yes/no.",
    stall: "Quiet — no recent activity; may be stuck.",
    other: "Waiting on your input.",
  },
  de: {
    doneTitle: (name: string) => `${name} — fertig`,
    doneBody: "Agent hat seinen Zug beendet.",
    blockedTitle: (name: string) => `${name} — braucht dich`,
    menu: "Wartet auf eine Menüauswahl.",
    "yes-no": "Wartet auf ein Ja/Nein.",
    stall: "Ruhig — keine Aktivität; möglicherweise hängengeblieben.",
    other: "Wartet auf deine Eingabe.",
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
  return {
    ...base,
    title: t.blockedTitle(input.name),
    body: input.reason ? blockSummary(input.reason, locale) : t.other,
  };
}

export class PushService {
  private pub: string;

  constructor(
    private store: SessionStore,
    private send: SendFn = defaultSend,
    genKeys: GenKeys = () => webpush.generateVAPIDKeys(),
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
    try {
      webpush.setVapidDetails(config.vapidSubject, pub, priv);
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
    for (const row of this.store.listPushSubs()) {
      const sub: PushSubInput = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      const data = JSON.stringify(buildPayload(input, row.locale));
      try {
        const r = await this.send(sub, data);
        if (r?.statusCode === 404 || r?.statusCode === 410) this.store.deletePushSub(row.endpoint);
      } catch (err) {
        const code = (err as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) this.store.deletePushSub(row.endpoint);
        else console.warn(`[push] send failed for ${row.endpoint}:`, code ?? err);
      }
    }
  }
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
