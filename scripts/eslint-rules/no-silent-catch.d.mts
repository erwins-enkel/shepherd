// Types for the local ESLint rule (scripts/eslint-rules/no-silent-catch.mjs). The rule stays
// plain .mjs so eslint.config.js (run by node) imports it without a build step; this
// declaration only exists so its TypeScript importer — test/eslint-no-silent-catch.test.ts —
// gets real types instead of `any`.
import type { Rule } from "eslint";

declare const rule: Rule.RuleModule;
export default rule;
