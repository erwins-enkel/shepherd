import { describe, it, expect } from "vitest";
import { collapsePath, pathParts } from "./diff-path";

describe("collapsePath", () => {
  it("collapses a long, deep path to root + immediate parent, keeping the filename whole", () => {
    expect(collapsePath("ui/src/lib/components/viewport/FilesPanel.svelte")).toEqual({
      dir: "ui/…/viewport/",
      name: "FilesPanel.svelte",
    });
    expect(
      collapsePath("ui/src/lib/feature-announcements/entries/v1.44.0-files-created-column.ts"),
    ).toEqual({ dir: "ui/…/entries/", name: "v1.44.0-files-created-column.ts" });
  });

  it("passes through a short path (single directory segment)", () => {
    expect(collapsePath("src/fs-browse.ts")).toEqual({ dir: "src/", name: "fs-browse.ts" });
  });

  it("does not collapse a shallow path (two directory segments)", () => {
    expect(collapsePath("ui/messages/de.json")).toEqual({ dir: "ui/messages/", name: "de.json" });
  });

  it("returns an empty dir for a top-level file (no slash)", () => {
    expect(collapsePath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("pathParts", () => {
  it("returns a single collapsed part for a normal file", () => {
    expect(pathParts({ path: "src/fs-browse.ts", status: "modified" })).toEqual([
      { dir: "src/", name: "fs-browse.ts" },
    ]);
  });

  it("returns two collapsed parts (old → new) for a rename, collapsing both sides", () => {
    expect(
      pathParts({
        status: "renamed",
        oldPath: "ui/src/lib/old/nested/Old.ts",
        path: "ui/src/lib/new/Renamed.ts",
      }),
    ).toEqual([
      { dir: "ui/…/nested/", name: "Old.ts" },
      { dir: "ui/…/new/", name: "Renamed.ts" },
    ]);
  });

  it("ignores oldPath when status is not renamed", () => {
    expect(pathParts({ path: "a/b/c/d.ts", oldPath: "x/y.ts", status: "modified" })).toEqual([
      { dir: "a/…/c/", name: "d.ts" },
    ]);
  });
});
