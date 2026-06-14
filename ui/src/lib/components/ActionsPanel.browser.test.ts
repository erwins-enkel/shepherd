import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import { listWorkflowRuns } from "$lib/api";

// Mock the API so the panel never hits the network; each test seeds the result.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listWorkflowRuns: vi.fn(),
  };
});

const { default: ActionsPanel } = await import("./ActionsPanel.svelte");

const mockList = vi.mocked(listWorkflowRuns);

function seed(slug: string | null, webUrl: string | null) {
  mockList.mockResolvedValue({
    slug,
    webUrl,
    kind: null,
    runs: [],
    supportsActions: true,
    canRerun: false,
    canCancel: false,
  });
}

beforeEach(() => {
  mockList.mockReset();
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("ActionsPanel repo slug link", () => {
  it("renders an <a> linking to webUrl when provided", async () => {
    seed("owner/repo", "https://github.com/owner/repo");
    render(ActionsPanel, { repoPath: "/repo" });

    await expect.poll(() => document.querySelector(".actions-header")).toBeTruthy();
    const link = document.querySelector(".actions-header .repo-link") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.href).toBe("https://github.com/owner/repo");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.textContent?.trim()).toBe("owner/repo");
  });

  it("renders slug as plain text when webUrl is null", async () => {
    seed("owner/repo", null);
    render(ActionsPanel, { repoPath: "/repo" });

    await expect.poll(() => document.querySelector(".actions-header")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".actions-header")?.textContent)
      .toContain("owner/repo");
    const link = document.querySelector(".actions-header .repo-link");
    expect(link).toBeNull();
  });
});
