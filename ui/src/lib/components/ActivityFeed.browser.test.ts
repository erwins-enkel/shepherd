import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { ActivityEntry, DiffResult } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const EMPTY_DIFF: DiffResult = {
  base: "main",
  baseRef: "main",
  head: null,
  fetchFailed: false,
  truncated: false,
  files: [],
};

// Mock the API so no real network calls are made.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getActivity: vi.fn(async (): Promise<ActivityEntry[]> => []),
    getDiff: vi.fn(async (): Promise<DiffResult> => ({
      base: "main",
      baseRef: "main",
      head: null,
      fetchFailed: false,
      truncated: false,
      files: [],
    })),
  };
});

// Mock pollWhileVisible: just call fn immediately, skip interval setup.
vi.mock("$lib/visibility", () => ({
  pollWhileVisible: (fn: () => void) => {
    fn();
    return () => {};
  },
}));

const { default: ActivityFeed } = await import("./ActivityFeed.svelte");

import { getActivity, getDiff } from "$lib/api";

const mockGetActivity = vi.mocked(getActivity);
const mockGetDiff = vi.mocked(getDiff);

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  mockGetActivity.mockReset();
  mockGetDiff.mockReset();
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --font-mono: ui-monospace, monospace;
    --color-panel: #1a1a1a;
    --color-line: #333;
    --color-inset: #111;
    --color-ink: #ccc;
    --color-ink-bright: #fff;
    --color-muted: #666;
    --color-faint: #444;
    --color-head: #222;
    --color-hover: #2a2a2a;
    --color-line-bright: #555;
    --color-amber: #f5a623;
    --color-green: #4caf50;
    --color-red: #f44336;
    --fs-base: 13px;
    --fs-meta: 12px;
    --fs-micro: 10px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

describe("ActivityFeed — files-changed section", () => {
  it("renders Files changed section when diff has files", async () => {
    const diffResult: DiffResult = {
      base: "main",
      baseRef: "main",
      head: "feature",
      fetchFailed: false,
      truncated: false,
      files: [
        {
          path: "src/foo.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          binary: false,
          hunks: [],
        },
        {
          path: "src/bar.ts",
          status: "added",
          additions: 10,
          deletions: 0,
          binary: false,
          hunks: [],
        },
        {
          path: "src/old.ts",
          status: "deleted",
          additions: 0,
          deletions: 5,
          binary: false,
          hunks: [],
        },
      ],
    };
    mockGetActivity.mockResolvedValue([]);
    mockGetDiff.mockResolvedValue(diffResult);

    render(ActivityFeed, { sessionId: "s1" });

    // The file-tree section title should be present
    await expect.element(page.getByText(m.activity_files_changed())).toBeInTheDocument();
    // A known filename should appear
    await expect.element(page.getByText("foo.ts")).toBeInTheDocument();
  });

  it("shows a deleted file as removed (D badge)", async () => {
    const diffResult: DiffResult = {
      base: "main",
      baseRef: "main",
      head: "feature",
      fetchFailed: false,
      truncated: false,
      files: [
        {
          path: "src/deleted-file.ts",
          status: "deleted",
          additions: 0,
          deletions: 5,
          binary: false,
          hunks: [],
        },
      ],
    };
    mockGetActivity.mockResolvedValue([]);
    mockGetDiff.mockResolvedValue(diffResult);

    render(ActivityFeed, { sessionId: "s1" });

    await expect.element(page.getByText("deleted-file.ts")).toBeInTheDocument();
    // D badge for removed
    await expect.poll(() => document.querySelector(".ft-badge")?.textContent?.trim()).toBe("D");
  });
});

