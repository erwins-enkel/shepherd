import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { DiffFile, DiffResult } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { getDiff } from "$lib/api";
import { diffView } from "$lib/diff-view.svelte";

// Mock only the network: getDiff. Everything below the panel (sidebar, lazy
// stack, the diffView store) is exercised for real.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getDiff: vi.fn(),
  };
});

// This suite exercises DiffPanel's ORCHESTRATION (sidebar + lazy stack + toggle +
// states), not Pierre's diff rendering (which has its own PierreDiff.browser.test).
// So the fixture files are note-card files (binary / no textual change) — the stack
// renders their note anchors synchronously and never mounts PierreDiff, keeping the
// panel test deterministic and free of Pierre's async-highlight teardown races.
function multiFileDiff(): DiffResult {
  const files: DiffFile[] = [
    {
      path: "assets/logo.png",
      status: "added",
      additions: 0,
      deletions: 0,
      binary: true,
    },
    {
      path: "src/empty.ts",
      status: "modified",
      additions: 0,
      deletions: 0,
      binary: false,
      patch: "",
    },
  ];
  return {
    base: "main",
    baseRef: "origin/main",
    head: "feat/x",
    fetchFailed: false,
    truncated: false,
    files,
  };
}

const mockedGetDiff = vi.mocked(getDiff);

// Import after vi.mock so the panel binds to the mocked getDiff.
const { default: DiffPanel } = await import("./DiffPanel.svelte");

let fontStyle: HTMLStyleElement;
beforeEach(async () => {
  // Wide viewport so `diffView.narrow` is false and the split/unified toggle shows.
  // The headless CI browser defaults to a narrow (<=768px) iframe, which would
  // otherwise force unified and hide the toggle.
  await page.viewport(1280, 800);
  // Reset the persisted diff-view preference so toggle assertions are deterministic.
  try {
    localStorage.removeItem("shepherd:diff-view");
  } catch {
    /* ignore */
  }
  diffView.set("split");
  mockedGetDiff.mockReset();
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --font-mono: ui-monospace, monospace;
    --color-bg: #0a0d0c;
    --color-head: #141414;
    --color-panel: #1a1a1a;
    --color-inset: #111;
    --color-line: #333;
    --color-line-bright: #444;
    --color-hover: #222;
    --color-sel: #223;
    --color-ink: #ccc;
    --color-muted: #888;
    --color-faint: #555;
    --color-amber: #f5a623;
    --color-green: #4caf50;
    --color-red: #f44336;
    --color-blue: #4a90e2;
    --fs-meta: 12px;
    --fs-base: 13px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  vi.restoreAllMocks();
  fontStyle.remove();
  document.body.innerHTML = "";
});

describe("DiffPanel — multi-file diff", () => {
  it("lists files in the sidebar and renders the stack", async () => {
    mockedGetDiff.mockResolvedValue(multiFileDiff());
    render(DiffPanel, { sessionId: "s1" });

    // Summary bar
    await expect.element(page.getByText("2 files")).toBeInTheDocument();

    // Sidebar rail: one selectable row per file
    await vi.waitFor(() => {
      const rows = document.querySelectorAll(".sidebar .row");
      expect(rows.length).toBe(2);
    });
    expect(document.querySelector(".sidebar")?.textContent).toContain("assets/logo.png");
    expect(document.querySelector(".sidebar")?.textContent).toContain("src/empty.ts");

    // Stack: one anchor section per file
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".stack section").length).toBe(2);
    });
  });

  it("shows the split/unified toggle (wide) and toggling updates the store", async () => {
    mockedGetDiff.mockResolvedValue(multiFileDiff());
    render(DiffPanel, { sessionId: "s1" });

    // Wide viewport (set in beforeEach) → diffView resolves non-narrow and the
    // toggle mounts. Wait for the store's mount-time init() + the group to render.
    const group = await vi.waitFor(() => {
      expect(diffView.narrow, "wide viewport → not narrow").toBe(false);
      const g = document.querySelector(`[aria-label="${m.diff_view_label()}"]`);
      expect(g).not.toBeNull();
      return g as HTMLElement;
    });
    const buttons = group.querySelectorAll("button");
    expect(buttons.length).toBe(2);

    // Default pref is split → first button active.
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(diffView.pref).toBe("split");

    // Click "Unified" → store flips, resolved view follows.
    (buttons[1] as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(diffView.pref).toBe("unified");
      expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("scrolls the stack when a sidebar file is selected", async () => {
    mockedGetDiff.mockResolvedValue(multiFileDiff());
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    render(DiffPanel, { sessionId: "s1" });

    const rows = await vi.waitFor(() => {
      const r = document.querySelectorAll<HTMLButtonElement>(".sidebar .row");
      expect(r.length).toBe(2);
      return r;
    });

    rows[1].click(); // select the second file

    await vi.waitFor(() => {
      // handleSelect highlights immediately …
      expect(rows[1].getAttribute("aria-current")).toBe("true");
      // … then scrolls the target into view via the stack's scrollToPath.
      expect(scrollSpy).toHaveBeenCalled();
    });
  });
});

describe("DiffPanel — states", () => {
  it("renders the loading message before the diff resolves", async () => {
    mockedGetDiff.mockReturnValue(new Promise<DiffResult>(() => {})); // never resolves
    render(DiffPanel, { sessionId: "s1" });
    await expect.element(page.getByText(m.common_loading())).toBeInTheDocument();
  });

  it("renders the error message when the diff fails", async () => {
    mockedGetDiff.mockRejectedValue(new Error("boom"));
    render(DiffPanel, { sessionId: "s1" });
    await expect.element(page.getByText(m.diff_error())).toBeInTheDocument();
  });

  it("renders the empty message when there are no changed files", async () => {
    mockedGetDiff.mockResolvedValue({
      base: "main",
      baseRef: "origin/main",
      head: null,
      fetchFailed: false,
      truncated: false,
      files: [],
    });
    render(DiffPanel, { sessionId: "s1" });
    await expect.element(page.getByText(m.diff_empty({ base: "origin/main" }))).toBeInTheDocument();
    // No toggle when there are no files.
    expect(document.querySelector(`[aria-label="${m.diff_view_label()}"]`)).toBeNull();
  });
});
