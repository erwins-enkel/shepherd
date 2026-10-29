import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { Session } from "#lib/types.js";
import MobileFabs from "./MobileFabs.svelte";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MobileFabs (phone variant E)", () => {
  it("Assist and New sit above the action bar and fire their handlers", async () => {
    await page.viewport(390, 844);
    const onnew = vi.fn();
    const onassistant = vi.fn();
    render(MobileFabs, { onnew, onassistant });

    const assist = document.querySelector<HTMLElement>("#topbar-assist")!;
    expect(assist.classList.contains("compact")).toBe(true);
    expect(assist.querySelector(".assist-label")).toBeNull();
    const r = assist.getBoundingClientRect();
    expect(r.width).toBeGreaterThanOrEqual(48);
    expect(r.height).toBeGreaterThanOrEqual(48);

    // Floats above the bar band, never over it. The token is a calc(), so resolve it on a probe.
    const probe = document.createElement("div");
    probe.style.height = "var(--mobile-actionbar-h)";
    document.body.appendChild(probe);
    const bandTop = 844 - probe.getBoundingClientRect().height;
    probe.remove();
    expect(r.bottom).toBeLessThanOrEqual(bandTop);

    await page.getByRole("button", { name: m.operator_assistant_title() }).click();
    expect(onassistant).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: m.actionbar_new_task() }).click();
    expect(onnew).toHaveBeenCalledOnce();
  });

  it("the Assist pip follows the assistant's status", async () => {
    render(MobileFabs, {
      onnew: vi.fn(),
      onassistant: vi.fn(),
      assistant: { id: "oa", status: "blocked" } as Session,
    });
    await expect
      .element(page.getByRole("button", { name: m.topbar_assist_blocked() }))
      .toBeInTheDocument();
  });

  it("renders no Assist button without onassistant", async () => {
    render(MobileFabs, { onnew: vi.fn() });
    await expect.element(page.getByRole("button", { name: m.actionbar_new_task() })).toBeVisible();
    expect(document.querySelector("#topbar-assist")).toBeNull();
  });
});
