import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AnnotatedCodeBlock from "./AnnotatedCodeBlock.svelte";

describe("AnnotatedCodeBlock", () => {
  it("renders the filename", async () => {
    render(AnnotatedCodeBlock, {
      block: {
        type: "annotated-code",
        id: "ac1",
        filename: "src/api.ts",
        code: "export function init() {}",
      },
    });
    await expect.element(page.getByText("src/api.ts")).toBeInTheDocument();
  });

  it("renders annotation label and note as prose (not line-anchored)", async () => {
    render(AnnotatedCodeBlock, {
      block: {
        type: "annotated-code",
        id: "ac2",
        filename: "src/api.ts",
        code: "export function init() {}",
        annotations: [{ label: "Key:", note: "This sets up the main handler." }],
      },
    });
    await expect.element(page.getByText("Key:")).toBeInTheDocument();
    await expect.element(page.getByText(/This sets up the main handler\./)).toBeInTheDocument();
  });

  it("renders annotation without label", async () => {
    render(AnnotatedCodeBlock, {
      block: {
        type: "annotated-code",
        id: "ac3",
        filename: "src/api.ts",
        annotations: [{ note: "No label annotation." }],
      },
    });
    await expect.element(page.getByText("No label annotation.")).toBeInTheDocument();
  });

  it("renders without throwing when code is absent", () => {
    expect(() =>
      render(AnnotatedCodeBlock, {
        block: { type: "annotated-code", id: "ac4", filename: "src/absent.ts" },
      }),
    ).not.toThrow();
  });
});
