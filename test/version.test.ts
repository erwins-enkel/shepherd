import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHEPHERD_VERSION } from "../src/version";

test("SHEPHERD_VERSION equals package.json version", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  expect(SHEPHERD_VERSION).toBe(pkg.version);
  expect(SHEPHERD_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
