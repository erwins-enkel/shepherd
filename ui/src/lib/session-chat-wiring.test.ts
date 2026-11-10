import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// MarkdownBody resolves TASK references from the herd passed through Viewport → ChatView.
// Keep both page layouts connected: component-only tests cannot catch a missing page prop.
test("desktop and mobile session viewports receive the herd for chat links", () => {
  const page = readFileSync(new URL("../routes/+page.svelte", import.meta.url), "utf8");
  const viewports = [...page.matchAll(/<Viewport\s[\s\S]*?\/>/g)].map(([tag]) => tag);
  expect(viewports).toHaveLength(2);
  for (const viewport of viewports) {
    expect(viewport).toContain("herd={store.sessions}");
  }
});
