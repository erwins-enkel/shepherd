import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import EmojiPicker from "./EmojiPicker.svelte";
import { m } from "$lib/paraglide/messages";

describe("EmojiPicker — custom emoji Set button", () => {
  it("Set commits a pasted emoji", async () => {
    const onpick = vi.fn();
    render(EmojiPicker, { value: null, onpick, onclose: vi.fn() });

    await page.getByPlaceholder(m.emojipicker_custom()).fill("🦄");
    await page.getByRole("button", { name: m.emojipicker_set() }).click();

    expect(onpick).toHaveBeenCalledTimes(1);
    expect(onpick).toHaveBeenCalledWith("🦄");
  });

  it("Set is disabled when the field is empty", async () => {
    const onpick = vi.fn();
    render(EmojiPicker, { value: null, onpick, onclose: vi.fn() });

    await expect.element(page.getByRole("button", { name: m.emojipicker_set() })).toBeDisabled();
    expect(onpick).not.toHaveBeenCalled();
  });

  it("Set is disabled for an invalid (non-emoji) value", async () => {
    const onpick = vi.fn();
    render(EmojiPicker, { value: null, onpick, onclose: vi.fn() });

    await page.getByPlaceholder(m.emojipicker_custom()).fill("ab");

    await expect.element(page.getByRole("button", { name: m.emojipicker_set() })).toBeDisabled();
    expect(onpick).not.toHaveBeenCalled();
  });
});
