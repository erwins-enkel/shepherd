import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import CodeBlock from "./CodeBlock.svelte";

describe("CodeBlock", () => {
  it("renders the filename in the header", async () => {
    render(CodeBlock, {
      block: { type: "code", id: "c1", filename: "src/index.ts", code: "const x = 1;" },
    });
    await expect.element(page.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("renders the truncated label when truncated is true and no code", async () => {
    render(CodeBlock, {
      block: { type: "code", id: "c2", filename: "src/big.ts", truncated: true },
    });
    // header filename still shown
    await expect.element(page.getByText("src/big.ts")).toBeInTheDocument();
    // truncated label visible (appears in header and empty state)
    const truncatedEls = page.getByText("truncated");
    await expect.element(truncatedEls.first()).toBeInTheDocument();
  });

  it("renders without throwing when code is absent (grounded-out)", () => {
    expect(() =>
      render(CodeBlock, {
        block: { type: "code", id: "c3", filename: "src/missing.ts" },
      }),
    ).not.toThrow();
  });

  it("renders truncated label in header when truncated and code provided", async () => {
    render(CodeBlock, {
      block: {
        type: "code",
        id: "c4",
        filename: "src/long.ts",
        code: "const a = 1;",
        truncated: true,
      },
    });
    await expect.element(page.getByText("src/long.ts")).toBeInTheDocument();
    await expect.element(page.getByText("truncated")).toBeInTheDocument();
  });
});
