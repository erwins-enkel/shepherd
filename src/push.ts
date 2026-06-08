import webpush from "web-push";
import { config } from "./config";
import type { SessionStore, PushSubInput, StoredPushSub } from "./store";
import type { EventHub } from "./events";
import type { BlockReason } from "./blocked";
import type { ChecksState, GitState } from "./forge/types";

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  kind: "blocked" | "done" | "review" | "ci" | "review-human" | "autopilot" | "autopilot-done";
  tag: string;
}

/** User-facing notification categories — coarser than the internal kinds. */
type PushCategory = "agent" | "reviews" | "ci";

/** Maps each internal kind to the category a device toggles. Single source of truth. */
const KIND_CATEGORY: Record<PushPayload["kind"], PushCategory> = {
  blocked: "agent",
  done: "agent",
  autopilot: "agent",
  "autopilot-done": "agent",
  review: "reviews",
  "review-human": "reviews",
  ci: "ci",
};

/** A notification described by intent, not text — localized per device at send time. */
export interface NotifyInput {
  kind: "blocked" | "done" | "review" | "ci" | "review-human" | "autopilot" | "autopilot-done";
  sessionId: string;
  tag: string;
  name: string;
  reason?: BlockReason;
  /** For kind "review": which critic verdict, selecting the body copy. */
  decision?: "changes_requested" | "commented";
  /** For kind "ci": the new rollup state, selecting the body copy. */
  ciState?: ChecksState;
  /** For kind "review-human": the human review state, selecting the body copy. */
  reviewState?: "approved" | "changes_requested" | "commented";
  /** For kind "autopilot"/"autopilot-done": the classifier's hand-back summary (verbatim). */
  summary?: string;
  /** Overrides the cooldown key (default `${kind}:${sessionId}`). */
  cooldownKey?: string;
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
    reviewCommentBody: "Critic left a comment on the PR.",
    ciTitle: (name: string) => `${name} — CI`,
    ciPending: "CI running.",
    ciSuccess: "CI passed.",
    ciFailure: "CI failed.",
    humanReviewTitle: (name: string) => `${name} — review`,
    humanApproved: "A reviewer approved your PR.",
    humanChanges: "A reviewer requested changes.",
    humanCommented: "A reviewer left a comment.",
    autopilotTitle: (name: string) => `${name} — needs you`,
    autopilotFallback: "Autopilot paused for your input.",
    autopilotDoneTitle: (name: string) => `${name} — complete`,
    autopilotDoneFallback: "Autopilot finished — task complete, nothing to open as a PR.",
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
    reviewCommentBody: "Kritiker hat den PR kommentiert.",
    ciTitle: (name: string) => `${name} — CI`,
    ciPending: "CI läuft.",
    ciSuccess: "CI bestanden.",
    ciFailure: "CI fehlgeschlagen.",
    humanReviewTitle: (name: string) => `${name} — Review`,
    humanApproved: "Ein Reviewer hat deinen PR genehmigt.",
    humanChanges: "Ein Reviewer fordert Änderungen an.",
    humanCommented: "Ein Reviewer hat einen Kommentar hinterlassen.",
    autopilotTitle: (name: string) => `${name} — braucht dich`,
    autopilotFallback: "Autopilot pausiert für deine Eingabe.",
    autopilotDoneTitle: (name: string) => `${name} — fertig`,
    autopilotDoneFallback: "Autopilot fertig — Aufgabe erledigt, kein PR zu öffnen.",
  },
} as const;

type NotifyText = (typeof NOTIFY_TEXT)[NotifyLocale];

function asLocale(l: string | undefined): NotifyLocale {
  return l === "de" ? "de" : "en";
}

/** CI notification body for a rollup state (anything but success/failure reads as running). */
function ciBody(t: NotifyText, state: NotifyInput["ciState"]): string {
  if (state === "success") return t.ciSuccess;
  if (state === "failure") return t.ciFailure;
  return t.ciPending;
}

