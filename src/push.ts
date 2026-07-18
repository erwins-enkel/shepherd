import webpush from "web-push";
import { config } from "./config";
import type { SessionStore, PushSubInput, StoredPushSub } from "./store";
import type { EventHub } from "./events";
import type { BlockReason } from "./blocked";
import type { ChecksState, GitState } from "./forge/types";
import { blockReasonToHoldCode, renderHold } from "./hold";

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  kind:
    | "blocked"
    | "done"
    | "review"
    | "ci"
    | "review-human"
    | "autopilot"
    | "autopilot-done"
    | "merge_attention"
    | "usage_limit"
    | "extra_credits"
    | "learnings_retired"
    | "learnings_trialed"
    | "manual_steps"
    | "ready"
    | "backup_stale"
    | "landing_conflict";
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
  merge_attention: "ci",
  usage_limit: "agent",
  extra_credits: "agent",
  learnings_retired: "agent",
  learnings_trialed: "agent",
  manual_steps: "ci",
  ready: "agent",
  // Host-global operational alert; ride the "agent" toggle like usage_limit/extra_credits.
  backup_stale: "agent",
  // Epic-global merge/land attention; ride the "ci" toggle like merge_attention/manual_steps.
  landing_conflict: "ci",
};

/** A notification described by intent, not text — localized per device at send time. */
export interface NotifyInput {
  kind:
    | "blocked"
    | "done"
    | "review"
    | "ci"
    | "review-human"
    | "autopilot"
    | "autopilot-done"
    | "merge_attention"
    | "usage_limit"
    | "extra_credits"
    | "learnings_retired"
    | "learnings_trialed"
    | "manual_steps"
    | "ready"
    | "backup_stale"
    | "landing_conflict";
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
  /** For kind "merge_attention": the automerge state ("merge_error" | "rebase_cap"). */
  mergeState?: "merge_error" | "rebase_cap";
  /** For kind "merge_attention": the desig of the session that needs attention. */
  desig?: string;
  /** For kind "usage_limit": percent of the 5-hour window already used. */
  pct?: number;
  /** For kind "usage_limit": epoch ms when the window resets. */
  resetAt?: number;
  /** For kind "extra_credits": paid extra-credit overage spent this window. */
  creditSpent?: number;
  /** For kind "extra_credits": the extra-credit cap for this window. */
  creditCap?: number;
  /** For kind "extra_credits": currency symbol/prefix for the amounts. */
  currency?: string;
  /** For kind "learnings_retired": how many rules the auto-retire sweep retired. */
  retiredCount?: number;
  /** For kind "learnings_trialed": how many proposals the auto-trial sweep promoted. */
  trialedCount?: number;
  /** For kind "backup_stale": whole hours since the newest snapshot (for the body copy). */
  staleHours?: number;
  /** For kind "landing_conflict": the epic's parent issue number (subject of the body). */
  epicNumber?: number;
  /** For kind "landing_conflict": the epic's landing PR number (subject of the body). */
  landingPr?: number;
  /** Overrides the cooldown key (default `${kind}:${sessionId}`). */
  cooldownKey?: string;
}

export type SendResult = { statusCode?: number };
export type SendFn = (sub: PushSubInput, payload: string) => Promise<SendResult>;
type GenKeys = () => { publicKey: string; privateKey: string };

