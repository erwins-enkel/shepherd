import { test, expect, vi, beforeEach } from "vitest";
import type { Session } from "./types";

vi.mock("./api", () => ({
  getDoneSessions: vi.fn(),
}));

import { doneSessions } from "./done.svelte";
import { getDoneSessions } from "./api";

const session = (id: string): Session => ({ id }) as Session;

beforeEach(() => {
  doneSessions.sessions = [];
  vi.clearAllMocks();
});

test("load() populates sessions from api", async () => {
  const list = [session("s1"), session("s2")];
  vi.mocked(getDoneSessions).mockResolvedValue(list);
  await doneSessions.load();
  expect(doneSessions.sessions).toEqual(list);
});

test("load() swallows api errors and leaves the list untouched (best-effort)", async () => {
  doneSessions.sessions = [session("prev")];
  vi.mocked(getDoneSessions).mockRejectedValue(new Error("network error"));
  await expect(doneSessions.load()).resolves.toBeUndefined();
  expect(doneSessions.sessions).toEqual([session("prev")]);
});

test("remove() drops the matching session by id", () => {
  doneSessions.sessions = [session("a"), session("b"), session("c")];
  doneSessions.remove("b");
  expect(doneSessions.sessions.map((s) => s.id)).toEqual(["a", "c"]);
});

test("remove() is a no-op when the id is not in the list", () => {
  doneSessions.sessions = [session("x"), session("y")];
  doneSessions.remove("z");
  expect(doneSessions.sessions.map((s) => s.id)).toEqual(["x", "y"]);
});
