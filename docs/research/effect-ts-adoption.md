# Should Shepherd adopt Effect — for itself, for new projects, in the readiness check?

**Verdict, three answers:**

1. **Shepherd itself: no.** Don't migrate, and don't start a pilot yet. The real problems Effect
   would solve here are **238 swallowed promise rejections** (73 `.catch(() => {})` plus 165
   `=> null`/`=> undefined` sentinels), **`promisify(execFile)` re-declared in 23 files**, **11
   home-made backoff formulas**, **one private `withTimeout`** and **no runtime validation of HTTP
   request bodies** (ajv is already a dependency, but only plugin payloads use it at runtime). Each can be fixed with a small shared module or a lint rule, without bringing a
   new runtime into a 190k-LOC codebase that many agents edit concurrently. Effect 4 is **seven
   weeks old** (4.0.0 on 2026-10-01), and its first minor release already contained breaking
   changes.
2. **New projects (house stack): not as a default; fine as a per-project opt-in.** The house stack
   is a SvelteKit stack, and Effect has **no official Svelte bindings**. For a backend-heavy new
   TS service (Bun server, worker, CLI) it is a reasonable choice, provided it ships with
   Effect's official agent kit, described below.
3. **Readiness check: no.** The analyzer scores _guardrails_ (tooling that catches mistakes), not
   runtime-library choices. A repo written in plain async/await with strict TS, lint and tests is
   not less ready. The underlying goal (typed errors, nothing swallowed) is better served by two
   guardrails the analyzer lacks: **tsconfig strictness** and a **no-empty-catch lint rule**.

> Research note, **2026-11-19**, against **effect 4.1.4** (npm `latest`, published 2026-11-11) and
> Shepherd at `a22864861` (Bun 1.4.4). Effect claims come from primary sources (npm registry,
> `Effect-TS/effect` repo, effect.website), each linked. Shepherd claims come with `file:line` and
> the grep that produced the count. A recommendation, not a committed plan. Report-only: this file
> is the entire diff.

---

## 1. Effect, as of today

