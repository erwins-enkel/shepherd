import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import ApiEndpointBlock from "./ApiEndpointBlock.svelte";

const BASIC_BLOCK = {
  type: "api-endpoint" as const,
  id: "ae1",
  method: "GET",
  path: "/api/users",
  inferred: true,
  summary: "List all users",
};

describe("ApiEndpointBlock", () => {
  it("renders the HTTP method", async () => {
    render(ApiEndpointBlock, { block: BASIC_BLOCK });
    await expect.element(page.getByText("GET")).toBeInTheDocument();
  });

  it("renders the path", async () => {
    render(ApiEndpointBlock, { block: BASIC_BLOCK });
    await expect.element(page.getByText("/api/users")).toBeInTheDocument();
  });

  it("renders the summary", async () => {
    render(ApiEndpointBlock, { block: BASIC_BLOCK });
    await expect.element(page.getByText("List all users")).toBeInTheDocument();
  });

  it("renders the InferredBadge when inferred is true", async () => {
    render(ApiEndpointBlock, { block: BASIC_BLOCK });
    await expect
      .element(page.getByText("abgeleitet").or(page.getByText("inferred")))
      .toBeInTheDocument();
  });

  it("renders params section when params present", async () => {
    render(ApiEndpointBlock, {
      block: {
        ...BASIC_BLOCK,
        id: "ae2",
        params: [{ name: "limit", in: "query", type: "integer", required: true }],
      },
    });
    await expect.element(page.getByText("limit")).toBeInTheDocument();
    await expect.element(page.getByText("query")).toBeInTheDocument();
  });

  it("renders responses section when responses present", async () => {
    render(ApiEndpointBlock, {
      block: {
        ...BASIC_BLOCK,
        id: "ae3",
        responses: [{ status: 200, description: "OK" }],
      },
    });
    await expect.element(page.getByText("200")).toBeInTheDocument();
    await expect.element(page.getByText("OK")).toBeInTheDocument();
  });

  it("renders deprecated label when deprecated is true", async () => {
    render(ApiEndpointBlock, {
      block: { ...BASIC_BLOCK, id: "ae4", deprecated: true },
    });
    await expect
      .element(page.getByText("deprecated").or(page.getByText("veraltet")))
      .toBeInTheDocument();
  });
});
