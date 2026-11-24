import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import ts from "typescript-eslint";
import rule from "../scripts/eslint-rules/no-detached-jsdoc.mjs";

// RuleTester drives its cases through describe/it; hand it bun:test's.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: ts.parser } });

tester.run("no-detached-jsdoc", rule, {
  valid: [
    "/** Doc. */\nfunction f() {}",
    "/** A. */\n// note\n/** B. */\nfunction f() {}",
    "/** Module header. */\n\n/** B. */\nfunction f() {}",
    "/* plain */\n/** B. */\nfunction f() {}",
    "/** A. */\nconst a = 1;\n/** B. */\nfunction f() {}",
    "class C {\n  /** A. */\n  a() {}\n  /** B. */\n  b() {}\n}",
  ],
  invalid: [
    {
      code: "/** Stranded. */\n/** B. */\nfunction f() {}",
      errors: [{ messageId: "detached", line: 1 }],
    },
    {
      code: "class C {\n  /** Stranded. */\n  /** B. */\n  b() {}\n}",
      errors: [{ messageId: "detached", line: 2 }],
    },
    {
      code: "/** A. */ /** B. */\nfunction f() {}",
      errors: [{ messageId: "detached", line: 1 }],
    },
    {
      code: "/** A. */\n/** B. */\n/** C. */\nfunction f() {}",
      errors: [
        { messageId: "detached", line: 1 },
        { messageId: "detached", line: 2 },
      ],
    },
  ],
});
