import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { ReviewVerdict } from "$lib/types";

// Mock api so the reviews store's load() never fires real network calls.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getReviews: vi.fn(async () => ({})), getReviewingIds: vi.fn(async () => []) };
});

const { default: CriticBadge } = await import("./CriticBadge.svelte");
const { reviews } = await import("$lib/reviews.svelte");

const NOW = 2_000_000;

const base: ReviewVerdict = {
  sessionId: "s1",
  headSha: "abc",
  decision: "changes_requested",
  summary: "",
  body: "## findings",
  findings: ["x"],
  addressRound: 0,
  addressCap: 5,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: NOW - 60_000,
};
const v = (p: Partial<ReviewVerdict>): ReviewVerdict => ({ ...base, ...p });

beforeEach(() => {
  // reset store between tests
  reviews.map = {};
  reviews.reviewing = {};
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CriticBadge composite badge", () => {
  it("verdict + in-progress round → single badge containing both verdict and round suffix", async () => {
    reviews.map = { s1: v({ addressRound: 1 }) };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge").toBe(1);

    // verdict text present
    await expect.element(page.getByText(/CHANGES/)).toBeInTheDocument();
    // round suffix present — m.criticbadge_round with round=1, cap=5 → "↻ 1/5"
    await expect.element(page.getByText(/1\/5/)).toBeInTheDocument();
  });

  it("verdict with no address round → single badge, no suffix", async () => {
    reviews.map = { s1: v({ addressRound: 0 }) };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge").toBe(1);

    await expect.element(page.getByText(/CHANGES/)).toBeInTheDocument();
    // no round fraction visible
    expect(document.querySelector(".addr")).toBeNull();
  });

  it("no verdict and no round → nothing rendered", async () => {
    render(CriticBadge, { sessionId: "s1" });
    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "no badge when nothing to show").toBe(0);
  });

  it("reviewing state + round → single reviewing badge with round suffix", async () => {
    reviews.map = { s1: v({ addressRound: 2 }) };
    reviews.reviewing = { s1: true };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge while reviewing").toBe(1);

    await expect.element(page.getByText(/REVIEWING/)).toBeInTheDocument();
    await expect.element(page.getByText(/2\/5/)).toBeInTheDocument();
  });

  it("commented verdict + stalled round → single composite badge", async () => {
    // addressRound at cap, not pending → stalled status; decision "commented" → "REVIEWED" label.
    // Both should appear in one composite .critic-badge, not two separate elements.
    reviews.map = {
      s1: v({
        decision: "commented",
        addressRound: 5,
        addressCap: 5,
        finalRoundPending: false,
        findings: ["x"],
      }),
    };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge for stalled").toBe(1);

    await expect.element(page.getByText(/REVIEWED/)).toBeInTheDocument();
    await expect.element(page.getByText(/STALLED/)).toBeInTheDocument();
  });

  it("verdict + final round → single composite badge with addr-final suffix", async () => {
    // addressRound === addressCap, findings present, finalRoundPending true, updatedAt recent
    // → addressRoundInfo returns status "final" (dim).
    reviews.map = {
      s1: v({
        addressRound: 5,
        addressCap: 5,
        finalRoundPending: true,
        findings: ["x"],
        updatedAt: Date.now() - 1_000, // recent; well within finalRoundTimeoutMs (900_000)
      }),
    };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge for final").toBe(1);

    // verdict text present
    await expect.element(page.getByText(/CHANGES/)).toBeInTheDocument();
    // final suffix present — m.criticbadge_final with round=5, cap=5
    await expect.element(page.getByText(/FINAL/)).toBeInTheDocument();
    // suffix carries the dim class
    const suffix = document.querySelector(".addr");
    expect(suffix, "addr suffix rendered").not.toBeNull();
    expect(suffix!.classList.contains("addr-final"), "addr-final class present").toBe(true);
  });
});
