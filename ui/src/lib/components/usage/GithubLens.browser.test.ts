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
