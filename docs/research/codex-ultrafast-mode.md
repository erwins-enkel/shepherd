# Codex Ultrafast mode: is it a Codex feature, and does it fit Shepherd?

**Brief:** Issue #4275 asks for Codex **Ultrafast** as a default for new Codex sessions and as a
per-session control. The issue cites the API guide
([Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)), so it was
unclear whether Ultrafast is an API-only feature or something the Codex CLI can use.

**Answer:** Ultrafast is a **Codex feature too**, not just an API one. The installed Codex 0.172
offers it on this account's default model. It uses the same mechanism as Fast mode: a service
tier from the model catalog, passed at launch as `-c service_tier="<id>"`. Shepherd already has
that pipeline from #4234. Supporting Ultrafast **extends** that pipeline and needs **no
rebuild**. The open question is a product one: #4253 and #4245 currently say Ultrafast stays
"pinned off, not offered".

**This file is a research note, not code.** It was checked on **2026-11-27** against OpenAI's
docs (§7), the Codex 0.172.0 and 0.164.0 installed on this host, and Shepherd's source on `main`
(`1ea57db39`).

## 1. What Ultrafast is

| Question                    | Finding                                                                                                                                                                                                                                                                       | Source                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| What kind of setting        | A **service tier**, spelled `ultrafast`. It is not a separate parameter or a model variant. API: "Set `service_tier` to `ultrafast`".                                                                                                                                         | [API guide][api-uf]                             |
| Codex too?                  | Yes. The API guide says: "To use Ultrafast in ChatGPT Work or Codex, choose a speed in the composer." The Codex speed page says: "Use `/fast` or `/ultrafast` to choose a speed. Repeat the active command to return to Standard. The CLI saves your selection."              | [API guide][api-uf], [Speed][speed]             |
| Models                      | GPT-6.2 Astra, GPT-6.2 Sol, GPT-6 Astra, GPT-6.1 Sol.                                                                                                                                                                                                                         | [API guide][api-uf], [Speed][speed]             |
| Speed                       | Up to 4.5× Standard on GPT-6.2 Astra/Sol. Up to 8× in Codex on GPT-6 Astra.                                                                                                                                                                                                   | [Speed][speed]                                  |
| Who gets it (ChatGPT login) | **Pro:** which models you get depends on the Pro plan. On Pro $500 both GPT-6.2 models are available. **Enterprise / Edu:** needs a credit-based or usage-based agreement. "Ultrafast is a separate permission and is off by default." The workspace owner enables it.        | [Speed][speed]                                  |
| API-key login               | "When you sign in to Codex with an API key, you pay API token rates." Ultrafast has "separate rate limits from Standard and Fast modes".                                                                                                                                      | [Speed][speed], [API guide][api-uf]             |
| Relation to Fast            | A **separate, faster tier**, not a stronger Fast. Fast is `priority` (the API also accepts `fast`). Codex has two independent feature flags: `features.fast_mode` and `features.ultrafast_mode`. Both are "stable; on by default", and each works independently of the other. | [Config reference][cfg], [Fast guide][api-fast] |
| Admin policy                | `configRequirements/read` returns `supportsIndependentSpeedModes`. If it is `true`, the managed `fast_mode` and `ultrafast_mode` requirements apply separately. "Older servers omit this field and use `fast_mode` for both."                                                 | [App server][appsrv], [Config reference][cfg]   |
| Residency                   | US only for GPT-6.2 Astra/Sol and GPT-6 Astra. GPT-6.1 Sol also supports the EEA and Switzerland.                                                                                                                                                                             | [Speed][speed]                                  |

### Cost (ChatGPT sign-in, multiplier relative to Standard on the same model)

