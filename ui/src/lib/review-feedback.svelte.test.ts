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
  reviewFeedback.remote = {};
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

describe("mirrored sessions (#4139)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const read = (instanceId: string, key: string) => ({ instanceId, key });

  it("a machine snapshot seeds only its sessions, once per read key; load() leaves it", async () => {
    reviewFeedback.applyRemote({ id: "r2", pending: [item("ic:old")], autoPaused: false });
    mockGet.mockResolvedValue({
      r1: { items: [item("rc:1")], autoPaused: false },
      x9: { items: [item("rc:9")], autoPaused: false },
    });
    reviewFeedback.syncMachines([read("m-seed", "k1")], () => ["r1", "r2"]);
    await flush();
    expect(mockGet).toHaveBeenCalledWith("m-seed");
    expect(reviewFeedback.items("r1").map((i) => i.id)).toEqual(["rc:1"]);
    expect(reviewFeedback.items("r2")).toEqual([]); // the machine has nothing for it any more
    expect("x9" in reviewFeedback.remote).toBe(false); // not one of its mirrored sessions
    reviewFeedback.syncMachines([read("m-seed", "k1")], () => ["r1"]);
    expect(mockGet).toHaveBeenCalledTimes(1);
    mockGet.mockResolvedValue({});
    await reviewFeedback.load();
    expect(reviewFeedback.items("r1")).toHaveLength(1);
  });

  it("a failed read is retried on the next sync", async () => {
    mockGet.mockRejectedValueOnce(new Error("502"));
    reviewFeedback.syncMachines([read("m-retry", "k1")], () => ["r1"]);
    await flush();
    mockGet.mockResolvedValue({ r1: { items: [item("rc:1")], autoPaused: false } });
    reviewFeedback.syncMachines([read("m-retry", "k1")], () => ["r1"]);
    await flush();
    expect(reviewFeedback.items("r1")).toHaveLength(1);
  });

  it("frames replace a mirrored entry; pruning forgets sessions that left", () => {
    reviewFeedback.applyRemote({ id: "r1", pending: [item("rc:1")], autoPaused: true });
    expect(reviewFeedback.autoPaused("r1")).toBe(true);
    reviewFeedback.applyRemote({ id: "r3", pending: [item("rc:3")], autoPaused: false });
    reviewFeedback.pruneRemote(["r3"]);
    expect(Object.keys(reviewFeedback.remote)).toEqual(["r3"]);
    reviewFeedback.applyRemote({ id: "r3", pending: [], autoPaused: false });
    expect(reviewFeedback.remote).toEqual({});
  });
});