/** Human-review body for a review state (default: changes-requested copy). */
function humanReviewBody(t: NotifyText, state: NotifyInput["reviewState"]): string {
  if (state === "approved") return t.humanApproved;
  if (state === "commented") return t.humanCommented;
  return t.humanChanges;
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
  switch (input.kind) {
    case "done":
      return { ...base, title: t.doneTitle(input.name), body: t.doneBody };
    case "review":
      return {
        ...base,
        title: t.reviewTitle(input.name),
        body: input.decision === "commented" ? t.reviewCommentBody : t.reviewBody,
      };
    case "ci":
      return { ...base, title: t.ciTitle(input.name), body: ciBody(t, input.ciState) };
    case "review-human":
      return {
        ...base,
        title: t.humanReviewTitle(input.name),
        body: humanReviewBody(t, input.reviewState),
      };
    case "autopilot":
      return {
        ...base,
        title: t.autopilotTitle(input.name),
        body: input.summary && input.summary.trim() ? input.summary : t.autopilotFallback,
      };
    case "autopilot-done":
      return {
        ...base,
        title: t.autopilotDoneTitle(input.name),
        body: input.summary && input.summary.trim() ? input.summary : t.autopilotDoneFallback,
      };
    default:
      return {
        ...base,
        title: t.blockedTitle(input.name),
        body: input.reason ? blockSummary(input.reason, locale) : t.other,
      };
  }
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
    const key = input.cooldownKey ?? `${input.kind}:${input.sessionId}`;
    const t = this.now();
    // Suppress repeats within the window of the last send that actually fired; a
    // sustained flap stays suppressed until a full quiet window passes. Distinct
    // kinds (done vs blocked) live under separate keys and never collapse.
    if (cooldownMs > 0) {
      const last = this.lastNotified.get(key);
      if (last !== undefined && t - last < cooldownMs) return;
    }
    const category = KIND_CATEGORY[input.kind];
    let sent = false;
    for (const row of this.store.listPushSubs()) {
      // Honor the device's category selection: a sub that muted this category
      // never receives the push (filtered server-side so it works app-closed).
      if (!row.cats[category]) continue;
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

/** Push when the critic posts a verdict (changes-requested or comment) — an attention signal. */
export function attachReviewPush(events: EventHub, store: SessionStore, push: PushService): void {
  events.subscribe((event, data) => {
    if (event !== "session:review") return;
    const { id, review } = data as { id: string; review: { decision: string } | null };
    if (review?.decision !== "changes_requested" && review?.decision !== "commented") return;
    const name = store.get(id)?.name ?? id;
    void push.notify({
      kind: "review",
      sessionId: id,
      tag: `review:${id}`,
      name,
      decision: review.decision,
    });
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

/** Bridge session:git changes to push: every CI transition + each newer human review. */
export function attachGitPush(events: EventHub, store: SessionStore, push: PushService): void {
  const primed = new Set<string>();
  const lastChecks = new Map<string, ChecksState>();
  const lastReviewTs = new Map<string, number>();
  events.subscribe((event, data) => {
    if (event === "session:archived") {
      const { id } = data as { id: string };
      primed.delete(id);
      lastChecks.delete(id);
      lastReviewTs.delete(id);
      return;
    }
    if (event !== "session:git") return;
    const { id, git } = data as { id: string; git: GitState };

    // First sighting of a session (process start, or a PR first appearing): seed
    // the dedup state from what's already true and DON'T notify. Otherwise a
    // restart — the in-memory maps start empty, and a redeploy happens after
    // every merge — would re-announce CI/review status that settled long ago as
    // if it were a fresh transition. Only state present *now* is primed: a review
    // that lands later still notifies (its ts beats the unset -Infinity sentinel).
    if (!primed.has(id)) {
      primed.add(id);
      lastChecks.set(id, git.checks);
      if (git.latestReview) lastReviewTs.set(id, git.latestReview.submittedAt);
      return;
    }

    const name = store.get(id)?.name ?? id;

    // CI: notify on any transition into a meaningful state (skip "none").
    if (git.checks !== lastChecks.get(id)) {
      lastChecks.set(id, git.checks);
      if (git.checks !== "none") {
        void push.notify({
          kind: "ci",
          sessionId: id,
          tag: `ci:${id}`,
          name,
          ciState: git.checks,
          cooldownKey: `ci:${id}:${git.checks}`,
        });
      }
    }

    // Human review: notify when a strictly newer review lands.
    const r = git.latestReview;
    if (r && r.submittedAt > (lastReviewTs.get(id) ?? -Infinity)) {
      lastReviewTs.set(id, r.submittedAt);
      void push.notify({
        kind: "review-human",
        sessionId: id,
        tag: `review-human:${id}`,
        name,
        reviewState: r.state,
        cooldownKey: `review-human:${id}:${r.submittedAt}`,
      });
    }
  });
}
