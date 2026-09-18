# What would it take to adopt varlock in Shepherd?

**Verdict: adopt HALF of it — the schema and the audit, not the runtime and not the secrets.**
Shepherd has **182 distinct `SHEPHERD_*` env keys** referenced in `src/`, `scripts/` and `deploy/`,
of which **67 are documented** — a 115-key gap that nothing in CI catches. A committed `.env.schema`
plus `varlock audit` closes exactly that gap: it fits the freshness-check pattern CI already runs
(`check:herdr-types`, `check:eval-fingerprints`, `check:docs-manifest`), exits `1` on drift, and
needs **no runtime dependency, no change to `shepherd.service`, and no change to `src/config.ts`**.
The runtime half is a different proposition: `varlock/auto-load` costs **~0.4–0.6 s of synchronous
boot time** and shells out through a `#!/usr/bin/env node` shebang — reintroducing the exact
node-resolution failure `src/node-bin.ts` exists to prevent, at boot, before any diagnostic can
report it. And `varlock run`'s default injection puts **every resolved secret, in plaintext**, into
a `__VARLOCK_ENV` blob that every child inherits — which for a program that spawns agent PTYs is a
regression, not a hardening.

> Engineering evaluation, **2026-09-18**, against **varlock 1.19.0** (MIT, DMNO Inc., released
> 2026-09-12) probed live under **Bun 1.4.2** on this host, and Shepherd at `d40b7338`. Every
> varlock behaviour claimed below was **observed by running it**; doc-sourced claims are marked with
> their URL. A capability map and a recommendation, not a committed plan. Read-only research task:
> this document is the entire diff.

---

## 1. What Shepherd's config actually looks like today

Shepherd is configured through **three stacked tiers**, and only the first is env:

| Tier             | Source                                                                                          | Authority                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1. Process env   | `Environment=` in `deploy/shepherd.service:22-31` + `EnvironmentFile=-%h/.shepherd/env` (`:33`) | Seeds tier 3 on a fresh DB; authoritative for infra knobs (port, host, paths) |
| 2. Code defaults | `src/config.ts` — one eager `export const config = {…}` (`src/config.ts:557`)                   | The `??` right-hand side of 122 reads over 109 distinct `SHEPHERD_*` keys     |
| 3. DB settings   | `settings` key/value table (`src/store.ts:1357`), **67 `getSetting` call sites**                | UI-configurable; wins at runtime for most behavioural knobs                   |

Two consequences shape everything below.

**`~/.shepherd/env` is not a repo `.env` file.** It lives outside the checkout deliberately — the
repo is public and `bun run update` deploys all of `main` — and it is consumed twice: by systemd
(`EnvironmentFile=`) and by POSIX shell (`. "$HOME/.shepherd/env"` in `deploy/install.sh:266`,
`deploy/update.sh:213,244`, `deploy/shepherd-restore.sh:28`, `deploy/provision.ts:147,323`). There
is **no `.env` anywhere in the repo**; the only one is `ci/self-hosted-runner/.env.example`, for a
retired feature.

**varlock can only ever validate tier 1.** A `.env.schema` would not be "the single source of truth
for Shepherd's configuration" — it is the source of truth for the _seed_ layer. Any adoption PR that
claims more than that is overclaiming, and this report is scoped accordingly.

### 1.1 The drift, measured

```
# LC_ALL=C matters: sort's locale collation ignores underscores while comm compares
# byte-wise, and the mismatch silently produces bogus diffs on these key names.
$ export LC_ALL=C
$ grep -rhoE "SHEPHERD_[A-Z0-9_]+" src scripts deploy | sort -u > code
$ grep -ohE  "SHEPHERD_[A-Z0-9_]+" docs-site/.../configuration.md | sort -u > docs
$ wc -l code docs            → 182 code, 67 docs
$ comm -13 docs code | wc -l → 115   (in code, undocumented)
$ comm -23 docs code | wc -l →   0   (documented, not in code)
```

