import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Lexical masking preserves newlines and code while skipping Swift nested comments,
// ordinary/multiline/raw strings. Imports inside conditional branches remain visible.
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          if (source[i] === "\n") out += "\n";
          i++;
        }
      }
      out += " ";
    } else {
      const string = /^(#*)("""|")/.exec(source.slice(i));
      if (string) {
        const hashes = string[1]!;
        const quote = string[2]!;
        const end = quote + hashes;
        i += string[0].length;
        while (i < source.length && !source.startsWith(end, i)) {
          if (source.startsWith("\\" + hashes, i)) i += 2 + hashes.length;
          else {
            if (source[i] === "\n") out += "\n";
            i++;
          }
        }
        i += end.length;
        out += " ";
      } else out += source[i++];
    }
  }
  return out;
}

export function forbiddenImports(source: string): string[] {
  return [
    ...codeOnly(source).matchAll(
      /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/g,
    ),
  ]
    .map((match) => match[1]!)
    .filter((name) => ["AppKit", "UIKit", "SwiftTerm", "Shepherd"].includes(name));
}
function swiftFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? swiftFiles(path) : path.endsWith(".swift") ? [path] : [];
  });
}
const root = join(import.meta.dir, "../..");
const core = join(root, "native/Sources/ShepherdAppCore");
describe("native app core boundary", () => {
  test("requires package product, target and test target", () => {
    const manifest = readFileSync(join(root, "native/Package.swift"), "utf8");
    expect(manifest).toMatch(/\.library\(name: "ShepherdAppCore"/);
    expect(manifest).toMatch(/\.target\(\s*name: "ShepherdAppCore"/);
    expect(manifest).toMatch(/\.testTarget\(\s*name: "ShepherdAppCoreTests"/);
    expect(swiftFiles(core).length).toBeGreaterThan(0);
  });
  test("rejects scoped and conditional platform imports", () => {
    expect(forbiddenImports("#if os(macOS)\nimport class AppKit.NSApplication\n#endif")).toEqual([
      "AppKit",
    ]);
    expect(forbiddenImports("// import AppKit\nimport SwiftUI")).toEqual([]);
    expect(
      forbiddenImports(
        '@preconcurrency import UIKit\nlet s = #"import Shepherd"#\n/* /* import SwiftTerm */ */',
      ),
    ).toEqual(["UIKit"]);
  });
  test("core sources contain no platform imports or view declarations", () => {
    const files = swiftFiles(core);
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      expect({ path, imports: forbiddenImports(source) }).toEqual({ path, imports: [] });
      expect(
        /\b(?:struct|class|enum|extension)\s+\w+[^{}]*:\s*[^{}]*\b(?:View|ViewModifier|App|Scene)\b/.test(
          codeOnly(source),
        ),
      ).toBe(false);
    }
  });
  test("moved model definitions are absent from the Mac source tree", () => {
    const source = swiftFiles(join(root, "native/Apps/ShepherdMac/Sources"))
      .map((path) => codeOnly(readFileSync(path, "utf8")))
      .join("\n");
    expect(
      /\b(?:class|struct|enum|protocol)\s+(?:AppModel|AppExtension|DetailModel|SidebarModel|NotificationsModel|ComposeModel|PlanModel|QueuesModel|MergeModel|SettingsModel|TerminalController|ProfileStore|DetailTabRegistry)\b/.test(
        source,
      ),
    ).toBe(false);
  });
});
