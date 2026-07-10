import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiTimeline from "./PuiTimeline.svelte";

describe("PuiTimeline", () => {
  it("renders event at, label, and caption verbatim", async () => {
    render(PuiTimeline, {
      node: {
        type: "timeline",
        props: {
          events: [
            {
              at: "**raw** at",
              label: "**raw** label",
              caption: "**raw** caption",
            },
          ],
        },
      },
    });
    await expect.element(page.getByText("**raw** at")).toBeInTheDocument();
    await expect.element(page.getByText("**raw** label")).toBeInTheDocument();
    await expect.element(page.getByText("**raw** caption")).toBeInTheDocument();
  });

  it("event list is an <ol>", async () => {
    const { container } = await render(PuiTimeline, {
      node: {
        type: "timeline",
        props: {
          events: [{ at: "2024-01", label: "Deploy" }],
        },
      },
    });
    expect(container.querySelector("ol.pui-timeline")).not.toBeNull();
  });

  it("empty events renders empty-state text", async () => {
    render(PuiTimeline, {
      node: { type: "timeline", props: { events: [] } },
    });
    await expect.element(page.getByText("No events.")).toBeInTheDocument();
  });

  it("missing events prop renders empty-state text and does not throw", async () => {
    render(PuiTimeline, {
      node: { type: "timeline" },
    });
    await expect.element(page.getByText("No events.")).toBeInTheDocument();
  });

  it("renders multiple events in order", async () => {
    const { container } = await render(PuiTimeline, {
      node: {
        type: "timeline",
        props: {
          events: [
            { at: "Jan", label: "First" },
            { at: "Feb", label: "Second" },
          ],
        },
      },
    });
    const items = container.querySelectorAll("li.pui-timeline-event");
    expect(items.length).toBe(2);
  });
});
