import { describe, it, expect, vi, afterEach } from "vitest";
import type { ComponentProps } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { Session } from "#lib/types.js";
import TerminalStrip from "./TerminalStrip.svelte";

type Props = ComponentProps<typeof TerminalStrip>;

const session = { id: "s1", desig: "TASK-7", name: "pin-status", status: "idle" } as Session;

function props(over: Partial<Props> = {}): Props {
  return {
    folded: true,
    session,
    workingBlocked: {},
    backgroundBusy: {},
    onunfold: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TerminalStrip", () => {
  it("renders nothing while the session column is unfolded", async () => {
    render(TerminalStrip, props({ folded: false }));
    expect(document.querySelector(".terminal-strip")).toBeNull();
  });

  it("names the folded session and unfolds on click", async () => {
    const onunfold = vi.fn();
    render(TerminalStrip, props({ onunfold }));
    const strip = page.getByRole("button", {
      name: m.assistant_layout_unfold_session({ desig: "TASK-7", name: "pin-status" }),
    });
    await expect.element(strip).toBeVisible();
    expect(document.querySelector(".name")?.textContent).toBe("TASK-7 · pin-status");
    await strip.click();
    expect(onunfold).toHaveBeenCalledOnce();
  });

  it("falls back to a plain unfold label without a session", async () => {
    render(TerminalStrip, props({ session: null }));
    const strip = page.getByRole("button", { name: m.assistant_layout_unfold() });
    await expect.element(strip).toBeVisible();
    expect(document.querySelector(".name")).toBeNull();
  });
});
