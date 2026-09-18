# Research: What would it take to adopt varlock in Shepherd?

**Verdict: adopt one half, skip the other — and the half worth adopting needs no runtime integration at all.**

[varlock](https://varlock.dev) is two products sharing a CLI: a **schema/validation layer** for `.env` files, and a **secrets layer** (local encryption, provider plugins, a credential proxy for AI agents). Shepherd's needs are close to inverted from varlock's centre of gravity:

- The **secrets** half solves a problem Shepherd does not have. Shepherd holds ~7 env-resident secrets, most of which **generate themselves** when unset, and spawned agents already sit behind a `--clearenv` bwrap membrane that is _stronger_ than what varlock offers (§4).
- The **schema** half solves a problem Shepherd has badly: **172 environment variables, 86 of them undocumented, parsed by five mutually incompatible boolean idioms, with doc-sync maintained by an LLM rather than a check** (§2).

The recommended move is to take the schema half as a **documentation and drift-gate tool only** — author `.env.schema`, wire `varlock audit` into the existing pre-push gate, and never import varlock into the server. No runtime dependency, no startup cost, no behaviour change (§5).

This is a read-only research task (per the research directive): the deliverable is this report. No product code changed.

## 1. Is varlock safe to depend on?

| Fact             | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| Version          | `1.19.0` (post-1.0, released 2026-09-12)                            |
| License / vendor | MIT / DMNO Inc. (`dmno-dev/varlock`)                                |
| Traction         | 4,552 stars, 121 forks, ~189,700 npm downloads/week                 |
| Activity         | Repo pushed 2026-09-18 (the day of this report); created 2025-04-11 |
| Bun support      | First-class — "For the most part, Varlock just works with Bun"      |

Real, maintained, permissively licensed. Dependency risk is not the reason to be selective; **fit** is — and fit differs sharply between varlock's two halves.

One important caveat that recurs below: the **credential proxy specifically** is flagged by its own vendor as an early preview — _"its flags, decorators, and behavior may change (including breaking changes) in minor releases… pin your varlock version if you depend on it."_ The schema/CLI surface (`load`, `run`, `audit`, `scan`) carries no such warning.

Varlock's model: a committed `.env.schema` declares every variable with JSDoc-style decorators (`@type`, `@required`, `@sensitive`, `@example`, `@docs`), becoming the single source of truth `.env.example` never manages to be. Values layer on top, with `process.env` always winning:

```
.env.schema < .env < .env.local < .env.[env] < .env.[env].local < process.env
```

That last rule is what makes a zero-risk adoption possible for Shepherd (§5.1).

## 2. The problem Shepherd actually has

Measured against `origin/main` (d40b733). "Product code" = `src`, `ui`, `scripts`, `ci`, `deploy`, `site`, `docs-site`, excluding `test/`.

| Metric                                                                                                | Count                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Distinct env vars read in product code                                                                | **172**                                                           |
| Read sites in product code                                                                            | **263** (of which **217** in `src/` alone; ~490 counting `test/`) |
| Distinct vars read in `src/config.ts`                                                                 | 116 (109 of them `SHEPHERD_*`)                                    |
| Documented in `docs-site/…/reference/configuration.md`                                                | 70                                                                |
| **Read in code but appearing nowhere** in `docs-site/`, `docs/` (excl. `docs/research/`), `README.md` | **86**                                                            |
| Env-resident secrets                                                                                  | **~7**                                                            |

Four findings fall out.

### 2.1 Config is already centralised — but it is a snapshot, not a schema

`src/config.ts` (1,081 lines) is a genuine central module holding 116 of the 172 vars, and `configuration.md` already states Shepherd is _"configured entirely through environment variables (read in `src/config.ts`)"_. Shepherd is not starting from a vacuum.

But it is a **plain object literal snapshotted at module import** (`export const config = { … }`, `src/config.ts:557`), not a declared schema. And ~56 read sites in `src/` bypass it entirely, plus ~35 more across `scripts`/`ci`/`deploy`/`ui`/`site`. Several duplicate config.ts's own defaults rather than importing them:

- `SHEPHERD_DB ?? $HOME/.shepherd/shepherd.db` — `src/config.ts:22`, `src/backup-paths.ts:12`, `scripts/delivery-report.ts:41`, `scripts/usage-report.ts:580`
- `CLAUDE_CONFIG_DIR ?? $HOME/.claude` — `src/config.ts:585`, `src/sandbox.ts:139`, `src/egress.ts:116`, `src/recap.ts:280`

### 2.2 Five boolean idioms, and one silently inverts operator intent

There is no `envFlag()` primitive. Boolean coercion is done five different ways:

| Idiom                                                    | Count | Example                                        |
| -------------------------------------------------------- | ----- | ---------------------------------------------- |
| `=== "1"`                                                | 35    | `SHEPHERD_DOC_AGENT` (`config.ts:709`)         |
| `!== "0"`                                                | 7     | `SHEPHERD_LLM_NAMING` (`config.ts:833`)        |
| `["0","false"].includes(lower)`                          | 3     | `SHEPHERD_USAGE_HOLD_ENABLED`                  |
| inline IIFE `v === "1" \|\| v?.toLowerCase() === "true"` | 1     | `DO_NOT_TRACK` (`config.ts:637`)               |
| `!["false","0","off"].includes(…)`                       | 1     | `SHEPHERD_TRIM_AUTO_CONTEXT` (`config.ts:435`) |

The consequences are not cosmetic:

| Operator writes             | Flag parsed as | Actual effect    |
| --------------------------- | -------------- | ---------------- |
| `SHEPHERD_DOC_AGENT=true`   | `=== "1"`      | silently **off** |
| `SHEPHERD_LLM_NAMING=false` | `!== "0"`      | silently **on**  |

The second is the dangerous one: an opt-out flag set to `false` stays **enabled** — the exact opposite of intent, with no error. `@type=boolean` coerces `true/false/1/0/yes/no` uniformly and rejects garbage at load.

### 2.3 Numeric parsing fails open, sometimes to `NaN`

**14 of the 16** `SHEPHERD_LEARNINGS_*` vars use bare `Number(process.env.X ?? default)` with **no finite check** — a typo yields `NaN`, silently. Same pattern for `SHEPHERD_PORT` (`src/config.ts:480`), `SHEPHERD_PUSH_COOLDOWN_MS` (`:645`) and `SHEPHERD_AUTOMERGE_REBASE_CAP` (`:963`).

The port families are **not** in that set — they are the one part of the config surface that already fails loudly. `validatePreviewPortRange` throws on a non-finite `SHEPHERD_PREVIEW_PORT_BASE`/`_COUNT` (`src/config.ts:345–349`) and `validateAgentIngressPort` throws on a non-integer or out-of-range `SHEPHERD_AGENT_INGRESS_PORT` (`:401–406`), both on the boot path (`src/index.ts:540`, `:548`).

The two exceptions are worth naming, because one of them is the pattern the rest should follow:

- `SHEPHERD_LEARNINGS_AUTO_TRIAL` (`src/learnings-lifecycle.ts:16`) is a boolean kill-switch (`!== "0"`), so it belongs to §2.2's problem, not this one.
- `SHEPHERD_LEARNINGS_PRUNE_DAYS` (`src/learnings-lifecycle.ts:33–36`) **is** validated, via `resolveProposedRetentionDays` (`:229–238`): it requires `Number.isFinite(parsed) && parsed > 0`, emits a `console.warn` naming the bad value, and falls back. Neither unchecked nor silent.

Both exceptions are about **runtime validation only** — neither is documented (see §2.4).

That second exception matters for scoping: Shepherd already has an in-repo precedent for exactly the "validate, warn visibly, fall back" behaviour a schema would generalise — `@type=number` would extend it to the other 14 rather than introduce a foreign idea. The port validators are the stricter precedent (throw, don't warn), which is why §6's open question about blocking-vs-warning is a real choice and not an obvious one.

There are also **two different `envNum` helpers with incompatible signatures** — `src/house-rules.ts:34` takes a var _name_, `src/tmp-sweep.ts:42` takes a _value_.

The only startup hard-fails today are the port-range validators (`validatePreviewPortRange`, `validateAgentIngressPort`). Everything else fails open to a default.

### 2.4 Documentation sync is maintained by an LLM, not a gate

`configuration.md` is 423 lines of genuinely good, richly-cited prose covering 70 vars. It is kept current by `src/doc-agent.ts` — a nightly PR-gated documentation agent explicitly instructed to ground itself in _"`src/config.ts` — environment variables (names, defaults, behavior)"_ (`src/doc-agent.ts:1726`).

There is **no mechanical check**. `scripts/check-generated-docs.sh` gates only the herdr CLI reference; `check:glossary`, `check:feature-catalog`, `check:model-mirror` cover other artifacts. Nothing asserts config.ts ↔ configuration.md parity. The result is 86 undocumented vars, including every role triple (`SHEPHERD_CRITIC_*`, `SHEPHERD_PLANNER_*`, `SHEPHERD_AUTOPILOT_*`, …), **all 16** `SHEPHERD_LEARNINGS_*` (the prefix `SHEPHERD_LEARNINGS_` appears nowhere in `docs-site/` or `README.md`, and nowhere in `docs/` outside this report — §2.3's two exceptions are validated at runtime, not documented), `SHEPHERD_AUTH_MODE`, and `SHEPHERD_DEFAULT_MODEL`.

This is exactly `varlock audit`'s job: it exits `1` on drift in either direction — **missing in schema** (used in code, undeclared) and **unused in schema** (declared, no longer referenced).

## 3. Feature-by-feature fit

| varlock feature                          | Fit          | Why                                                                                                |
| ---------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `.env.schema` as single source of truth  | **Strong**   | 172 vars, 86 undocumented, no enforcement                                                          |
| `varlock audit` drift gate               | **Strong**   | Fixes §2.4; scans `.ts`/`.svelte`/`.astro` natively; slots beside the fallow pre-push gate         |
| `@type` validation / coercion            | **Strong**   | Fixes §2.2 and §2.3                                                                                |
| `varlock scan` (leak scan)               | Moderate     | Cheap — husky `pre-commit`/`pre-push` already exist; repo is public                                |
| `varlock load --agent`                   | Moderate     | Redacted JSON config view; safe for Shepherd's own spawned agents to read                          |
| MCP `headersHelper` / stdio-wrap recipes | Moderate     | Useful independently of the proxy — see §4.3                                                       |
| `@generateTsTypes`                       | Moderate     | Typed `process.env`; overlaps but cannot replace the `normalize*` helpers (§5.3)                   |
| GitHub Action (CI schema validation)     | Weak         | CI has 4 secrets, all GitHub-managed                                                               |
| Local encryption / provider plugins      | **Weak**     | ~7 secrets, single-operator, most self-generating (§4.1)                                           |
| SvelteKit / Vite integration             | **None**     | `ui/src` contains **one** env read: `import.meta.env.DEV`. No `$env/*`, no `PUBLIC_*`, no `VITE_*` |
| Credential proxy for AI agents           | **Negative** | §4.2                                                                                               |

## 4. The secrets half: why it has almost no surface here

### 4.1 Shepherd's secrets mostly generate themselves

| Secret                               | Behaviour when unset                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `SHEPHERD_PASSWORD`                  | Generated, argon2id-hashed into SQLite, printed once (`src/index.ts:486–507`) |
| `SHEPHERD_COOKIE_SECRET`             | Generated + persisted                                                         |
| `SHEPHERD_VAPID_PRIVATE` / `_PUBLIC` | Generated + persisted (`src/push.ts:414–421`)                                 |
| `SHEPHERD_TOKEN`                     | Optional break-glass bearer                                                   |
| `SHEPHERD_API_KEY_HELPER_PATH`       | A **path to a helper script** — "the raw key is NEVER stored"                 |
| `SHEPHERD_APTABASE_APP_KEY`          | Public telemetry key, baked-in default                                        |

Notably, the two credential stores that _would_ justify a secrets manager are **already not in env**: forge tokens live in `forges.json` (`src/forge/load-config.ts`), and minted access tokens live in SQLite as `sha256` hashes (`src/access-tokens.ts`). `ANTHROPIC_API_KEY` is CI-only.

Varlock's encryption and its 14 provider plugins (1Password, Vault, AWS…) are built for a team sharing many secrets across many environments. Shepherd is one operator, one box, one `~/.shepherd/env`.

### 4.2 The credential proxy looks tailor-made and is a downgrade

Varlock's headline AI feature is a credential broker — the agent holds a placeholder; the proxy swaps in the real secret at the network boundary against a TLS-verified upstream and scrubs it from responses. For a product that spawns autonomous coding agents, that sounds exact.

**Shepherd already ships something stronger.** `src/sandbox.ts:628` builds bwrap flags beginning with `--clearenv`, then re-adds a **6-entry non-secret allowlist** (`LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TZ`, `COLORTERM`). The comment at `src/sandbox.ts:625` states the intent directly: _"This is what keeps env-resident secrets (GH_TOKEN, SHEPHERD_TOKEN, ANTHROPIC\_\*, AWS\_\*, …) out of a hijacked agent."_ On top of that, `src/spawn-auth.ts` masks `.credentials.json` **in place** and RO-binds the `apiKeyHelper`. That is filesystem isolation, composed with the netns egress allowlist (#601).

Varlock's own docs say the proxy is explicitly _not_ that:

> It stops the agent from _trivially reading_ a secret it's _using_, but on its own it is **not a sandbox**: it doesn't isolate the filesystem, other processes, or memory. A determined agent can spawn a process outside the proxy's view (e.g. reparented via `setsid`) and resolve secrets directly from their source.

And its documented limits collide with Shepherd's actual deployment:

- **Bare `--sandbox` is macOS-only.** Shepherd runs on Linux, where the only built-in isolation is `--sandbox=docker`/`=podman`, which _requires_ `--sandbox-image` containing the agent toolchain. That would duplicate and conflict with the existing netns/slirp4netns boundary.
- **Streaming is completely undocumented.** Across the entire official corpus there is **no mention of SSE, `text/event-stream`, chunked transfer, or response buffering**. Since Shepherd's whole purpose is spawning Claude Code sessions against a streaming LLM API, whether streaming survives the interception path is a blocking unknown.
- **No WebSockets, no HTTP/2, no gRPC** on hosts with a `@proxy` rule. Shepherd's terminal transport is WebSocket end to end.
- **Node < 24 built-in `fetch` silently bypasses the proxy**, sending placeholders straight upstream — a 401, not a fallback.
- Compressed or >2 MB response bodies pass through unscrubbed.

A telling signal: **every AI-tool guide varlock publishes — Claude Code included — uses plain `varlock run`, never `varlock proxy run`.** The proxy appears only in its own quick-start and the sandboxing page, as generic illustration. There is no documented recipe for an MCP server behind the proxy at all.

**Do not adopt the proxy.** This is the most important conclusion here, because it is the feature most likely to be proposed on the strength of its marketing.

### 4.3 …but two proxy-adjacent recipes are worth stealing

Independent of the proxy, varlock documents MCP patterns Shepherd could use directly:

- **`headersHelper`** for remote MCP servers — resolves auth headers at connect time, re-runs on 401/403, 10-second budget.
- **stdio wrap** with `--filter MY_SERVER_*` and `--inject vars` — gives each local MCP server least-privilege env and keeps the `__VARLOCK_ENV` blob out of third-party processes.

Worth a look if Shepherd's per-session MCP endpoint ever needs per-server credential scoping.

## 5. What Phase-1 adoption would actually take

### 5.1 The structural mismatch — and why it works in our favour

Shepherd has **no dotenv dependency and no repo-local `.env`**. Runtime config comes from systemd:

```ini
# deploy/shepherd.service
Environment=SHEPHERD_PORT=7330
EnvironmentFile=-%h/.shepherd/env
```

The real config file is `~/.shepherd/env` — outside the repo, systemd-owned, `KEY=value`.

This is _fortunate_. Because varlock puts `process.env` at the **top** of its precedence chain, systemd-injected values already win over anything varlock resolves. A validation-only adoption is therefore a genuine no-op at runtime: varlock reads the same values the server already has, checks them against the schema, changes nothing.

If a later phase wants varlock to resolve that file too, `@import()` supports home paths — `@import(~/.shepherd/env, allowMissing=true)` — though varlock warns on imports that are outside the repo or gitignored, since they won't exist for anyone else.

### 5.2 Phase 1 — schema + drift gate (the recommendation)

Touches no product code.

1. `bun add -D varlock` at the root.
2. **Fix `.gitignore` first.** Line 7 is `.env.*`, which silently swallows a committed `.env.schema`. Verified: `git check-ignore -v .env.schema` → `.gitignore:7:.env.*`. Add a negation — the file already uses this exact pattern for `ci/self-hosted-runner/.env.example`:
   ```gitignore
   !.env.schema
   ```
   Without this the whole adoption fails silently.
3. `bunx varlock init --agent` to draft, then author properly. The bulk of the effort is here, but it is **transcription, not invention**: 70 vars already have curated prose in `configuration.md` to move into `@docs`/description comments, and `@type`/`@required` facts are readable off `src/config.ts`.
4. Add `bunx varlock audit` to `pre-push` beside the fallow gate. Use `@auditIgnorePaths()` for `test/`, `examples/`, `mockup/`.
5. Optionally `bunx varlock scan --staged` in `pre-commit`.

**Known coverage gap to accept up front:** `varlock audit` scans source files by extension (`.ts`, `.svelte`, `.astro`, `.py`, …) and **cannot scan extensionless files or shell scripts**. So the env contracts in `deploy/install.sh`, `deploy/update.sh`, `deploy/rotate-shepherd-log.sh` and `ci/self-hosted-runner/*.sh` stay outside the gate. They can still be _declared_ in the schema; they just won't be drift-checked. `@auditIgnore` suppresses the resulting "unused in schema" noise.

**Cost**: dominated by writing ~172 schema entries — realistically a day or two of careful work, and it should land in themed batches (core/network, role triples, learnings, preview, telemetry) rather than one unreviewable diff.

**What it does not cost**: no runtime dependency, no startup penalty, no boot-path change, revertible by deleting one file.

### 5.3 Phase 2 — typed access (optional, later)

`@generateTsTypes(path=env.d.ts)` gives a typed `process.env`. Worth it only once Phase 1 has settled.

Two limits to scope around:

- varlock's `@type=enum(a, b, c)` **cannot replace** Shepherd's `normalize*` helpers. Those do domain work an enum can't express — `normalizeDefaultModelSetting` handles the Fable→Opus availability fallback (PR #846); `normalizeRoleModelToken` resolves per-role model tokens. Expect varlock to validate _shape_ while the helpers keep owning _meaning_.
- varlock does **not** fix the import-time snapshot problem. `test/setup-test-env.ts` currently has to delete every `SHEPHERD_*` except a 9-entry allowlist precisely because `config` snapshots at import and never re-reads. That is an architecture issue in `src/config.ts`, orthogonal to varlock, and it will still be there afterwards.

### 5.4 Runtime integration — deliberately skipped

If Shepherd ever did load varlock at runtime, note that `varlock/auto-load` **uses `execSync` to shell out to the varlock CLI**. Startup-only, so it does not violate the single-loop rule, but it buys a hard runtime dependency and boot latency for no benefit given §5.1.

The better shape, if ever needed, is `ExecStart=varlock run -- bun run src/index.ts` — resolve once in the parent, inject, keep the app clean.

One Bun gotcha to record either way: Bun auto-loads `.env` files based on `NODE_ENV`/`BUN_ENV` and feeds them to varlock. Disable in `bunfig.toml`:

```toml
[run]
env = false
```

## 6. Recommendation

| Phase | Action                                                                       | Verdict                                                                                     |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1     | `.env.schema` + `!.env.schema` in `.gitignore` + `varlock audit` in pre-push | **Do it** — high value, no runtime risk                                                     |
| 1b    | `varlock scan --staged` in pre-commit                                        | Do it — near-free, repo is public                                                           |
| 2     | `@generateTsTypes`, typed `process.env`                                      | Defer; revisit after Phase 1                                                                |
| 3     | Local encryption, provider plugins, SvelteKit/Vite integration               | **Skip** — no surface in Shepherd                                                           |
| 4     | Credential proxy for spawned agents                                          | **Skip** — weaker than the existing bwrap membrane, preview-grade, and Linux-hostile (§4.2) |

The honest summary: varlock is a good tool whose most-advertised feature Shepherd should decline, and whose least-glamorous feature — a schema file and a drift check — fixes a real, measurable, 86-variable documentation debt for roughly the cost of writing the documentation that is already owed.

Worth noting what Phase 1 does _not_ fix, so it isn't oversold: the import-time snapshot, the two rival `envNum` helpers, and the duplicated default expressions are all still there afterwards. The schema makes them _visible and enforced_; it doesn't refactor them.

## Open questions

- Does `configuration.md` stay the curated operator-facing page, with `.env.schema` as the enforced machine-readable source? (Recommended: yes — schema gates, page explains. The doc-agent already owns the page and would gain a check to satisfy.)
- Should `varlock audit` **fail** pre-push or warn during a grace period? Fallow's precedent is block-on-new-issues.
- Themed batches for the ~172 entries — which split?
- Is the shell-script coverage gap (§5.2) acceptable, or does `deploy/*.sh` need its own check?

## Sources

- [varlock.dev](https://varlock.dev/) · [docs for agents (`llms.txt`)](https://varlock.dev/llms.txt) · [SKILL.md](https://varlock.dev/.well-known/agent-skills/varlock/SKILL.md)
- [Credential proxy guide](https://varlock.dev/guides/proxy/) · [Running the proxy](https://varlock.dev/guides/proxy/running/) · [Sandboxing](https://varlock.dev/guides/proxy/sandboxing/)
- [Bun integration](https://varlock.dev/integrations/bun/) · [SvelteKit integration](https://varlock.dev/integrations/sveltekit/) · [GitHub Action](https://github.com/dmno-dev/varlock-action)
- [github.com/dmno-dev/varlock](https://github.com/dmno-dev/varlock) · [npm](https://www.npmjs.com/package/varlock)