115 keys are referenced in code and absent from
`docs-site/src/content/docs/reference/configuration.md`. A minority are shell-local script variables
that were never config (`SHEPHERD_EXCLUDE_START`, `SHEPHERD_KEY_OK_`, `SHEPHERD_UPDATE_EXIT__`), but
the bulk are real, load-bearing knobs: every role CLI/model/effort triple (`SHEPHERD_CRITIC_*`,
`SHEPHERD_PLANNER_*`, `SHEPHERD_NAMER_*`, `SHEPHERD_RECAP_*`, `SHEPHERD_OPTIMIZER_*`,
`SHEPHERD_MERGE_SUGGEST_*`, `SHEPHERD_DISTILLER_*`, `SHEPHERD_AUTOPILOT_*`), the entire
learnings-lifecycle tuning surface (21 keys), all three VAPID keys, `SHEPHERD_AUTH_MODE`,
`SHEPHERD_DEFAULT_MODEL`, `SHEPHERD_FABLE_AVAILABLE`. (`SHEPHERD_DOC_AGENT_*` is **not** in this
set — that family is fully documented at `configuration.md:261-266`.)

### 1.2 Parsing is ad hoc and inconsistent

`src/config.ts` reads env **122 times** (123 `process.env.<KEY>` occurrences, one of them prose in
the comment at `src/config.ts:47`) over **109 distinct `SHEPHERD_*` keys**. The idioms do not agree
— **five** of them parse a boolean:

| Idiom                                                                       | Count | Meaning                          |
| --------------------------------------------------------------------------- | ----- | -------------------------------- |
| `process.env.X === "1"`                                                     | 14    | opt-in, default off              |
| `process.env.X !== "0"`                                                     | 4     | kill switch, default on          |
| `parseKillSwitch(…)` (`src/config.ts:449`)                                  | 3     | same as `!== "0"`, named         |
| list membership — `!["0","false"].includes(…)` / `["1","true"].includes(…)` | 4     | **3 of them kill-switch shaped** |
| ad-hoc IIFE (`DO_NOT_TRACK`, `src/config.ts:637`)                           | 1     | opt-in, accepts `1` or `true`    |
| `Number(process.env.X ?? default)`                                          | 19    | of which **6** unguarded         |

**26 boolean keys in total** — 25 `SHEPHERD_*` plus `DO_NOT_TRACK`. The list-membership four are the
easiest to miss because they never appear in a `=== "1"` / `!== "0"` grep:
`SHEPHERD_TRIM_AUTO_CONTEXT` (`src/config.ts:779` via `parseTrimAutoContext`, **default on**),
`SHEPHERD_USAGE_HOLD_ENABLED` (`:1005`, **default on**), `SHEPHERD_USAGE_HOLD_AUTO_RELEASE`
(`:1014`, **default on**) and `SHEPHERD_USAGE_DOWNGRADE_ENABLED` (`:1026`, default off).

**Numeric reads are in better shape than a grep suggests: 13 of the 19 are guarded.** Seven go
through `clampCap` (`:739`, `:825`, `:861`, `:873`, `:881`, `:1008`, `:1029`) and one through
`clampFraction` (`:814`) — both fall back to a supplied default on a non-finite input
(`src/config.ts:151,157`). Two guard inline (`:960` via `|| 0`, `:1000` via `Math.max(0, … || 0)`).
Three more are rejected **at boot**: `:972`/`:973` by `validatePreviewPortRange`
(`src/config.ts:339`) and `:569` by `validateAgentIngressPort` (`src/config.ts:391`), both invoked
unconditionally at module scope in `src/index.ts:540-554`. The comment at `src/config.ts:385-386`
states that idiom explicitly — "Fail-fast (throw), consistent with `validatePreviewPortRange` —
never a silent fallback". That prior art is load-bearing for §4 Stage 3.

That leaves **six genuinely unguarded numeric reads**, which propagate `NaN`:

- `SHEPHERD_PUSH_COOLDOWN_MS=2m` → `NaN` (`src/config.ts:645`); every comparison against it is
  `false`, so the cooldown silently vanishes. Same shape for `SHEPHERD_AUTOPILOT_STEP_CAP`
  (`:850`), `SHEPHERD_AUTOMERGE_REBASE_CAP` (`:963`), `SHEPHERD_PREVIEW_SWEEP_MS` (`:975`) and
  `SHEPHERD_PREVIEW_KILL_MAX_AGE_MS` (`:981`). Note that `SHEPHERD_PREVIEW_PORT_BASE` / `_COUNT`
  are **not** in this set despite sitting between them — `validatePreviewPortRange` rejects a
  non-finite value of either by name (`src/config.ts:345-349`).
