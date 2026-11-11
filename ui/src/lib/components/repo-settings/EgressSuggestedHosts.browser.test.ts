import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { getRepoConfig, getRepoEgressSuggestions, putRepoConfig } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getRepoConfig: vi.fn(),
    getRepoEgressSuggestions: vi.fn(),
    putRepoConfig: vi.fn(),
  };
});

const { default: EgressSuggestedHosts } = await import("./EgressSuggestedHosts.svelte");
const mockSuggest = vi.mocked(getRepoEgressSuggestions);
const mockPut = vi.mocked(putRepoConfig);
const mockConfig = vi.mocked(getRepoConfig);

// repoConfig is a module singleton, so every test uses its own repo.
let n = 0;
let repo = "";

const allowBtn = (host: string) =>
  page.getByRole("button", { name: m.egress_blocked_allow_host({ host }) });

beforeEach(() => {
  repo = `/repo/egress-suggest-${++n}`;
  mockSuggest.mockReset();
  mockPut.mockReset();
  mockConfig.mockReset();
  mockConfig.mockResolvedValue({ egressExtraHosts: ["corp.example.com"] } as never);
  mockPut.mockImplementation(async (_repo, patch) => ({ ...patch }) as never);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EgressSuggestedHosts", () => {
  it("renders nothing while there are no suggestions", async () => {
    mockSuggest.mockResolvedValue({ hosts: [] });
    render(EgressSuggestedHosts, { repoPath: repo });
    await expect.poll(() => mockSuggest.mock.calls.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-field="egressSuggestedHosts"]')).toBeNull();
  });

  it("shows each host's lockfiles and tier, and allows a trusted host in one click", async () => {
    mockSuggest.mockImplementation(async () => ({
      hosts: mockPut.mock.calls.length
        ? []
        : [{ host: "registry.npmjs.org", sources: ["bun.lock", "ui/bun.lock"] }],
    }));
    render(EgressSuggestedHosts, { repoPath: repo });

    await expect
      .element(page.getByText(m.egress_suggested_meta({ sources: "bun.lock, ui/bun.lock" })))
      .toBeVisible();
    await expect
      .element(page.getByText(m.egress_blocked_tier_trusted(), { exact: true }))
      .toBeVisible();
    await expect.element(allowBtn("registry.npmjs.org")).toBeEnabled();
    await allowBtn("registry.npmjs.org").click();
    expect(mockPut).toHaveBeenCalledWith(repo, {
      egressExtraHosts: ["corp.example.com", "registry.npmjs.org"],
    });
    await expect.element(page.getByText("registry.npmjs.org")).not.toBeInTheDocument();
  });

  it("asks before allowing a host off the trusted list", async () => {
    mockSuggest.mockResolvedValue({
      hosts: [{ host: "npm.corp.example", sources: ["package-lock.json"] }],
    });
    render(EgressSuggestedHosts, { repoPath: repo });

    await expect.element(allowBtn("npm.corp.example")).toBeEnabled();
    await allowBtn("npm.corp.example").click();
    expect(mockPut).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.egress_blocked_confirm_allow() }).click();
    expect(mockPut).toHaveBeenCalledWith(repo, {
      egressExtraHosts: ["corp.example.com", "npm.corp.example"],
    });
  });
});
