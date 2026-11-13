import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import IntegratedChildNote from "./IntegratedChildNote.svelte";
import { m } from "#lib/paraglide/messages.js";

// #3016: the chip on integrated work — in the herd's Merged group and on the epic's child row.

const MAC = { instanceId: "mac-1", name: "macbook", platform: "macos" };

async function hoverOpen(node: HTMLElement) {
  node.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  await expect.poll(() => document.querySelector(".status-tip:popover-open")).not.toBeNull();
  return document.querySelector<HTMLElement>(".status-tip")!;
}

const chip = () => document.querySelector<HTMLElement>("[data-testid='integrated-note']")!;

describe("IntegratedChildNote", () => {
  it("a local session: the epic it is integrated into, quiet, explained on hover", async () => {
    render(IntegratedChildNote, { note: { parentIssueNumber: 3016, host: null, settle: null } });
    await expect.poll(() => chip()?.textContent).toBe(m.integrated_chip({ parent: "3016" }));
    expect(chip().classList.contains("chip-integrated--quiet")).toBe(true);
    const tip = await hoverOpen(chip());
    expect(tip.textContent).toContain(m.integrated_tip_summary_local());
    expect(tip.textContent).toContain(m.integrated_local_todo());
  });

  it("a session on another machine whose agent still works: machine, reason and what to do", async () => {
    render(IntegratedChildNote, { note: { parentIssueNumber: 3016, host: MAC, settle: "busy" } });
    await expect
      .poll(() => chip()?.textContent)
      .toBe(
        m.integrated_chip_remote({
          parent: "3016",
          host: "macbook",
          status: m.integrated_busy_status(),
        }),
      );
    const tip = await hoverOpen(chip());
    expect(tip.textContent).toContain(m.integrated_busy_happens({ host: "macbook" }));
    expect(tip.textContent).toContain(m.integrated_busy_todo({ host: "macbook" }));
  });

  it("a settle waiting on the operator (older Shepherd there) takes the warn tone", async () => {
    render(IntegratedChildNote, {
      note: { parentIssueNumber: 3016, host: MAC, settle: "unsupported" },
    });
    await expect.poll(() => chip()?.classList.contains("chip-integrated--warn")).toBe(true);
    const tip = await hoverOpen(chip());
    expect(tip.textContent).toContain(m.integrated_unsupported_todo({ host: "macbook" }));
  });
});