- `SHEPHERD_PORT=seven` → `mainPort = NaN` (`src/config.ts:480`), which is never validated directly.
  It does not reach `serve()`: `agentIngressPort` defaults to `mainPort + 1` (`src/config.ts:569`),
  so it is `NaN` too, and `validateAgentIngressPort` throws first — but the message it prints names
  **`SHEPHERD_AGENT_INGRESS_PORT`**, the derived key, not `SHEPHERD_PORT`, the one the operator
  actually mistyped. Fail-fast, misattributed. A `@type=port` on `SHEPHERD_PORT` would name the real
  culprit.

### 1.3 Secrets in env, and who inherits them

Six env keys are credentials: `SHEPHERD_PASSWORD`, `SHEPHERD_COOKIE_SECRET`, `SHEPHERD_TOKEN`,
`SHEPHERD_VAPID_PRIVATE`, `ANTHROPIC_API_KEY`, and (weakly) `SHEPHERD_APTABASE_APP_KEY`.

Shepherd spreads `...process.env` into child processes at **10 sites** (`src/pty-bridge.ts:36`,
`src/socket-pty-bridge.ts:121`, `src/doc-agent.ts:139`, `src/preview-launch.ts:155`,
`src/server.ts:6236`, `src/usage-probe.ts:172`, …). For the **`autonomous` and `standard`** sandbox
profiles this is contained: the bwrap membrane does `--clearenv` and re-sets only `HOME`/`PATH`/`TERM`
plus a six-entry locale allowlist (`src/sandbox.ts:303-315,624-631`). For **`trusted`** — the
_default_ profile, which returns `innerArgv` unchanged (`src/sandbox.ts:664`) — there is no membrane
and the agent pane inherits everything.

