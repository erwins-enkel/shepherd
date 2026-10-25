import { describe, expect, it, vi } from "vitest";
import {
  docChips,
  docPath,
  docsOverCap,
  emptyDocs,
  filesFromDrop,
  isPrdFile,
  mergeDocs,
  pickedDocs,
  removeDocChip,
  sortDropped,
  walkDropEntry,
  type AttachedDoc,
  type AttachedDocs,
} from "./project-docs.js";

const f = (name: string, size = 1): File =>
  new File([new Uint8Array(size)], name.split("/").pop()!);
const doc = (path: string, folder: string | null = null, file = f(path)): AttachedDoc => ({
  file,
  path,
  folder,
});
/** A File that reports `size` without allocating it. */
const sized = (name: string, size: number): File =>
  Object.defineProperty(f(name, 0), "size", { value: size });

describe("docPath", () => {
  it("keeps a loose name", () => {
    expect(docPath("prd.md")).toEqual({ path: "prd.md", folder: null });
  });
  it("strips the top folder and reports it", () => {
    expect(docPath("export/a/b.png")).toEqual({ path: "a/b.png", folder: "export" });
  });
  it("rejects hidden and empty segments", () => {
    expect(docPath(".DS_Store")).toBeNull();
    expect(docPath("export/.git/x")).toBeNull();
    expect(docPath("a//b")).toBeNull();
  });
  it("rejects a folder with nothing under it", () => {
    expect(docPath("export/")).toBeNull();
  });
});

describe("isPrdFile", () => {
  it("accepts prd types case-insensitively", () => {
    for (const n of ["a.md", "a.MARKDOWN", "a.txt", "a.PDF"]) expect(isPrdFile(n)).toBe(true);
  });
  it("rejects the rest", () => {
    for (const n of ["a.png", "md", "prd.md.png"]) expect(isPrdFile(n)).toBe(false);
  });
});

describe("pickedDocs", () => {
  it("treats plain files as loose", () => {
    const a = f("a.md");
    expect(pickedDocs([a])).toEqual([{ file: a, path: "a.md", folder: null }]);
  });
  it("strips webkitRelativePath and skips hidden", () => {
    const a = Object.defineProperty(f("a.png"), "webkitRelativePath", { value: "export/a.png" });
    const h = Object.defineProperty(f(".DS_Store"), "webkitRelativePath", {
      value: "export/.DS_Store",
    });
    expect(pickedDocs([a, h])).toEqual([{ file: a, path: "a.png", folder: "export" }]);
  });
  it("handles null", () => {
    expect(pickedDocs(null)).toEqual([]);
  });
});

describe("sortDropped", () => {
  it("sorts by loose/folder and extension", () => {
    const out = sortDropped([
      { file: f("prd.md"), rel: "prd.md" },
      { file: f("spec.PDF"), rel: "spec.PDF" },
      { file: f("logo.png"), rel: "logo.png" },
      { file: f("readme.md"), rel: "export/readme.md" },
      { file: f(".DS_Store"), rel: ".DS_Store" },
    ]);
    expect(out.prd.map((d) => d.path)).toEqual(["prd.md", "spec.PDF"]);
    expect(out.design.map((d) => [d.path, d.folder])).toEqual([
      ["logo.png", null],
      ["readme.md", "export"],
    ]);
  });
});

const fileEntry = (name: string, fullPath: string) =>
  ({
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (ok: (x: File) => void) => ok(f(name)),
  }) as unknown as FileSystemEntry;

const dirEntry = (name: string, fullPath: string, batches: FileSystemEntry[][], err?: Error) => {
  const createReader = vi.fn(() => {
    let i = 0;
    return {
      readEntries: (ok: (b: FileSystemEntry[]) => void, bad: (e: Error) => void) => {
        if (err) bad(err);
        else ok(batches[i++] ?? []);
      },
    };
  });
  return { isFile: false, isDirectory: true, name, fullPath, createReader };
};

describe("walkDropEntry", () => {
  it("reads a file entry", async () => {
    const out = await walkDropEntry(fileEntry("a.md", "/a.md"));
    expect(out.map((d) => d.rel)).toEqual(["a.md"]);
  });
  it("drains every batch and recurses", async () => {
    const sub = dirEntry("screens", "/export/screens", [
      [fileEntry("c.png", "/export/screens/c.png")],
    ]);
    const root = dirEntry("export", "/export", [
      [fileEntry("a.png", "/export/a.png"), sub as unknown as FileSystemEntry],
      [fileEntry("b.png", "/export/b.png")],
    ]);
    const out = await walkDropEntry(root as unknown as FileSystemEntry);
    expect(out.map((d) => d.rel).sort()).toEqual([
      "export/a.png",
      "export/b.png",
      "export/screens/c.png",
    ]);
  });
  it("never descends into hidden entries", async () => {
    const hidden = dirEntry(".git", "/export/.git", [[fileEntry("x", "/export/.git/x")]]);
    const root = dirEntry("export", "/export", [
      [hidden as unknown as FileSystemEntry, fileEntry(".DS_Store", "/export/.DS_Store")],
    ]);
    const out = await walkDropEntry(root as unknown as FileSystemEntry);
    expect(out).toEqual([]);
    expect(hidden.createReader).not.toHaveBeenCalled();
  });
  it("rejects on a read error", async () => {
    const root = dirEntry("export", "/export", [], new Error("boom"));
    await expect(walkDropEntry(root as unknown as FileSystemEntry)).rejects.toThrow("boom");
  });
});

