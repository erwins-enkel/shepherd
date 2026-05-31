import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  ...svelte.configs.prettier,
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // .mjs files run under Node — needs Node globals
  {
    files: ["src/pty-attach.mjs", "test/fixtures/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  // Svelte components live in ui/ and run in the browser
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      // __GIT_SHA__ is injected at build time via ui/vite.config.ts `define`
      globals: { ...globals.browser, __GIT_SHA__: "readonly" },
      parserOptions: {
        parser: ts.parser,
        extraFileExtensions: [".svelte"],
      },
    },
  },
  // Generated output — never lint
  {
    ignores: ["ui/.svelte-kit/", "ui/build/", "ui/dist/", "ui/src/lib/paraglide/"],
  },
];
