import { describe, expect, it } from "vitest";
import { resolveRepo } from "../src/lib/routing";
import type { RoutingRule } from "../src/lib/types";

const rule = (pattern: string, repoPath: string): RoutingRule => ({ pattern, repoPath });

describe("resolveRepo", () => {
  it("matches an exact full URL", () => {
    const rules = [rule("https://github.com/acme/web", "~/Work/web")];
    expect(resolveRepo("https://github.com/acme/web", rules, "~/fallback")).toBe("~/Work/web");
  });

  it("matches with a `*` wildcard", () => {
    const rules = [rule("https://github.com/*", "~/Work/gh")];
    expect(resolveRepo("https://github.com/acme/web/issues/3", rules, "~/fallback")).toBe(
      "~/Work/gh",
    );
  });

  it("returns the first matching rule when several match", () => {
    const rules = [rule("https://github.com/*", "~/Work/first"), rule("*", "~/Work/second")];
    expect(resolveRepo("https://github.com/acme/web", rules, "~/fallback")).toBe("~/Work/first");
  });

  it("skips a rule with a blank pattern (or blank repo)", () => {
    const rules = [
      rule("   ", "~/Work/skipped"),
      rule("https://github.com/*", "   "),
      rule("https://github.com/*", "~/Work/kept"),
    ];
    expect(resolveRepo("https://github.com/acme/web", rules, "~/fallback")).toBe("~/Work/kept");
  });

  it("falls back when nothing matches", () => {
    const rules = [rule("https://gitlab.com/*", "~/Work/gl")];
    expect(resolveRepo("https://github.com/acme/web", rules, "~/fallback")).toBe("~/fallback");
  });

  it("matches case-insensitively", () => {
    const rules = [rule("https://GitHub.com/Acme/*", "~/Work/ci")];
    expect(resolveRepo("https://github.com/acme/web", rules, "~/fallback")).toBe("~/Work/ci");
  });

  it("does not let glob metacharacters in the URL bleed through (literal dots)", () => {
    // `.` in the pattern is literal, so a different char must not satisfy it.
    const rules = [rule("https://a.b/*", "~/Work/dot")];
    expect(resolveRepo("https://axb/whatever", rules, "~/fallback")).toBe("~/fallback");
  });

  it("falls back (does not throw) when `rules` is not an array", () => {
    // Corrupt/legacy storage can hand us a non-array; `for...of` would throw
    // "is not iterable" and crash the popup's effectiveRepo derived. Treat a
    // non-array as no rules and return the fallback instead.
    const bad = { 0: rule("*", "~/Work/x") } as unknown as RoutingRule[];
    expect(resolveRepo("https://github.com/acme/web", bad, "~/fallback")).toBe("~/fallback");
    expect(resolveRepo("https://x", null as unknown as RoutingRule[], "~/fallback")).toBe(
      "~/fallback",
    );
  });
});
