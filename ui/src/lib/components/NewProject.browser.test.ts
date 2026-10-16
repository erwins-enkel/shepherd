import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import NewProject from "./NewProject.svelte";
import { m } from "#lib/paraglide/messages.js";

const ENTRY = { name: "demo", path: "/r/demo", display: "~/r/demo", realPath: "/r/demo" };

function mockApi() {
  const posts: { body: BodyInit | null | undefined; type: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).startsWith("/api/projects")) {
      posts.push({
        body: init?.body,
        type: new Headers(init?.headers).get("content-type"),
      });
      return new Response(JSON.stringify(ENTRY), { status: 201 });
    }
    return new Response(JSON.stringify({ commands: [] }), { status: 200 });
  });
  return posts;
}

afterEach(() => vi.restoreAllMocks());

describe("NewProject bootstrap kickoff (#3112)", () => {
  it("offers the PRD + design import and hands back the bootstrap kickoff", async () => {
    const posts = mockApi();
    const ondone = vi.fn();
    render(NewProject, { ondone });
    await page.getByLabelText(m.newproject_name_label()).fill("demo");
    await expect
      .element(page.getByLabelText(m.newproject_docs_prd_label()))
      .not.toBeInTheDocument();
    await page.getByLabelText(m.newproject_kickoff_label()).selectOptions("__bootstrap__");
    await expect.element(page.getByLabelText(m.newproject_docs_prd_label())).toBeVisible();
    await expect.element(page.getByLabelText(m.newproject_docs_design_label())).toBeVisible();
    await page.getByRole("button", { name: m.newproject_submit() }).click();
    await vi.waitFor(() => expect(ondone).toHaveBeenCalled());
    expect(ondone.mock.calls[0]![1]).toEqual({ kind: "bootstrap" });
    // No files picked → the plain JSON create.
    expect(posts[0]?.type).toBe("application/json");
  });

  it("sends picked PRD files as multipart with their docs path", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await page.getByLabelText(m.newproject_name_label()).fill("demo");
    await page.getByLabelText(m.newproject_kickoff_label()).selectOptions("__bootstrap__");
    await page
      .getByLabelText(m.newproject_docs_prd_label())
      .upload(new File(["# PRD"], "prd.md", { type: "text/markdown" }));
    await expect
      .element(page.getByText(m.newproject_docs_hint({ prd: 1, design: 0 })))
      .toBeVisible();
    await page.getByRole("button", { name: m.newproject_submit() }).click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    const fd = posts[0]!.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(JSON.parse(String(fd.get("project")))).toMatchObject({ name: "demo" });
    expect((fd.get("prd") as File).name).toBe("prd.md");
  });
});

describe("NewProject idea length", () => {
  it("blocks an idea over the server's 8000-char limit before sending", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await page.getByLabelText(m.newproject_name_label()).fill("demo");
    await page.getByLabelText(m.newproject_idea_label()).fill("x".repeat(8001));
    await expect
      .element(page.getByText(m.newproject_idea_count({ count: 8001, max: 8000 })))
      .toBeVisible();
    await expect
      .element(page.getByText(m.newproject_failed_idea_too_long({ max: 8000 })))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: m.newproject_submit() })).toBeDisabled();
    expect(posts.length).toBe(0);
  });

  it("names the cause when the server rejects the idea as too long", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("/api/projects"))
        return new Response(JSON.stringify({ error: "newproject_failed_idea_too_long" }), {
          status: 400,
        });
      return new Response(JSON.stringify({ commands: [] }), { status: 200 });
    });
    render(NewProject, { ondone: vi.fn() });
    await page.getByLabelText(m.newproject_name_label()).fill("demo");
    await page.getByLabelText(m.newproject_idea_label()).fill("an idea");
    await page.getByRole("button", { name: m.newproject_submit() }).click();
    await expect
      .element(page.getByText(m.newproject_failed_idea_too_long({ max: 8000 })))
      .toBeVisible();
    await expect.element(page.getByText(m.newproject_failed_generic())).not.toBeInTheDocument();
  });
});
