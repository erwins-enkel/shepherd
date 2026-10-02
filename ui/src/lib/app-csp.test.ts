import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../svelte.config.js";

const directives: Record<string, string[]> = config.kit.csp.directives;
const appHtml = readFileSync(new URL("../app.html", import.meta.url), "utf8");

describe("app CSP (svelte.config.js)", () => {
  it("is hash-mode (the app is prerendered, so there is no per-request nonce)", () => {
    expect(config.kit.csp.mode).toBe("hash");
  });

  it("hashes every inline <script> in app.html", () => {
    // The hash regex only understands attribute-less inline scripts. A `<script type=…>` or
    // `<script src=…>` added to app.html would be invisible to it, so fail loudly instead.
    expect(appHtml.match(/<script\b/g)?.length).toBe(appHtml.match(/<script>/g)?.length);
    const bodies = [...appHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) => body);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const hash = `sha256-${createHash("sha256").update(body).digest("base64")}`;
      expect(directives["script-src"]).toContain(hash);
    }
  });

  it("allows the Google Fonts hosts app.html links to", () => {
    expect(appHtml).toContain("https://fonts.googleapis.com/");
    expect(directives["style-src"]).toContain("https://fonts.googleapis.com");
    expect(directives["font-src"]).toContain("https://fonts.gstatic.com");
  });

  it("keeps the backstop tight where it matters", () => {
    expect(directives["script-src"]).not.toContain("unsafe-eval");
    expect(directives["script-src"]).not.toContain("unsafe-inline");
    // Passive loads (the beacon this CSP exists to stop) stay same-origin / inline only.
    expect(directives["img-src"]).toEqual(["self", "data:", "blob:"]);
    expect(directives["object-src"]).toEqual(["none"]);
    expect(directives["form-action"]).toEqual(["self"]);
    expect(directives["base-uri"]).toEqual(["self"]);
  });
});
