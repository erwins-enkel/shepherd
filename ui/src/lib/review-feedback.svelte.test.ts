import { describe, it, expect, vi, beforeEach } from "vitest";
import { reviewFeedback } from "./review-feedback.svelte";
import { getPendingReviewFeedback } from "./api";
import type { ReviewFeedbackItem } from "./types";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, getPendingReviewFeedback: vi.fn() };
});
const mockGet = vi.mocked(getPendingReviewFeedback);

const item = (id: string): ReviewFeedbackItem => ({
  id,
  kind: "ic",
  author: "alice",
  isBot: false,
  body: "nit",
  createdAt: 1000,
  status: "pending",
  sentAt: null,
  sentBy: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  reviewFeedback.map = {};
});

describe("review feedback store (#4126)", () => {
  it("load() seeds the snapshot, and a failure leaves live events to populate it", async () => {
    mockGet.mockResolvedValue({ s1: { items: [item("ic:1")], autoPaused: true } });
    await reviewFeedback.load();
    expect(reviewFeedback.items("s1").map((i) => i.id)).toEqual(["ic:1"]);
    expect(reviewFeedback.autoPaused("s1")).toBe(true);
    mockGet.mockRejectedValue(new Error("offline"));
    await expect(reviewFeedback.load()).resolves.toBeUndefined();
    expect(reviewFeedback.items("s1")).toHaveLength(1);
  });

  it("apply() REPLACES the session's list — the payload is always the full set", () => {
    reviewFeedback.apply({ id: "s1", pending: [item("ic:1"), item("ic:2")], autoPaused: false });
    reviewFeedback.apply({ id: "s1", pending: [item("ic:3")], autoPaused: false });
    expect(reviewFeedback.items("s1").map((i) => i.id)).toEqual(["ic:3"]);
  });

  it("an empty, unpaused payload drops the entry; a paused one keeps the cue", () => {
    reviewFeedback.apply({ id: "s1", pending: [item("ic:1")], autoPaused: false });
    reviewFeedback.apply({ id: "s1", pending: [], autoPaused: false });
    expect("s1" in reviewFeedback.map).toBe(false);
    reviewFeedback.apply({ id: "s1", pending: [], autoPaused: true });
    expect(reviewFeedback.autoPaused("s1")).toBe(true);
    expect(reviewFeedback.items("s1")).toEqual([]);
  });
});
