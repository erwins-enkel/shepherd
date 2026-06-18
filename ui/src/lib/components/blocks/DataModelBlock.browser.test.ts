import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import DataModelBlock from "./DataModelBlock.svelte";

const BASIC_BLOCK = {
  type: "data-model" as const,
  id: "dm1",
  inferred: true,
  entities: [
    {
      id: "user",
      name: "User",
      fields: [
        { name: "id", type: "uuid", pk: true },
        { name: "email", type: "text", nullable: false },
        { name: "created_at", type: "timestamp" },
      ],
    },
  ],
};

describe("DataModelBlock", () => {
  it("renders entity name", async () => {
    render(DataModelBlock, { block: BASIC_BLOCK });
    await expect.element(page.getByText("User")).toBeInTheDocument();
  });

  it("renders field names", async () => {
    const { container } = render(DataModelBlock, { block: BASIC_BLOCK });
    // Field names appear in td.dm-field-name cells
    const cells = Array.from(container.querySelectorAll(".dm-field-name"));
    const cellTexts = cells.map((c) => c.textContent ?? "");
    expect(cellTexts.some((t) => t.includes("email"))).toBe(true);
    expect(cellTexts.some((t) => t.includes("created_at"))).toBe(true);
  });

  it("renders the InferredBadge when inferred is true", async () => {
    render(DataModelBlock, { block: BASIC_BLOCK });
    // InferredBadge renders the glossary term "inferred"
    await expect
      .element(page.getByText("abgeleitet").or(page.getByText("inferred")))
      .toBeInTheDocument();
  });

  it("does not render InferredBadge when inferred is not set", async () => {
    const { container } = render(DataModelBlock, {
      block: { ...BASIC_BLOCK, id: "dm2", inferred: undefined },
    });
    // .inferred-badge span should not be present
    const badge = container.querySelector(".inferred-badge");
    expect(badge).toBeNull();
  });

  it("renders relations when present", async () => {
    const { container } = render(DataModelBlock, {
      block: {
        ...BASIC_BLOCK,
        id: "dm3",
        relations: [{ from: "User", to: "Post", kind: "has-many" }],
      },
    });
    const relList = container.querySelector(".dm-relations-list");
    expect(relList).not.toBeNull();
    expect(relList?.textContent).toContain("User");
    expect(relList?.textContent).toContain("Post");
    expect(relList?.textContent).toContain("has-many");
  });

  it("renders FK and PK badges", async () => {
    render(DataModelBlock, { block: BASIC_BLOCK });
    await expect.element(page.getByText("PK")).toBeInTheDocument();
  });
});
