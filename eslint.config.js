import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // pty-attach.mjs runs under Node — needs Node globals
  {
    files: ["src/pty-attach.mjs"],
    languageOptions: { globals: globals.node },
  },
];
