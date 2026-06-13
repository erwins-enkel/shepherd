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
  doneSessions.loaded = false;
  vi.clearAllMocks();
});

test("load() populates sessions from api and sets loaded", async () => {
  const list = [session("s1"), session("s2")];
  vi.mocked(getDoneSessions).mockResolvedValue(list);
  await doneSessions.load();
  expect(doneSessions.sessions).toEqual(list);
  expect(doneSessions.loaded).toBe(true);
});

test("load() swallows api errors (best-effort)", async () => {
  vi.mocked(getDoneSessions).mockRejectedValue(new Error("network error"));
  await expect(doneSessions.load()).resolves.toBeUndefined();
  expect(doneSessions.sessions).toEqual([]);
  expect(doneSessions.loaded).toBe(false);
});
