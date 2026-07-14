import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import CloneRepo from "./CloneRepo.svelte";
import type { GithubRepo } from "$lib/api";

const getGithubRepos =
  vi.fn<() => Promise<{ repos: GithubRepo[]; login: string; available: true }>>();

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  getGithubRepos: () => getGithubRepos(),
}));

function repo(nameWithOwner: string): GithubRepo {
  const [owner, name] = nameWithOwner.split("/");
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}.git`,
    isPrivate: false,
    isFork: false,
    isArchived: false,
    pushedAt: null,
    cloned: false,
  };
}

describe("CloneRepo", () => {
  it("lists each owner's repos alphabetically, not in the server's most-recently-pushed order", async () => {
    // Server order is by push recency — deliberately un-alphabetical, and interleaved
    // across owners so grouping and sorting are both exercised.
    getGithubRepos.mockResolvedValue({
      repos: [repo("me/zeta"), repo("acme/widget"), repo("me/alpha"), repo("acme/anvil")],
      login: "me",
      available: true,
    });

    render(CloneRepo, { props: { ondone: vi.fn() } });

    await expect.element(page.getByRole("button", { name: "alpha" })).toBeVisible();

    const rows = [...document.querySelectorAll(".repolist .repo .rname")].map((e) => e.textContent);
    // Own account first (alphabetical within), then the org (alphabetical within).
    expect(rows).toEqual(["alpha", "zeta", "anvil", "widget"]);
  });
});