describe("filesFromDrop", () => {
  it("collects entries, falls back to getAsFile, ignores strings", async () => {
    const fallback = f("logo.png");
    const dt = {
      items: [
        { kind: "file", webkitGetAsEntry: () => fileEntry("a.md", "/a.md"), getAsFile: () => null },
        { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => fallback },
        { kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
      ],
    } as unknown as DataTransfer;
    const out = await filesFromDrop(dt);
    expect(out.map((d) => d.rel)).toEqual(["a.md", "logo.png"]);
    expect(out[1].file).toBe(fallback);
  });
  it("captures every entry before returning", async () => {
    let dead = false;
    const guard =
      <T>(v: T) =>
      () => {
        if (dead) throw new Error("DataTransfer item used after drop returned");
        return v;
      };
    const dt = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: guard(fileEntry("a.md", "/a.md")),
          getAsFile: guard(null),
        },
        { kind: "file", webkitGetAsEntry: guard(null), getAsFile: guard(f("b.png")) },
      ],
    } as unknown as DataTransfer;
    const p = filesFromDrop(dt);
    dead = true;
    expect((await p).map((d) => d.rel)).toEqual(["a.md", "b.png"]);
  });
});

describe("mergeDocs", () => {
  it("appends", () => {
    const out = mergeDocs({ prd: [doc("a.md")], design: [] }, { prd: [doc("b.md")], design: [] });
    expect(out.prd.map((d) => d.path)).toEqual(["a.md", "b.md"]);
  });
  it("replaces same path in same area; later wins, survivors first", () => {
    const old = doc("a.md");
    const keep = doc("k.md");
    const neu = doc("a.md");
    const out = mergeDocs({ prd: [old, keep], design: [] }, { prd: [neu], design: [] });
    expect(out.prd).toEqual([keep, neu]);
    expect(out.prd[1]).toBe(neu);
  });
  it("keeps same path in different areas", () => {
    const out = mergeDocs({ prd: [doc("a.md")], design: [] }, { prd: [], design: [doc("a.md")] });
    expect(out.prd).toHaveLength(1);
    expect(out.design).toHaveLength(1);
  });
  it("dedupes within the incoming batch", () => {
    const first = doc("a.png");
    const second = doc("a.png");
    const out = mergeDocs(emptyDocs(), { prd: [], design: [first, second] });
    expect(out.design).toHaveLength(1);
    expect(out.design[0]).toBe(second);
  });
});

describe("docChips", () => {
  it("makes one chip per prd file", () => {
    const chips = docChips({ prd: [doc("prd.md")], design: [] });
    expect(chips).toEqual([
      {
        area: "prd",
        key: chips[0].key,
        name: "prd.md",
        target: "docs/prd/prd.md",
        count: 1,
        folder: false,
      },
    ]);
  });
  it("collapses a folder into one chip", () => {
    const chips = docChips({
      prd: [],
      design: [doc("a.png", "export"), doc("s/b.png", "export"), doc("c.png", "export")],
    });
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      area: "design",
      name: "export",
      target: "docs/design/",
      count: 3,
      folder: true,
    });
  });
  it("gives loose design files their own chip, distinct from a same-named folder", () => {
    const chips = docChips({
      prd: [doc("p.md")],
      design: [doc("logo.png"), doc("x.png", "logo.png"), doc("y.png")],
    });
    expect(chips.map((c) => c.area)).toEqual(["prd", "design", "design", "design"]);
    expect(chips.slice(1).map((c) => c.name)).toEqual(["logo.png", "logo.png", "y.png"]);
    expect(new Set(chips.slice(1).map((c) => c.key)).size).toBe(3);
  });
});

describe("removeDocChip", () => {
  const docs: AttachedDocs = {
    prd: [doc("p.md"), doc("q.md")],
    design: [
      doc("a.png", "export"),
      doc("b.png", "export"),
      doc("logo.png"),
      doc("c.png", "other"),
    ],
  };
  it("removes a folder's files only", () => {
    const chip = docChips(docs).find((c) => c.folder && c.name === "export")!;
    const out = removeDocChip(docs, chip);
    expect(out.design.map((d) => d.path)).toEqual(["logo.png", "c.png"]);
    expect(out.prd).toHaveLength(2);
  });
  it("removes a prd file", () => {
    const chip = docChips(docs).find((c) => c.name === "p.md")!;
    expect(removeDocChip(docs, chip).prd.map((d) => d.path)).toEqual(["q.md"]);
  });
  it("removes a loose design file", () => {
    const chip = docChips(docs).find((c) => c.name === "logo.png")!;
    expect(removeDocChip(docs, chip).design.map((d) => d.path)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
  });
});

describe("docsOverCap", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => doc(`f${i}.png`));
  it("allows 500 files, rejects 501 across areas", () => {
    expect(docsOverCap({ prd: many(200), design: many(300) })).toBe(false);
    expect(docsOverCap({ prd: many(200), design: many(301) })).toBe(true);
  });
  it("caps total bytes at 50 MiB across areas", () => {
    const MiB = 1024 * 1024;
    const at = {
      prd: [doc("a.md", null, sized("a.md", 20 * MiB))],
      design: [doc("b.png", null, sized("b.png", 30 * MiB))],
    };
    expect(docsOverCap(at)).toBe(false);
    const over = { prd: at.prd, design: [doc("b.png", null, sized("b.png", 30 * MiB + 1))] };
    expect(docsOverCap(over)).toBe(true);
  });
});
