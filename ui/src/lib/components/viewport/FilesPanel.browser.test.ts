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
  it("provides a shared explanation of the two file sources", async () => {
    render(FilesPanel, { sessionId: "sess-source-info" });
    await waitForPanel();

    await expect
      .element(
        page.getByRole("button", {
          name: m.newtask_info_aria({ topic: m.files_source_switch_aria() }),
        }),
      )
      .toBeInTheDocument();
    expect(document.querySelector(".info-tooltip")?.textContent?.trim()).toBe(
      "Scratchpad contains supplementary files for this session and stays separate from the repository. Worktree is the agent's project directory and changes; you can only browse and download it here.",
    );
    expect(mockWorktreeListing).not.toHaveBeenCalled();
  });

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

describe("FilesPanel — Created column and sorting", () => {
  const rowNames = () =>
    Array.from(document.querySelectorAll(".list .row .nm")).map((n) => n.textContent?.trim());

  // A dir + files with varied creation times, plus one file with no createdMs.
  const now = Date.now();
  const HOUR = 3_600_000;
  const mixedListing = {
    path: "",
    parent: null as string | null,
    entries: [
      { name: "zzz-dir", type: "dir" as const, path: "zzz-dir", createdMs: now - 5 * HOUR },
      { name: "aaa-dir", type: "dir" as const, path: "aaa-dir", createdMs: now - 1 * HOUR },
      { name: "b.txt", type: "file" as const, path: "b.txt", createdMs: now - 2 * HOUR },
      { name: "a.txt", type: "file" as const, path: "a.txt", createdMs: now - 4 * HOUR },
      { name: "c.txt", type: "file" as const, path: "c.txt" }, // no createdMs
    ],
  };

  it("renders a Created cell per row and an em-dash for a missing createdMs", async () => {
    mockListing.mockResolvedValue(mixedListing);
    render(FilesPanel, { sessionId: "sess-c1" });
    await waitForPanel();

    await expect.poll(() => document.querySelectorAll(".list .row .created").length).toBe(5);
    // The entry without createdMs renders the guarded em-dash, never "NaNs".
    const empties = Array.from(document.querySelectorAll(".created.empty")).map((e) =>
      e.textContent?.trim(),
    );
    expect(empties).toEqual(["—"]);
    expect(document.querySelector(".list")?.textContent).not.toContain("NaN");
  });

  it("defaults to name-ascending with directories grouped first", async () => {
    mockListing.mockResolvedValue(mixedListing);
    render(FilesPanel, { sessionId: "sess-c2" });
    await waitForPanel();

    await expect.poll(() => rowNames().length).toBe(5);
    expect(rowNames()).toEqual(["aaa-dir", "zzz-dir", "a.txt", "b.txt", "c.txt"]);
  });

  it("sorts by Created (newest first), keeps dirs grouped, puts missing dates last, and toggles", async () => {
    mockListing.mockResolvedValue(mixedListing);
    render(FilesPanel, { sessionId: "sess-c3" });
    await waitForPanel();
    await expect.poll(() => rowNames().length).toBe(5);

    // First Created click → descending (newest first): dirs first by date desc, then files
    // by date desc, missing-date file last.
    await page.getByRole("button", { name: m.files_sort_created_aria() }).click();
    await expect.poll(() => rowNames()).toEqual(["aaa-dir", "zzz-dir", "b.txt", "a.txt", "c.txt"]);

    // Second click → ascending: dirs oldest-first, files oldest-first, missing still last.
    await page.getByRole("button", { name: m.files_sort_created_aria() }).click();
    await expect.poll(() => rowNames()).toEqual(["zzz-dir", "aaa-dir", "a.txt", "b.txt", "c.txt"]);
  });
});

describe("FilesPanel — Attachments overlay (#1717)", () => {
  const ATT = "attachments";
  const rootWithAttachments = {
    path: "",
    parent: null as string | null,
    entries: [{ name: ATT, type: "dir" as const, path: ATT, attachments: true }],
  };
  const nmText = () =>
    Array.from(document.querySelectorAll(".list .row .nm")).map((n) => n.textContent?.trim());

  it("renders the localized Attachments folder from the initial listing", async () => {
    mockListing.mockResolvedValue(rootWithAttachments);
    render(FilesPanel, { sessionId: "att-1" });
    await waitForPanel();
    await expect.poll(() => nmText()).toContain(m.files_attachments_folder());
    // The raw reserved slug is never shown to the operator.
    expect(nmText()).not.toContain(ATT);
  });

  it("keeps scratchpad labels and hides the upload affordance inside the attachments subtree", async () => {
    const emptySub = { path: ATT, parent: "", entries: [] as never[] };
    mockListing.mockImplementation(async (_id: string, path?: string) =>
      path === ATT ? emptySub : rootWithAttachments,
    );
    render(FilesPanel, { sessionId: "att-2" });
    await waitForPanel();

    // Navigate into the Attachments folder.
    const folder = Array.from(document.querySelectorAll<HTMLButtonElement>("button.row")).find(
      (b) => b.querySelector(".nm")?.textContent?.trim() === m.files_attachments_folder(),
    );
    expect(folder).toBeTruthy();
    folder!.click();

    // Upload affordance disappears (uploadDisabled inside the read-only overlay).
    await expect.poll(() => document.querySelector("button.upload-btn")).toBeNull();

    // Empty-state text stays the SCRATCHPAD variant — not the Worktree string.
    const empty = document.querySelector(".placeholder")?.textContent ?? "";
    expect(empty).toContain(m.files_empty());
    expect(empty).not.toContain(m.files_worktree_empty());

    // Breadcrumb root crumb stays the scratchpad label; current crumb is the localized folder name.
    const crumbs = Array.from(document.querySelectorAll(".crumbs .crumb")).map((c) =>
      c.textContent?.trim(),
    );
    expect(crumbs).toContain(m.files_root_crumb());
    expect(crumbs).not.toContain(m.files_worktree_root_crumb());
    expect(document.querySelector(".crumb.current")?.textContent?.trim()).toBe(
      m.files_attachments_folder(),
    );
  });
});

