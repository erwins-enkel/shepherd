import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import CalloutBlock from "./CalloutBlock.svelte";

describe("CalloutBlock", () => {
  it("shows the localized tone label for 'risk'", async () => {
    render(CalloutBlock, {
      block: { type: "callout", id: "c1", tone: "risk", markdown: "Danger ahead." },
    });
    await expect.element(page.getByText("Risk")).toBeInTheDocument();
  });

  it("renders the markdown body", async () => {
    render(CalloutBlock, {
      block: { type: "callout", id: "c2", tone: "risk", markdown: "Danger ahead." },
    });
    await expect.element(page.getByText("Danger ahead.")).toBeInTheDocument();
  });

  it("shows 'Info' label for info tone", async () => {
    render(CalloutBlock, {
      block: { type: "callout", id: "c3", tone: "info", markdown: "Just so you know." },
    });
    await expect.element(page.getByText("Info")).toBeInTheDocument();
  });

  it("shows 'Decision' label for decision tone", async () => {
    render(CalloutBlock, {
      block: { type: "callout", id: "c4", tone: "decision", markdown: "We chose X." },
    });
    await expect.element(page.getByText("Decision")).toBeInTheDocument();
  });

  it("shows 'Warning' label for warning tone", async () => {
    render(CalloutBlock, {
      block: { type: "callout", id: "c5", tone: "warning", markdown: "Watch out." },
    });
    await expect.element(page.getByText("Warning")).toBeInTheDocument();
  });

  it("shows 'Success' label for success tone", async () => {
    render(CalloutBlock, {
      block: { type: "callout", id: "c6", tone: "success", markdown: "All done." },
    });
    await expect.element(page.getByText("Success")).toBeInTheDocument();
  });
});
