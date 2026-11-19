# OXC (oxlint + oxfmt) vs ESLint + Prettier in a Svelte 5 toolchain (2026-11-19)

**Question:** can a Svelte 5 / SvelteKit project that uses ESLint + Prettier move to oxlint and oxfmt today, fully or partly? What breaks? What does that mean for this repo?

**Verdict: partly.**

- **Formatter: yes, oxfmt can replace Prettier now.** It is still beta. It formats `.svelte` files by running the same `prettier-plugin-svelte` 4.1.1 we use, and it sorts Tailwind classes itself.
- **Linter: no.** oxlint lints only the `<script>` blocks of a `.svelte` file. It cannot load `svelte-eslint-parser`, so `eslint-plugin-svelte`'s template rules never run. `no-unused-vars` is switched off for `.svelte` files, and type-aware rules skip them too.
- **For this repo:**
  - Switching to oxfmt is optional and low-risk. It costs one reformat commit, about 86 files.
  - Keep ESLint.
  - Don't set up a hybrid oxlint + ESLint now. The speed gain is small next to our warm caches and delta-scoped pre-push, and the hybrid would bring two rule divergences that hit our own config (below).
  - Revisit oxlint when its "language plugins" ship.

Empirical results are marked **[tested]**. They come from a scratch copy of this repo under `~/.cache/shepherd/tmp/oxc-research/lab`, with oxlint 1.94.0, oxfmt 0.79.0, oxlint-tsgolint 7.0.2007, and the repo's own pinned versions of ESLint 10.15.0, eslint-plugin-svelte 3.24.1, Prettier 3.10.1, prettier-plugin-svelte 4.1.1, prettier-plugin-tailwindcss 0.8.1 and Svelte 5.57.3. The re-run against the ESLint config added in #4084/#4085 (custom rule, bulk-suppressions baseline, `no-restricted-syntax`) used a second scratch copy, `~/.cache/shepherd/tmp/oxc-research/lab2`, with the same tool versions. Everything else is documented fact.

## Versions and maturity

