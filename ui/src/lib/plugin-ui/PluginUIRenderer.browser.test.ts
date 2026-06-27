import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PluginUIRenderer from "./PluginUIRenderer.svelte";

describe("PluginUIRenderer", () => {
  it("dispatches a known type (text) to the correct component", async () => {
    render(PluginUIRenderer, {
      node: { type: "text", props: { value: "Hello plugin" } },
    });
    await expect.element(page.getByText("Hello plugin")).toBeInTheDocument();
  });

  it("renders UnknownNodeTile for an unknown type", async () => {
    render(PluginUIRenderer, {
      node: { type: "exotic-widget", props: {} },
    });
    await expect.element(page.getByText("Unsupported component")).toBeInTheDocument();
    await expect.element(page.getByText("exotic-widget")).toBeInTheDocument();
  });

  it("renders a nested tree via PuiStack → PuiText", async () => {
    render(PluginUIRenderer, {
      node: {
        type: "stack",
        children: [
          { type: "text", props: { value: "First" } },
          { type: "text", props: { value: "Second" } },
        ],
      },
    });
    await expect.element(page.getByText("First")).toBeInTheDocument();
    await expect.element(page.getByText("Second")).toBeInTheDocument();
  });

  it("renders callout node verbatim — no markdown parsing", async () => {
    render(PluginUIRenderer, {
      node: { type: "callout", props: { text: "**bold** stays literal" } },
    });
    await expect.element(page.getByText("**bold** stays literal")).toBeInTheDocument();
  });

  it("renders UnknownNodeTile for prototype key 'constructor' (not a crash)", async () => {
    render(PluginUIRenderer, {
      node: { type: "constructor", props: {} },
    });
    await expect.element(page.getByText("Unsupported component")).toBeInTheDocument();
    await expect.element(page.getByText("constructor")).toBeInTheDocument();
  });

  it("renders UnknownNodeTile for prototype key 'toString' (not a crash)", async () => {
    render(PluginUIRenderer, {
      node: { type: "toString", props: {} },
    });
    await expect.element(page.getByText("Unsupported component")).toBeInTheDocument();
    await expect.element(page.getByText("toString")).toBeInTheDocument();
  });
});
