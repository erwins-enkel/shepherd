import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { ApiError } from "$lib/api";
import { m } from "$lib/paraglide/messages";

// Mock the entire API module — no real network calls
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getScratchpadListing: vi.fn(),
    scratchpadDownloadUrl: vi.fn((id: string, path: string) => `/dl/${id}/${path}`),
    uploadScratchpadFile: vi.fn(),
    getWorktreeListing: vi.fn(),
    worktreeDownloadUrl: vi.fn((id: string, path: string) => `/wt/${id}/${path}`),
  };
});

const { default: FilesPanel } = await import("./FilesPanel.svelte");

const { getScratchpadListing, uploadScratchpadFile, getWorktreeListing } = await import("$lib/api");
const mockListing = vi.mocked(getScratchpadListing);
const mockUpload = vi.mocked(uploadScratchpadFile);
const mockWorktreeListing = vi.mocked(getWorktreeListing);

const EMPTY_LISTING = { path: "", parent: null, entries: [] };

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  mockListing.mockReset();
  mockUpload.mockReset();
  mockWorktreeListing.mockReset();

  // Default: empty listing so the panel renders without hanging on the initial browse
  mockListing.mockResolvedValue(EMPTY_LISTING);
  mockWorktreeListing.mockResolvedValue(EMPTY_LISTING);

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
    --color-amber: #f5a623;
    --color-blue: #4a9eff;
    --color-green: #4caf50;
    --color-red: #f44336;
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

// Helper: wait for the upload button to be present (listing loaded)
async function waitForPanel() {
  await expect.poll(() => document.querySelector("button.upload-btn")).toBeTruthy();
}

describe("FilesPanel — file select calls uploadScratchpadFile", () => {
  it("calls uploadScratchpadFile(sessionId, file, currentPath) on file input change", async () => {
    mockUpload.mockResolvedValue("subdir/test.txt");
    // seed a second browse call after upload
    mockListing.mockResolvedValue(EMPTY_LISTING);

    render(FilesPanel, { sessionId: "sess-1" });
    await waitForPanel();

    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBeNull();

    // Simulate file selection via the hidden input
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // uploadScratchpadFile should be called with (sessionId, file, undefined) — root path is ""
    await expect.poll(() => mockUpload.mock.calls.length).toBe(1);
    expect(mockUpload).toHaveBeenCalledWith("sess-1", file, undefined);
  });

  it("refreshes the listing (getScratchpadListing) after a successful upload", async () => {
    mockUpload.mockResolvedValue("test.txt");

    render(FilesPanel, { sessionId: "sess-2" });
    await waitForPanel();

    const callsBefore = mockListing.mock.calls.length;

    const file = new File(["data"], "test.txt", { type: "text/plain" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // After upload settles, browse() is called again → getScratchpadListing should be called
    await expect.poll(() => mockListing.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe("FilesPanel — 413 too-large error surfaces inline", () => {
  it("shows files_upload_too_large message inline when upload returns 413", async () => {
    mockUpload.mockRejectedValue(new ApiError(413, "file too large"));

    render(FilesPanel, { sessionId: "sess-3" });
    await waitForPanel();

    const file = new File(["x".repeat(100)], "bigfile.bin", { type: "application/octet-stream" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const expectedMsg = m.files_upload_too_large({ name: "bigfile.bin" });
    await expect
      .poll(() => document.querySelector(".upload-status.err")?.textContent?.trim())
      .toBe(expectedMsg);
  });
});

describe("FilesPanel — drag-and-drop calls uploadScratchpadFile", () => {
  it("calls uploadScratchpadFile on drop anywhere in the tab with correct args", async () => {
    mockUpload.mockResolvedValue("dropped.txt");

    render(FilesPanel, { sessionId: "sess-4" });
    await waitForPanel();

    const file = new File(["drop"], "dropped.txt", { type: "text/plain" });
    // The whole .files tab is the drop zone, not just the inner list.
    const tab = document.querySelector<HTMLDivElement>(".files")!;
    expect(tab).not.toBeNull();

    const dt = new DataTransfer();
    dt.items.add(file);
    tab.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
    tab.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));

    await expect.poll(() => mockUpload.mock.calls.length).toBe(1);
    expect(mockUpload).toHaveBeenCalledWith("sess-4", file, undefined);
  });

  it("shows the whole-tab drop overlay on dragover and clears it on drop", async () => {
    mockUpload.mockResolvedValue("dropped.txt");

    render(FilesPanel, { sessionId: "sess-5" });
    await waitForPanel();

    const tab = document.querySelector<HTMLDivElement>(".files")!;
    const dt = new DataTransfer();
    dt.items.add(new File(["drop"], "dropped.txt", { type: "text/plain" }));

    tab.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
    await expect.poll(() => document.querySelector(".drop-overlay")).toBeTruthy();

    tab.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await expect.poll(() => document.querySelector(".drop-overlay")).toBeFalsy();
  });
});

// Helper: click the Worktree segmented-control button (trusted click via the browser locator)
async function clickWorktreeSegButton() {
  await page.getByRole("button", { name: m.files_source_worktree() }).click();
}

describe("FilesPanel — source switch (scratchpad/worktree)", () => {
  it("defaults to scratchpad and fetches scratchpad listing", async () => {
    render(FilesPanel, { sessionId: "sess-6" });
    await waitForPanel();

    await expect.poll(() => mockListing.mock.calls.length).toBeGreaterThan(0);
    expect(mockWorktreeListing).not.toHaveBeenCalled();
  });

  it("switching to Worktree fetches the worktree listing and uses worktree download URLs", async () => {
    mockListing.mockResolvedValue(EMPTY_LISTING);
    mockWorktreeListing.mockResolvedValue({
      path: "",
      parent: null,
      entries: [{ name: "readme.md", type: "file", path: "readme.md" }],
    });

    render(FilesPanel, { sessionId: "sess-7" });
    await waitForPanel();

    await clickWorktreeSegButton();

    await expect.poll(() => mockWorktreeListing.mock.calls.length).toBeGreaterThan(0);
    expect(mockWorktreeListing).toHaveBeenCalledWith("sess-7", undefined);

    await expect.poll(() => document.querySelector("a.row.file")).toBeTruthy();
    const fileRow = document.querySelector<HTMLAnchorElement>("a.row.file")!;
    expect(fileRow.getAttribute("href")).toBe("/wt/sess-7/readme.md");
  });

  it("hides the upload button in worktree mode", async () => {
    render(FilesPanel, { sessionId: "sess-8" });
    await waitForPanel();

    expect(document.querySelector("button.upload-btn")).toBeTruthy();

    await clickWorktreeSegButton();

    await expect.poll(() => document.querySelector("button.upload-btn")).toBeFalsy();
  });

  it("renders a linkOutside entry as a disabled, non-interactive row", async () => {
    mockWorktreeListing.mockResolvedValue({
      path: "",
      parent: null,
      entries: [{ name: "escaped-link", type: "file", path: "escaped-link", linkOutside: true }],
    });

    render(FilesPanel, { sessionId: "sess-9" });
    await waitForPanel();

    await clickWorktreeSegButton();

    await expect.poll(() => document.querySelector(".row.link-outside")).toBeTruthy();
    const row = document.querySelector(".row.link-outside")!;
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("escaped-link");
    // Not rendered as a navigable/actionable element
    expect(row.querySelector("a")).toBeNull();
    expect(row.closest("a")).toBeNull();
    expect(row.tagName).not.toBe("BUTTON");
  });
});
