import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { PullRequest } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { listPullRequests } from "$lib/api";

// Mock the API so the panel never hits the network; each test seeds the result.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listPullRequests: vi.fn(),
    mergeBacklogPr: vi.fn(async () => {}),
    requestDependabotRebase: vi.fn(async () => {}),
  };
});

const { default: PrsPanel } = await import("./PrsPanel.svelte");

const mockList = vi.mocked(listPullRequests);

function pr(number: number, title = `PR ${number}`): PullRequest {
  return {
    number,
    title,
    url: `https://example.com/pr/${number}`,
    author: "octocat",
    kind: "regular",
    createdAt: 0,
    isDraft: false,
    mergeable: true,
    checks: "success",
    jobs: [],
  };
}

function seed(prs: PullRequest[], slug = "acme/repo", webUrl: string | null = null) {
  mockList.mockResolvedValue({ slug, webUrl, prs });
}

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --font-mono: ui-monospace, monospace;
    --color-panel: #1a1a1a;
    --color-line: #333;
    --color-line-bright: #555;
    --color-inset: #111;
    --color-ink: #ccc;
    --color-ink-bright: #fff;
    --color-muted: #666;
    --color-faint: #444;
    --color-amber: #f5a623;
    --color-green: #4caf50;
    --color-red: #f44336;
    --color-blue: #2196f3;
    --fs-base: 13px;
    --fs-meta: 12px;
    --fs-micro: 10px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }`;
  document.head.appendChild(fontStyle);
  mockList.mockReset();
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

const noop = () => {};

const launchBtn = () => page.getByRole("button", { name: m.prspanel_launch_train() });
const checkbox = (n: number) =>
  page.getByRole("checkbox", { name: m.prspanel_select_pr({ number: n }) });

describe("PrsPanel repo slug link", () => {
  it("renders an <a> linking to webUrl when provided", async () => {
    seed([], "owner/repo", "https://github.com/owner/repo");
    render(PrsPanel, { repoPath: "/repo", onreview: noop });

    await expect.poll(() => document.querySelector(".prs-header")).toBeTruthy();
    const link = document.querySelector(".prs-header .repo-link") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.href).toBe("https://github.com/owner/repo");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.textContent?.trim()).toBe("owner/repo");
  });

  it("renders slug as plain text when webUrl is null", async () => {
    seed([], "owner/repo", null);
    render(PrsPanel, { repoPath: "/repo", onreview: noop });

    await expect.poll(() => document.querySelector(".prs-header")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".prs-header")?.textContent)
      .toContain("owner/repo");
    const link = document.querySelector(".prs-header .repo-link");
    expect(link).toBeNull();
  });
});

describe("PrsPanel launch-train toolbar", () => {
  it("disables Launch with 0 and 1 selected, enables it with 2", async () => {
    seed([pr(1), pr(2), pr(3)]);
    render(PrsPanel, { repoPath: "/repo", onreview: noop, onlaunchtrain: noop });

    // wait for the rows to load
    await expect.element(checkbox(1)).toBeInTheDocument();

    // 0 selected → disabled
    await expect.element(launchBtn()).toBeDisabled();

    // 1 selected → still disabled (a train needs >= 2 PRs)
    await checkbox(1).click();
    await expect.element(launchBtn()).toBeDisabled();

    // 2 selected → enabled
    await checkbox(2).click();
    await expect.element(launchBtn()).toBeEnabled();
  });

  it("select-all selects every row, then clear deselects all", async () => {
    seed([pr(1), pr(2), pr(3)]);
    render(PrsPanel, { repoPath: "/repo", onreview: noop, onlaunchtrain: noop });
    await expect.element(checkbox(1)).toBeInTheDocument();

    await page.getByRole("button", { name: m.prspanel_select_all() }).click();
    await expect.element(checkbox(1)).toBeChecked();
    await expect.element(checkbox(2)).toBeChecked();
    await expect.element(checkbox(3)).toBeChecked();
    await expect.element(launchBtn()).toBeEnabled();

    await page.getByRole("button", { name: m.prspanel_clear_all() }).click();
    await expect.element(checkbox(1)).not.toBeChecked();
    await expect.element(checkbox(2)).not.toBeChecked();
    await expect.element(checkbox(3)).not.toBeChecked();
    await expect.element(launchBtn()).toBeDisabled();
  });

  it("clears the selection when the repoPath prop changes", async () => {
    seed([pr(1), pr(2)]);
    const { rerender } = await render(PrsPanel, {
      repoPath: "/repo-a",
      onreview: noop,
      onlaunchtrain: noop,
    });
    await expect.element(checkbox(1)).toBeInTheDocument();

    await checkbox(1).click();
    await checkbox(2).click();
    await expect.element(launchBtn()).toBeEnabled();

    // new repo → selection must not leak across repos
    seed([pr(1), pr(2)], "acme/other");
    await rerender({ repoPath: "/repo-b", onreview: noop, onlaunchtrain: noop });
    await expect.element(checkbox(1)).not.toBeChecked();
    await expect.element(checkbox(2)).not.toBeChecked();
    await expect.element(launchBtn()).toBeDisabled();
  });

  it("reconciles a selected row that leaves the list (phantom can't arm the gate)", async () => {
    seed([pr(1), pr(2), pr(3)]);
    render(PrsPanel, { repoPath: "/repo", onreview: noop, onlaunchtrain: noop });
    await expect.element(checkbox(1)).toBeInTheDocument();

    // select two — gate armed, count shows 2
    await checkbox(1).click();
    await checkbox(2).click();
    await expect.element(launchBtn()).toBeEnabled();
    await expect
      .element(page.getByText(m.prspanel_selected_count({ count: 2 })))
      .toBeInTheDocument();

    // merge PR 2: the row leaves the list. The silent reload returns only 1 + 3,
    // so the present-selection drops to {1} and the gate disarms.
    seed([pr(1), pr(3)]);
    // exact: the launch button's name ("Launch merge train") substring-matches
    // "Merge", so without exact we'd grab the wrong control.
    await page.getByRole("button", { name: m.prspanel_merge_button(), exact: true }).nth(1).click(); // arm PR 2 (rows in order 1,2,3)
    await page.getByRole("button", { name: m.prspanel_merge_confirm(), exact: true }).click(); // confirm

    await expect.element(checkbox(2)).not.toBeInTheDocument();
    await expect
      .element(page.getByText(m.prspanel_selected_count({ count: 1 })))
      .toBeInTheDocument();
    await expect.element(launchBtn()).toBeDisabled();
  });

  it("shows the in-train badge and disables merge only for PRs in the train set", async () => {
    seed([pr(1), pr(2)]);
    render(PrsPanel, {
      repoPath: "/repo",
      onreview: noop,
      onlaunchtrain: noop,
      // PR 1 is owned by a running train; PR 2 is not.
      inTrainPrs: new Set(["/repo#1"]),
    });
    await expect.element(checkbox(1)).toBeInTheDocument();

    // PR 1: in-train badge present, merge button locked.
    await expect.element(page.getByText(m.status_merging())).toBeInTheDocument();
    const mergeBtns = page.getByRole("button", { name: m.prspanel_merge_button(), exact: true });
    await expect.element(mergeBtns.nth(0)).toBeDisabled();

    // PR 2: not in the set → no badge of its own, merge button enabled.
    await expect.element(mergeBtns.nth(1)).toBeEnabled();
    // exactly one in-train badge (only PR 1)
    expect(page.getByText(m.status_merging()).elements()).toHaveLength(1);
  });

  it("calls onlaunchtrain with the selected PRs in display order", async () => {
    seed([pr(1, "first"), pr(2, "second"), pr(3, "third")]);
    const onlaunchtrain = vi.fn();
    render(PrsPanel, { repoPath: "/repo", onreview: noop, onlaunchtrain });
    await expect.element(checkbox(1)).toBeInTheDocument();

    // select out of order; payload must still be in display order (1, 3)
    await checkbox(3).click();
    await checkbox(1).click();
    await launchBtn().click();

    expect(onlaunchtrain).toHaveBeenCalledOnce();
    const [repoPath, prs] = onlaunchtrain.mock.calls[0];
    expect(repoPath).toBe("/repo");
    expect(prs.map((p: PullRequest) => p.number)).toEqual([1, 3]);
  });
});
