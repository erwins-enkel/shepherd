import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { referencedIn, shepherdSources } from "../scripts/herdr-compat/consumers";

const src = (text: string, path = "src/x.ts") => [{ path, text }];

describe("referencedIn", () => {
  it("matches a double- or single-quoted literal of the exact name", () => {
    expect(referencedIn("pane.report_agent", src(`request("pane.report_agent", {})`))).toBe(true);
    expect(referencedIn("tab_list", src(`if (r.type === 'tab_list') {}`))).toBe(true);
  });

  it("does not match a prefix, a suffix or an unquoted mention", () => {
    const text = `request("pane.graphics.set_all"); // pane.graphics.set is gone; "xpane.graphics.set"`;
    expect(referencedIn("pane.graphics.set", src(text))).toBe(false);
  });

  it("treats the name literally, not as a regex", () => {
    expect(referencedIn("pane.run", src(`"paneXrun"`))).toBe(false);
  });
});

describe("shepherdSources", () => {
  const sources = shepherdSources(join(import.meta.dir, ".."));

  it("scans src/, scripts/ and deploy/ but never the vendored src/generated/", () => {
    const paths = sources.map((s) => s.path);
    expect(paths.some((p) => p.startsWith("src/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("scripts/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("deploy/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("src/generated/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("test/"))).toBe(false);
  });

  it("sees a method the socket driver really calls", () => {
    expect(referencedIn("pane.report_agent", sources)).toBe(true);
  });
});
