import { describe, it, expect, vi, beforeEach } from "vitest";
import { amendments } from "./amendments.svelte";
import { getAmendments } from "./api";
import type { TaskAmendment } from "./types";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, getAmendments: vi.fn() };
});
const mockGet = vi.mocked(getAmendments);

const row = (over: Partial<TaskAmendment> = {}): TaskAmendment => ({
  id: "a1",
  sessionId: "s1",
  text: "widen it",
  createdAt: 1000,
  retractedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  amendments.map = {};
});

describe("amendments store", () => {
  it("load() seeds the snapshot", async () => {
    mockGet.mockResolvedValue({ s1: [row()] });
    await amendments.load();
    expect(amendments.forSession("s1").map((a) => a.text)).toEqual(["widen it"]);
  });

  it("load() is best-effort — a failure leaves live events to populate it", async () => {
    mockGet.mockRejectedValue(new Error("offline"));
    await expect(amendments.load()).resolves.toBeUndefined();
    expect(amendments.forSession("s1")).toEqual([]);
  });

  it("apply() REPLACES a session's list — the payload is always the full set", async () => {
    amendments.map = { s1: [row({ id: "a1" }), row({ id: "a2" })] };
    amendments.apply({ id: "s1", amendments: [row({ id: "a3", text: "only this" })] });
    expect(amendments.forSession("s1").map((a) => a.text)).toEqual(["only this"]);
  });

  it("an empty payload is a genuine all-clear, not a no-op", () => {
    amendments.map = { s1: [row()] };
    amendments.apply({ id: "s1", amendments: [] });
    expect(amendments.forSession("s1")).toEqual([]);
  });

  it("standing() hides retracted amendments; forSession() keeps them for the record", () => {
    amendments.map = {
      s1: [row({ id: "a1" }), row({ id: "a2", text: "gone", retractedAt: 5 })],
    };
    expect(amendments.standing("s1").map((a) => a.id)).toEqual(["a1"]);
    expect(amendments.forSession("s1")).toHaveLength(2);
  });

  it("an unknown session reads as empty, not undefined", () => {
    expect(amendments.forSession("nope")).toEqual([]);
    expect(amendments.standing("nope")).toEqual([]);
  });

  it("drop() removes a session's entry", () => {
    amendments.map = { s1: [row()] };
    amendments.drop("s1");
    expect("s1" in amendments.map).toBe(false);
    amendments.drop("s1"); // idempotent
  });
});
