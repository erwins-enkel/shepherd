import type { Program } from "estree";
import { parseAst } from "vite";
import { describe, expect, it } from "vitest";
import { MessageSplitError, rewriteMessageImports } from "./paraglide-split";

const KEYS = new Set(["a", "b", "newtask_pr_review_template", "gloss_x", "gloss_y", "diag_z"]);
const opts = {
  isBarrel: (s: string) => /(^|\/)paraglide\/messages(\.js)?$/.test(s),
  messagePath: (k: string) => (KEYS.has(k) ? `/p/messages/${k}.js` : null),
  messageKeys: () => KEYS,
};

function run(code: string) {
  return rewriteMessageImports(code, parseAst(code) as unknown as Program, opts)?.code ?? null;
}

function fails(code: string): MessageSplitError {
  try {
    run(code);
  } catch (e) {
    expect(e).toBeInstanceOf(MessageSplitError);
    return e as MessageSplitError;
  }
  throw new Error("expected MessageSplitError");
}

describe("rewriteMessageImports", () => {
  it("rewrites m.key() to aliased per-message imports", () => {
    const out = run(
      `import { m } from "#lib/paraglide/messages.js";\nexport const x = [m.a(), m.b({ n: 1 }), m.a()];`,
    )!;
    expect(out).not.toContain("paraglide/messages.js");
    expect(out.match(/\/p\/messages\/a\.js/g)).toHaveLength(1);
    expect(out).toContain(`import { b as __pm_b } from "/p/messages/b.js";`);
    expect(out).toContain("[__pm_a(), __pm_b({ n: 1 }), __pm_a()]");
    expect(() => parseAst(out)).not.toThrow();
  });

  it("leaves shadowing locals alone", () => {
    const out = run(
      [
        `import { m } from "../paraglide/messages";`,
        `p.then((m) => m.x);`,
        `function f(m) { return m[1]; }`,
        `{ let m = re.exec(s); m?.[0]; }`,
        `try {} catch (m) { m.message; }`,
        `for (const m of xs) m.y;`,
        `const { m: q } = o;`,
        `m.a();`,
      ].join("\n"),
    )!;
    expect(out).toContain("p.then((m) => m.x)");
    expect(out).toContain("return m[1]");
    expect(out).toContain("m?.[0]");
    expect(out).toContain("m.message");
    expect(out).toContain("m.y");
    expect(out).toContain("__pm_a();");
  });

  it("rewrites references inside nested closures (svelte template effects)", () => {
    const out = run(
      `import { m } from "#lib/paraglide/messages.js";\nexport default function C(n) { $.template_effect(() => $.set_text(t, m.b())); }`,
    )!;
    expect(out).toContain("$.set_text(t, __pm_b())");
  });

  it("rewrites named barrel imports, keeping the local name", () => {
    const out = run(
      `import { newtask_pr_review_template, a as aa } from "#lib/paraglide/messages.js";\naa(newtask_pr_review_template());`,
    )!;
    expect(out).toContain(
      `import { newtask_pr_review_template as newtask_pr_review_template } from "/p/messages/newtask_pr_review_template.js";`,
    );
    expect(out).toContain(`import { a as aa } from "/p/messages/a.js";`);
  });

  it("inlines only the prefix family into keyedMessages(m, [...])", () => {
    const out = run(
      `import { m } from "#lib/paraglide/messages.js";\nexport const g = keyedMessages(m, ["gloss_"]);\nm.a();`,
    )!;
    expect(out).toContain(
      'keyedMessages({ gloss_x: __pm_gloss_x, gloss_y: __pm_gloss_y }, ["gloss_"])',
    );
    expect(out).toContain(`import { gloss_y as __pm_gloss_y } from "/p/messages/gloss_y.js";`);
    expect(out).not.toContain("diag_z");
    expect(() => parseAst(out)).not.toThrow();
  });

  it("returns null without a barrel import", () => {
    expect(run(`import { m } from "./other";\nm.a();`)).toBeNull();
    expect(run(`import { a } from "#lib/paraglide/messages/a.js";\na();`)).toBeNull();
  });

  it.each([
    ["computed access", `m[k]()`],
    ["bare value", `f(m)`],
    ["typeof", `typeof m`],
    ["shorthand property", `({ m })`],
    ["unknown key", `m.nope()`],
    ["keyedMessages without literal prefixes", `keyedMessages(m, prefixes)`],
    ["other callee", `lookup(m, ["gloss_"])`],
  ])("fails on %s", (_name, use) => {
    const code = `import { m } from "#lib/paraglide/messages.js";\n${use};`;
    expect(fails(code).pos).toBeGreaterThan(code.indexOf("\n"));
  });

  it.each([
    ["namespace import", `import * as all from "#lib/paraglide/messages.js";`],
    ["re-export", `export * from "#lib/paraglide/messages.js";`],
    ["named re-export", `export { m } from "#lib/paraglide/messages.js";`],
    ["unknown named import", `import { nope } from "#lib/paraglide/messages.js";`],
  ])("fails on %s", (_name, code) => {
    fails(code);
  });
});
