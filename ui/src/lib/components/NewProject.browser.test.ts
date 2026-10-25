import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import NewProject from "./NewProject.svelte";
import { m } from "#lib/paraglide/messages.js";
import { expectMinPx } from "#lib/test-support/geometry.js";

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

const prdMd = () => new File(["# PRD"], "prd.md", { type: "text/markdown" });

/** A file as a directory picker hands it over: `webkitRelativePath` starts at the picked folder. */
function folderFile(rel: string): File {
  const file = new File(["png"], rel.split("/").pop()!, { type: "image/png" });
  Object.defineProperty(file, "webkitRelativePath", { value: rel });
  return file;
}

function pick(selector: string, files: File[]) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
const pickPrd = (files: File[]) => pick('input[type="file"]:not([webkitdirectory])', files);
const pickDesign = (files: File[]) => pick('input[type="file"][webkitdirectory]', files);

const dialogEl = () => document.querySelector<HTMLFormElement>("form.card")!;
const chipList = () => page.getByRole("list", { name: m.newproject_docs_group() });
const submitButton = () => page.getByRole("button", { name: m.newproject_submit() });
const names = (fd: FormData, area: string) => (fd.getAll(area) as File[]).map((f) => f.name);

async function fillName() {
  await page.getByLabelText(m.newproject_name_label()).fill("demo");
}

async function submitForm(posts: { body: BodyInit | null | undefined }[]): Promise<FormData> {
  await submitButton().click();
  await vi.waitFor(() => expect(posts.length).toBe(1));
  const fd = posts[0]!.body as FormData;
  expect(fd).toBeInstanceOf(FormData);
  return fd;
}

async function openAdvanced(choice: string) {
  await page.getByText(m.newproject_advanced_summary({ choice })).click();
}

describe("NewProject attachments (#3420)", () => {
  it("shows the attach buttons up front and folds the kickoff under Advanced", async () => {
    mockApi();
    render(NewProject, { ondone: vi.fn() });
    await expect
      .element(page.getByRole("button", { name: m.newproject_attach_prd() }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.newproject_attach_design() }))
      .toBeVisible();
    await expect.element(page.getByLabelText(m.newproject_kickoff_label())).not.toBeVisible();
  });

  it("defaults to the bootstrap kickoff with a plain JSON create", async () => {
    const posts = mockApi();
    const ondone = vi.fn();
    render(NewProject, { ondone });
    await fillName();
    await submitButton().click();
    await vi.waitFor(() => expect(ondone).toHaveBeenCalled());
    expect(ondone.mock.calls[0]![1]).toEqual({ kind: "bootstrap" });
    expect(posts[0]?.type).toBe("application/json");
  });

  it("shows no attachment summary or bootstrap note without attachments", async () => {
    mockApi();
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    await expect.element(page.getByText(m.newproject_idea_label())).toBeVisible();
    await expect
      .element(page.getByText(m.newproject_docs_summary({ prd: 0, design: 0 })))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText(m.newproject_docs_bootstrap_note()))
      .not.toBeInTheDocument();
    await expect.element(chipList()).not.toBeInTheDocument();
  });

  it("lists a picked PRD as a chip and sends it as multipart", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    pickPrd([prdMd()]);
    await expect.element(chipList().getByText("prd.md", { exact: true })).toBeVisible();
    await expect.element(chipList().getByText("→ docs/prd/prd.md", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(m.newproject_docs_summary({ prd: 1, design: 0 })))
      .toBeVisible();
    const fd = await submitForm(posts);
    expect(JSON.parse(String(fd.get("project")))).toMatchObject({ name: "demo" });
    expect(names(fd, "prd")).toEqual(["prd.md"]);
    expect(fd.getAll("design")).toEqual([]);
  });

  it("groups a picked design folder into one chip", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    pickDesign([folderFile("export/a.png"), folderFile("export/screens/b.png")]);
    await expect.element(chipList().getByText("export", { exact: true })).toBeVisible();
    await expect
      .element(
        chipList().getByText(m.newproject_doc_target_folder({ target: "docs/design/", count: 2 })),
      )
      .toBeVisible();
    expect(chipList().getByRole("listitem").elements()).toHaveLength(1);
    const fd = await submitForm(posts);
    expect(names(fd, "design")).toEqual(["a.png", "screens/b.png"]);
    expect(fd.getAll("prd")).toEqual([]);
  });

  it("removes a file with its chip's ✕", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    pickPrd([prdMd()]);
    await page
      .getByRole("button", { name: m.newproject_doc_remove_aria({ name: "prd.md" }) })
      .click();
    await expect.element(chipList()).not.toBeInTheDocument();
    await expect
      .element(page.getByText(m.newproject_docs_summary({ prd: 1, design: 0 })))
      .not.toBeInTheDocument();
    await submitButton().click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.type).toBe("application/json");
  });

  it("blocks both create buttons when the attachments exceed the server's caps", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    pickPrd(Array.from({ length: 501 }, (_, i) => new File(["x"], `f${i}.md`)));
    await expect.element(page.getByText(m.newproject_failed_docs_size())).toBeVisible();
    await expect.element(submitButton()).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: m.newproject_submit_customize() }))
      .toBeDisabled();
    // requestSubmit() bypasses the disabled button, so this hits the submit handler's own guard.
    dialogEl().requestSubmit();
    await new Promise((r) => setTimeout(r, 50));
    expect(posts.length).toBe(0);
  });
});

