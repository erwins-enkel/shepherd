import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import HerdLensStrip from "./HerdLensStrip.svelte";
import { overwriteGetLocale } from "$lib/paraglide/runtime";

const base = {
  filter: "all" as const,
  statusFilter: null,
  statusLabel: "",
  collapsible: false,
};

// The strip lives in a 300–360px sidebar. Pin a 300px frame (the sidebar floor) so the
// single-row + label-fit guarantees are exercised at the worst case, matching the plan's
// step-7 measurement.
function mount300() {
  const frame = document.createElement("div");
  frame.style.width = "300px";
  document.body.appendChild(frame);
  render(HerdLensStrip, { props: base, target: frame });
  return frame;
}

afterEach(() => {
  overwriteGetLocale(() => "en");
  document.body.replaceChildren();
});

describe("HerdLensStrip layout at the 300px sidebar floor", () => {
  it("keeps all six lenses on a single row", async () => {
    const frame = mount300();
    const btns = [...frame.querySelectorAll<HTMLElement>(".lens")];
    expect(btns).toHaveLength(6);
    // single row ⇒ every segment shares the same offsetTop
    const tops = new Set(btns.map((b) => b.offsetTop));
    expect(tops.size).toBe(1);
  });

  it("does not clip the longest DE label (Nächstes) — no ellipsis overflow", async () => {
    overwriteGetLocale(() => "de");
    const frame = mount300();
    const labels = [...frame.querySelectorAll<HTMLElement>(".lens .lb")];
    expect(labels.length).toBe(6);
    // a clipped label has scrollWidth > clientWidth (text-overflow:ellipsis kicked in)
    for (const lb of labels) {
      expect(lb.scrollWidth).toBeLessThanOrEqual(lb.clientWidth);
    }
  });
});

describe("HerdLensStrip header bits", () => {
  it("renders the collapse control only when collapsible", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, collapsible: true }, target: frame });
    expect(frame.querySelector("#herd-collapse-btn")).not.toBeNull();
  });

  it("renders the status chip only when a status filter is active", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, {
      props: { ...base, statusFilter: "running", statusLabel: "Busy" },
      target: frame,
    });
    expect(frame.querySelector(".statchip")).not.toBeNull();
  });
});