/** Kinds that are allowed through even when reducedPushMode is on. */
const REDUCED_ALLOWED = new Set<NotifyInput["kind"]>([
  "ready",
  "usage_limit",
  "extra_credits",
  "backup_stale",
]);

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
    mergeErrorTitle: "Merge failed",
    mergeErrorBody: (desig: string) => `${desig}: the merge train needs your help`,
    rebaseCapTitle: "Rebase limit reached",
    rebaseCapBody: (desig: string) => `${desig}: too many rebase attempts — over to you`,
    usageLimitTitle: (pct: number) => `5-hour limit at ${pct}%`,
    usageLimitBody: (time: string | null) =>
      time ? `Approaching the usage cap — resets at ${time}.` : "Approaching the usage cap.",
    extraCreditsTitle: "Extra credits in use",
    extraCreditsBody: (amount: string) => `Now spending paid extra usage — ${amount} this period.`,
    learningsRetiredTitle: "Learnings auto-retired",
    learningsRetiredBody: (n: number) =>
      `${n} ${n === 1 ? "rule" : "rules"} auto-retired — tap to review.`,
    learningsTrialedTitle: "Learnings on trial",
    learningsTrialedBody: (n: number) =>
      `${n} ${n === 1 ? "proposal" : "proposals"} auto-promoted to trial — tap to review.`,
    readyTitle: (name: string) => `${name} — your turn`,
    readyBody: "Waiting on you for 5s — your turn.",
    manualStepsTitle: (name: string) => `${name} — manual steps`,
    manualStepsBody: "Ready to merge, but held until you ack the manual steps it needs.",
    backupStaleTitle: "Backups stale",
    backupStaleBody: (h: number | null) =>
      h !== null
        ? `No successful DB backup in ~${h}h — the backup timer may be failing.`
        : "No successful DB backup yet — the backup timer may be failing.",
    landingConflictTitle: "Landing needs rework",
    landingConflictBody: (epic: number, pr: number | null) =>
      pr !== null
        ? `Epic #${epic}'s landing PR #${pr} has a conflict with the default branch — over to you.`
        : `Epic #${epic}'s landing PR has a conflict with the default branch — over to you.`,
  },
  de: {
    doneTitle: (name: string) => `${name} — wartet`,
    doneBody: "Agent hat seinen Zug beendet.",
    blockedTitle: (name: string) => `${name} — braucht dich`,
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
    mergeErrorTitle: "Merge fehlgeschlagen",
    mergeErrorBody: (desig: string) => `${desig}: der Merge-Train braucht deine Hilfe`,
    rebaseCapTitle: "Rebase-Limit erreicht",
    rebaseCapBody: (desig: string) => `${desig}: zu viele Rebase-Versuche — du bist dran`,
    usageLimitTitle: (pct: number) => `5-Stunden-Limit bei ${pct} %`,
    usageLimitBody: (time: string | null) =>
      time ? `Limit fast erreicht — Reset um ${time}.` : "Limit fast erreicht.",
    extraCreditsTitle: "Zusatzguthaben aktiv",
    extraCreditsBody: (amount: string) =>
      `Kostenpflichtige Zusatznutzung läuft — ${amount} in diesem Zeitraum.`,
    learningsRetiredTitle: "Learnings automatisch zurückgezogen",
    learningsRetiredBody: (n: number) =>
      `${n} ${n === 1 ? "Regel" : "Regeln"} zurückgezogen — zum Prüfen tippen.`,
    learningsTrialedTitle: "Learnings im Test",
    learningsTrialedBody: (n: number) =>
      `${n} ${n === 1 ? "Vorschlag" : "Vorschläge"} automatisch in den Test übernommen — zum Prüfen tippen.`,
    readyTitle: (name: string) => `${name} — du bist dran`,
    readyBody: "Wartet seit 5s auf dich — du bist dran.",
    manualStepsTitle: (name: string) => `${name} — manuelle Schritte`,
    manualStepsBody:
      "Bereit zum Mergen, aber zurückgehalten, bis du die manuellen Schritte bestätigst.",
    backupStaleTitle: "Backups veraltet",
    backupStaleBody: (h: number | null) =>
      h !== null
        ? `Seit ~${h}h kein erfolgreiches DB-Backup — der Backup-Timer könnte fehlschlagen.`
        : "Noch kein erfolgreiches DB-Backup — der Backup-Timer könnte fehlschlagen.",
    landingConflictTitle: "Landing braucht Überarbeitung",
    landingConflictBody: (epic: number, pr: number | null) =>
      pr !== null
        ? `Der Landing-PR #${pr} von Epic #${epic} hat einen Konflikt mit dem Standard-Branch — du bist dran.`
        : `Der Landing-PR von Epic #${epic} hat einen Konflikt mit dem Standard-Branch — du bist dran.`,
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
  return renderHold({ code: blockReasonToHoldCode(reason) }, locale);
}