describe("NewProject drop target (#3420)", () => {
  it("sorts dropped files into PRD and design", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    const dt = new DataTransfer();
    dt.items.add(prdMd());
    dt.items.add(new File(["png"], "logo.png", { type: "image/png" }));
    dialogEl().dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    await expect.element(chipList().getByText("prd.md", { exact: true })).toBeVisible();
    await expect.element(chipList().getByText("logo.png", { exact: true })).toBeVisible();
    const fd = await submitForm(posts);
    expect(names(fd, "prd")).toEqual(["prd.md"]);
    expect(names(fd, "design")).toEqual(["logo.png"]);
  });

  it("ignores a drop while the create is in flight", async () => {
    let release: (r: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("/api/projects"))
        return new Promise<Response>((res) => (release = res));
      return new Response(JSON.stringify({ commands: [] }), { status: 200 });
    });
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    await submitButton().click();
    await expect.element(page.getByText(m.newproject_creating())).toBeVisible();
    const dt = new DataTransfer();
    dt.items.add(prdMd());
    const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    dialogEl().dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    await expect.element(page.getByText("prd.md", { exact: true })).not.toBeInTheDocument();
    release(new Response(JSON.stringify(ENTRY), { status: 201 }));
  });

  it("names a drop it could not read until a later drop succeeds", async () => {
    mockApi();
    const unreadable = {
      name: "prd.md",
      fullPath: "/prd.md",
      isFile: true,
      file: (_ok: unknown, bad: (e: Error) => void) => bad(new Error("gone")),
    } as unknown as FileSystemEntry;
    const entry = vi
      .spyOn(DataTransferItem.prototype, "webkitGetAsEntry")
      .mockReturnValue(unreadable);
    render(NewProject, { ondone: vi.fn() });
    const drop = () => {
      const dt = new DataTransfer();
      dt.items.add(prdMd());
      dialogEl().dispatchEvent(
        new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    };
    drop();
    await expect.element(page.getByText(m.newproject_drop_failed())).toBeVisible();
    await expect.element(chipList()).not.toBeInTheDocument();
    // No entry → the getAsFile() fallback reads it.
    entry.mockReturnValue(null);
    drop();
    await expect.element(chipList().getByText("prd.md", { exact: true })).toBeVisible();
    await expect.element(page.getByText(m.newproject_drop_failed())).not.toBeInTheDocument();
  });

  it("claims file drags only, so text still drops into the idea", async () => {
    mockApi();
    render(NewProject, { ondone: vi.fn() });
    const text = new DataTransfer();
    text.setData("text/plain", "x");
    const textOver = new DragEvent("dragover", {
      dataTransfer: text,
      bubbles: true,
      cancelable: true,
    });
    dialogEl().dispatchEvent(textOver);
    expect(textOver.defaultPrevented).toBe(false);
    expect(dialogEl().classList.contains("dragging")).toBe(false);

    const files = new DataTransfer();
    files.items.add(prdMd());
    const fileOver = new DragEvent("dragover", {
      dataTransfer: files,
      bubbles: true,
      cancelable: true,
    });
    dialogEl().dispatchEvent(fileOver);
    expect(fileOver.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(dialogEl().classList.contains("dragging")).toBe(true));
  });

  it("keeps the drag highlight inside the dialog and clears it when the drag leaves", async () => {
    mockApi();
    render(NewProject, { ondone: vi.fn() });
    const files = new DataTransfer();
    files.items.add(prdMd());
    const leave = (relatedTarget: EventTarget | null) =>
      dialogEl().dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget }));
    dialogEl().dispatchEvent(
      new DragEvent("dragover", { dataTransfer: files, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(dialogEl().classList.contains("dragging")).toBe(true));
    // Crossing onto a child (the idea field) is not leaving.
    leave(document.getElementById("np-idea"));
    await new Promise((r) => setTimeout(r, 50));
    expect(dialogEl().classList.contains("dragging")).toBe(true);
    leave(null);
    await vi.waitFor(() => expect(dialogEl().classList.contains("dragging")).toBe(false));
  });
});

