import { describe, expect, test } from "bun:test";
import { parseProjectDocs, PROJECT_DOCS_MAX_FILES, safeDocPath } from "../src/project-docs";

describe("safeDocPath", () => {
  test("keeps plain relative paths", () => {
    expect(safeDocPath("prd.md")).toBe("prd.md");
    expect(safeDocPath("screens/home page.png")).toBe("screens/home page.png");
  });
  test("rejects traversal, absolute, backslash, control chars and .git", () => {
    for (const bad of [
      "",
      "../x",
      "a/../../x",
      "/etc/passwd",
      "a//b",
      "./a",
      "a\\b",
      "a\u0000b",
      ".git/config",
      "x/.GIT/hooks",
      Array(17).fill("a").join("/"),
    ])
      expect(safeDocPath(bad)).toBeNull();
  });
});

describe("parseProjectDocs", () => {
  const form = (entries: [string, File | string][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };

  test("reads prd and design files by their relative names", async () => {
    const r = await parseProjectDocs(
      form([
        ["project", "{}"],
        ["prd", new File(["# PRD"], "prd.md")],
        ["design", new File(["x"], "screens/a.png")],
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docs.map((d) => [d.area, d.relPath])).toEqual([
      ["prd", "prd.md"],
      ["design", "screens/a.png"],
    ]);
    expect(new TextDecoder().decode(r.docs[0]!.data)).toBe("# PRD");
  });

  test("a relative path survives the multipart round trip", async () => {
    const sent = new FormData();
    sent.append("design", new File(["x"], "a.png"), "screens/a.png");
    const got = await new Request("http://x/", { method: "POST", body: sent }).formData();
    const r = await parseProjectDocs(got);
    expect(r.ok && r.docs[0]?.relPath).toBe("screens/a.png");
  });

  test("a bad path or a non-file entry is rejected", async () => {
    expect(await parseProjectDocs(form([["prd", new File(["x"], "../x")]]))).toEqual({
      ok: false,
      error: "newproject_failed_docs",
    });
    expect(await parseProjectDocs(form([["design", "text"]]))).toEqual({
      ok: false,
      error: "newproject_failed_docs",
    });
  });

  test("over the file cap is rejected", async () => {
    const many = Array.from(
      { length: PROJECT_DOCS_MAX_FILES + 1 },
      (_, i) => ["design", new File(["x"], `f${i}.txt`)] as [string, File],
    );
    expect(await parseProjectDocs(form(many))).toEqual({
      ok: false,
      error: "newproject_failed_docs_size",
    });
  });
});