| Fact                     | Value                                                                                                                                                                                                                                         | Source                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current stable           | **4.1.4** (2026-11-11); `prev` = 3.22.4 (still patched, 2026-10-22; no v3 end-of-life date found)                                                                                                                                             | `npm view effect dist-tags time`                                                                                                                                                     |
| v4 timeline              | beta 2026-02-20 → RC 2026-08-12 → **4.0.0 2026-10-01** → 4.1.0 2026-10-29                                                                                                                                                                     | [4.0 release post](https://effect.website/blog/releases/effect/40), npm `time`                                                                                                       |
| Stability contract       | 4.x LTS ≥ 3 years. Stable APIs break only in majors, but `unstable` APIs may break in minors and `experimental` ones in patches                                                                                                               | [README § LTS](https://github.com/Effect-TS/effect/blob/main/README.md#long-term-support)                                                                                            |
| Churn, observed          | **4.1 (a minor) shipped breaking changes** (ChildProcess, Crypto, Toml, sql, BunHttpServer idle timeout), mostly in unstable areas. 4.0.0 also shipped some modules without the `unstable` tag they should have had                           | [4.1 post](https://effect.website/blog/releases/effect/41), [first-week post](https://effect.website/blog/effect-4-first-week)                                                       |
| Cadence                  | 13 stable releases in 6 weeks; all `@effect/*` packages share one version number and release together                                                                                                                                         | npm `time`                                                                                                                                                                           |
| 3 → 4 breaks             | `@effect/platform`/`rpc`/`cluster`/`schema` merged into `effect`; `Context.Tag`→`Context.Service`; FiberRef→`Context.Reference`; `Runtime<R>` removed; `catch*`/fork renames; Schema v4; fiber runtime rewritten                              | [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)                                                                                                           |
| Licence, deps, ownership | MIT; core has **zero runtime deps**; maintained by Effectful (seed round led by Amplify, 2024)                                                                                                                                                | [LICENSE](https://github.com/Effect-TS/effect/blob/main/LICENSE), [Amplify](https://amplifypartners.com/blog-posts/effectful)                                                        |
| Bundle floor             | **7.1 kB min+gz** for a minimal v4 program (vs 35.6 kB in v3); no per-module figures                                                                                                                                                          | [4.0 post](https://effect.website/blog/releases/effect/40)                                                                                                                           |
| Perf                     | v4 vs v3: 6.4× task throughput, −86% heap per fiber. **No official benchmark against plain async/await**                                                                                                                                      | [4.0 post](https://effect.website/blog/releases/effect/40)                                                                                                                           |
| Type-check cost          | **No official figure found**                                                                                                                                                                                                                  | —                                                                                                                                                                                    |
| Bun                      | First-party `@effect/platform-bun` + `@effect/sql-sqlite-bun` (on `bun:sqlite`). **But** its FileSystem, ChildProcessSpawner, Runtime and Socket re-export the _Node_ implementations, so they run on Bun's Node-compat layer. No PTY support | [platform/bun/src](https://github.com/Effect-TS/effect/tree/main/packages/platform/bun/src), [sql-sqlite-bun](https://github.com/Effect-TS/effect/tree/main/packages/sql/sqlite-bun) |
| Svelte                   | **No official integration**. Official atom bindings cover React/Solid/Vue only; `@effect/atom-svelte` does not exist on npm                                                                                                                   | [packages/atom](https://github.com/Effect-TS/effect/tree/main/packages/atom)                                                                                                         |
| Incremental adoption     | `ManagedRuntime.make(layer)` + `runPromise` at the edges; `Effect.tryPromise` to wrap Promises. A failed layer build is sticky (never retried). No dedicated v4 guide for adopting in an existing codebase                                    | [v4 runtime docs](https://effect.website/docs/v4/runtime), [LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md#integrating-effect-into-existing-applications)            |
| Schema                   | Built into `effect`; `Schema.toStandardSchemaV1`; `decodeUnknownSync` works without a runtime                                                                                                                                                 | [Standard Schema docs](https://effect.website/docs/v4/schema/standard-schema)                                                                                                        |

### 1.1 Agent support — strong, with one trap

The npm package itself **ships `AGENTS.md`, `CLAUDE.md` and an `ai-docs/` folder**
([LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md)). The official skills install
with `npx skills add Effect-TS/skills` and include a `effect-v3-to-v4` migration skill
([Effect-TS/skills](https://github.com/Effect-TS/skills)). The **Effect Language Service**
(`@effect/language-service` 0.87.5) has a CLI, `effect-language-service check` / `diagnostics
--project`, that can **gate CI**, and it flags global `fetch`/`console` and other anti-patterns
([language-service](https://github.com/Effect-TS/language-service)). Effect's blog recommends
vendoring the Effect source via `git subtree` so agents read real code, because agents are
"substantially less effective" working from the human docs
([post](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive)).
`effect.website/llms.txt` currently **returns 404**.

**The trap (our inference, not an Effect claim):** v4 renamed core APIs only seven weeks ago,
while most Effect code in the wild, and therefore in model training data, is v3. Without the
shipped `AGENTS.md`/skill wired into the repo, an agent will confidently write `Context.Tag` and
v3 `catch*` names. The language-service gate in CI is what turns that into a red build instead of
a review comment.

### 1.2 Who uses it, from primary sources only

- **OpenCode** (a Bun-based coding agent) depends on `effect` 4.1.0 and `@effect/sql-sqlite-bun`
  ([package.json](https://github.com/anomalyco/opencode/blob/dev/package.json)). It is the closest
  analogue to Shepherd's shape.
- **Harbor** publicly declined it: young ecosystem leading to wrapper code, hiring/onboarding
  cost, friction with Drizzle/Sentry/Passport, and stack traces
  ([post](https://runharbor.com/blog/2025-11-24-why-we-dont-use-effect-ts)).
- **Thoughtworks Radar** put it in _Trial_ in April 2025; it is not on the current edition
  ([radar](https://www.thoughtworks.com/radar/languages-and-frameworks/effect)).
- Claims like "Claude Code recommends Effect" appear only in Effect's own newsletter, not in a
  first-party source. They are not counted here.

---

## 2. Part 1 — Shepherd itself

### 2.1 What Effect would actually fix here

Effect's value is typed errors, structured concurrency (timeouts, retries, cancellation,
finalizers), dependency injection via Layers, and Schema. Measured against Shepherd's server
(`src/`, 459 files / 190k LOC excluding tests and generated code; counts from
`grep -rE <pat> src --include='*.ts' --exclude='*.test.ts'`):

| Effect feature        | Shepherd today                                                                                                                                                                                                                                                                                                                                                           | Gap?                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Typed errors          | 1,510 `try`, 458 `.catch(`, **238 swallowed rejections** (73 `.catch(() => {})` + 165 `.catch(() => null/undefined)`), ~170 empty catch blocks; 50 `Error` subclasses; 319/376 `ok: true/false` unions with **no shared `Result`** (only a local alias, `src/schedules-core.ts:208`)                                                                                     | **Yes**                 |
| Timeouts/cancellation | One `withTimeout`, private to `src/service.ts:2253`; 12 `Promise.race`; 9 `AbortController`; `timedAsync` (`src/instrument.ts`) is profiling-only and does not enforce timeouts                                                                                                                                                                                          | **Yes**                 |
| Retries/schedules     | 11 `2 **` backoff formulas (e.g. `src/codex-activity.ts:587`, `src/poller.ts:878`); fixed arrays (`src/api-error-retry.ts:10`); 19 hand-rolled sleeps                                                                                                                                                                                                                    | **Yes**                 |
| Child processes       | `promisify(execFile)` re-declared in **23 files** (e.g. `src/herdr.ts:23`, `src/diagnostics.ts:60`)                                                                                                                                                                                                                                                                      | **Yes** (duplication)   |
| DI / testability      | 120 `*Deps` interfaces, closure injection, hand-wired in `src/index.ts` (51 `new XService(`); 21 `-core.ts` pure modules                                                                                                                                                                                                                                                 | **No**: already solved  |
| Concurrency control   | `mapBounded` (`src/map-bounded.ts:4`), keyed serializer (`src/herdr.ts:788`), `timerTask` (`src/index.ts:3798`), worker-thread loop watchdog                                                                                                                                                                                                                             | Mostly solved           |
| Validation            | **ajv ^8** is a production dep (`package.json:78`), used at runtime only for plugin payloads (`src/plugin-agents.ts:23`, `:206-207`); `contracts/openapi.yaml` is validated with Ajv2020 **in tests only** (`test/contract/openapi.test.ts:4`, `test/contract/harness.ts:3`); HTTP request bodies (102 `req.json()`) go through ~597 hand-written `is*/parse*/validate*` | **Yes**                 |
| Observability         | 724 `console.*`, no OTel                                                                                                                                                                                                                                                                                                                                                 | Yes, but not a priority |

So the gaps are real, and they sit in exactly the areas Effect is good at. The question is whether
Effect is the right _fix_.

### 2.2 Why not

1. **Effect is contagious in function signatures.** It pays off when effectful code composes as
   `Effect`. If you wrap only the leaves and call `runPromise` everywhere, you pay the learning,
   dependency and churn costs and keep most of the error-swallowing seams. The payoff needs a
   large share of `service.ts`/`server.ts`/`index.ts` (31k LOC combined) rewritten, a long
   cross-cutting migration on a `main` that many agents edit at once. Every such change is a
   rebase-conflict magnet.
2. **Shepherd sits on the Bun-native and native edges Effect covers least.** It uses `Bun.spawn`,
   `Bun.serve`, `Bun.file`, synchronous `bun:sqlite` (`src/store.ts:2`) and `node-pty`. Effect's
   Bun child-process and filesystem layers are Node-compat re-exports, and it has no PTY support
   (§1). The PTY/herdr core, the hardest part, would stay hand-rolled anyway.
3. **It doesn't touch the single-loop constraint.** Fibers run on the same Bun loop that feeds the
   web terminal (`src/loop-watchdog.ts:1-12`). The loop-blocking bugs Shepherd has actually had
   (sync exec, CPU spins) are untouched by Effect.
4. **Effect 4 is too new for a 190k-LOC bet.** A breaking minor release within four weeks of GA
   (§1), and the agent-prior trap (§1.1). Agents writing into this repo would need the Effect
   skill and the language-service gate on every spawn, which also adds to the per-spawn context
   cost Shepherd works to trim.
5. **The fallow gate scores `Effect.gen` bodies like any other function** (cyclomatic 20 /
   cognitive 15, `.fallowrc.jsonc:225-235`). A partial migration raises dead-export and
   duplication noise while two styles coexist.

### 2.3 What to do instead (each a small, separate issue)

| Gap              | Fix without Effect                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swallowed errors | Lint rule banning rejection-swallowing handlers: empty `.catch(() => {})`, **`.catch(() => null/undefined)` sentinels**, and empty `catch {}`, unless they carry an explicit `// best-effort: <why>` marker. A plain no-empty rule only catches the 73 empty ones, so it needs a custom/`no-restricted-syntax` selector for the 165 sentinels. Burn down 238 + ~170 behind the rule |
| Timeouts/retries | One `src/async.ts`: `sleep`, `withTimeout` (promote from `src/service.ts:2253`), `retry({ schedule })`; migrate the 11 backoff formulas and 19 sleeps                                                                                                                                                                                                                               |
| `execFile` dupes | One shared `execFileAsync` export (with default `timeout` + `killSignal`) replacing 23 local `promisify` calls                                                                                                                                                                                                                                                                      |
| Result types     | One shared `Result<T, E>` + `ok()/err()` in a tiny module; adopt opportunistically                                                                                                                                                                                                                                                                                                  |
| Validation       | Separate spike on validating request bodies at the HTTP boundary (`req.json()`, 102 sites). **Baseline = the incumbent**: ajv (already a prod dep) compiling the existing `contracts/openapi.yaml` request schemas, the same way the contract tests already do. Compare it against Effect Schema (pulls in all of `effect`) and other validators                                    |

**Revisit trigger:** reconsider Effect only if (a) these helpers land and the same problems
persist, **and** (b) Effect 4.x has gone ~6 months without a breaking minor release.

---

## 3. Part 2 — new projects and the readiness check

### 3.1 House stack (greenfield scaffold)

The greenfield bootstrap pins `DEFAULT_HOUSE_STACK` (`src/house-stack.ts:27`): svelte, kit,
tailwind, vite, typescript, prettier, eslint, husky, lint-staged, fallow, vitest, playwright, bun.
It is injected into the scaffold prompt (`src/bootstrap-directive.ts:92`) and is operator-editable
(the `houseStack` setting).

- **Don't add `effect` to the default.** The default target is a SvelteKit app, and Effect has no
  official Svelte bindings (§1). For a UI-first app it is mostly overhead.
- **Opt-in is fine, and the setting already allows it.** For a backend-heavy new service, Effect
  4 is a defensible choice. If chosen, the scaffold should also set up the agent kit, otherwise the
  v3-prior trap bites from day one:
  1. `npx skills add Effect-TS/skills` (the `effect-ts` skill points agents at the shipped
     `node_modules/effect/AGENTS.md`);
  2. an `AGENTS.md`/`CLAUDE.md` line telling agents to read that file before writing Effect code;
  3. `effect-language-service check` (or `diagnostics --project`) in pre-push/CI.

  This is a scaffold-prompt note, not code. Wire it only when someone actually wants an Effect
  project.

### 3.2 Readiness analyzer

`src/readiness.ts` scores weighted guardrails (`GuardrailDef { id, weight, detect, applies? }`,
`:88`). Every JS/TS check (`:200-340`) and every install step (`:1165`) is **tooling**: hooks,
type checker, linter, formatter, test runner, CI, dead-code audit, env schema. It never scores a
runtime-library choice, and it shouldn't start with Effect:

- **It isn't a guardrail.** A repo without Effect isn't missing a safety net in the way a repo
  without a type checker or tests is. Scoring it would mark down well-guarded repos for a style
  choice.
- **A conditional check doesn't help either.** "If `effect` is a dep, is the language service
  wired?" is technically sound (an `applies?`-gated check like `env_schema`), but it would apply to
  very few repos. It can wait until Shepherd onboards Effect projects.

**What the analyzer is missing is the guardrail form of Effect's promise:**

| Proposed check            | Detects                                                                                                                                                                                                    | Why                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `type_checker` strictness | `type_checker` currently passes on any `tsconfig.json` or `typescript` dep (`src/readiness.ts:226-235`) and never reads `compilerOptions.strict`. Score `strict: true` (bonus: `noUncheckedIndexedAccess`) | A non-strict tsconfig is the biggest unguarded hole in agent-written TS; it costs nothing to add                                          |
| Swallowed-error lint      | ESLint config enables a no-empty-catch-style rule (`no-empty` + a promise-catch equivalent)                                                                                                                | Encodes the "fail closed" rule the analyzer already prescribes in prose (`GUARDRAIL_BLIND_SPOTS`, `src/readiness.ts:976`) as a real check |

Both fit the existing data shape: extend the `GuardrailId` union and the four exhaustive tables,
which the compiler enforces.

---

## 4. Decisions for the operator

1. File the §2.3 helpers (lint rule, `async.ts`, shared `execFileAsync`, `Result`) as issues? I
   recommend yes, one issue each.
2. File the two readiness checks from §3.2? I recommend yes; tsconfig strictness first.
3. Validation spike at the HTTP boundary (incumbent ajv + existing OpenAPI schemas as baseline,
   vs Effect Schema and other validators): worth an issue now, or park it?
