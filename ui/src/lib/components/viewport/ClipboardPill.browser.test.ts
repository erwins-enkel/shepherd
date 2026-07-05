import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";

const { default: ClipboardPill } = await import("./ClipboardPill.svelte");

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ClipboardPill", () => {
  it("Copy writes the exact text to the clipboard and fires oncopied on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const oncopied = vi.fn();
    const oncopyfailed = vi.fn();
    render(ClipboardPill, {
      text: "hello clipboard",
      oncopied,
      oncopyfailed,
      ondismiss: vi.fn(),
    });

    await page.getByRole("button", { name: /copy/i }).click();

    expect(writeText).toHaveBeenCalledWith("hello clipboard");
    await vi.waitFor(() => expect(oncopied).toHaveBeenCalledTimes(1));
    expect(oncopyfailed).not.toHaveBeenCalled();
  });

  it("fires oncopyfailed (not oncopied) when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const oncopied = vi.fn();
    const oncopyfailed = vi.fn();
    render(ClipboardPill, {
      text: "some text",
      oncopied,
      oncopyfailed,
      ondismiss: vi.fn(),
    });

    await page.getByRole("button", { name: /copy/i }).click();

    await vi.waitFor(() => expect(oncopyfailed).toHaveBeenCalledTimes(1));
    expect(oncopied).not.toHaveBeenCalled();
  });

  it("dismiss control fires ondismiss", async () => {
    const ondismiss = vi.fn();
    render(ClipboardPill, {
      text: "some text",
      oncopied: vi.fn(),
      oncopyfailed: vi.fn(),
      ondismiss,
    });

    await page.getByRole("button", { name: /close|dismiss/i }).click();

    expect(ondismiss).toHaveBeenCalledTimes(1);
  });
});
