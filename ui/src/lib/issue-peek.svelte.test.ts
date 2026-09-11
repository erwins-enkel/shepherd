import { describe, it, expect, vi, beforeEach } from "vitest";
import { IssuePeek } from "./issue-peek.svelte";
import { getIssue } from "./api";
import type { Issue } from "./types";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, getIssue: vi.fn() };
});
const mockGet = vi.mocked(getIssue);

const ISSUE: Issue = {
  number: 72,
  title: "Stufe B: die Niederschrift",
  body: "Gesprochenes wird Text mit Zeitmarken.",
  url: "https://example.test/issues/72",
  labels: ["enhancement"],
  createdAt: 1_700_000_000_000,
  assignees: [],
};

let now = 1_000;
const clock = () => now;

beforeEach(() => {
  vi.clearAllMocks();
  now = 1_000;
});

describe("issue peek cache", () => {
  it("reads cold until something is requested", () => {
    const peek = new IssuePeek(clock);
    expect(peek.get("/repo", 72)).toBeNull();
  });

  it("shows a loading entry immediately, then the issue", async () => {
    const peek = new IssuePeek(clock);
    mockGet.mockResolvedValue(ISSUE);
    peek.request("/repo", 72);
    expect(peek.get("/repo", 72)).toEqual({ state: "loading" });
    await vi.waitFor(() => expect(peek.get("/repo", 72)).toEqual({ state: "ready", issue: ISSUE }));
  });

  // The whole point: a pointer crossing a wall of cards must not become a wall of requests.
  it("serves a repeat request from cache", async () => {
    const peek = new IssuePeek(clock);
    mockGet.mockResolvedValue(ISSUE);
    peek.request("/repo", 72);
    await vi.waitFor(() => expect(peek.get("/repo", 72)?.state).toBe("ready"));
    peek.request("/repo", 72);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("joins a request that is still in flight instead of duplicating it", () => {
    const peek = new IssuePeek(clock);
    mockGet.mockReturnValue(new Promise(() => {}));
    peek.request("/repo", 72);
    peek.request("/repo", 72);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("keys by repo and by number", async () => {
    const peek = new IssuePeek(clock);
    mockGet.mockResolvedValue(ISSUE);
    peek.request("/repo-a", 72);
    peek.request("/repo-a", 73);
    peek.request("/repo-b", 72);
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(3));
  });

  it("asks again once a hit has aged out", async () => {
    const peek = new IssuePeek(clock);
    mockGet.mockResolvedValue(ISSUE);
    peek.request("/repo", 72);
    await vi.waitFor(() => expect(peek.get("/repo", 72)?.state).toBe("ready"));
    now += 60_000;
    expect(peek.get("/repo", 72)).toBeNull();
    peek.request("/repo", 72);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  // A forge that can't produce the issue (local repo, deleted issue, un-authed gh) is a
  // resting state, not a failure to hammer — but it ages out sooner than a hit, so fixing
  // the auth doesn't leave the preview blank for a full minute.
  it("records a null answer as unavailable and re-asks sooner than a hit", async () => {
    const peek = new IssuePeek(clock);
    mockGet.mockResolvedValue(null);
    peek.request("/repo", 72);
    await vi.waitFor(() => expect(peek.get("/repo", 72)).toEqual({ state: "unavailable" }));
    now += 10_000;
    expect(peek.get("/repo", 72)).toBeNull();
  });

  it("records a rejected request as unavailable", async () => {
    const peek = new IssuePeek(clock);
    mockGet.mockRejectedValue(new Error("offline"));
    peek.request("/repo", 72);
    await vi.waitFor(() => expect(peek.get("/repo", 72)).toEqual({ state: "unavailable" }));
  });
});
