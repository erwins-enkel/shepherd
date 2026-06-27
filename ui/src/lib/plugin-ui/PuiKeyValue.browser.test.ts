import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiKeyValue from "./PuiKeyValue.svelte";

describe("PuiKeyValue", () => {
  it("renders key and value pairs", async () => {
    render(PuiKeyValue, {
      node: {
        type: "key-value",
        props: {
          pairs: [
            { key: "Version", value: "1.2.3" },
            { key: "Status", value: "active" },
          ],
        },
      },
    });
    await expect.element(page.getByText("Version")).toBeInTheDocument();
    await expect.element(page.getByText("1.2.3")).toBeInTheDocument();
    await expect.element(page.getByText("Status")).toBeInTheDocument();
    await expect.element(page.getByText("active")).toBeInTheDocument();
  });

  it("shows empty state for empty pairs array", async () => {
    render(PuiKeyValue, {
      node: { type: "key-value", props: { pairs: [] } },
    });
    await expect.element(page.getByText("No entries.")).toBeInTheDocument();
  });

  it("handles missing props without throwing", () => {
    expect(() => render(PuiKeyValue, { node: { type: "key-value" } })).not.toThrow();
  });

  it("coerces non-string values to string", async () => {
    render(PuiKeyValue, {
      node: {
        type: "key-value",
        props: { pairs: [{ key: "Count", value: 42 }] },
      },
    });
    await expect.element(page.getByText("42")).toBeInTheDocument();
  });
});
