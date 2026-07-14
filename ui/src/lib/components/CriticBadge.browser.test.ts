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

/**
 * The grey-in-orange FINAL REVIEW bug shipped WITH the correct `.streak-final` class applied — the
 * class was never the defect, the resolved border-color was (`.critic-reviewing`'s amber leaking
 * through underneath a state that only recolored its text). So these assert computed style, not
 * classes; a class assertion here would be regression-proof against nothing.
 *
 * Expected values are resolved from the tokens via a probe element rather than hardcoded as hex, so
 * a palette retune in app.css can't fail these for the wrong reason.
 */
describe("CriticBadge streak ladder — resolved colors", () => {
  /** Computed rgb() a token resolves to in the live stylesheet. */
  function token(name: string): string {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }

  const badge = () => document.querySelector(".critic-badge") as HTMLElement;
  // border is `1px solid` on all four sides, so the top side speaks for the whole box.
  const ink = (el: HTMLElement) => {
    const s = getComputedStyle(el);
    return { color: s.color, border: s.borderTopColor };
  };

  const roundVerdict = (extra: Partial<ReviewVerdict> = {}) =>
    v({ addressRound: 2, addressCap: 5, ...extra });
  const finalVerdict = () =>
    v({
      addressRound: 5,
      addressCap: 5,
      finalRoundPending: true,
      findings: ["x"],
      updatedAt: Date.now() - 1_000, // recent → "final", not yet timed out into "stalled"
    });
  const stalledVerdict = () =>
    v({ addressRound: 5, addressCap: 5, finalRoundPending: false, findings: ["x"] });

  it("final: warn text AND warn border — the border no longer leaks amber", async () => {
    reviews.map = { s1: finalVerdict() };
    render(CriticBadge, { sessionId: "s1" });
    await expect.element(page.getByText(/FINAL REVIEW/)).toBeInTheDocument();

    const warn = token("--status-warn");
    const { color, border } = ink(badge());
    expect(color, "final text is --status-warn").toBe(warn);
    expect(border, "final border is --status-warn, not amber").toBe(warn);
    expect(border, "border hue agrees with text hue").toBe(color);
  });

  it("final + reviewing: still warn on both — the exact cascade that produced grey-in-orange", async () => {
    reviews.map = { s1: finalVerdict() };
    reviews.reviewing = { s1: true }; // adds .critic-reviewing, whose amber border leaked before
    render(CriticBadge, { sessionId: "s1" });
    await expect.element(page.getByText(/FINAL REVIEW/)).toBeInTheDocument();

    const warn = token("--status-warn");
    const { color, border } = ink(badge());
    expect(color, "text stays --status-warn under .critic-reviewing").toBe(warn);
    expect(border, "border is NOT the reviewing amber").toBe(warn);
    expect(border).not.toBe(token("--color-amber"));
    // and it is certainly not the old recessive faint text
    expect(color).not.toBe(token("--color-faint"));
  });

  it("stalled: blocked-red text AND border", async () => {
    reviews.map = { s1: stalledVerdict() };
    render(CriticBadge, { sessionId: "s1" });
    await expect.element(page.getByText(/STALLED REVIEW/)).toBeInTheDocument();

    const blocked = token("--status-blocked");
    const { color, border } = ink(badge());
    expect(color, "stalled text is --status-blocked").toBe(blocked);
    expect(border, "stalled border is --status-blocked").toBe(blocked);
  });

  it("round keeps amber (in-progress), and agrees with its border while reviewing", async () => {
    reviews.map = { s1: roundVerdict() };
    reviews.reviewing = { s1: true };
    render(CriticBadge, { sessionId: "s1" });
    await expect.element(page.getByText(/REVIEW 2\/5/)).toBeInTheDocument();

    const amber = token("--color-amber");
    const { color, border } = ink(badge());
    expect(color, "round stays amber = in progress").toBe(amber);
    expect(border, "reviewing border agrees with the amber text").toBe(amber);
  });

  it("stalled + reviewing: the pulsing dot stays AMBER, never red", async () => {
    // Reachable in practice: addressStallStatus escalates to "stalled" on the finalRoundTimeoutMs
    // clock while a re-review is still in flight, and roundView still sets dot: true. A dot that
    // followed currentColor would pulse RED here — DESIGN.md forbids a pulsing subordinate red
    // (that loudest red is reserved for the blocked-agent pip; Four-Light Rule).
    reviews.map = { s1: stalledVerdict() };
    reviews.reviewing = { s1: true };
    render(CriticBadge, { sessionId: "s1" });
    await expect.element(page.getByText(/STALLED REVIEW/)).toBeInTheDocument();

    const dot = document.querySelector(".rev-dot") as HTMLElement;
    expect(dot, "running dot rendered while re-reviewing a stalled streak").not.toBeNull();
    expect(getComputedStyle(dot).backgroundColor, "dot is amber (running), not red").toBe(
      token("--color-amber"),
    );
    // the pill itself is still red — hue (severity) and dot (running) are orthogonal axes
    expect(getComputedStyle(badge()).color).toBe(token("--status-blocked"));
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