describe("FilesPanel — a blocked drop always says why", () => {
  const ATT = "attachments";
  const rootWithAttachments = {
    path: "",
    parent: null as string | null,
    entries: [{ name: ATT, type: "dir" as const, path: ATT, attachments: true }],
  };

  // A synthetic DataTransfer SILENTLY DISCARDS dropEffect writes (the spec only honours them
  // during a real drag), so reading the property back would always report "none" and prove
  // nothing. Record the assignments instead — that is what the handler actually did.
  const dragTo = (tab: HTMLElement, type: "dragover" | "drop", file?: File) => {
    const dt = new DataTransfer();
    if (file) dt.items.add(file);
    const dropEffects: string[] = [];
    Object.defineProperty(dt, "dropEffect", {
      configurable: true,
      get: () => dropEffects[dropEffects.length - 1] ?? "none",
      set: (v: string) => void dropEffects.push(v),
    });
    const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    tab.dispatchEvent(evt);
    return { evt, dt, dropEffects };
  };

  // The load-bearing invariant behind every message in this block. A synthetic DragEvent
  // dispatched at the handler bypasses the browser's own drag bookkeeping, so it CANNOT prove a
  // real drop would follow — asserting dropEffect here is what stops a "none" regression (which
  // cancels the drag, so no drop event ever fires) from passing these tests silently.
  it("keeps the drop live on dragover — preventDefault, never dropEffect none", async () => {
    render(FilesPanel, { sessionId: "drag-live" });
    await waitForPanel();
    const tab = document.querySelector<HTMLDivElement>(".files")!;

    const enabled = dragTo(tab, "dragover", new File(["a"], "a.eps", { type: "" }));
    expect(enabled.evt.defaultPrevented).toBe(true);
    expect(enabled.dropEffects).toEqual(["copy"]);

    // Same guarantee where upload is impossible — otherwise the explanation is unreachable.
    await clickWorktreeSegButton();
    const disabled = dragTo(tab, "dragover", new File(["a"], "a.eps", { type: "" }));
    expect(disabled.evt.defaultPrevented).toBe(true);
    expect(disabled.dropEffects).toEqual(["copy"]);
    // No overlay where nothing can land (poll: Svelte flushes the removal asynchronously).
    await expect.poll(() => document.querySelector(".drop-overlay")).toBeFalsy();
  });

  it("explains a drop on the read-only Worktree tab instead of swallowing it", async () => {
    render(FilesPanel, { sessionId: "drag-wt" });
    await waitForPanel();
    await clickWorktreeSegButton();

    const tab = document.querySelector<HTMLDivElement>(".files")!;
    dragTo(tab, "drop", new File(["a"], "logo.eps", { type: "" }));

    await expect
      .poll(() => document.querySelector(".upload-status.err")?.textContent?.trim())
      .toBe(m.files_upload_readonly_worktree());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("explains a drop inside the read-only Attachments folder", async () => {
    const emptySub = { path: ATT, parent: "", entries: [] as never[] };
    mockListing.mockImplementation(async (_id: string, path?: string) =>
      path === ATT ? emptySub : rootWithAttachments,
    );
    render(FilesPanel, { sessionId: "drag-att" });
    await waitForPanel();

    const folder = Array.from(document.querySelectorAll<HTMLButtonElement>("button.row")).find(
      (b) => b.querySelector(".nm")?.textContent?.trim() === m.files_attachments_folder(),
    );
    folder!.click();
    await expect.poll(() => document.querySelector("button.upload-btn")).toBeNull();

    const tab = document.querySelector<HTMLDivElement>(".files")!;
    dragTo(tab, "drop", new File(["a"], "logo.eps", { type: "" }));

    await expect
      .poll(() => document.querySelector(".upload-status.err")?.textContent?.trim())
      .toBe(m.files_upload_readonly_attachments());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // The classic dead end: dragging an attachment straight out of a mail client or a browser tab
  // hands over a reference, not a file, so dataTransfer.files is empty.
  it("explains a drop that carried no file at all", async () => {
    render(FilesPanel, { sessionId: "drag-nofile" });
    await waitForPanel();

    const tab = document.querySelector<HTMLDivElement>(".files")!;
    dragTo(tab, "drop");

    await expect
      .poll(() => document.querySelector(".upload-status.err")?.textContent?.trim())
      .toBe(m.files_upload_no_files());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("names the cause when the session has no scratchpad target (404)", async () => {
    mockUpload.mockRejectedValue(new ApiError(404, "not found"));
    render(FilesPanel, { sessionId: "drag-404" });
    await waitForPanel();

    const file = new File(["a"], "logo.eps", { type: "" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await expect
      .poll(() => document.querySelector(".upload-status.err")?.textContent?.trim())
      .toBe(m.files_upload_unavailable({ name: "logo.eps" }));
  });
});
