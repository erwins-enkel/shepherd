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
    sendReviewFeedback.mockResolvedValue(true);
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

  it("an agent that isn't running (409) keeps the items and says so", async () => {
    sendReviewFeedback.mockResolvedValue(false);
    const onclose = open();
    await page.getByRole("button", { name: m.reviewfeedback_send() }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.reviewfeedback_not_running());
    expect(reviewFeedback.items("s1")).toHaveLength(2);
    expect(onclose).not.toHaveBeenCalled();
  });

  it("dismiss calls the API with the selected ids", async () => {
    dismissReviewFeedback.mockResolvedValue(undefined);
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
