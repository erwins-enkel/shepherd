import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import ts from "typescript-eslint";
import rule from "../scripts/eslint-rules/no-silent-catch.mjs";

// RuleTester drives its cases through describe/it; hand it bun:test's.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: ts.parser } });

tester.run("no-silent-catch", rule, {
  valid: [
    "try { f(); } catch { /* best-effort: probe only */ }",
    "try { f(); } catch (e) {\n  // best-effort: cleanup; caller already failed\n}",
    "try { f(); } catch (e) { log(e); }",
    "try { f(); } catch { return null; }",
    "p.catch(() => null); // best-effort: optional enrichment",
    "p.catch(() => { /* best-effort: fire-and-forget */ });",
    "p.catch(() => /* best-effort: absent is fine */ undefined);",
    "// best-effort: warm-up only\np.catch(() => {});",
    "const x = await p\n  // best-effort: optional\n  .catch(() => null);",
    "p.catch((e) => log(e));",
    "p.catch(() => []);",
    'p.catch(() => "");',
    "p.catch(noop);",
    'p["catch"](() => null);',
    "p.then(ok, () => null);",
  ],
  invalid: [
    { code: "try { f(); } catch {}", errors: [{ messageId: "emptyCatch" }] },
    { code: "try { f(); } catch { /* ignore */ }", errors: [{ messageId: "emptyCatch" }] },
    {
      code: "try { f(); } catch (e) {\n  // best-effort\n}",
      errors: [{ messageId: "emptyCatch" }],
    },
    {
      code: "try { f(); } catch {\n  // best-effort:\n}",
      errors: [{ messageId: "emptyCatch" }],
    },
    { code: "p.catch(() => {});", errors: [{ messageId: "emptyHandler" }] },
    { code: "p.catch((e) => {});", errors: [{ messageId: "emptyHandler" }] },
    { code: "p.catch(() => { /* nope */ });", errors: [{ messageId: "emptyHandler" }] },
    { code: "p.catch(function () {});", errors: [{ messageId: "emptyHandler" }] },
    { code: "p.catch(() => null);", errors: [{ messageId: "sentinel" }] },
    { code: "p.catch(() => undefined);", errors: [{ messageId: "sentinel" }] },
    { code: "p.catch(() => void 0);", errors: [{ messageId: "sentinel" }] },
    { code: "p?.catch(() => null);", errors: [{ messageId: "sentinel" }] },
    {
      // A marker two lines above does not count — only the line directly above.
      code: "// best-effort: stale\n\np.catch(() => null);",
      errors: [{ messageId: "sentinel" }],
    },
    {
      // A marker in a sibling catch does not cover this one.
      code: "a.catch(() => null);\nb.catch(() => { /* best-effort: x */ });",
      errors: [{ messageId: "sentinel" }],
    },
    {
      // A trailing comment on the previous statement's line is not a marker for this one.
      code: "f(); // best-effort: about f\np.catch(() => null);",
      errors: [{ messageId: "sentinel" }],
    },
  ],
});
