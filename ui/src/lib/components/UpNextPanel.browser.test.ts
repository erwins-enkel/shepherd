import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { UpNextItem, UpNextSnapshot } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { upNext } from "$lib/up-next.svelte";
import { getUpNext } from "$lib/api";

// Mock the API so mounting (which kicks upNext.load()) makes no real network call.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getUpNext: vi.fn(async (): Promise<UpNextSnapshot | null> => upNext.snapshot),
    refreshUpNext: vi.fn(async () => {}),
    startUpNext: vi.fn(async () => ({ created: [], errors: [] })),
  };
});

const { default: UpNextPanel } = await import("./UpNextPanel.svelte");

const item = (repoPath: string, number: number, priority = false): UpNextItem => ({
  repoPath,
  repoSlug: null,
  repoLabel: repoPath.split("/").at(-1) ?? repoPath,
  number,
  title: `issue ${number}`,
  url: `https://example.test/${number}`,
  kind: "feature",
  priority,
  createdAt: 0,
  issueRef: { number, url: `https://example.test/${number}`, title: `issue ${number}`, body: "" },
});

const SNAPSHOT: UpNextSnapshot = {
  generatedAt: 1,
  repoCount: 2,
  fallback: null,
  failedRepoCount: 0,
  sections: [
    {
      kind: "priority",
      repoPath: null,
      repoSlug: null,
      repoLabel: null,
      totalCount: 2,
      items: [
        item("~/projects/homeassistant", 1, true),
        item("~/projects/car-gas-tracker", 5, true),
      ],
    },
    {
      kind: "repo",
      repoPath: "~/projects/homeassistant",
      repoSlug: null,
      repoLabel: "homeassistant",
      totalCount: 1,
      items: [item("~/projects/homeassistant", 2)],
    },
    {
      kind: "repo",
      repoPath: "~/projects/car-gas-tracker",
      repoSlug: null,
      repoLabel: "car-gas-tracker",
      totalCount: 1,
      items: [item("~/projects/car-gas-tracker", 6)],
    },
  ],
};

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  upNext.snapshot = SNAPSHOT;
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --color-panel:#1a1a1a;--color-line:#333;--color-line-bright:#555;--color-inset:#111;
    --color-bg:#000;--color-ink:#ccc;--color-ink-bright:#fff;--color-muted:#666;--color-faint:#444;
    --color-amber:#f5a623;--color-green:#4caf50;--color-red:#f44336;
    --fs-lg:16px;--fs-meta:12px;--fs-micro:10px;
  }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  upNext.snapshot = null;
  upNext.loadError = false;
  fontStyle.remove();
});

describe("UpNextPanel repo filter", () => {
  it("shows all repos when unfiltered", async () => {
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText("#6")).toBeInTheDocument();
  });

  it("scopes sections and priority items to the active repo filter", async () => {
    render(UpNextPanel, { repoFilter: new Set(["~/projects/homeassistant"]) });
    // homeassistant repo section + its priority item remain
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    // the other repo's section row AND its cross-repo priority item are gone
    await expect.element(page.getByText("#6")).not.toBeInTheDocument();
    await expect.element(page.getByText("#5")).not.toBeInTheDocument();
  });

  it("shows a repo-scoped empty note when the filtered repo has nothing queued", async () => {
    render(UpNextPanel, {
      repoFilter: new Set(["~/projects/does-not-exist"]),
      filteredRepo: "does-not-exist",
    });
    await expect
      .element(page.getByText(m.upnext_repo_filter_empty({ repo: "does-not-exist" })))
      .toBeInTheDocument();
  });
});

describe("UpNextPanel load failure", () => {
  it("surfaces a load error when every repo's issue fetch failed (empty queue, failures > 0)", async () => {
    upNext.snapshot = {
      generatedAt: 1,
      repoCount: 0,
      fallback: null,
      failedRepoCount: 2,
      sections: [],
    };
    render(UpNextPanel, {});
    // The failure must win over the "all caught up" empty state.
    await expect.element(page.getByText(m.common_issues_load_failed())).toBeInTheDocument();
    await expect.element(page.getByText(m.upnext_empty())).not.toBeInTheDocument();
  });

  it("surfaces a load error when the snapshot fetch itself throws", async () => {
    upNext.snapshot = null;
    vi.mocked(getUpNext).mockRejectedValueOnce(new Error("network down"));
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.common_issues_load_failed())).toBeInTheDocument();
  });

  it("shows the all-caught-up empty state (not an error) when the queue is genuinely empty", async () => {
    upNext.snapshot = {
      generatedAt: 1,
      repoCount: 3,
      fallback: null,
      failedRepoCount: 0,
      sections: [],
    };
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.upnext_empty())).toBeInTheDocument();
    await expect.element(page.getByText(m.common_issues_load_failed())).not.toBeInTheDocument();
  });

  it("renders the queue (no error) when some repos failed but work remains", async () => {
    upNext.snapshot = { ...SNAPSHOT, failedRepoCount: 1 };
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText(m.common_issues_load_failed())).not.toBeInTheDocument();
  });

  it("keeps painting cached work when a lens-open fetch throws (does not blank to error)", async () => {
    // A successful app-load peek left a usable snapshot; the lens-open GET then fails.
    upNext.snapshot = SNAPSHOT;
    vi.mocked(getUpNext).mockRejectedValueOnce(new Error("network down"));
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText(m.common_issues_load_failed())).not.toBeInTheDocument();
  });
});
