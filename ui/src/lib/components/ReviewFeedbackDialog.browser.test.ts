import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { ReviewFeedbackItem } from "#lib/types.js";

const sendReviewFeedback = vi.fn();
const dismissReviewFeedback = vi.fn();
vi.mock("#lib/api.js", async (orig) => ({
  ...(await orig<typeof import("#lib/api.js")>()),
  sendReviewFeedback: (...a: unknown[]) => sendReviewFeedback(...a),
  dismissReviewFeedback: (...a: unknown[]) => dismissReviewFeedback(...a),
}));

const { m } = await import("#lib/paraglide/messages.js");
const { reviewFeedback } = await import("#lib/review-feedback.svelte.js");
const { default: ReviewFeedbackDialog } = await import("./ReviewFeedbackDialog.svelte");
const { default: ReviewFeedbackBadge } = await import("./ReviewFeedbackBadge.svelte");

const item = (over: Partial<ReviewFeedbackItem>): ReviewFeedbackItem => ({
  id: "review:1",
  kind: "review",
  author: "alice",
  isBot: false,
  body: "Please **rename** this.",
  createdAt: Date.now() - 120_000,
  reviewState: "changes_requested",
  status: "pending",
  sentAt: null,
  sentBy: null,
  ...over,
});

const ITEMS = [
  item({}),
  item({
    id: "rc:2",
    kind: "rc",
    author: "coderabbitai",
    isBot: true,
    body: "Off by one <script>alert(1)</script>",
    reviewState: undefined,
    path: "src/a.ts",
    line: 12,
    parentReviewId: "review:1",
  }),
];

beforeEach(() => {
  reviewFeedback.map = { s1: { items: ITEMS, autoPaused: false } };
});
afterEach(() => {
  document.body.innerHTML = "";
  reviewFeedback.map = {};
  sendReviewFeedback.mockReset();
  dismissReviewFeedback.mockReset();
});

/** Mirror the server: its session:review-feedback event (the full remaining list) lands before
 *  the HTTP reply. `kept` are ids the server leaves pending despite the request (overflow). */
function serverEvent(removed: readonly string[], kept: readonly string[] = []) {
  const gone = new Set(removed.filter((id) => !kept.includes(id)));
  reviewFeedback.apply({
    id: "s1",
    pending: reviewFeedback.items("s1").filter((i) => !gone.has(i.id)),
    autoPaused: false,
  });
}

function open(onclose = vi.fn()) {
  render(ReviewFeedbackDialog, {
    sessionId: "s1",
    prNumber: 7,
    prUrl: "https://github.com/o/r/pull/7",
    onclose,
  });
  return onclose;
}

const checkbox = (author: string) =>
  page.getByRole("checkbox", { name: m.reviewfeedback_select({ author }) });

