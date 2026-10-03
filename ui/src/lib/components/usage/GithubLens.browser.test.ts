import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { GithubRateLimit } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import GithubLens from "./GithubLens.svelte";

const BASE = Date.now();
const H = 3_600_000;

function fixture(over: Partial<GithubRateLimit> = {}): GithubRateLimit {
  return {
    rest: { limit: 5000, used: 173, remaining: 4827, resetAt: BASE + H },
    graphql: { limit: 5000, used: 5002, remaining: 0, resetAt: BASE + H },
    search: { limit: 30, used: 0, remaining: 30, resetAt: BASE + H },
    fetchedAt: BASE,
    backoff: { remaining: 0, resetAt: BASE + H, pausedUntil: BASE + H, blocked: true },
    restBackoff: { remaining: null, resetAt: null, pausedUntil: null, blocked: false },
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("GithubLens", () => {
  it("renders REST and GraphQL bucket labels", async () => {
    render(GithubLens, { data: fixture() });
    await expect.element(page.getByText(m.github_lens_rest_label())).toBeInTheDocument();
    await expect.element(page.getByText(m.github_lens_graphql_label())).toBeInTheDocument();
  });

  it("marks an empty GraphQL bucket Exhausted, not Paused", async () => {
    render(GithubLens, { data: fixture() }); // graphql.remaining = 0
    // exact:true so the pill match isn't satisfied by the "…exhausted…" banner prose.
    await expect
      .element(page.getByText(m.github_lens_exhausted(), { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.github_lens_paused(), { exact: true }))
      .not.toBeInTheDocument();
  });

  it("marks a backed-off-but-non-empty GraphQL bucket Paused, not Exhausted", async () => {
    // Bucket still has budget, but Shepherd's backoff is engaged (transient secondary
    // rate-limit error) — the pill must read "Paused", never "Exhausted".
    const data = fixture({
      graphql: { limit: 5000, used: 1000, remaining: 4000, resetAt: BASE + H },
      backoff: { remaining: 4000, resetAt: BASE + H, pausedUntil: BASE + H, blocked: true },
    });
    render(GithubLens, { data });
    await expect
      .element(page.getByText(m.github_lens_paused(), { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.github_lens_exhausted(), { exact: true }))
      .not.toBeInTheDocument();
    // The banner must use the backoff copy, not the contradictory "exhausted" copy.
    // Match the time-independent clause (the interpolated "~{time}" floors to 59m/1h).
    await expect
      .element(page.getByText("rate-limit backoff clears", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("GraphQL budget exhausted", { exact: false }))
      .not.toBeInTheDocument();
  });

  it("marks a backed-off REST bucket Paused even while it reads full (#2662)", async () => {
    // `gh api rate_limit` was seen reporting 5000/5000 while every real REST call
    // 403'd — Shepherd's REST backoff is the only signal, so it must show.
    const data = fixture({
      rest: { limit: 5000, used: 0, remaining: 5000, resetAt: BASE + H },
      graphql: { limit: 5000, used: 1000, remaining: 4000, resetAt: BASE + H },
      backoff: { remaining: 4000, resetAt: BASE + H, pausedUntil: null, blocked: false },
      restBackoff: {
        remaining: null,
        resetAt: null,
        pausedUntil: BASE + 5 * 60_000,
        blocked: true,
      },
    });
    render(GithubLens, { data });
    await expect
      .element(page.getByText(m.github_lens_paused(), { exact: true }))
      .toBeInTheDocument();
    // Time-independent clause of the banner, plus the hint that the numbers can't be trusted.
    await expect
      .element(page.getByText("REST reads are paused", { exact: false }))
      .toBeInTheDocument();
    expect(document.body.textContent).toContain("may still read full");
    expect(document.body.textContent).not.toContain("REST budget exhausted");
  });

  it("shows only the exhausted REST banner when the bucket is empty and backed off", async () => {
    const data = fixture({
      rest: { limit: 5000, used: 5000, remaining: 0, resetAt: BASE + H },
      graphql: { limit: 5000, used: 1000, remaining: 4000, resetAt: BASE + H },
      backoff: { remaining: 4000, resetAt: BASE + H, pausedUntil: null, blocked: false },
      restBackoff: {
        remaining: null,
        resetAt: null,
        pausedUntil: BASE + 5 * 60_000,
        blocked: true,
      },
    });
    render(GithubLens, { data });
    await expect
      .element(page.getByText("REST budget exhausted", { exact: false }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain("REST reads are paused");
    expect(document.body.textContent).not.toContain(m.github_lens_paused());
  });

  it("times the exhausted REST banner by the backoff when it outlasts the reset", async () => {
    // The REST cooldown escalates to 15 min and clears only on a success, so it can
    // outlast the bucket reset — reads stay skipped until the later of the two.
    const data = fixture({
      rest: { limit: 5000, used: 5000, remaining: 0, resetAt: BASE + 2 * 60_000 },
      graphql: { limit: 5000, used: 1000, remaining: 4000, resetAt: BASE + H },
      backoff: { remaining: 4000, resetAt: BASE + H, pausedUntil: null, blocked: false },
      restBackoff: {
        remaining: null,
        resetAt: null,
        pausedUntil: BASE + 15 * 60_000 + 30_000,
        blocked: true,
      },
    });
    render(GithubLens, { data });
    await expect
      .element(page.getByText("REST budget exhausted", { exact: false }))
      .toBeInTheDocument();
    expect(document.body.textContent).toContain("paused for ~15m");
  });

  it("shows no pill when both buckets are healthy and backoff is clear", async () => {
    const data = fixture({
      graphql: { limit: 5000, used: 1000, remaining: 4000, resetAt: BASE + H },
      backoff: { remaining: 4000, resetAt: BASE + H, pausedUntil: null, blocked: false },
    });
    render(GithubLens, { data });
    await expect.element(page.getByText(m.github_lens_rest_label())).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(m.github_lens_exhausted());
    expect(document.body.textContent).not.toContain(m.github_lens_paused());
  });
});