describe("NewProject kickoff (#3420)", () => {
  it("notes the bootstrap start until another kickoff is picked under Advanced", async () => {
    const posts = mockApi();
    const ondone = vi.fn();
    render(NewProject, { ondone });
    await fillName();
    pickPrd([prdMd()]);
    await expect.element(page.getByText(m.newproject_docs_bootstrap_note())).toBeVisible();
    await openAdvanced(m.newproject_kickoff_bootstrap());
    await page.getByLabelText(m.newproject_kickoff_label()).selectOptions("__prd__");
    await expect
      .element(page.getByText(m.newproject_docs_bootstrap_note()))
      .not.toBeInTheDocument();
    await expect
      .element(
        page.getByText(m.newproject_advanced_summary({ choice: m.newproject_kickoff_prd() })),
      )
      .toBeVisible();
    const fd = await submitForm(posts);
    expect(ondone.mock.calls[0]![1]).toEqual({ kind: "prd", prdSupplied: true });
    // The PRD keeps its own name under docs/prd/ — no rename to PRD.md.
    expect(names(fd, "prd")).toEqual(["prd.md"]);
  });

  it("keeps an explicitly picked PRD brief when a PRD is attached afterwards", async () => {
    const posts = mockApi();
    const ondone = vi.fn();
    render(NewProject, { ondone });
    await fillName();
    await openAdvanced(m.newproject_kickoff_bootstrap());
    await page.getByLabelText(m.newproject_kickoff_label()).selectOptions("__prd__");
    pickPrd([prdMd()]);
    await expect.element(chipList().getByText("prd.md", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(m.newproject_docs_bootstrap_note()))
      .not.toBeInTheDocument();
    await expect
      .element(
        page.getByText(m.newproject_advanced_summary({ choice: m.newproject_kickoff_prd() })),
      )
      .toBeVisible();
    const fd = await submitForm(posts);
    expect(ondone.mock.calls[0]![1]).toEqual({ kind: "prd", prdSupplied: true });
    expect(names(fd, "prd")).toEqual(["prd.md"]);
  });

  it("hands back the plain PRD brief without attachments", async () => {
    const posts = mockApi();
    const ondone = vi.fn();
    render(NewProject, { ondone });
    await fillName();
    await openAdvanced(m.newproject_kickoff_bootstrap());
    await page.getByLabelText(m.newproject_kickoff_label()).selectOptions("__prd__");
    await submitButton().click();
    await vi.waitFor(() => expect(ondone).toHaveBeenCalled());
    expect(ondone.mock.calls[0]![1]).toEqual({ kind: "prd" });
    expect(posts[0]?.type).toBe("application/json");
  });
});

describe("NewProject start", () => {
  it("“Create & start” hands the first session over to start by itself", async () => {
    mockApi();
    const ondone = vi.fn();
    render(NewProject, { ondone });
    await fillName();
    await submitButton().click();
    await vi.waitFor(() => expect(ondone).toHaveBeenCalled());
    expect(ondone.mock.calls[0]![3]).toBe(false);
  });

  it("“Create & adjust before starting” creates the project but leaves the start to the operator", async () => {
    const posts = mockApi();
    const ondone = vi.fn();
    render(NewProject, { ondone });
    await fillName();
    await page.getByRole("button", { name: m.newproject_submit_customize() }).click();
    await vi.waitFor(() => expect(ondone).toHaveBeenCalled());
    expect(posts.length).toBe(1);
    expect(ondone.mock.calls[0]![1]).toEqual({ kind: "bootstrap" });
    expect(ondone.mock.calls[0]![3]).toBe(true);
  });

  it("blocks “Create & adjust before starting” while the name is missing", async () => {
    mockApi();
    render(NewProject, { ondone: vi.fn() });
    await expect
      .element(page.getByRole("button", { name: m.newproject_submit_customize() }))
      .toBeDisabled();
  });
});

describe("NewProject idea length", () => {
  it("blocks an idea over the server's 8000-char limit before sending", async () => {
    const posts = mockApi();
    render(NewProject, { ondone: vi.fn() });
    await fillName();
    await page.getByLabelText(m.newproject_idea_label()).fill("x".repeat(8001));
    await expect
      .element(page.getByText(m.newproject_idea_count({ count: 8001, max: 8000 })))
      .toBeVisible();
    await expect
      .element(page.getByText(m.newproject_failed_idea_too_long({ max: 8000 })))
      .toBeVisible();
    await expect.element(submitButton()).toBeDisabled();
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
    await fillName();
    await page.getByLabelText(m.newproject_idea_label()).fill("an idea");
    await submitButton().click();
    await expect
      .element(page.getByText(m.newproject_failed_idea_too_long({ max: 8000 })))
      .toBeVisible();
    await expect.element(page.getByText(m.newproject_failed_generic())).not.toBeInTheDocument();
  });
});

describe("NewProject mobile (#3420)", () => {
  // Back to vitest's default viewport for whatever runs after.
  afterEach(() => page.viewport(414, 896));

  it("keeps the attach toolbar and chips tappable and inside 375px", async () => {
    await page.viewport(375, 812);
    mockApi();
    render(NewProject, { ondone: vi.fn() });
    pickPrd([new File(["# PRD"], `${"very-long-product-requirements-".repeat(3)}.md`)]);
    pickDesign([folderFile("export/a.png")]);
    await expect.element(chipList()).toBeVisible();
    const card = dialogEl();
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    for (const name of [m.newproject_attach_prd(), m.newproject_attach_design()])
      expectMinPx(page.getByRole("button", { name }).element().getBoundingClientRect().height, 44);
    for (const x of chipList().getByRole("button").elements()) {
      const box = x.getBoundingClientRect();
      expectMinPx(box.width, 44, "chip ✕ width");
      expectMinPx(box.height, 44, "chip ✕ height");
    }
    expectMinPx(
      document.querySelector(".advanced summary")!.getBoundingClientRect().height,
      44,
      "advanced summary",
    );
  });
});