/** Autopilot body: the agent's summary when present, else the locale fallback line. */
function autopilotBody(summary: string | undefined, fallback: string): string {
  return summary && summary.trim() ? summary : fallback;
}

/** Learnings summary title/body (auto-retire vs auto-trial) — both background sweep pushes. */
function learningsParts(t: NotifyText, input: NotifyInput): { title: string; body: string } {
  return input.kind === "learnings_trialed"
    ? { title: t.learningsTrialedTitle, body: t.learningsTrialedBody(input.trialedCount ?? 0) }
    : { title: t.learningsRetiredTitle, body: t.learningsRetiredBody(input.retiredCount ?? 0) };
}

/** Merge-attention title/body: rebase-cap copy when capped, else the generic merge-error copy. */
function mergeAttentionParts(t: NotifyText, input: NotifyInput): { title: string; body: string } {
  const desig = input.desig ?? input.name;
  if (input.mergeState === "rebase_cap") {
    return { title: t.rebaseCapTitle, body: t.rebaseCapBody(desig) };
  }
  return { title: t.mergeErrorTitle, body: t.mergeErrorBody(desig) };
}

/** Landing-conflict title/body: the epic + landing-PR numbers the operator must rework. */
function landingConflictParts(t: NotifyText, input: NotifyInput): { title: string; body: string } {
  return {
    title: t.landingConflictTitle,
    body: t.landingConflictBody(input.epicNumber ?? 0, input.landingPr ?? null),
  };
}

/** Extra-credits body: the spent/cap amount formatted with the optional currency prefix. */
function extraCreditsBody(t: NotifyText, input: NotifyInput): string {
  const cur = input.currency ?? "";
  const amount = `${cur}${(input.creditSpent ?? 0).toFixed(2)} / ${cur}${(input.creditCap ?? 0).toFixed(2)}`;
  return t.extraCreditsBody(amount);
}

