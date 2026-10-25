import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";

const { default: TerminalSelectSheet } = await import("./TerminalSelectSheet.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TerminalSelectSheet", () => {
  it("shows the buffer text in a natively selectable, scrollable block", async () => {
    render(TerminalSelectSheet, { text: "line one\nline two", fontSize: 11, onclose: vi.fn() });
    const pre = document.querySelector("pre")!;
    expect(pre.textContent).toBe("line one\nline two");
    const cs = getComputedStyle(pre);
    expect(cs.userSelect).toBe("text");
    expect(cs.touchAction).toBe("auto");
  });

  it("opens scrolled to the latest output", async () => {
    const text = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n");
    render(TerminalSelectSheet, { text, fontSize: 11, onclose: vi.fn() });
    const pre = document.querySelector("pre")!;
    await vi.waitFor(() => expect(pre.scrollTop).toBeGreaterThan(0));
    expect(pre.scrollTop + pre.clientHeight).toBeGreaterThanOrEqual(pre.scrollHeight - 1);
  });

  it("Done and Escape both close", async () => {
    const onclose = vi.fn();
    render(TerminalSelectSheet, { text: "x", fontSize: 11, onclose });
    await page.getByRole("button", { name: /done/i }).click();
    expect(onclose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});
