import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// #2102: Svelte does not sanitize `href`, so a `javascript:` URL from forge/API/plugin data would
// run on click. Every `href={…}` bound to a URL-ish field must go through `firstSafeHttpUrl`
// (lib/url.ts). This guard keeps new bindings from skipping it.

const SRC = join(import.meta.dirname, "..");

/** Bindings that are app-authored or already validated: `commitUrl` is REPO_URL + a build sha,
 *  `previewUrl` is built locally from the preview slot, `entry.ctaUrl` is the compiled feature
 *  catalog, `openPrUrl` (CriticBadge) is derived via firstSafeHttpUrl, and `seg.href` comes from
 *  textLinks' http(s)-only matcher. ALL_CAPS constants never match the pattern. */
const EXEMPT = new Set(["commitUrl", "previewUrl", "entry.ctaUrl", "openPrUrl", "seg.href"]);

/** A url-ish identifier or member: `url`, `pr.url`, `run.runUrl`, `plugin.repository`, `href`. */
const URLISH = /^(?:[\w$]+(?:\?)?\.)*(?:url|[a-z]\w*Url|repository|href)$/;

function svelteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "paraglide" ? [] : svelteFiles(p);
    return e.name.endsWith(".svelte") ? [p] : [];
  });
}

function unsafeHrefs(source: string): string[] {
  const hits: string[] = [];
  for (const [, raw] of source.matchAll(/\bhref=\{([^}]*)\}/g)) {
    const expr = raw!.trim().replace(/\s*\?\?\s*undefined$/, "");
    if (EXEMPT.has(expr)) continue;
    if (URLISH.test(expr)) hits.push(expr);
  }
  return hits;
}

describe("forge hrefs go through firstSafeHttpUrl (#2102)", () => {
  it("flags a raw url binding and accepts a validated one", () => {
    expect(unsafeHrefs("<a href={pr.url}>x</a><a href={c.prUrl ?? undefined}>y</a>")).toEqual([
      "pr.url",
      "c.prUrl",
    ]);
    expect(unsafeHrefs("<a href={firstSafeHttpUrl(pr.url) ?? undefined}>x</a>")).toEqual([]);
    expect(unsafeHrefs("<a href={REPO_URL}>x</a><a href={commitUrl}>y</a>")).toEqual([]);
  });

  it("no .svelte file binds a url-ish value to href unvalidated", () => {
    const offenders = svelteFiles(SRC).flatMap((f) =>
      unsafeHrefs(readFileSync(f, "utf8")).map((e) => `${relative(SRC, f)}: href={${e}}`),
    );
    expect(offenders).toEqual([]);
  });
});
