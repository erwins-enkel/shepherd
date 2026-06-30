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

describe("HerdLensStrip OWED count badge (#1257)", () => {
  it("hides the badge when owedCount is 0 (or default)", async () => {
    const frame = mount300();
    expect(frame.querySelector(".owed-badge")).toBeNull();
  });

  it("renders the badge with the count when owedCount > 0", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, owedCount: 3 }, target: frame });
    const badge = frame.querySelector(".owed-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("3");
    // The badge anchors to the OWED lens (absolute → inside a position:relative segment).
    expect(frame.querySelector(".lens-owed .owed-badge")).not.toBeNull();
  });

  it("caps a large count at 99+", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, owedCount: 250 }, target: frame });
    expect(frame.querySelector(".owed-badge")!.textContent).toBe("99+");
  });

  it("keeps all six lenses on a single row at the 300px floor with a 2-digit badge", async () => {
    const frame = document.createElement("div");
    frame.style.width = "300px";
    document.body.appendChild(frame);
    render(HerdLensStrip, { props: { ...base, owedCount: 42 }, target: frame });
    const btns = [...frame.querySelectorAll<HTMLElement>(".lens")];
    expect(btns).toHaveLength(6);
    // single row ⇒ every segment shares the same offsetTop (the absolute badge adds no flow width)
    expect(new Set(btns.map((b) => b.offsetTop)).size).toBe(1);
    // the badge itself must not overflow the OWED segment's box
    const owed = frame.querySelector<HTMLElement>(".lens-owed")!;
    const badge = frame.querySelector<HTMLElement>(".owed-badge")!;
    expect(badge.offsetWidth).toBeLessThanOrEqual(owed.offsetWidth);
  });
});
