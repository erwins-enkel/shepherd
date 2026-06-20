import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
      parserOptions: { parser: ts.parser, extraFileExtensions: [".svelte"] },
    },
  },
  { ignores: ["dist/", "src/lib/paraglide/", "scripts/"] },
];
