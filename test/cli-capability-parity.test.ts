import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES } from "../src/remote-instances/capabilities";

// `shepherd new --require` (#3527) warns about a capability outside the vocabulary it embeds. The
// server's CAPABILITIES is the source of truth; a stale copy would warn about a valid value.
const CONTROL = join(import.meta.dir, "..", "cli", "src", "commands", "control.rs");

test("the CLI's CAPABILITIES matches the server vocabulary", () => {
  const source = readFileSync(CONTROL, "utf8");
  const list = /const CAPABILITIES: &\[&str\] = &\[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const copy = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(copy).toEqual([...CAPABILITIES]);
});
