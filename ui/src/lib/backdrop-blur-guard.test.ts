// A panel inside a `backdrop-filter` host vanishes with it when Chrome on macOS drops that layer
// for a frame. Blocking backdrops get their blur from the `.scrim`/`.overlay` recipe in app.css,
// which keeps it on a stable `::before`; see rule 5 in .claude/rules/ui-design-system.md.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set([
  "lib/components/automation-settings/ScheduleDialog.svelte", // ::backdrop has no children
  "lib/components/viewport/ViewportTermBanners.svelte", // small strips, not full-window backdrops
  "routes/design-system/+page.svelte", // recipe docs and demo
]);

function* svelteFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* svelteFiles(p);
    else if (e.name.endsWith(".svelte")) yield p;
  }
}

test("no component sets backdrop-filter on its own", () => {
  const offenders = [...svelteFiles(src)]
    .filter((file) => /^\s*(-webkit-)?backdrop-filter\s*:/m.test(readFileSync(file, "utf8")))
    .map((file) => relative(src, file).replaceAll("\\", "/"))
    .filter((file) => !ALLOWED.has(file));
  expect(offenders).toEqual([]);
});
