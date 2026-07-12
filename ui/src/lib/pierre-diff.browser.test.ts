import { describe, it, expect } from "vitest";
import { registerShepherdThemes, parseFilePatch } from "./pierre-diff";

// BROWSER project: exercises the lazy `@pierre/diffs` runtime path, which
// needs a real DOM (custom-element registration etc).

const SAMPLE_PATCH = `diff --git a/src/greet.ts b/src/greet.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/greet.ts
@@ -0,0 +1,2 @@
+export function greet(): string {
+  return "hello";
+}
`;

describe("registerShepherdThemes", () => {
  it("resolves without throwing", async () => {
    await expect(registerShepherdThemes()).resolves.toBeUndefined();
  });

  it("is idempotent (safe to call twice)", async () => {
    await registerShepherdThemes();
    await expect(registerShepherdThemes()).resolves.toBeUndefined();
  });
});

describe("parseFilePatch", () => {
  it("parses a small one-file unified diff into non-null metadata matching the patch's path", async () => {
    const file = await parseFilePatch(SAMPLE_PATCH);
    expect(file).not.toBeNull();
    expect(file?.name).toBe("src/greet.ts");
  });
});
