/**
 * Review-feedback steer core (#4126): which PR review feedback counts, when an automatic steer
 * may go out, and the steer text itself. Pure, no I/O; the service in `review-feedback.ts` feeds
 * it forge reads and session state.
 */
import type { PrFeedbackItem } from "./forge/types";
import { fenceUntrusted, scrubFenceTokens } from "./untrusted";

/** Review bots trusted by default (logins normalized by {@link normalizeBotLogin}). */
export const REVIEW_FEEDBACK_PRESET_BOTS = [
  "coderabbitai",
  "copilot-pull-request-reviewer",
  "copilot",
  "claude",
] as const;

/** Per-repo delivery mode: `off` no fetch; `manual` card only; `autopilot` auto-send when the
 *  session's effective autopilot is on; `always` auto-send in attended sessions too. */
export type ReviewFeedbackMode = "off" | "manual" | "autopilot" | "always";

/** Lowercased, trimmed, without GitHub's trailing `[bot]`. */
export function normalizeBotLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

/** Written by Shepherd itself: critic reviews, author responses and the issue log all carry a
 *  `<!-- shepherd…` marker. */
export function isShepherdAuthored(body: string): boolean {
  return body.includes("<!-- shepherd");
}

/** True when an item can never count, whoever wrote it. */
function excluded(item: PrFeedbackItem, prAuthor: string): boolean {
  if (!item.body.trim() || isShepherdAuthored(item.body)) return true;
  if (!item.author || item.author.toLowerCase() === prAuthor.toLowerCase()) return true;
  if (item.kind === "rc" && item.resolved) return true;
  return item.kind === "review" && !item.reviewState;
}

/**
 * The cheap, synchronous half of eligibility. `drop` never counts; `bot` is an allowlisted bot
 * account; `needs-write-check` is a human whose standing the forge must confirm. Only real bot
 * accounts (`isBot`) match the allowlist, so a human named `claude` still needs write access.
 */
export function preFilter(
  item: PrFeedbackItem,
  ctx: { prAuthor: string; bots: readonly string[] },
): "drop" | "bot" | "needs-write-check" {
  if (excluded(item, ctx.prAuthor)) return "drop";
  if (!item.isBot) return "needs-write-check";
  const login = normalizeBotLogin(item.author);
  return ctx.bots.some((b) => normalizeBotLogin(b) === login) ? "bot" : "drop";
}

/** Feedback older than this is stored as primed: never shown, never sent. */
export function primeCutoff(sessionCreatedAt: number, featureActivatedAt: number): number {
  return Math.max(sessionCreatedAt, featureActivatedAt);
}

export function isPrimed(item: PrFeedbackItem, cutoff: number): boolean {
  return item.createdAt < cutoff;
}

/** At most this many automatic feedback steers per session per {@link AUTO_WINDOW_MS}. */
export const AUTO_CAP = 5;
export const AUTO_WINDOW_MS = 60 * 60_000;

/** Another automatic steer fits the rolling cap: fewer than {@link AUTO_CAP} sends in
 *  `(now - AUTO_WINDOW_MS, now]`. */
export function withinAutoCap(autoSentAts: number[], now: number): boolean {
  const since = now - AUTO_WINDOW_MS;
  return autoSentAts.filter((t) => t > since && t <= now).length < AUTO_CAP;
}

/** Whether the repo's mode lets feedback go out without the operator. */
export function autoSendAllowed(mode: ReviewFeedbackMode, autopilotOn: boolean): boolean {
  if (mode === "always") return true;
  return mode === "autopilot" && autopilotOn;
}

/** A steer that never started a turn stops blocking feedback after this long. */
export const STEER_QUIET_MS = 10 * 60_000;

/** The previous steer has been taken up: none was sent, the agent went idle after it, or it has
 *  sat for {@link STEER_QUIET_MS}. */
export function steerConsumed(
  lastSteerAt: number | undefined,
  idleEdgeAt: number | undefined,
  now: number,
): boolean {
  if (lastSteerAt === undefined) return true;
  if (idleEdgeAt !== undefined && idleEdgeAt > lastSteerAt) return true;
  return now - lastSteerAt >= STEER_QUIET_MS;
}

const MAX_BODY_CHARS = 4000;
/** Items one steer carries; the rest stay pending for the next one. */
export const MAX_STEER_ITEMS = 20;
const FENCE_LABEL = "review comment";

const REVIEW_STATE_LABEL: Record<NonNullable<PrFeedbackItem["reviewState"]>, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
};

/** Forge-supplied text made safe for a trusted line: no control characters, no fence tokens. */
function oneLine(text: string): string {
  return scrubFenceTokens(text.replace(/\p{Cc}+/gu, " ")).trim();
}

function where(item: PrFeedbackItem): string {
  if (item.kind === "review")
    return `review (${REVIEW_STATE_LABEL[item.reviewState ?? "commented"]})`;
  if (item.kind === "ic") return "PR comment";
  if (!item.path) return "inline comment";
  const path = oneLine(item.path);
  return item.line != null ? `${path}:${item.line}` : path;
}

function itemBlock(n: number, item: PrFeedbackItem): string {
  const who = `@${oneLine(item.author)}${item.isBot ? " (bot)" : ""}`;
  const body =
    item.body.length > MAX_BODY_CHARS ? `${item.body.slice(0, MAX_BODY_CHARS)}…` : item.body;
  return `${n}. ${who} — ${where(item)}:\n${fenceUntrusted(FENCE_LABEL, body)}`;
}

/** Input order, with each inline comment moved right after its parent review when that review is
 *  in the batch. */
function grouped(items: PrFeedbackItem[]): PrFeedbackItem[] {
  const reviews = new Set(items.filter((i) => i.kind === "review").map((i) => i.id));
  const nested = (i: PrFeedbackItem) =>
    i.kind === "rc" && !!i.parentReviewId && reviews.has(i.parentReviewId);
  return items.flatMap((i) => {
    if (nested(i)) return [];
    if (i.kind !== "review") return [i];
    return [i, ...items.filter((c) => nested(c) && c.parentReviewId === i.id)];
  });
}

/** The one batched steer for `items` on PR #`prNumber`. Fixed English: agent-facing, not i18n.
 *  Trusted lines name each item; every body travels in its own untrusted fence. */
export function buildReviewFeedbackSteer(prNumber: number, items: PrFeedbackItem[]): string {
  const ordered = grouped(items);
  const shown = ordered.slice(0, MAX_STEER_ITEMS);
  const header =
    `Shepherd: new review feedback on PR #${prNumber} from people or review bots with standing ` +
    "on this repo. Address each valid point in this PR, then commit & push. If you disagree " +
    "with a point, don't silently skip it — reply on the PR with " +
    `\`gh pr comment ${prNumber} --body "…"\` explaining why.`;
  const blocks = shown.map((item, i) => itemBlock(i + 1, item));
  const rest = ordered.length - shown.length;
  if (rest > 0) blocks.push(`+${rest} more — see the PR.`);
  return [header, ...blocks].join("\n\n");
}