describe("ActivityFeed — sectioned tool stream", () => {
  it("renders kind headers and entry summaries for mixed entries", async () => {
    const entries: ActivityEntry[] = [
      { ts: 1000, tool: "Edit", summary: "edit foo.ts", status: "ok" },
      { ts: 2000, tool: "Edit", summary: "edit bar.ts", status: "ok" },
      { ts: 3000, tool: "Bash", summary: "run tests", status: "ok" },
    ];
    mockGetActivity.mockResolvedValue(entries);
    mockGetDiff.mockResolvedValue(EMPTY_DIFF);

    render(ActivityFeed, { sessionId: "s1" });

    // kind header for edits should appear (newest-first, so Bash before Edit after reverse)
    await expect.element(page.getByText(m.activity_kind_exec())).toBeInTheDocument();
    // entry summary should appear
    await expect.element(page.getByText("run tests")).toBeInTheDocument();
    await expect.element(page.getByText("edit foo.ts")).toBeInTheDocument();
  });

  it("shows count in parens when a group has more than one entry", async () => {
    const entries: ActivityEntry[] = [
      { ts: 1000, tool: "Edit", summary: "edit a.ts", status: "ok" },
      { ts: 2000, tool: "Edit", summary: "edit b.ts", status: "ok" },
      { ts: 3000, tool: "Edit", summary: "edit c.ts", status: "ok" },
    ];
    mockGetActivity.mockResolvedValue(entries);
    mockGetDiff.mockResolvedValue(EMPTY_DIFF);

    render(ActivityFeed, { sessionId: "s1" });

    // All three are edits, grouped as one group of 3 → "Edits (3)"
    await expect.element(page.getByText(`${m.activity_kind_edit()} (3)`)).toBeInTheDocument();
  });
});

describe("ActivityFeed — interleaved kind-repeating stream", () => {
  it("renders without duplicate-key crash for interleaved tools (regression: each_key_duplicate)", async () => {
    // Stream where the same kind appears non-consecutively: read, exec, read, edit, exec
    // groupActivity only coalesces CONSECUTIVE same-kind entries, so this produces
    // groups: [read(1), exec(1), read(1), edit(1), exec(1)] — five groups, two with kind "read"
    // and two with kind "exec". Keying by group.kind alone would throw each_key_duplicate.
    const entries: ActivityEntry[] = [
      { ts: 1000, tool: "Read", summary: "read file A", status: "ok" },
      { ts: 2000, tool: "Bash", summary: "run build", status: "ok" },
      { ts: 3000, tool: "Read", summary: "read file B", status: "ok" },
      { ts: 4000, tool: "Edit", summary: "edit foo.ts", status: "ok" },
      { ts: 5000, tool: "Bash", summary: "run tests", status: "ok" },
    ];
    mockGetActivity.mockResolvedValue(entries);
    mockGetDiff.mockResolvedValue(EMPTY_DIFF);

    // Must not throw — if (group.kind) key is used, Svelte 5 throws each_key_duplicate
    expect(() => render(ActivityFeed, { sessionId: "s1" })).not.toThrow();

    // All five summaries should render (newest-first after reverse: run tests, edit foo.ts, read file B, run build, read file A)
    await expect.element(page.getByText("run tests")).toBeInTheDocument();
    await expect.element(page.getByText("edit foo.ts")).toBeInTheDocument();
    await expect.element(page.getByText("read file B")).toBeInTheDocument();
    await expect.element(page.getByText("run build")).toBeInTheDocument();
    await expect.element(page.getByText("read file A")).toBeInTheDocument();

    // The repeated-kind section headers should both appear (two exec groups, two read groups)
    const kindHeaders = document.querySelectorAll("li.kind-header");
    // 5 groups total: exec, edit, read, exec, read (reversed order)
    expect(kindHeaders.length).toBe(5);
  });
});

describe("ActivityFeed — empty state", () => {
  it("renders empty message when no activity and no diff files", async () => {
    mockGetActivity.mockResolvedValue([]);
    mockGetDiff.mockResolvedValue(EMPTY_DIFF);

    render(ActivityFeed, { sessionId: "s1" });

    await expect.element(page.getByText(m.activity_empty())).toBeInTheDocument();
  });

  it("does NOT render files-changed section when no diff files", async () => {
    mockGetActivity.mockResolvedValue([]);
    mockGetDiff.mockResolvedValue(EMPTY_DIFF);

    render(ActivityFeed, { sessionId: "s1" });

    await expect.element(page.getByText(m.activity_empty())).toBeInTheDocument();
    // files-changed title must NOT be present
    const filesTitle = document.querySelector(".ft-title");
    expect(filesTitle).toBeNull();
  });
});