/** Locale-formatted clock time of a window reset, or null without an anchor. */
function resetTimeLabel(resetAt: number | undefined, locale: NotifyLocale): string | null {
  if (resetAt === undefined) return null;
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAt));
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
        body: autopilotBody(input.summary, t.autopilotFallback),
      };
    case "autopilot-done":
      return {
        ...base,
        title: t.autopilotDoneTitle(input.name),
        body: autopilotBody(input.summary, t.autopilotDoneFallback),
      };
    case "merge_attention":
      return { ...base, ...mergeAttentionParts(t, input) };
    case "usage_limit":
      return {
        ...base,
        title: t.usageLimitTitle(input.pct ?? 0),
        body: t.usageLimitBody(resetTimeLabel(input.resetAt, asLocale(locale))),
      };
    case "extra_credits":
      return { ...base, title: t.extraCreditsTitle, body: extraCreditsBody(t, input) };
    case "learnings_retired":
    case "learnings_trialed":
      return { ...base, ...learningsParts(t, input) };
    case "ready":
      return { ...base, title: t.readyTitle(input.name), body: t.readyBody };
    case "manual_steps":
      return { ...base, title: t.manualStepsTitle(input.name), body: t.manualStepsBody };
    case "backup_stale":
      return {
        ...base,
        title: t.backupStaleTitle,
        body: t.backupStaleBody(input.staleHours ?? null),
      };
    case "landing_conflict":
      return { ...base, ...landingConflictParts(t, input) };
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

  /** Returns true when at least one device actually received the push. */
  async notify(input: NotifyInput): Promise<boolean> {
    // Suppress while the app is actively in use: the live UI already surfaces
    // every status change, so an OS banner is pure noise. Decided server-side —
    // by simply not sending — because a service worker can't reliably drop a
    // push under userVisibleOnly:true (Android substitutes its own banner). We
    // don't touch the cooldown clock here: nothing was sent.
    if (this.isActive()) return false;
    if (config.reducedPushMode && !REDUCED_ALLOWED.has(input.kind)) return false;
    const cooldownMs = config.pushCooldownMs;
    const key = input.cooldownKey ?? `${input.kind}:${input.sessionId}`;
    const t = this.now();
    if (this.withinCooldown(key, t, cooldownMs)) return false;
    const category = KIND_CATEGORY[input.kind];
    let sent = false;
    for (const row of this.store.listPushSubs()) {
      // Honor the device's category selection: a sub that muted this category
      // never receives the push (filtered server-side so it works app-closed).
      // Exception: "ready" bypasses the category filter unconditionally — it must
      // reach all devices regardless of their agent/reviews/ci selection.
      if (input.kind !== "ready" && !row.cats[category]) continue;
      if (await this.deliver(row, input)) sent = true;
    }
    if (sent && cooldownMs > 0) this.lastNotified.set(key, t);
    return sent;
  }

  /** True when a prior send under `key` still falls inside the cooldown window.
   *  Suppresses repeats within the window of the last send that actually fired; a
   *  sustained flap stays suppressed until a full quiet window passes. Distinct
   *  kinds (done vs blocked) live under separate keys and never collapse. */
  private withinCooldown(key: string, t: number, cooldownMs: number): boolean {
    if (cooldownMs <= 0) return false;
    const last = this.lastNotified.get(key);
    return last !== undefined && t - last < cooldownMs;
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
    const { id, review } = data as {
      id: string;
      review: { decision: string; dismissed?: boolean } | null;
    };
    if (review?.decision !== "changes_requested" && review?.decision !== "commented") return;
    // A dismissed verdict is the operator taking over a stalled rework — clearStallState re-emits
    // session:review with the (unchanged) changes_requested decision, which must NOT re-notify.
    if (review.dismissed) return;
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

/** Bridge automerge:status attention states to push notifications. */
export function attachMergePush(events: EventHub, push: PushService): void {
  events.subscribe((event, data) => {
    if (event !== "automerge:status") return;
    const { repoPath, state, detail, sessionId } = data as {
      repoPath: string;
      enabled: boolean;
      state: string | null;
      detail: string | null;
      sessionId: string | null;
    };
    // A green, up-to-date, otherwise-ready PR held ONLY on un-acked manual operator steps (#1060):
    // the "don't let auto-merge eat this" nudge. computeMerge emits this state only for a PR that
    // is ready except for the gate, so it never fires for a red/draft PR. Per-session tag +
    // cooldown key; the cooldown stamp is set inside notify() only on a successful send (house rule
    // — optimistic stamping drops the signal).
    if (state === "manual_steps") {
      const desig = detail ?? repoPath;
      const target = sessionId ?? repoPath;
      void push
        .notify({
          kind: "manual_steps",
          sessionId: target,
          tag: `manual_steps:${target}`,
          name: desig,
          cooldownKey: `manual_steps:${target}`,
        })
        .catch((err) => console.warn("[push] manual_steps notify failed:", err));
      return;
    }
    if (state !== "merge_error" && state !== "rebase_cap") return;
    const desig = detail ?? repoPath;
    // Deep-link to the affected session when known; fall back to repoPath.
    const target = sessionId ?? repoPath;
    // Key the tag AND cooldown by the affected session (not the repo): two sessions in the
    // same repo hitting the same attention state must each surface (and not replace each
    // other on the device), rather than the second being collapsed/suppressed.
    void push
      .notify({
        kind: "merge_attention",
        sessionId: target,
        tag: `merge_attention:${target}`,
        name: desig,
        mergeState: state,
        desig,
        cooldownKey: `${state}:${target}`,
      })
      .catch((err) => console.warn("[push] merge_attention notify failed:", err));
  });
}

/** Warn when the 5-hour usage window crosses this percentage. */
export const USAGE_WARN_PCT = 80;
/** Setting key holding the resetAt of the 5h window already warned about. */
const USAGE_WARNED_KEY = "usageWarnedResetAt5h";

/** Push once per 5-hour window when usage crosses the warning threshold. */
export function attachUsagePush(
  events: EventHub,
  store: SessionStore,
  push: PushService,
  now: () => number = () => Date.now(),
): void {
  // The warned marker is read sync but persisted in notify's .then, so an emit
  // landing while a notify is still in flight would re-read the stale marker and
  // could double-warn the same window. Emits are ~30s apart, far wider than push
  // delivery — but don't rely on that spacing: skip while one is pending.
  let inFlight = false;
  events.subscribe((event, data) => {
    if (event !== "usage:limits") return;
    const { session5h } = data as { session5h: { pct: number; resetAt: number } | null };
    if (!session5h || session5h.pct < USAGE_WARN_PCT) return;
    // One warning per window: the stored resetAt marks the window already warned.
    // Persisted (not in-memory) so the post-merge redeploys don't re-announce it.
    const warned = Number(store.getSetting(USAGE_WARNED_KEY) ?? 0);
    if (inFlight || now() < warned) return;
    inFlight = true;
    void push
      .notify({
        kind: "usage_limit",
        sessionId: "",
        tag: "usage-5h",
        name: "5h",
        pct: session5h.pct,
        resetAt: session5h.resetAt,
        cooldownKey: "usage_limit:5h",
      })
      .then((sent) => {
        // Only mark the window once a device heard it: a push suppressed while
        // the app is active retries next tick and fires when the user steps away.
        if (sent) store.setSetting(USAGE_WARNED_KEY, String(session5h.resetAt));
      })
      .catch((err) => console.warn("[push] usage_limit notify failed:", err))
      .finally(() => {
        inFlight = false;
      });
  });
}

/** Setting key holding the year-month bucket of the credit window already warned about. */
const CREDITS_WARNED_KEY = "usage_credits_warned";

/** A snapshot of the paid extra-credit (pay-as-you-go overage) window, off usage:limits. */
interface CreditWindowLike {
  spent: number;
  cap: number;
  currency: string;
  resetAt: number | null;
  stale: boolean;
}

/** Year-month bucket ("YYYY-MM") identifying the credit window via its upcoming reset month. */
function creditBucket(resetAt: number | null, now: number): string {
  const d = new Date(resetAt ?? now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Push once per monthly credit window the first time paid extra-credit spend exceeds 0. */
export function attachCreditsPush(
  events: EventHub,
  store: SessionStore,
  push: PushService,
  now: () => number = () => Date.now(),
): void {
  // Same in-flight discipline as attachUsagePush: the warned bucket is read sync
  // but persisted in notify's .then, so an emit landing mid-delivery would re-read
  // the stale marker and could double-warn the same window. Skip while one pends.
  let inFlight = false;
  events.subscribe((event, data) => {
    if (event !== "usage:limits") return;
    const { credits } = data as { credits: CreditWindowLike | null };
    // Gate on freshness (a stale snapshot is data the app disregards) and key off
    // spent: pct rounds to 0 while real money is being spent.
    if (!credits || credits.stale || credits.spent <= 0) return;
    // One warning per monthly window, keyed by the bucket (stable per window,
    // survives redeploys) — NOT the raw resetAt epoch, which could shift/mis-roll.
    const bucket = creditBucket(credits.resetAt, now());
    const warned = store.getSetting(CREDITS_WARNED_KEY);
    if (inFlight || warned === bucket) return;
    inFlight = true;
    void push
      .notify({
        kind: "extra_credits",
        sessionId: "",
        tag: "usage-credits",
        name: "credits",
        creditSpent: credits.spent,
        creditCap: credits.cap,
        currency: credits.currency,
        cooldownKey: "usage_limit:credits",
      })
      .then((sent) => {
        // Only mark the window once a device heard it: a push suppressed while
        // the app is active retries next tick and fires when the user steps away.
        if (sent) store.setSetting(CREDITS_WARNED_KEY, bucket);
      })
      .catch((err) => console.warn("[push] extra_credits notify failed:", err))
      .finally(() => {
        inFlight = false;
      });
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