- **oxlint 1.94.0**, released 2026-11-16 ([npm](https://www.npmjs.com/package/oxlint), [release](https://github.com/oxc-project/oxc/releases/tag/oxlint_v1.94.0)).
  - **Stable** since v1.0 ([blog 2025-06-10](https://oxc.rs/blog/2025-06-10-oxlint-stable.html)).
  - Its **JS plugins are still alpha** ([docs](https://oxc.rs/docs/guide/usage/linter/js-plugins.html), [blog 2026-03-11](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha.html)).
  - **[tested]** It has about 870 built-in rules, 112 of them in the `typescript` plugin. There is no `svelte` plugin. A `vue` plugin exists, and it covers script-block rules only ([plugins](https://oxc.rs/docs/guide/usage/linter/plugins.html)).
- **Type-aware linting is stable** since 2026-07-22 with tsgolint v7, which is built on TypeScript 7 ([blog](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html)).
  - Current tsgolint: `oxlint-tsgolint` 7.0.2007 ([npm](https://www.npmjs.com/package/oxlint-tsgolint)).
  - It covers 60 of typescript-eslint's 62 type-aware rules ([docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)).
  - A second, Rust-based backend, `tsrs` (7.1.0-beta.tsrs3), was announced on 2026-11-17 ([blog](https://oxc.rs/blog/2026-11-17-faster-type-aware-linting-with-tsrs.html)).
- **oxfmt 0.79.0**, released 2026-11-16 ([npm](https://www.npmjs.com/package/oxfmt), [release](https://github.com/oxc-project/oxc/releases/tag/oxfmt_v0.79.0)).
  - **Beta** since 2026-02-24 ([blog](https://oxc.rs/blog/2026-02-24-oxfmt-beta.html)). No stable announcement yet.
- The migration tools ship in lockstep with oxlint: `@oxlint/migrate` 1.94.0 and `eslint-plugin-oxlint` 1.94.0 (npm).

## oxlint and `.svelte` files

- **Only the script is linted.** The docs say framework files (`.vue`, `.svelte`, `.astro`) are linted "by linting only their `<script>` blocks" ([linter docs](https://oxc.rs/docs/guide/usage/linter.html)). The compatibility matrix rates Svelte and SvelteKit as **partial: "No template linting yet"** ([compatibility](https://oxc.rs/compatibility), [source](https://github.com/oxc-project/website/blob/main/.vitepress/data/compat/oxlint.ts)).
- **`no-unused-vars` skips `.svelte` files entirely.** oxlint can't see whether the template uses a variable ([rule source](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rules/eslint/no_unused_vars/mod.rs), [#17991](https://github.com/oxc-project/oxc/issues/17991)).
- **JS plugins cannot load custom parsers.** The docs list "Custom file formats and parsers (e.g. Svelte, Vue, Angular)" as not supported yet ([js-plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)).
  - `context.languageOptions.parser` is still open. It "has been said to block Svelte community from migrating" ([#20373](https://github.com/oxc-project/oxc/issues/20373)).
  - `@oxlint/migrate` confirms that only some `eslint-plugin-svelte` rules work, and only on script blocks ([README](https://github.com/oxc-project/oxlint-migrate#caveats)).
- **The fix is "language plugins", and none of it has shipped.** It is specified in RFC [#21936](https://github.com/oxc-project/oxc/issues/21936) and tracked in umbrella [#23207](https://github.com/oxc-project/oxc/issues/23207). All six sub-issues are open, including [#23210](https://github.com/oxc-project/oxc/issues/23210) (virtual JS/TS with mapped diagnostics) and [#23211](https://github.com/oxc-project/oxc/issues/23211) (type-aware integration).
  - The 2026-03 blog promised framework formats "later this year" ([blog](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha.html)).
  - JS Plugins Milestone 3 still lists "Support custom template syntax" as unchecked ([#19918](https://github.com/oxc-project/oxc/issues/19918)).
- **[tested] Script-level `eslint-plugin-svelte` rules do run as a JS plugin.**
  - Same results as ESLint in `.svelte` and `.svelte.ts` files: `svelte/no-inspect`, `svelte/prefer-svelte-reactivity`, `no-debugger`, `prefer-const`.
  - The template rules ESLint caught in a probe component were silent under oxlint: `svelte/no-at-html-tags`, `require-each-key`, `no-at-debug-tags` and `no-unused-svelte-ignore`, plus `no-unused-vars`. oxlint reported 0 diagnostics where ESLint reported 7.
- **Open Svelte script-block bugs:** `{@html}` with `<script>` inside a template literal gets parsed as a script block ([#28888](https://github.com/oxc-project/oxc/issues/28888)). `import/unambiguous` fires on framework script blocks ([#29454](https://github.com/oxc-project/oxc/issues/29454)).

## typescript-eslint parity and type-aware linting

- **[tested] The presets map completely.** `@oxlint/migrate --type-aware` mapped all of our `js` + `typescript-eslint` + `svelte` recommended rules (124 rules in total). It skipped 4 core rules: `no-undef` and `no-useless-assignment` are nursery, and `no-dupe-args` and `no-octal` are superseded by strict mode.
  - Outside the presets, it skipped `no-restricted-syntax` as "Not yet in oxlint" and mis-mapped our local `shepherd/no-silent-catch` rule. See [Migration tooling](#migration-tooling).
- **Type-aware rules don't work in `.svelte` scripts.** The duplicates [oxc#19481](https://github.com/oxc-project/oxc/issues/19481) and [tsgolint#807](https://github.com/oxc-project/tsgolint/issues/807) both point to the open [tsgolint#322](https://github.com/oxc-project/tsgolint/issues/322). Language-plugin type-aware integration is [#23211](https://github.com/oxc-project/oxc/issues/23211).
  - `.svelte.ts` files are plain TS and are covered. One open false positive: `$state(false)` gets narrowed to the literal `false` inside `$derived` ([tsgolint#1344](https://github.com/oxc-project/tsgolint/issues/1344)).
- **TypeScript 7 rules apply.** Legacy options like `baseUrl` are unsupported ([docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)).
- **[tested]** With tsgolint, `typescript/no-floating-promises` caught a planted floating promise in `src/`, the same as ESLint.

## oxfmt and `.svelte` files

- **Svelte is "full" support, through Prettier.** The compatibility matrix says full, but requires installing `svelte` (for `svelte/compiler`) ([compatibility](https://oxc.rs/compatibility), [language support](https://oxc.rs/docs/guide/usage/formatter/language-support.html)).
  - `.svelte` is a "Prettier-backed" format. oxfmt bundles `prettier-plugin-svelte` and you enable it with `"svelte": true` or an object ([config reference](https://oxc.rs/docs/guide/usage/formatter/config-file-reference.html#svelte), [#19715](https://github.com/oxc-project/oxc/issues/19715)).
  - Markup and `<style>` go through that bundled Prettier path. The `<script>` blocks are formatted by oxc's native formatter instead ([language support](https://oxc.rs/docs/guide/usage/formatter/language-support.html)).
  - Bundled versions at the `oxfmt_v0.79.0` tag: `prettier` 3.10.1, `prettier-plugin-svelte` 4.1.1, and an insiders build of `prettier-plugin-tailwindcss` ([package.json](https://github.com/oxc-project/oxc/blob/oxfmt_v0.79.0/apps/oxfmt/package.json)).
  - A native Rust Svelte formatter is only an open stub ([#28266](https://github.com/oxc-project/oxc/issues/28266), opened 2026-10-28).
- **No arbitrary Prettier plugins.** "Prettier plugins: Not supported", but popular ones are built in ([unsupported features](https://oxc.rs/docs/guide/usage/formatter/unsupported-features.html), [#15665](https://github.com/oxc-project/oxc/issues/15665)). Built in:
  - Tailwind sorting (`sortTailwindcss`), which also sorts classes in Svelte templates ([sorting](https://oxc.rs/docs/guide/usage/formatter/sorting.html#sort-tailwind-css-classes), [#19715](https://github.com/oxc-project/oxc/issues/19715)).
  - Import sorting, `package.json` sorting and JSDoc formatting ([beyond Prettier](https://oxc.rs/docs/guide/usage/formatter/beyond-prettier.html)).
- **Parity with Prettier** ([conformance snapshots](https://github.com/oxc-project/oxc/tree/main/apps/oxfmt/conformance/snapshots)):
  - Svelte corpus: 79/79 (100%).
  - Prettier's own JS test suite: 92.2%. TS: 92.4%.
  - The gaps are partly deliberate and documented divergences ([DIVERGENCES.md](https://github.com/oxc-project/oxc/blob/main/crates/oxc_formatter/DIVERGENCES.md)). The docs pitch oxfmt as fixing "Prettier's bugs and inconsistencies" ([formatter](https://oxc.rs/docs/guide/usage/formatter.html)).
- **[tested] On this repo's Prettier-clean code:**
  - 524 of 528 `ui/src` `.svelte` files came out byte-identical, including markup, styles and Tailwind order.
  - 59 of 2,539 files in `ui/src` + `src` differed. All the differences were in JS/TS: 73 hunks, most of them long union types broken onto one member per line (divergence [`union-annotation-flat-retry`](https://github.com/oxc-project/oxc/blob/main/crates/oxc_formatter/DIVERGENCES.md#union-annotation-flat-retry)), plus `if (!(…))` re-parenthesized and `if (x) y(); // comment` joined onto one line.
  - Across the whole repo, 86 files differed:
    - 65 TS files and the same 4 Svelte files (script only);
    - 13 Markdown files (wrapped inline code in list items gets indented);
    - `cli/Cargo.toml` (oxfmt formats TOML and Prettier doesn't);
    - 2 HTML files and the generated config.

## Migration tooling

- **`oxfmt --migrate prettier`** ([docs](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier.html)) migrates `overrides` (a `parser` becomes `associations`), turns `.prettierignore` into `ignorePatterns`, and maps the options of the Svelte, Tailwind, Astro and packagejson plugins. Other plugins are skipped. It doesn't read nested configs or the `prettier` key in `package.json`.
  - **[tested]** On our `.prettierrc` it mapped every option cleanly: `tailwindStylesheet` became `sortTailwindcss.stylesheet`, it emitted `svelte: {}`, kept the `*.jsonc` override, and carried over all 34 ignore patterns, `eslint-suppressions.json` included.
- **`@oxlint/migrate`** ([docs](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.html), [repo](https://github.com/oxc-project/oxlint-migrate)) converts a flat config into `.oxlintrc.json` and keeps plugins it can't map as `jsPlugins`. **[tested]** On our root config it:
  - warned `special parser detected: svelte-eslint-parser` and `ignore list inside overrides is not supported`;
  - **silently dropped** the `ignores: ["**/*.test.ts"]` on the `src/**/*.ts` promise-gate block. The 6 colocated tests under `src/` would then be gated.
  - dropped `no-restricted-syntax` ("Not implemented"). Our `promisify(execFile)` ban (an esquery selector) has no oxlint equivalent. The ESLint core tracking issue lists the rule as unported ([#479](https://github.com/oxc-project/oxc/issues/479)).
  - turned the inline local plugin `shepherd/no-silent-catch` into `jsPlugins: ["eslint-plugin-shepherd"]`, a package that doesn't exist. It needs a hand-written wrapper module (`{ meta: { name: "shepherd" }, rules: { "no-silent-catch": rule } }`) referenced by path.
- **`eslint-plugin-oxlint`** switches off the ESLint rules that oxlint already covers ([README](https://github.com/oxc-project/eslint-plugin-oxlint)). For `.vue`, `.svelte` and `.astro` files it keeps `no-unused-vars`, `@typescript-eslint/no-unused-vars` and `consistent-type-imports` on in ESLint, because oxlint can't see templates ([constants.ts](https://github.com/oxc-project/eslint-plugin-oxlint/blob/main/src/constants.ts)).
- **The official hybrid is `oxlint && eslint`.** ESLint keeps the rules oxlint doesn't support, with `eslint-plugin-oxlint` last in the config ([docs](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint.html#running-oxlint-and-eslint-together)).
  - For Svelte, that leaves ESLint running `eslint-plugin-svelte` over every `.svelte` file. You keep the slow parser, so you keep most of ESLint's cost.

## Ecosystem signals

- **The Svelte CLI (`sv add`) still offers `eslint` and `prettier`. There is no oxlint or oxfmt add-on** ([addons dir](https://github.com/sveltejs/cli/tree/main/packages/sv/src/addons)).
  - An oxfmt add-on PR is open: [cli#1434](https://github.com/sveltejs/cli/pull/1434), for [cli#1420](https://github.com/sveltejs/cli/issues/1420). On 2026-11-12 a maintainer said oxfmt should **replace** Prettier as the official formatter, but "we will not merge it now, but when we are confident".
  - The `sv` repo itself formats with oxfmt (`svelte: true`) since [cli#1235](https://github.com/sveltejs/cli/pull/1235) (merged 2026-08-20), and **still lints with ESLint** ([package.json](https://github.com/sveltejs/cli/blob/main/package.json)).
- **The Svelte core repo wants oxlint but is blocked.** Rich Harris opened "migrate repo to oxlint" ([svelte#17665](https://github.com/sveltejs/svelte/issues/17665)), blocked on oxc [#20373](https://github.com/oxc-project/oxc/issues/20373), [#19918](https://github.com/oxc-project/oxc/issues/19918) and [#12018](https://github.com/oxc-project/oxc/issues/12018), all still open.
  - The Svelte team has no tooling-performance roadmap ([svelte#17798](https://github.com/sveltejs/svelte/issues/17798)).
  - A Svelte team member is building a Rust Svelte toolchain on top of oxc (`rsvelte`) and asking oxc for parser and semantic hooks ([#29123](https://github.com/oxc-project/oxc/issues/29123), [#29235](https://github.com/oxc-project/oxc/issues/29235)). It is not an official Svelte or oxc product.
- **Vite+ (VoidZero) bundles both tools.** `vite-plus` 1.7.0 pins `oxlint` 1.94.0, `oxfmt` 0.79.0 and `tsrs` ([npm](https://www.npmjs.com/package/vite-plus)), and exposes them as `vp lint`, `vp fmt` and `vp check` ([lint](https://github.com/voidzero-dev/vite-plus/blob/main/docs/guide/lint.md), [fmt](https://github.com/voidzero-dev/vite-plus/blob/main/docs/guide/fmt.md)). The same Svelte limits apply.

## Compatibility table

| Feature                                      | ESLint + Prettier (our setup)                        | oxlint / oxfmt today                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Core JS + typescript-eslint recommended      | yes                                                  | ✅ all mapped **[tested]**, 4 core rules skipped                                                                             |
| Type-aware rules in `.ts`                    | `no-floating-promises`, `no-misused-promises` (src/) | ✅ tsgolint/tsrs, stable                                                                                                     |
| Type-aware rules in `.svelte` script         | not used here                                        | ❌ [tsgolint#322](https://github.com/oxc-project/tsgolint/issues/322)                                                        |
| Lint `.svelte` `<script>`                    | yes (svelte-eslint-parser)                           | ✅ native parser                                                                                                             |
| Lint `.svelte` template                      | yes                                                  | ❌ [#23207](https://github.com/oxc-project/oxc/issues/23207)                                                                 |
| `no-unused-vars` in `.svelte`                | yes                                                  | ❌ rule skips the file                                                                                                       |
| eslint-plugin-svelte, script rules           | yes                                                  | ✅ via alpha JS plugin **[tested]**                                                                                          |
| eslint-plugin-svelte, template rules         | yes                                                  | ❌ no custom parser ([#20373](https://github.com/oxc-project/oxc/issues/20373))                                              |
| `no-restricted-imports` (marked/DOMPurify)   | static imports only                                  | ⚠️ also flags dynamic `import()` **[tested]**                                                                                |
| `eslint-disable` comments                    | yes                                                  | ✅ honored ([docs](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html))                                             |
| Local custom rule `shepherd/no-silent-catch` | inline plugin in `eslint.config.js`                  | ✅ via alpha JS plugin, 411/411 hits match **[tested]**; ⚠️ migrate mis-maps it                                              |
| `no-restricted-syntax` (esquery selectors)   | bans `promisify(execFile)` in `src/`                 | ❌ not implemented ([#479](https://github.com/oxc-project/oxc/issues/479)) **[tested]**                                      |
| Bulk-suppressions baseline                   | `eslint-suppressions.json` + `--prune-suppressions`  | ✅ same JSON format, fixed name `oxlint-suppressions.json` **[tested]**                                                      |
| Format JS/TS                                 | Prettier                                             | ⚠️ native, documented divergences (59/2,539 files differ **[tested]**)                                                       |
| Format `.svelte` markup/style                | prettier-plugin-svelte 4.1.1                         | ✅ same plugin, bundled (524/528 identical **[tested]**)                                                                     |
| Tailwind class sorting                       | prettier-plugin-tailwindcss                          | ✅ built-in `sortTailwindcss`                                                                                                |
| Other Prettier plugins                       | n/a (we use none)                                    | ❌ unsupported                                                                                                               |
| Config migration                             | n/a                                                  | ✅ `oxfmt --migrate prettier`; ⚠️ `@oxlint/migrate` drops override `ignores` + `no-restricted-syntax`, mis-maps local plugin |
| Speed, cold, no cache **[tested]**           | ESLint 61 s; Prettier 25 s (ui+src) / 43 s (repo)    | oxlint 4.8 s (type-aware + svelte JS plugin); oxfmt 4.4 s / 4.3 s                                                            |

## Applied to this repo

Our current setup:

- **Root `eslint.config.js`:**
  - `js` + `typescript-eslint` + `svelte` recommended configs, plus `svelte.configs.prettier`.
  - A type-aware promise gate on `src/**/*.ts`, with tests excluded. The same block runs the local custom rule `shepherd/no-silent-catch`, defined in `scripts/eslint-rules/no-silent-catch.mjs` and registered as an inline plugin (#4084).
  - An ESLint bulk-suppressions baseline, `eslint-suppressions.json`: 411 `no-silent-catch` hits across `src/`. It may only shrink, and you clean it up with `bunx eslint --prune-suppressions src`. `.prettierignore` excludes it.
  - A `no-restricted-syntax` esquery selector that bans `promisify(execFile)` in `src/` outside `src/instrument.ts` and `src/safe-git.ts` (#4085).
  - A `no-restricted-imports` rule that forbids static `marked` / `dompurify` imports in `ui/src` but allows `await import(...)`.
  - Svelte globals and the svelte parser settings.
- **`extension/eslint.config.js`:** the same presets, with no type-aware rules.
- **Prettier:** `.prettierrc` with the svelte and tailwind plugins, plus `.prettierignore`.
- **Where these run:**
  - lint-staged in the root `package.json`;
  - the delta-scoped lanes in `scripts/pre-push.ts`;
  - the CI "Lint (prettier + eslint)" step, whose cache key hashes the eslint and prettier config files (`.github/workflows/ci.yml`);
  - `.fallowrc.jsonc`, which lists both `eslint.config.js` files as entry points.

Mapping, from the **[tested]** runs:

- **Rules oxlint lacks or loses:**
  - Every template-level `svelte/*` rule. The repo has 54 `.svelte` files with `svelte/no-navigation-without-resolve` disables placed on `<a>` tags, and 12 `no-at-html-tags` disables. oxlint wouldn't even read these HTML-comment directives.
  - `no-unused-vars` in `.svelte` files.
  - `no-restricted-syntax`. **[tested]** A planted `promisify(execFile)` in `src/` gave 0 oxlint diagnostics where ESLint reported 1. The ban would have to move into a custom JS-plugin rule.
- **New false positives under oxlint:**
  - 8 `no-restricted-imports` hits on the _sanctioned_ dynamic imports in `ui/src/lib/sanitize-html.ts`, `codex-release-notes-renderer.ts` and `WireframeBlock.svelte`. oxlint deliberately extended the rule to `import()` ([PR #24029](https://github.com/oxc-project/oxc/pull/24029), [rule source](https://github.com/oxc-project/oxc/blob/main/crates/oxc_linter/src/rules/eslint/no_restricted_imports.rs)), which breaks the "dynamic import is fine" design our rule relies on.
  - 6 `no-unsafe-optional-chaining` hits through `as` casts in tests ([#27602](https://github.com/oxc-project/oxc/issues/27602), open).
- **What works:** the preset script-level rules, the type-aware gate, and the extension config. On the extension, migration plus oxlint gave 0 diagnostics, matching ESLint.
  - **[tested] `shepherd/no-silent-catch` runs unchanged as an (alpha) JS plugin**, once it is wrapped by hand. oxlint found 411 hits in `src/`, with per-file counts identical to `eslint-suppressions.json`.
  - **[tested] The bulk-suppressions baseline carries over.** oxlint has its own bulk suppressions ([PR #19328](https://github.com/oxc-project/oxc/pull/19328), merged 2026-05-06) and uses the same JSON format. Our ESLint file, copied to `oxlint-suppressions.json`, suppressed all 411 hits. `oxlint --suppress-all` regenerated an identical file, apart from the `no-unsafe-optional-chaining` false positive below.
    - The file name is fixed. A configurable location is still open ([#28386](https://github.com/oxc-project/oxc/issues/28386)), so a hybrid would keep two baselines.
    - In 1.94.0, `--suppress-all` and `--prune-suppressions` work but are missing from `--help`. **[tested]** Prune dropped a planted stale entry and cut an inflated count back to the real one. The docs PR is still open ([#26057](https://github.com/oxc-project/oxc/pull/26057)), and so are `--suppress-rule` and `--pass-on-unpruned-suppressions` ([#20990](https://github.com/oxc-project/oxc/issues/20990), [#20991](https://github.com/oxc-project/oxc/issues/20991)). A maintainer said the format "might change in the next few versions" ([#10549](https://github.com/oxc-project/oxc/issues/10549#issuecomment-4413733016)).
- **Prettier:** fully covered by oxfmt's built-ins. Its plugins are exactly svelte and tailwind.
- **Cost of switching formatters:**
  - a one-time reformat of about 86 files;
  - accepting oxfmt's TS style (one member per line for long unions);
  - a decision on whether to format `cli/Cargo.toml`;
  - updating lint-staged, `pre-push.ts` and the CI step and cache key.
  - `svelte` is already a root devDependency, so the Svelte path works as-is.

**Recommendation:**

1. **oxfmt: optional, can adopt now.**
   - Formatting was already 25–43 s cold vs about 4 s, but CI uses a warm content cache, so the real gain is modest. The main reason to move is to track where Svelte is heading (`sv` plans to make oxfmt the default).
   - Do it as a dedicated chore PR: migration, reformat, and the hook/CI swap.
   - It is beta, so pin the exact version.
2. **oxlint: wait.**
   - A full switch would lose the template rules, our `no-restricted-imports` design and the `no-restricted-syntax` ban. The custom rule would also have to run on the alpha JS-plugin API.
   - A hybrid (oxlint for `.ts`, ESLint + `eslint-plugin-oxlint` for `.svelte`) means two configs and two divergence workarounds, for a gain our cached, delta-scoped lint already mostly captures.

**Watch for:**

- the language plugins umbrella [#23207](https://github.com/oxc-project/oxc/issues/23207), especially [#23210](https://github.com/oxc-project/oxc/issues/23210) and [#23211](https://github.com/oxc-project/oxc/issues/23211);
- `languageOptions.parser` support, [#20373](https://github.com/oxc-project/oxc/issues/20373);
- [svelte#17665](https://github.com/sveltejs/svelte/issues/17665) closing, the best signal that eslint-plugin-svelte works under oxlint;
- [cli#1434](https://github.com/sveltejs/cli/pull/1434) merging (oxfmt becomes the `sv` default);
- an oxfmt stable release, or the native Svelte formatter [#28266](https://github.com/oxc-project/oxc/issues/28266);
- tsgolint embedded-language support, [tsgolint#322](https://github.com/oxc-project/tsgolint/issues/322).

## Not verified

- Whether oxfmt's Svelte path is slower per file than the native path. The tested total was fast regardless.
- `oxlint --type-aware` against `ui/` and `extension/` tsconfigs. `ui/tsconfig.json` extends `$app/tsconfig`, which tsgolint couldn't resolve in the scratch copy because `svelte-kit sync` wasn't run there. No type-aware rules are configured for `ui/` today anyway.
- Editor/LSP experience (oxc VS Code and Zed extensions).
