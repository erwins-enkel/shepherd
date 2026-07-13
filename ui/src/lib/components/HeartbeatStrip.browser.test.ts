import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { SessionActivity } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import HeartbeatStrip from "./HeartbeatStrip.svelte";

afterEach(() => {
  document.body.innerHTML = "";
});

// Fixed clock + in-window events so bucketStrip is deterministic (8-min window).
const NOW = 10_000_000;
function activity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    lastActivityTs: NOW - 1_000,
    summary: "edited poller.ts",
    recentTs: [NOW - 5_000, NOW - 1_000],
    recentErrTs: [NOW - 5_000], // one slice errored → a red stub cell
    ...overrides,
  };
}

describe("HeartbeatStrip trigger", () => {
  it("is an activatable button, not a role=img span", () => {
    render(HeartbeatStrip, { activity: activity(), nowMs: NOW });
    const strip = document.querySelector("button.strip");
    expect(strip, "strip is a <button>").not.toBeNull();
    expect(document.querySelector('[role="img"]'), "no leftover role=img").toBeNull();
    expect((strip as HTMLButtonElement).disabled, "focusable (not disabled)").toBe(false);
  });

  it("accessible name discloses that activating opens the session (not only recency)", () => {
    render(HeartbeatStrip, { activity: activity(), nowMs: NOW });
    const strip = document.querySelector("button.strip") as HTMLButtonElement;
    const name = strip.getAttribute("aria-label") ?? "";
    // Reviewer point 3: mirror the Stepper — the open-session hint must be present so a
    // keyboard/SR user knows the control opens the session, not just "active X ago".
    expect(name).toContain(m.stepper_open_hint());
  });

  it("wires aria-describedby to the role=tooltip encoding legend", () => {
    render(HeartbeatStrip, { activity: activity(), nowMs: NOW });
    const strip = document.querySelector("button.strip") as HTMLButtonElement;
    const describedBy = strip.getAttribute("aria-describedby");
    expect(describedBy, "aria-describedby set").toBeTruthy();
    const legend = document.getElementById(describedBy!);
    expect(legend, "legend element present").not.toBeNull();
    expect(legend!.getAttribute("role")).toBe("tooltip");
    expect(legend!.hasAttribute("popover")).toBe(true);
  });

  it("legend lists the three encoding rows", () => {
    render(HeartbeatStrip, { activity: activity(), nowMs: NOW });
    const labels = [...document.querySelectorAll(".legend .lg-label")].map((n) =>
      n.textContent?.trim(),
    );
    expect(labels).toContain(m.heartbeat_legend_active_label());
    expect(labels).toContain(m.heartbeat_legend_idle_label());
    expect(labels).toContain(m.heartbeat_legend_error_label());
  });

  it("still renders an errored slice as a red stub cell in the strip", () => {
    render(HeartbeatStrip, { activity: activity(), nowMs: NOW });
    // Scope to the strip so the legend's error swatch isn't what we're matching.
    const errCell = document.querySelector("button.strip .cell.err");
    expect(errCell, "strip has an .cell.err stub").not.toBeNull();
  });
});