describe("ReviewFeedbackDialog (#4126)", () => {
  it("lists each item with author, bot tag, location and sanitized markdown", async () => {
    open();
    await expect
      .element(page.getByRole("dialog", { name: m.reviewfeedback_title() }))
      .toBeVisible();
    await expect.element(page.getByText("@alice")).toBeVisible();
    await expect.element(page.getByText("@coderabbitai")).toBeVisible();
    await expect.element(page.getByText(m.reviewfeedback_bot(), { exact: true })).toBeVisible();
    await expect.element(page.getByText(m.reviewfeedback_state_changes_requested())).toBeVisible();
    await expect.element(page.getByText("src/a.ts:12")).toBeVisible();
    await expect.poll(() => document.querySelector(".rf-body strong")?.textContent).toBe("rename");
    expect(document.querySelector(".rf-body script")).toBeNull();
    await expect.element(checkbox("alice")).toBeChecked();
    await expect.element(checkbox("coderabbitai")).toBeChecked();
    await expect
      .element(page.getByRole("link", { name: /PR #7/ }))
      .toHaveAttribute("href", "https://github.com/o/r/pull/7");
  });

  it("sends only the selected items and closes once none are left", async () => {
    sendReviewFeedback.mockImplementation(async (_id: string, ids: string[]) => {
      serverEvent(ids);
      return null;
    });
    const onclose = open();
    await checkbox("coderabbitai").click();
    await page.getByRole("button", { name: m.reviewfeedback_send() }).click();
    expect(sendReviewFeedback).toHaveBeenCalledWith("s1", ["review:1"]);
    await expect.poll(() => reviewFeedback.items("s1").map((i) => i.id)).toEqual(["rc:2"]);
    expect(onclose).not.toHaveBeenCalled();
    await checkbox("coderabbitai").click();
    await page.getByRole("button", { name: m.reviewfeedback_send() }).click();
    expect(sendReviewFeedback).toHaveBeenLastCalledWith("s1", ["rc:2"]);
    await expect.poll(() => onclose.mock.calls.length).toBe(1);
  });

  it.each([
    ["not_running", () => m.reviewfeedback_not_running()],
    ["no_pr", () => m.reviewfeedback_refused_no_pr()],
    ["pr_closed", () => m.reviewfeedback_refused_pr_closed()],
    ["nothing_pending", () => m.reviewfeedback_refused_nothing_pending()],
    ["busy", () => m.reviewfeedback_refused_busy()],
    ["failed", () => m.reviewfeedback_failed()],
  ])("a refused send (409 %s) keeps the items and says why (#4144)", async (reason, copy) => {
    sendReviewFeedback.mockResolvedValue(reason);
    const onclose = open();
    await page.getByRole("button", { name: m.reviewfeedback_send() }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(copy());
    expect(reviewFeedback.items("s1")).toHaveLength(2);
    expect(onclose).not.toHaveBeenCalled();
  });

  it("a send the server only partly delivers keeps the overflow listed", async () => {
    sendReviewFeedback.mockImplementation(async (_id: string, ids: string[]) => {
      serverEvent(ids, ["rc:2"]); // the server marked only review:1 sent
      return null;
    });
    const onclose = open();
    await page.getByRole("button", { name: m.reviewfeedback_send() }).click();
    expect(sendReviewFeedback).toHaveBeenCalledWith("s1", ["review:1", "rc:2"]);
    await expect.poll(() => reviewFeedback.items("s1").map((i) => i.id)).toEqual(["rc:2"]);
    expect(onclose).not.toHaveBeenCalled();
    await expect.element(checkbox("coderabbitai")).toBeVisible();
  });

  it("dismiss calls the API with the selected ids", async () => {
    dismissReviewFeedback.mockImplementation(async (_id: string, ids: string[]) => {
      serverEvent(ids);
    });
    const onclose = open();
    await page.getByRole("button", { name: m.reviewfeedback_dismiss() }).click();
    expect(dismissReviewFeedback).toHaveBeenCalledWith("s1", ["review:1", "rc:2"]);
    await expect.poll(() => onclose.mock.calls.length).toBe(1);
  });

  it("disables both actions while nothing is selected", async () => {
    open();
    await checkbox("alice").click();
    await checkbox("coderabbitai").click();
    await expect
      .element(page.getByRole("button", { name: m.reviewfeedback_send() }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: m.reviewfeedback_dismiss() }))
      .toBeDisabled();
  });
});

describe("ReviewFeedbackBadge (#4126)", () => {
  it("renders nothing while nothing is pending", async () => {
    reviewFeedback.map = {};
    render(ReviewFeedbackBadge, { sessionId: "s1" });
    expect(document.querySelector(".rf-badge")).toBeNull();
  });

  it("counts the comments, explains them (with the pause) and opens the dialog", async () => {
    reviewFeedback.map = { s1: { items: ITEMS, autoPaused: true } };
    render(ReviewFeedbackBadge, { sessionId: "s1" });
    const badge = page.getByRole("button", { name: m.reviewfeedback_badge_other({ count: 2 }) });
    const desc = badge.element().getAttribute("aria-description") ?? "";
    expect(desc).toContain(m.tooltip_review_comments_from());
    expect(desc).toContain(m.tooltip_review_comments_paused());
    await badge.click();
    await expect
      .element(page.getByRole("dialog", { name: m.reviewfeedback_title() }))
      .toBeVisible();
  });
});
