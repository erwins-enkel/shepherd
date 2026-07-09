import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { PromptPin } from "$lib/promptPins";

const { default: PinnedPrompt } = await import("./PinnedPrompt.svelte");

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const PINS: PromptPin[] = [
  { line: 3, text: "why is the sky blue?" },
  { line: 9, text: "now rewrite it as a haiku" },
];

const mount = (props: Partial<Parameters<typeof render>[1]> = {}) =>
  render(PinnedPrompt, {
    pins: PINS,
    resolved: { pin: PINS[1], uncertain: false },
    onjump: vi.fn(),
    ...props,
  } as never);

describe("PinnedPrompt", () => {
  it("pins the governing prompt's text", async () => {
    mount();
    await expect.element(page.getByText("now rewrite it as a haiku")).toBeInTheDocument();
  });

  it("pins the EARLIER prompt when the reader has scrolled back above the newer one", async () => {
    mount({ resolved: { pin: PINS[0], uncertain: false } });
    await expect.element(page.getByText("why is the sky blue?")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("haiku");
  });

  it("says the prompt is unknown rather than naming the wrong one", async () => {
    mount({ resolved: { pin: null, uncertain: true } });
    await expect.element(page.getByText(/prompt unknown/i)).toBeInTheDocument();
  });

  it("shows an empty state before any prompt is asked, and cannot expand", async () => {
    mount({ pins: [], resolved: { pin: null, uncertain: false } });
    await expect.element(page.getByText(/no prompt yet/i)).toBeInTheDocument();
    await expect.element(page.getByRole("button")).toBeDisabled();
  });

  it("expands to the full prompt history, newest first", async () => {
    mount();
    await page.getByRole("button", { expanded: false }).click();

    const items = document.querySelectorAll(".pp-item-text");
    expect([...items].map((n) => n.textContent)).toEqual([
      "now rewrite it as a haiku",
      "why is the sky blue?",
    ]);
  });

  it("picking a prompt jumps the terminal to its scrollback line and closes", async () => {
    const onjump = vi.fn();
    mount({ onjump });
    await page.getByRole("button", { expanded: false }).click();
    await page.getByText("why is the sky blue?").last().click();

    expect(onjump).toHaveBeenCalledWith(3);
    await vi.waitFor(() => expect(document.querySelector(".pp-pop")).toBeNull());
  });

  it("jumping returns focus to the bar, so keystrokes still reach the terminal", async () => {
    mount();
    await page.getByRole("button", { expanded: false }).click();
    await page.getByText("why is the sky blue?").last().click();

    // The clicked .pp-item is gone with the popover; focus must not fall to <body>.
    await vi.waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(document.querySelector("button.pp-main"));
  });

  it("Escape also returns focus to the bar", async () => {
    mount();
    const opener = document.querySelector("button.pp-main") as HTMLElement;
    await page.getByRole("button", { expanded: false }).click();
    (document.querySelector(".pp-item") as HTMLElement).focus();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("Escape dismisses the non-modal popover", async () => {
    mount();
    await page.getByRole("button", { expanded: false }).click();
    expect(document.querySelector(".pp-pop")).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    await vi.waitFor(() => expect(document.querySelector(".pp-pop")).toBeNull());
  });

  it("the history popover is anchored and non-modal, so it takes no scrim", async () => {
    mount();
    await page.getByRole("button", { expanded: false }).click();

    const pop = document.querySelector(".pp-pop")!;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-modal")).toBeNull();
    expect(document.querySelector(".scrim, .overlay")).toBeNull();
  });

  it("names itself for a screen reader: label + prompt, and the count is not a bare number", async () => {
    mount();
    const name = document.querySelector("button.pp-main")!.textContent!;
    expect(name).toContain("You asked"); // not aria-hidden: the text alone lacks context
    expect(name).toContain("now rewrite it as a haiku");
    expect(name).toContain("2 prompts in this session");
    // the numeral itself is decorative once the phrase above names it
    expect(document.querySelector(".pp-count")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("publishes its occupied height so the terminal can reserve it", async () => {
    let height = 0;
    render(PinnedPrompt, {
      pins: PINS,
      resolved: { pin: PINS[1], uncertain: false },
      onjump: vi.fn(),
      get height() {
        return height;
      },
      set height(v: number) {
        height = v;
      },
    } as never);

    await vi.waitFor(() => expect(height).toBeGreaterThan(0));
  });
});
