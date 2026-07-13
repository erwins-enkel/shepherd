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

describe("CriticBadge streak label", () => {
  it("verdict + in-progress round → streak label replaces the verdict word", async () => {
    reviews.map = { s1: v({ addressRound: 1 }) };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge").toBe(1);

    // streak label present — m.criticbadge_round with round=1, cap=5 → "REVIEW 1/5"
    await expect.element(page.getByText(/REVIEW 1\/5/)).toBeInTheDocument();
    // verdict word replaced, not appended
    expect(document.querySelector(".critic-changes_requested")).toBeNull();
    expect(page.getByText(/CHANGES/).elements().length, "no CHANGES text").toBe(0);
  });

  it("verdict with no address round → single badge, no suffix", async () => {
    reviews.map = { s1: v({ addressRound: 0 }) };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge").toBe(1);

    await expect.element(page.getByText(/CHANGES/)).toBeInTheDocument();
    // no streak label visible
    expect(document.querySelector('[class*="streak-"]')).toBeNull();
  });

  it("no verdict and no round → nothing rendered", async () => {
    render(CriticBadge, { sessionId: "s1" });
    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "no badge when nothing to show").toBe(0);
  });

  it("reviewing state + round → streak label replaces REVIEWING, with pulsing dot", async () => {
    reviews.map = { s1: v({ addressRound: 2 }) };
    reviews.reviewing = { s1: true };
    render(CriticBadge, { sessionId: "s1" });

    const badges = document.querySelectorAll(".critic-badge");
    expect(badges.length, "exactly one .critic-badge while reviewing").toBe(1);

    await expect.element(page.getByText(/REVIEW 2\/5/)).toBeInTheDocument();
    // reviewing word replaced by the streak label, not appended
    expect(page.getByText(/REVIEWING/).elements().length, "no REVIEWING text").toBe(0);
    // running indicator still present
    expect(document.querySelector(".rev-dot"), "rev-dot rendered while reviewing").not.toBeNull();
  });

  it("commented verdict + stalled round → STALLED REVIEW replaces the verdict word", async () => {
    // addressRound at cap, not pending → stalled status; decision "commented" → "REVIEWED" label.
    // The streak label takes over the pill, no verdict word remains.
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

    await expect.element(page.getByText(/STALLED REVIEW/)).toBeInTheDocument();
    expect(page.getByText(/REVIEWED/).elements().length, "no REVIEWED text").toBe(0);
    expect(
      document.querySelector(".streak-stalled"),
      "badge carries streak-stalled class",
    ).not.toBeNull();
  });

  it("verdict + final round → FINAL REVIEW streak label with streak-final class", async () => {
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

    // streak label present — m.criticbadge_final → "FINAL REVIEW"
    await expect.element(page.getByText(/FINAL REVIEW/)).toBeInTheDocument();
    // verdict word replaced, not appended
    expect(page.getByText(/CHANGES/).elements().length, "no CHANGES text").toBe(0);
    // badge carries the dim class
    const streak = document.querySelector(".streak-final");
    expect(streak, "streak-final rendered").not.toBeNull();
  });
});

describe("CriticBadge tip mode (card) — Open PR dialog + URL safety", () => {
  const dialogOpen = () => document.querySelector(".status-tip-dialog:popover-open");

  it("no tip → keeps the native title, no dialog", async () => {
    reviews.map = { s1: v({ addressRound: 0, decision: "changes_requested", summary: "bad" }) };
    render(CriticBadge, { sessionId: "s1" });
    const badge = page.getByText(/CHANGES/).element();
    await expect.element(page.getByText(/CHANGES/)).toBeInTheDocument();
    expect(badge.getAttribute("title")).toBe("bad");
    expect(document.querySelector("button.critic-trigger")).toBeNull();
  });

  it("verdict-url only (safe) → clicking opens a role=dialog whose Open PR anchor targets verdict.url", async () => {
    reviews.map = {
      s1: v({ addressRound: 0, decision: "changes_requested", url: "https://verdict/pr/1" }),
    };
    render(CriticBadge, { sessionId: "s1", tip: true });
    const btn = document.querySelector("button.critic-trigger") as HTMLButtonElement;
    expect(btn, "actionable trigger is a raised button").not.toBeNull();
    expect(getComputedStyle(btn).zIndex).toBe("1");
    btn.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dialogOpen()).not.toBeNull());
    const link = dialogOpen()!.querySelector("a.status-tip-action") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://verdict/pr/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("non-http(s) verdict url + no git.url → the Open-PR action is omitted (explain-only span)", async () => {
    reviews.map = {
      s1: v({ addressRound: 0, decision: "changes_requested", url: "javascript:alert(1)" }),
    };
    render(CriticBadge, { sessionId: "s1", tip: true });
    await expect.element(page.getByText(/CHANGES/)).toBeInTheDocument();
    expect(document.querySelector("button.critic-trigger"), "no dialog trigger").toBeNull();
  });

  it("unsafe verdict url but safe git.url → falls back to git.url", async () => {
    reviews.map = {
      s1: v({ addressRound: 0, decision: "changes_requested", url: "data:text/html,x" }),
    };
    render(CriticBadge, { sessionId: "s1", tip: true, prUrl: "https://git/pr/9" });
    const btn = document.querySelector("button.critic-trigger") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dialogOpen()).not.toBeNull());
    expect(dialogOpen()!.querySelector("a")!.getAttribute("href")).toBe("https://git/pr/9");
  });
});
