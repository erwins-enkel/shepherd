import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Compare the type, not `rg -n` output: paths/line numbers hide duplicate declarations.
function conformances(source: string): string[] {
  return [...source.matchAll(/extension\s+([\w.]+)\s*:\s*OpenEnum\s*\{/g)].map((match) =>
    match[1]!.replace(/^Components\.Schemas\./, ""),
  );
}

function swiftFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? swiftFiles(path) : path.endsWith(".swift") ? [path] : [];
  });
}

test("native OpenEnum conformances are declared exactly once across streams", () => {
  const root = join(import.meta.dir, "../..");
  const owners = new Map<string, string[]>();
  for (const directory of ["native/Sources", "native/Apps"]) {
    for (const path of swiftFiles(join(root, directory))) {
      for (const type of conformances(readFileSync(path, "utf8"))) {
        owners.set(type, [...(owners.get(type) ?? []), path]);
      }
    }
  }
  expect(owners.size).toBeGreaterThan(0);
  expect([...owners].filter(([, paths]) => paths.length > 1)).toEqual([]);
});

test("the conformance guard normalizes qualified and aliased schema names", () => {
  expect(
    conformances(
      "extension Components.Schemas.PrHandoff: OpenEnum {}\nextension PrHandoff: OpenEnum {}",
    ),
  ).toEqual(["PrHandoff", "PrHandoff"]);
});
