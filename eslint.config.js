import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // .mjs files run under Node — needs Node globals
  {
    files: ["src/pty-attach.mjs", "test/fixtures/*.mjs"],
    languageOptions: { globals: globals.node },
  },
];
