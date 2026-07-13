import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import EmptyHerd from "./EmptyHerd.svelte";

describe("EmptyHerd lifecycle overview", () => {
  it("teaches how work flows before any sessions exist", async () => {
    render(EmptyHerd, { onnew: () => {} });
    // The overview heading and its condensed happy-path stages render on the empty board,
    // so a brand-new user learns the pipeline without needing sessions in each stage.
    await expect.element(page.getByText("How work flows")).toBeInTheDocument();
    const flow = document.querySelector(".flow");
    expect(flow).toBeTruthy();
    // Endpoints of the happy path are present.
    await expect.element(page.getByText("Working", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Merged", { exact: true })).toBeInTheDocument();
  });
});