Confirmed live **inside this research session's own pane**: `env` lists `SHEPHERD_PASSWORD` and
`SHEPHERD_TOKEN`. That is [#2100](https://github.com/erwins-enkel/shepherd/issues/2100)'s territory
(`trusted` = no isolation), not a varlock finding — and, as §3.4 shows, varlock does not fix it.

---

## 2. What varlock is, verified by running it

varlock is a `.env.schema` file — a normal `.env` whose comments carry `@decorator` metadata, per the
`@env-spec` DSL — plus a CLI that resolves, validates, coerces, type-generates and redacts. It bills
itself as "AI-safe .env files: Schemas for agents, Secrets for humans."

| Fact         | Value                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Version      | **1.19.0**, released 2026-09-12; 1.0.0 was 2026-04-29, so **post-1.0**, 74 versions total      |
| License      | MIT                                                                                            |
| Maintainer   | DMNO Inc. (dmno.io) — single-vendor, repo created 2025-04-11                                   |
| Runtime deps | **zero** (optional per-platform native helpers); ~4.68 MB unpacked                             |
| `engines`    | `node >=22.3.0`, `bun >=1.3.3`                                                                 |
| Traction     | 4,552 stars, ~190 k npm downloads/week, 35 open issues                                         |
| Cadence      | 13 releases between 2026-07-06 and 2026-09-12 — weekly-to-biweekly minors                      |
| Telemetry    | anonymous usage analytics **on by default**; opt out via `varlock telemetry` or `DO_NOT_TRACK` |

It ships its own agent skill at `node_modules/varlock/skills/varlock/SKILL.md` (362 lines), which is
the densest primary reference for the syntax.

**Stability policy**: none published, beyond an explicit "early preview, may break in minors" notice
for the credential proxy (<https://varlock.dev/guides/proxy/>). Circumstantial evidence of semver
discipline: `@envFlag`, `@docsUrl` and `@generateTypes()` were all deprecated _with working aliases_
rather than removed, and every post-1.0 release has been a minor or patch.

### 2.1 Schema shape

```env-spec
# @defaultSensitive=false @defaultRequired=infer
# @generateTsTypes(path=env.d.ts)
# ---
# HTTP port the HUD listens on.
# @type=port @required
SHEPHERD_PORT=7330

# @type=boolean
SHEPHERD_DOC_AGENT=false

# Operator password.
# @sensitive @optional
SHEPHERD_PASSWORD=
```

Types: `string(minLength|maxLength|startsWith|endsWith|matches|…)`, `number(min|max|isInt|…)`,
`boolean` (accepts `t/true/yes/on/1` and `f/false/no/off/0`), `url`, `domain`, `enum(…)`, `email`,
`port`, `ip`, `semver`, `isoDate`, `uuid`, `md5`, `duration`, `array`, `record`, `simple-object`.
**There is no `integer` type** — `@type=integer` fails with `unknown data type: integer`; use
`number(isInt=true)`. `@defaultRequired=infer` means "items with a value are required, empty ones
optional", and — important for a multi-file setup — **applies per file**. Values may be resolver
functions: `ref()`/`${VAR}`, `concat()`, `exec()`/`$(cmd)`, `fallback()`, `if()`, `eq()`, `remap()`,
`forEnv()`.

Running `varlock load` on that schema in a shell carrying Shepherd's ambient env:

```
✅ SHEPHERD_PORT*         └ 7330
✅ SHEPHERD_DOC_AGENT*    └ true  < coerced from "1"   🟡 process.env
✅ SHEPHERD_PASSWORD  🔐 sensitive  └ AP▒▒▒▒▒          🟡 process.env
```

Two facts there decide the integration shape: **`process.env` is the highest-precedence source**,
and **sensitive values are masked in output by default**.

### 2.2 Precedence, and the one thing that does not work

Documented order: `.env.schema` < `.env` < `.env.local` < `.env.[env]` < `.env.[env].local` <
`process.env`.

The tempting move — `@import` the operator's out-of-repo file so the schema knows about it — **does
not do what it looks like it does**. Two probed constraints:

1. `@import` requires a `.env.*` filename: importing `~/.shepherd/env` fails with
   `imported file must be a .env.* file`. Renamed to `.env.local` it resolves (relative _and_
   absolute out-of-tree paths both work).
2. An imported file ranks **below** the importing schema's own static values. `varlock explain`:

   ```
   All definitions (2 sources, highest priority first)
     1. .env.schema (schema)                      value: static value
     2. fakehome/.shepherd/.env.local (overrides) value: static value
   ```

   The imported `SHEPHERD_PORT=7999` lost to the schema's `7330`.

**So the operator file must keep arriving via systemd, not via `@import`.** That is not a workaround
— it is strictly better: systemd puts it in `process.env`, the _highest_-precedence source, so
operator overrides keep winning with no schema changes and no change to `~/.shepherd/env`'s format
or location.

### 2.3 Runtime integration modes (both work under Bun 1.4.2)

| Mode                         | Probe result                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `varlock run -- bun …`       | works; injects individual vars **plus** a `__VARLOCK_ENV` blob                               |
| `import 'varlock/auto-load'` | works; `import { ENV } from 'varlock/env'` gives `ENV.SHEPHERD_PORT === 7330` typed `number` |

Also available but irrelevant here: `bunfig.toml` `preload`, `node --import`, a `"dotenv": "npm:varlock"`
override, framework plugins, `eval "$(varlock load --format shell)"`, and a credential proxy.

**Three probed properties that matter for a systemd service:**

- **Exit codes propagate.** Child `exit(78)` → `varlock run` exits `78`; Shepherd's
  `RestartPreventExitStatus=78` (EX_CONFIG, `deploy/shepherd.service:18`) would survive a wrapper.
  Signalling the _wrapper_ instead makes it die of the signal (143) and the child's own code is lost.
  Any non-zero child exit also prints a three-line `try running the same command without varlock`
  banner — which, with `StandardOutput=append:…/shepherd.log`, lands in the app log.
- **SIGTERM is forwarded** to the child (verified: child ran its handler). Docs add that
  `SIGTERM/INT/HUP/QUIT` are forwarded, that with no TTY the child gets its own process group so
  **grandchildren are terminated too**, and that `varlock run` is safe as a container PID 1
  (<https://varlock.dev/reference/cli/load-and-run/#run>).
- **stdout redaction is on by default when output is redirected** — which Shepherd's is, to the log
  file. Measured over 200 000 lines: 47 ms → 104 ms, i.e. **~0.3 µs/line**. Negligible; this is _not_
  a reason to avoid it, contrary to the usual single-event-loop worry.

**Two properties that are adoption blockers for the runtime path:**

- **`auto-load` costs ~0.4–0.6 s of synchronous boot time.** Measured with a 182-key schema:
  `bun -e 'process.exit(0)'` = 0.00 s; the same with `import 'varlock/auto-load'` = 0.42 / 0.59 /
  0.40 s. It works by `execSync`-ing the varlock CLI at import time.
- **That CLI is `#!/usr/bin/env node`.** `src/node-bin.ts` exists precisely because bare `node` is
  not reliably resolvable under systemd (mise/nvm shims) — its comment notes that when `"node"`
  fails, "every session pane silently stays black". `auto-load` reintroduces that failure mode at
  **boot**, ahead of any diagnostic, and additionally requires the resolved node to be ≥ 22.3.0.

### 2.4 Bun's own `.env` loading silently defeats varlock

varlock hard-errors below Bun 1.3.3, because that release added the ability to disable Bun's builtin
`.env` autoloading, "which is necessary to prevent conflicts with varlock's own .env loading"
(`packages/varlock/src/lib/check-bun-version.ts`). Probed, and it is not theoretical:

| Setup                                              | `process.env.SHEPHERD_PASSWORD` after `auto-load` |
| -------------------------------------------------- | ------------------------------------------------- |
| value in `.env.local`, no `bunfig.toml`            | **PRESENT** — Bun loaded it before varlock ran    |
| value in `.env.local`, `bunfig.toml` `env = false` | ABSENT                                            |
| value in `.env.schema`, no `bunfig.toml`           | ABSENT                                            |

So with `@disableProcessEnvInjection=true` set and no `env = false`, varlock appears to be honouring
the decorator (the non-sensitive key vanished) while Bun quietly kept the _secret_ in `process.env`
— the worst possible failure shape. Shepherd already has a `bunfig.toml`; adding `env = false` there
is a one-line, repo-wide change (harmless today, since there is no repo `.env`).

### 2.5 `varlock audit` — the actual reason to do this

`varlock audit` scans source for env references and diffs against the schema. Run against Shepherd's
real `src/` with a 4-key toy schema:

```
$ varlock audit --path ./.env.schema <shepherd>/src
🚨 Schema/code mismatch detected:
Missing in schema (141):
  - CLAUDE_CONFIG_DIR (seen at src/config.ts:585:8, src/config.ts:587:14, src/egress.ts:116:39)
  - SHEPHERD_COOKIE_SECRET (seen at src/config.ts:619:17)
  - SHEPHERD_VAPID_PRIVATE (seen at src/config.ts:623:17)
  …
$ echo $?
1
```

**141 keys, each with `file:line`, exit code 1.** It takes arbitrary target directories
(`varlock audit src scripts deploy`), supports `--ignore`, and `@auditIgnore` suppresses the reverse
direction (declared-but-unused). This drops straight into `ci.yml` beside `check:herdr-types` and
into `scripts/pre-push.ts` as another lane. It needs **no runtime integration at all** — just the
schema file and a dev dependency.

### 2.6 Type generation

`@generateTsTypes(path=env.d.ts)` emits a `declare module 'varlock/env'` augmentation with a JSDoc'd
`CoercedEnvSchema` (`SHEPHERD_PORT: number`, `SHEPHERD_PASSWORD?: string`, descriptions carried from
schema comments) plus a `PublicTypedEnvSchema` narrowed to non-sensitive keys. Options control
whether `process.env`/`import.meta.env` are typed `strict`/`loose`/`none`, and `exposeEnv=local`
gives a package-local `ENV` (the monorepo recommendation). Two caveats: the file is
`@ts-nocheck`/`eslint-disable`'d, and **every entry embeds a data-URI SVG icon** in its doc comment
— roughly 1 KB per key, so 182 keys is a large, noisy generated file. Codegen runs on load by
default; `auto=false` + `varlock codegen` is what a `check:`-style freshness gate would want.

### 2.7 What Shepherd would not use

- **Framework integrations.** `ui/` touches env in four places (`ui/vite.config.ts:49,56,113`,
  `ui/svelte.config.js:6`) plus one `import.meta.env` (`ui/src/lib/demo/router.ts:581`). There are no
  `PUBLIC_`-prefixed client-exposed vars and no client secret-exposure problem to solve. (A SvelteKit
  path exists — the Vite plugin, ordered before `sveltekit()` — but it buys nothing here.)
- **Secret-provider plugins** (1Password, Vault, AWS, Infisical, …) and **device-local encryption**
  (`varlock(prompt)`, Secure Enclave / TPM2). Shepherd's secrets are one operator's
  `~/.shepherd/env` on the operator's own host, most of them auto-generated and persisted into the DB
  on first boot (`src/operator-auth.ts:205`). A secret backend is a different project.
- **The credential proxy.** Explicitly an early preview with unstable API, and by its own docs "not
  a sandbox".
- **`varlock scan --staged`.** A plausible small win, but Shepherd's secrets were never in the repo.

---

## 3. What adoption would actually cost

### 3.1 Writing the schema (the real work)

182 keys, each needing a type, a required/optional call, a sensitivity call and a one-line
description. `varlock init --agent` drafts a schema from existing `.env`/`.env.example` files —
Shepherd has neither, so the draft would be empty and the schema must be **derived from
`src/config.ts` by hand** (or by an agent, from the `varlock audit` key list plus the documented 67).
Realistically a day of careful work, and it is the bulk of the cost.

### 3.2 The boolean-semantics trap

The five boolean idioms mean different things. A mechanical rewrite to `@type=boolean` would
**silently flip every kill switch's default**: `SHEPHERD_HOOKS_INGEST` unset today means _on_
(`parseKillSwitch` → `raw !== "0"`), and a schema line `SHEPHERD_HOOKS_INGEST=false` would make it
_off_. Each of the **26** boolean keys must be transcribed individually with its current default as
the schema value. This is the single most likely way an adoption PR ships a regression.

**Work the list from the code, not from a grep.** An adopter who greps `=== "1"` and `!== "0"` finds
21 of the 26 and misses the five that use another idiom — including the three list-membership
kill switches (`SHEPHERD_TRIM_AUTO_CONTEXT`, `SHEPHERD_USAGE_HOLD_ENABLED`,
`SHEPHERD_USAGE_HOLD_AUTO_RELEASE`, all **default on**, §1.2). Those are exactly the shape that
regresses silently, so the grep-shaped approach fails precisely where this section is trying to
protect you.

### 3.3 Tests

19 test files write `process.env.X = …` at **60 sites** (`SHEPHERD_TMP_SWEEP_DIR`,
`SHEPHERD_AGENT_TMPDIR`, `HOME`, `CODEX_HOME`, `XDG_RUNTIME_DIR`, …). `ENV` from `varlock/env` is a
frozen, resolve-once snapshot; any `config.ts` read migrated to `ENV.*` stops responding to those
writes. Note that Shepherd has already built its own miniature of this problem's solution: the root
`bunfig.toml` preloads `test/setup-test-env.ts`, which "strips the operator's ambient `SHEPHERD_*`
runtime config before any test imports `src/config.ts`". Keeping `config.ts` on `process.env` —
schema-_validated_ but read the same way — avoids the whole collision, which is the argument for
treating varlock as a **gate**, not a **runtime**.

### 3.4 It does not fix the secret-inheritance problem — and one mode makes it worse

Probed, with a planted sentinel secret and a cleaned ambient env:

| Invocation                               | Child's raw env                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `varlock run --inject all` (**default**) | schema keys present **+ `__VARLOCK_ENV` containing the sentinel in plaintext** |
| `varlock run --inject vars`              | schema keys present; **no blob**                                               |
| `varlock run --inject blob`              | schema keys **absent**; blob present (still carries the secret)                |

The default blob is a serialized resolution graph **including resolved sensitive values**, and
varlock's own docs say so, recommending `--inject vars` explicitly for "long-lived processes,
interactive shells, or any workflow where subprocesses may inspect their environment (e.g. `env`,
`printenv`, or an **LLM-driven agent**)". That is Shepherd exactly. Adopting `varlock run` without
`--inject vars` would hand every `trusted`-profile agent pane a single env var containing every
Shepherd credential in plaintext — strictly worse than today.

`@disableProcessEnvInjection=true` genuinely keeps values out of `process.env` (only the `ENV` proxy
sees them) — but **only with `env = false` in `bunfig.toml`** (§2.4), and it does nothing about the
_other_ inherited env, so `trusted`-profile panes keep inheriting `GH_TOKEN`, `ANTHROPIC_API_KEY`
and everything else. The genuinely useful, smaller piece is `@sensitive`: a **declarative,
machine-readable list of which keys are credentials**, which the 10 spread sites could key off
directly. Fixing `trusted`-profile inheritance stays
[#2100](https://github.com/erwins-enkel/shepherd/issues/2100)'s job.

### 3.5 Docs

`docs-site/src/content/docs/reference/configuration.md` is 423 lines of rich prose — multi-paragraph
entries with issue links and rationale. varlock's `@example`/`@docs()` metadata cannot reproduce it,
so **the docs page stays hand-written**. What the schema adds is a machine-checkable _key list_: a
small `check:env-schema-docs` comparing schema keys to the page's table rows would stop the 115-key
gap from recurring, without generating prose.

### 3.6 Smaller frictions

- **Telemetry is on by default.** Shepherd has its own telemetry-consent machinery and honours
  `DO_NOT_TRACK` (`src/config.ts:637`); adding a dev tool that phones home unasked needs an explicit
  `varlock telemetry disable` / committed `.varlock/config.json` step, or it contradicts the
  project's own posture.
- **Redaction has minimum-length rules**: values under 12 characters warn, and under 3 characters —
  plus booleans, numbers, and the `@currentEnv` item — error when marked `@sensitive`. A short
  `SHEPHERD_TOKEN` would trip this.
- **Supply chain**: zero runtime deps and cosign-signed release checksums are good. But
  `bunfig.toml` sets `minimumReleaseAge = 259200` (3 days) and varlock ships minors weekly — routine,
  but it means a fresh varlock release is not immediately installable here.

---

## 4. Recommendation — three stages, each independently shippable

**Stage 1 — schema + audit gate. Recommended; this is where essentially all the value is.**
Add `varlock` as a **devDependency only**. Author `.env.schema` covering all 182 keys with types,
sensitivity and one-line descriptions. Add `"check:env-schema": "varlock audit src scripts deploy"`
and wire it into `ci.yml` beside `check:herdr-types` and into `scripts/pre-push.ts`. Disable varlock
telemetry in a committed config. No runtime dependency, no unit change, no `src/config.ts` change, no
behaviour change, fully revertible — and it permanently closes the 115-key documentation gap.

**Stage 2 — docs parity check.** Extend the gate to compare schema keys against
`configuration.md`'s table rows, so a new knob cannot ship undocumented. Prose stays hand-written.

**Stage 3 — boot validation. Optional, later, and only if the boot cost is acceptable.**
`import 'varlock/auto-load'` in `src/index.ts` buys typed coercion and a named fail-fast boot error
instead of `NaN`, at a measured **~0.4–0.6 s added startup** and a new hard dependency on a
resolvable `node` ≥ 22.3.0 at boot (§2.3). Requires `env = false` in `bunfig.toml`. Migrate
`src/config.ts` **one key at a time**, transcribing each kill switch's current default (§3.2), and
keep `process.env` as the read path so the 60 test write-sites keep working.

The cheaper alternative is **not hypothetical: the repo already does this twice.**
`validatePreviewPortRange` (`src/config.ts:339`) and `validateAgentIngressPort`
(`src/config.ts:391`) are hand-written, throw a named and fixable message, run unconditionally at
boot (`src/index.ts:540-554`), and cost nothing at startup. Extending that established idiom to the
**six** unguarded `Number()` reads gets the whole of Stage 3's validation benefit with no
dependency, no `node` requirement at boot and no 0.4–0.6 s penalty.

**Six, not thirteen, is the honest size of the problem** — 13 of the 19 numeric reads are already
guarded (§1.2), so the gap varlock would buy down is about half what a first pass suggests, and it
is six lines of `clampCap` away from closed. That materially weakens Stage 3: its remaining
justification is not "stop the `NaN`s" but the 109-key **typed** surface — coercion plus generated
types plus one declaration site per key — and the 26 booleans still have to be transcribed by hand
either way (§3.2). Take Stage 3 only if that typed surface is judged worth the boot cost; the
validation argument alone no longer carries it.

**Do not adopt**: `varlock run` in `shepherd.service` (and if it is ever used for a script, never
without `--inject vars`), secret-provider plugins, local encryption, the credential proxy, framework
integrations. And do not describe `.env.schema` as Shepherd's configuration source of truth — it is
the source of truth for the env _seed_ layer; the `settings` table (67 `getSetting` sites) stays
authoritative at runtime.

### Alternatives considered

varlock's own docs argue against `dotenv`/`dotenvx` (migration recipes, not feature arguments) and,
generically, against the Zod-based pattern that `t3-oss/env`, `znv` and `envalid` implement — "your
`.env.schema` is the single source of truth … replacing the need for separate type declarations, Zod
schemas, and the `VITE_` prefix convention". Worth noting for honesty: **`t3-oss/env`, `znv` and
`envalid` are never named anywhere in varlock's primary sources** (checked against the full
1,046,559-byte `llms-full.txt` bundle and the repo README), so that comparison is inference, not
varlock's claim. For Shepherd specifically the Zod-style libraries are a poor fit anyway: they give
runtime validation and types but **no code-scanning audit**, and the audit is the feature that
actually closes this repo's gap.

---

## 5. Evidence index

| Claim                                       | Source                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 182 keys referenced / 67 documented         | `grep` over `src scripts deploy` vs `docs-site/.../configuration.md`                          |
| 122 env reads / 109 distinct keys           | `src/config.ts` (123 occurrences, one in the comment at `:47`)                                |
| 3 config tiers                              | `deploy/shepherd.service:22-33`, `src/config.ts:557`, `src/store.ts:1357`                     |
| 67 `getSetting` call sites                  | 68 occurrences of `getSetting(` in `src/**/*.ts`, minus the definition at `src/store.ts:1825` |
| 13 of 19 `Number()` reads guarded           | `clampCap`/`clampFraction` (`src/config.ts:151,157`) + `:960`, `:1000` + boot validators      |
| 6 unguarded numeric reads                   | `src/config.ts:480,645,850,963,975,981`                                                       |
| 26 boolean keys across 5 idioms             | 14+4+3 grep-visible; `:779`, `:1005`, `:1014`, `:1026` list-membership; `:637` `DO_NOT_TRACK` |
| two existing boot validators                | `src/config.ts:339,391`, called at `src/index.ts:540-554`                                     |
| membrane clears env; `trusted` does not     | `src/sandbox.ts:303-315,624-631,664`                                                          |
| 10 `{...process.env}` spread sites          | `src/pty-bridge.ts:36` et al.; `src/herdr-session.ts:74` is prose in a doc comment            |
| varlock 1.19.0, MIT, zero runtime deps      | `bun add varlock`; registry.npmjs.org/varlock                                                 |
| Bun ≥ 1.3.3 gate + rationale                | `node_modules/varlock/dist/check-bun-version-*.mjs`                                           |
| Bun `.env` autoload defeats the decorator   | A/B with and without `bunfig.toml` `env = false`                                              |
| schema syntax, decorators, CLI surface      | `node_modules/varlock/skills/varlock/SKILL.md`; `varlock --help`                              |
| audit: 141 missing, exit 1                  | `varlock audit --path ./.env.schema <shepherd>/src`                                           |
| import ranks below schema                   | `varlock explain SHEPHERD_PORT`                                                               |
| blob carries plaintext secrets              | planted sentinel, clean ambient env, `--inject all`                                           |
| `--inject vars` recommended for agent procs | <https://varlock.dev/reference/cli/load-and-run/#run>                                         |
| redaction ~0.3 µs/line                      | 200 000-line benchmark, 47 ms → 104 ms                                                        |
| auto-load ~0.4–0.6 s boot cost              | 182-key schema, `/usr/bin/time` × 3                                                           |
| CLI shebang is `#!/usr/bin/env node`        | `node_modules/varlock/bin/cli.js:1`; cf. `src/node-bin.ts:20-41`                              |
| `SHEPHERD_PORT=seven` misattributed at boot | `src/config.ts:480,569` → `validateAgentIngressPort` (`src/config.ts:400-405`)                |
| maturity, funding, telemetry, policy        | api.github.com/repos/dmno-dev/varlock; registry.npmjs.org; varlock.dev                        |

Upstream: <https://varlock.dev> · <https://github.com/dmno-dev/varlock>
