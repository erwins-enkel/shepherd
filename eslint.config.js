import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  ...svelte.configs.prettier,
  // Type-checked promise gate for the SERVER only (issue #1567). herdr's write surface is fully
  // async now, and `send` in particular colors a deep steer/reply cascade (sendSteerTo → reply →
  // PlanGate.resume / automerge / the routes). A dropped `await` in that cascade is invisible to
  // `tsc`: a floating promise silently reorders a steer, and `json(service.haltAll())` would
  // serialize a Promise as `{}` with no type error. These two rules are the durable enforcement.
  //
  // Scoped to `src/**/*.ts` on purpose: `projectService` needs a tsconfig per package, and the
  // root tsconfig covers server code only (ui/ + extension/ have their own). Widening this to ui/
  // means wiring the svelte parser project and eating a much slower lint; not worth it for the
  // surface this gate protects.
  //
  // Test files are excluded — they legitimately fire-and-forget. That exclusion has to be spelled
  // out: `src/**/*.ts` also matches the SIX colocated `*.test.ts` files under src/ (auth-url,
  // hold, hold-service, signoff, plugins/loader, plugins/gear-validate). Without the `ignores`
  // below, a floating promise would be an error in `src/hold.test.ts` but fine in
  // `test/hold.test.ts` — an arbitrary split that depends only on where the test happens to live.
  {
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  // Test code legitimately uses `any` for mocks / `as any` casts on test doubles; keep the
  // rule on for production but relax it for test files (incl. colocated *.test.ts under src/ & ui/src).
  {
    files: ["test/**/*", "**/*.test.ts", "**/*.spec.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // .mjs files run under Node — needs Node globals
  {
    files: ["src/pty-attach.mjs", "test/fixtures/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  // Svelte components live in ui/ and run in the browser
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      // __GIT_SHA__ / __APP_VERSION__ / __DEMO__ are injected at build time via ui/vite.config.ts `define`
      globals: {
        ...globals.browser,
        __GIT_SHA__: "readonly",
        __APP_VERSION__: "readonly",
        __DEMO__: "readonly",
      },
      parserOptions: {
        parser: ts.parser,
        extraFileExtensions: [".svelte"],
      },
    },
  },
  // marked + DOMPurify are heavy and are lazily imported by every consumer that renders
  // markdown. A single STATIC import hoists them into a shared chunk and silently
  // defeats all of them (Rollup: INEFFECTIVE_DYNAMIC_IMPORT) — that is what GitRail did
  // to seven other components.
  //
  // Scoped to ALL of ui/src, not just the Svelte files, because Rollup does not warn for
  // every static importer: a static import from a plain `ui/src/lib/*.ts` helper produces
  // NO warning at all, so scripts/check-ui-build.sh cannot see it (measured — see the
  // table in that script's header). For those files this rule is the ONLY gate.
  //
  // One block rather than the rule repeated per-glob, so there is a single definition to
  // keep correct.
  {
    files: ["ui/src/**/*"],
    rules: {
      // Dynamic `await import("marked")` is unaffected — both `paths` and `patterns`
      // only match static imports.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "marked",
              message:
                'Import dynamically — see SessionRecap.svelte: Promise.all([import("marked"), import("dompurify")]).',
            },
            {
              name: "dompurify",
              message:
                'Import dynamically — see SessionRecap.svelte: Promise.all([import("marked"), import("dompurify")]).',
            },
          ],
          // `paths` matches the exact specifier only, so it would miss a deep import
          // like "marked/lib/marked.esm.js" — precisely the path Rollup names in the
          // INEFFECTIVE_DYNAMIC_IMPORT warning this rule exists to prevent.
          patterns: ["marked/*", "dompurify/*"],
        },
      ],
    },
  },
  // Generated output — never lint
  {
    ignores: ["ui/.svelte-kit/", "ui/build/", "ui/dist/", "ui/src/lib/paraglide/"],
  },
];