| Tier          | Model                    | Included usage | Credits / pay-as-you-go                           |
| ------------- | ------------------------ | -------------- | ------------------------------------------------- |
| Fast          | GPT-6.2 Astra / Sol      | 2×             | 2×                                                |
| Fast          | GPT-6.1 and GPT-6 models | 2.5×           | 2×                                                |
| **Ultrafast** | GPT-6.2 Astra / Sol      | **6×**         | **3×** through 2027-02-28, **6×** from 2027-03-01 |
| **Ultrafast** | GPT-6 Astra, GPT-6.1 Sol | **8×**         | **6×**                                            |

Source: [Codex pricing, "Speed multipliers"][pricing]. Ultrafast uses up the plan allowance
**three to four times faster than Fast**. Any default that switches it on silently is expensive.

## 2. What the installed Codex reports (local probes, 2026-11-27)

These are read-only app-server calls (`initialize`, `model/list`, `config/read`,
`configRequirements/read`). They start no thread or turn and use no model allowance.

| Probe                                                | Codex 0.172.0 (`~/.bun/bin/codex`)                                                                                                                                                                        | Codex 0.164.0 (first `codex` on the shell `PATH`) |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `codex features list`                                | `fast_mode stable true`, `ultrafast_mode stable true`                                                                                                                                                     | same                                              |
| `model/list` → `gpt-6.2-sol` (`isDefault`)           | `serviceTiers: [{id:"priority",name:"Fast"}, {id:"ultrafast",name:"Ultrafast", description:"The fastest available responses for latency-sensitive work."}]`, `additionalSpeedTiers: ["fast","ultrafast"]` | model not in the catalog                          |
| `model/list` → every other model                     | only `priority` / "Fast"                                                                                                                                                                                  | only `priority` / "Fast"                          |
| `configRequirements/read`                            | `supportsIndependentSpeedModes: true`, no managed feature requirements                                                                                                                                    | same                                              |
| `config/read`                                        | `service_tier: "fast"` is **persisted** in the operator's config                                                                                                                                          | same                                              |
| Rollouts from the last 60 days (`~/.codex/sessions`) | `service_tier` values: 1,934 × `default`, 12 × `priority`, **0 × `ultrafast`**                                                                                                                            | —                                                 |

What this shows:

- On this account the catalog offers Ultrafast **only on `gpt-6.2-sol`**. The docs list four
  models, but the catalog is filtered by plan and model access. Shepherd must read the catalog
  and not hard-code a model list. That is what #4234 already does for Fast.
- **Ultrafast has never actually run on this host.** No rollout contains it. A launch with
  `-c service_tier="ultrafast"` is therefore **unverified end to end**. The implementation must
  record one runtime check: the `thread_settings_applied` event reports `ultrafast`.
- `-c service_tier="<anything>"` loads without a config error, so a bad tier id would not fail
  at startup. The catalog has to be the gate.

## 3. Answers to the verification points in #4275

