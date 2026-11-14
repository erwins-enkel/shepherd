import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";

vi.mock("#lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/api.js")>()),
  getHostFile: vi.fn(),
}));
const { default: HostFileDialog } = await import("./HostFileDialog.svelte");
const { getHostFile } = await import("#lib/api.js");
const mockGet = vi.mocked(getHostFile);

const dialog = () => page.getByRole("dialog", { name: m.hostfile_title() });

describe("HostFileDialog (#4017)", () => {
  beforeEach(() => mockGet.mockReset());

  it("renders a Markdown file as Markdown, with its name and full path", async () => {
    mockGet.mockResolvedValue({ path: "/h/r/report.md", size: 9, text: "# Heading" });
    render(HostFileDialog, { sessionId: "s1", path: "/h/r/report.md", onclose: vi.fn() });
    await expect.element(page.getByRole("heading", { name: "Heading" })).toBeVisible();
    await expect.element(dialog().getByText("report.md", { exact: true })).toBeVisible();
    await expect.element(dialog().getByText("/h/r/report.md", { exact: true })).toBeVisible();
    expect(mockGet).toHaveBeenCalledWith("s1", "/h/r/report.md");
  });

  it("shows any other text verbatim in a pre", async () => {
    mockGet.mockResolvedValue({ path: "/h/r.log", size: 9, text: "# not md\n<b>x</b>" });
    render(HostFileDialog, { sessionId: "s1", path: "/h/r.log", onclose: vi.fn() });
    await vi.waitFor(() =>
      expect(document.querySelector("pre.text")?.textContent).toBe("# not md\n<b>x</b>"),
    );
    expect(document.querySelector("pre.text b")).toBeNull();
  });

  it("says when the file can't be shown", async () => {
    mockGet.mockResolvedValue(null);
    render(HostFileDialog, { sessionId: "s1", path: "/h/gone.md", onclose: vi.fn() });
    await expect.element(page.getByText(m.hostfile_unavailable())).toBeVisible();
  });

  it("copies the path; Escape and close dismiss", async () => {
    mockGet.mockResolvedValue({ path: "/h/a.txt", size: 1, text: "a" });
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const onclose = vi.fn();
    render(HostFileDialog, { sessionId: "s1", path: "/h/a.txt", onclose });
    await page.getByRole("button", { name: m.markdown_copy_host_path() }).click();
    expect(write).toHaveBeenCalledWith("/h/a.txt");
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: m.common_close() }).click();
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});
