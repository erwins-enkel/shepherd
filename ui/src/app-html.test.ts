// app.html's inline boot recovery runs before any bundle loads, so it cannot import
// client-error.ts — it carries its own copy of the reload schedule. Keep the two in lockstep.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { RELOAD_COUNT_KEY, RELOAD_DELAYS_MS } from "#lib/client-error.js";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.html"), "utf8");

test("inline boot recovery shares client-error's key and schedule", () => {
  expect(html).toContain(`var KEY = "${RELOAD_COUNT_KEY}";`);
  expect(html).toContain(`var DELAYS_MS = [${RELOAD_DELAYS_MS.join(", ")}];`);
});

test("boot never waits on a third-party stylesheet", () => {
  expect(html).not.toContain("fonts.googleapis.com");
  expect(html).not.toContain("fonts.gstatic.com");
});

test("boot shell id matches what +layout.svelte removes", () => {
  const layout = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "routes", "+layout.svelte"),
    "utf8",
  );
  expect(html).toContain('id="boot-shell"');
  expect(layout).toContain('getElementById("boot-shell")');
});