| #4275 asks                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact CLI spelling             | No dedicated flag. Use the **config override** `-c service_tier="ultrafast"`, the same form #4234 uses for Fast. In the TUI it is the `/ultrafast` slash command.                                                                                                                                                                                                                                                                                                                     |
| Availability                   | Codex `features.ultrafast_mode` is stable and on by default (present in 0.164 and 0.172). Whether it is actually available depends on **model + plan + workspace permission**. The `model/list` `serviceTiers` entry is the authoritative signal.                                                                                                                                                                                                                                     |
| Supported models / accounts    | See §1. On this account only `gpt-6.2-sol` is listed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Relation to Fast               | A separate tier with its own feature flag and its own managed requirement. The two tiers are mutually exclusive per launch: a session has exactly one `service_tier`.                                                                                                                                                                                                                                                                                                                 |
| Switching in a running session | **In Codex:** yes. `/ultrafast` toggles it, the same command again returns to Standard, and the choice is **saved globally to `config.toml`**. App-server clients can also set `serviceTier` / `serviceTierForTurn` on `turn/start` ([App server][appsrv]). **In Shepherd:** no. Task sessions run the Codex TUI in a pane, and Shepherd never types slash commands into panes (#4253 non-goal). As with Fast, a change **takes effect at the next Codex start** (resume or restart). |
| Restart needed?                | Yes, for anything Shepherd changes. The UI must say so. The #4234 pattern already does this: `codexSpeedLaunch.applied` vs. the selected value shows the "pending" state.                                                                                                                                                                                                                                                                                                             |

## 4. How it fits Shepherd

### What #4234 already built (and Ultrafast reuses)

- **Launch:** `prepareCodexFastArgv` rewrites argv to `[binary, "-c", 'service_tier="<tier>"', …]`
  (`src/service.ts:4150-4173`). The tier id comes from the catalog, not from a constant.
- **Eligibility:** `CodexAccountClient.readFastTier` checks login, `config/read` and
  `configRequirements/read`, then searches `model/list` (`src/codex-account.ts:194-235`).
- **Observation:** the rollout's `thread_settings_applied.thread_settings.service_tier` is read
  (`src/codex-activity.ts:315-332`). The status bar **already labels `ultrafast`**
  (`ui/src/lib/components/SessionStatusBar.svelte:78`, message `codex_speed_ultrafast` in EN+DE).
- **UI:** `ui/src/lib/components/CodexSpeedSelect.svelte` provides the default and per-session
  select, cost copy, unavailability reasons and the pending/applied state.

#4234 **deliberately** shut Ultrafast out: `catalogFastTier` matches only the name "Fast" with id
`fast|priority` (`src/codex-account.ts:35-43`). A model with only an Ultrafast tier returns
reason `model` (`test/codex-account.test.ts:210`). `PUT …/codex-speed {"speed":"ultrafast"}` is
pinned to 400 (`test/server.test.ts:3705`).

### What would change (estimate: one medium PR, no new architecture)

1. **Type/enum:** add `ultrafast` to `CodexSpeed` (`src/codex-speed.ts:3`, `ui/src/lib/types.ts:1`).
   In `contracts/openapi.yaml:321-326`, add it to `CodexSpeed` and `DefaultCodexSpeed`, then
   regenerate the Swift and Rust contracts. `isCodexSpeed`, `putSessionCodexSpeed`
   (`src/server.ts:8355`), `putDefaultCodexSpeed` (`src/server.ts:12424`) and the persisted
   default (`src/index.ts:567`) must accept the new value.
2. **Eligibility per tier:** generalize `catalogFastTier` into a lookup by tier
   (`fast` → `priority|fast`, `ultrafast` → `ultrafast`). The policy check becomes per tier:
   - When `supportsIndependentSpeedModes` is `true`, check `ultrafast_mode` (feature +
     managed requirement).
   - Otherwise `fast_mode` governs both tiers.

   `CodexSpeedOptions` gets an `ultrafastUnavailable` reason next to `fastUnavailable`.

3. **Launch:** route `prepareCodexFastArgv` by the selected tier. The same constraints as Fast
   apply: no override inside the sandbox (reason `sandboxed`), and no override with changed
   startup env or argv (reason `version`/`unknown`). The `CODEX_HOME` handling at
   `src/service.ts:4395` (`applied === "fast"`) must cover `ultrafast` too.
4. **UI:** add an "Ultrafast" option to `CodexSpeedSelect`, with its own unavailability reason.
   The cost copy must show the **6×/8× multiplier** and use the tooltip module (EN + DE). The
   per-session status already shows Ultrafast. Add a feature announcement entry.
5. **Tests:** flip the two existing guard tests from "rejected" to "accepted when the catalog
   offers it". Add tier routing and policy-precedence tests, plus contract tests.

### What stays out

- Live switching in a running pane: the same non-goal as for Fast.
- Ultrafast in sandboxed sessions: the same restriction as for Fast.
- Helper roles (#4245): they stay pinned with `-c features.ultrafast_mode=false`. #4275 concerns
  task sessions only.

## 5. Risks and open points

- **Conflict with existing decisions.** #4253 (non-goals) and #4233 both say: "Codex Ultrafast
  as a selectable option. It is pinned off, not offered." #4275 reverses that. Before
  implementing, amend #4253's non-goal so the two plans don't contradict each other.
- **Cost.** Ultrafast costs 6–8× the included usage. A **default** of Ultrafast for all new
  Codex sessions would drain plan limits within a few sessions. Recommendation: offer
  Ultrafast as the default only with an explicit cost confirmation, or **per-session only**
  (see §6).
- **The persisted TUI choice already applies today.** A `/ultrafast` typed once in a Codex TUI
  is written to `config.toml`. From then on, every Shepherd session on "Use Codex setting"
  inherits it silently. On this host `service_tier = "fast"` is already persisted (§2). This is
  the risk #4233 item 1 describes, and it gets worse with Ultrafast. An explicit Standard
  default (#4233) protects better than any Ultrafast UI.
- **Launch unverified.** See §2: no rollout with `ultrafast` exists. The implementing PR needs
  one paid runtime check: a short turn on `gpt-6.2-sol` with an Ultrafast launch, where the
  status bar reports "Ultrafast".
- **Native client compatibility.** `CodexSpeed` is a generated closed enum in ShepherdKit
  (`native/Tests/ShepherdKitTests/ServerEventTests.swift:221`). Before shipping, check whether
  older iOS builds fail to decode a session or event that carries `codexSpeed: "ultrafast"`.
  If they do, ship the native build first or degrade gracefully on the server.
- **Catalog drift.** OpenAI changes which tiers each model offers (§2: one model locally, four
  in the docs). Gating stays catalog-based. Never hard-code models.

## 6. Recommendation

1. **Feasible without a rebuild.** Ultrafast is a second catalog tier in the existing #4234
   speed pipeline, roughly the size of a medium PR (§4).
2. **Decide first.** Amend #4253's non-goal "Ultrafast pinned off". Then decide whether
   Ultrafast may become the **default** or is **per-session only**. Recommendation: per-session
   plus an explicit, cost-confirmed default, never as an implicit inheritance.
3. **Order:** land #4233/#4245 (Standard pin, helpers pinned) first, then build #4275 on top.
   Otherwise the Standard pin and the Ultrafast option fight over the same argv logic.

## 7. Sources

- [api-uf]: OpenAI API, "Ultrafast mode",
  <https://developers.openai.com/api/docs/guides/ultrafast-mode> (fetched 2026-11-27).
- [api-fast]: OpenAI API, "Fast mode", <https://developers.openai.com/api/docs/guides/fast-mode>.
- [speed]: ChatGPT Learn, "Fast and Ultrafast modes",
  <https://learn.chatgpt.com/docs/agent-configuration/speed> (fetched 2026-11-27).
- [pricing]: ChatGPT Learn, Codex pricing, "Speed multipliers",
  <https://learn.chatgpt.com/docs/pricing> (fetched 2026-11-27).
- [cfg]: ChatGPT Learn, config reference (`features.fast_mode`, `features.ultrafast_mode`,
  managed requirements), <https://learn.chatgpt.com/docs/config-file/config-reference.md>.
- [appsrv]: ChatGPT Learn, App server (`supportsIndependentSpeedModes`, `serviceTier`,
  `serviceTierForTurn`), <https://learn.chatgpt.com/docs/app-server.md>.
- Local: `codex features list`, app-server `model/list`, `config/read` and
  `configRequirements/read` on codex-cli 0.172.0 and 0.164.0, plus the rollout scan of
  `~/.codex/sessions` (2026-11-27).
- Shepherd: PR #4234, issues #4220, #4233, #4245, #4253, #4275; file references at `1ea57db39`.

[api-uf]: https://developers.openai.com/api/docs/guides/ultrafast-mode
[api-fast]: https://developers.openai.com/api/docs/guides/fast-mode
[speed]: https://learn.chatgpt.com/docs/agent-configuration/speed
[pricing]: https://learn.chatgpt.com/docs/pricing
[cfg]: https://learn.chatgpt.com/docs/config-file/config-reference.md
[appsrv]: https://learn.chatgpt.com/docs/app-server.md
