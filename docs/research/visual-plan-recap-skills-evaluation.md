# Evaluation: BuilderIO `visual-plan` / `visual-recap` skills for Shepherd

**Verdict: DON'T adopt the skills as-is.** They are thin instruction wrappers around an **external hosted SaaS** (`plan.agent-native.com`) reached over an **MCP connector** — the two things Shepherd's reviewer/recap spawns are deliberately built to forbid (`--safe-mode` blocks MCP, `--disable-slash-commands` drops the skill catalog, the egress firewall blocks off-box hosts, LLM runs as a subscription spawn). Integrating them means undoing those exact controls and shipping unreleased plan/diff data off-box. Shepherd already generates durable recaps and gated plans end-to-end.

**What IS worth taking:** the _idea_ — render the recap/plan Shepherd already produces as a richer, **structured** surface (diagrams, file-tree, annotated diffs, schema/API summaries) in-app, instead of flat sanitized markdown. That's an incremental enhancement to `DoneRecapPanel` / `PlanPanel`, no external dependency, no spawn-policy change. Captured as a follow-up below.

Sources: [BuilderIO/skills](https://github.com/BuilderIO/skills) (MIT), [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native) (the renderer, MIT, self-hostable).

---

## What the two skills actually are

`BuilderIO/skills` is a 10-skill repo (MIT) from Builder.io's "Agent-Native" line. `visual-plan` and `visual-recap` are its two flagship skills. Neither contains standalone logic — both are **instruction wrappers** around three external pieces:

1. **A hosted app** — `plan.agent-native.com` (MCP endpoint `…/_agent-native/mcp`), one-time OAuth browser sign-in at install.
2. **A Plan MCP connector** (server name `plan`, legacy `agent-native-plans`) exposing `create-visual-plan`, `create-ui-plan`, `create-visual-recap`, `update-visual-plan`, `get-plan-feedback`, `get-plan-blocks`, `export-visual-plan`, etc.
3. **The `@agent-native/core` CLI** (`npx @agent-native/core@latest …`) for connect and local-files mode.

|                         | `visual-plan`                                                                                                                                                | `visual-recap`                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction               | Text plan → rich interactive visual plan (diagrams, file maps, annotated code, open questions, optional UI prototype)                                        | A PR/branch/commit/diff → interactive visual recap (same block model, built _from_ the diff)                                                                         |
| Frontmatter description | "Turn ordinary text plans into rich interactive visual plans with diagrams, file maps, annotated code, open questions, and UI/prototype review when useful." | "Turn a PR, branch, commit, or git diff into an interactive visual recap with diagrams, file maps, API/schema summaries, annotated diffs, and focused review notes." |
| Output                  | Hosted interactive plan at a returned URL (MDX, shareable, commentable)                                                                                      | Hosted interactive recap at a returned URL; optional **PR sticky-comment via a bundled GitHub Action**                                                               |
| Key MCP tool            | `create-visual-plan` (+ `create-ui-plan` / `create-prototype-plan` / `create-plan-design`)                                                                   | `create-visual-recap`                                                                                                                                                |

**Block vocabulary** (fetched live via `get-plan-blocks`, never hardcoded — tags drift): `diagram`/`mermaid`, `data-model`, `api-endpoint`, `diff`, `file-tree`, `annotated-code`, `code`, `wireframe`/`Screen`, `columns`, `tabs`, `rich-text`, `question-form`, `checklist`. Wireframes are HTML mockups using renderer-owned `--wf-*` theme tokens and `surface` presets (no raw hex, no `<html>/<style>/<script>`) — conceptually identical to Shepherd's own design-token discipline.

**`visual-recap` is the on-the-nose overlap** with Shepherd's durable recap. Its design rules are good and worth reading even if we don't adopt it: scope = whole work unit (not last message); structured blocks must be **true-by-construction from the actual changed lines** (the model writes only the "why"/risk prose); gate recap visibility to the owning org (recaps expose unreleased schema/internal endpoints); never transcribe secrets from diffs.

**Local-files / self-host escape hatch exists but doesn't dissolve the problem.** `--mode local-files` writes MDX to `plans/<slug>/` and runs a localhost bridge with no DB writes — but it still **opens the hosted Plan UI** against that bridge. The renderer itself ([BuilderIO/agent-native](https://github.com/BuilderIO/agent-native), MIT) _is_ genuinely self-hostable: React + Nitro + Drizzle, "any SQL database Drizzle supports, any host Nitro supports, no lock-in." So a fully on-box deployment is _possible_ — but it means standing up and operating a separate React/Nitro/SQL app plus an MCP connector, to re-implement a recap/plan surface Shepherd already has.

## Why direct integration fights Shepherd's architecture

Shepherd already generates both artifacts these skills produce, with a deliberately locked-down spawn model. The skills require precisely the capabilities that model removes:

| Shepherd control (today)                                                                                          | What the skills need                                          | Conflict                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer/recap spawns run `--safe-mode` (OAuth-safe MCP/plugin kill switch)                                       | A live **MCP connector** (`plan`)                             | `--safe-mode` blocks exactly this. Re-enabling MCP for these spawns reopens the trust-prompt + injection surface `--safe-mode` closed. |
| Spawns run `--disable-slash-commands` (drops the skill catalog)                                                   | Skills are slash-command-driven                               | The flag exists so untrusted plan text / issue bodies can't trigger arbitrary skills. These skills can't load under it.                |
| Autonomous sessions run behind a **netns egress allowlist** (#601)                                                | OAuth + MCP calls to `plan.agent-native.com`                  | Off-box host is firewalled. Even self-hosted, it's a new allowlist entry + a new always-on service.                                    |
| In-app LLM is a **subscription spawn**, never `claude -p` / no extra API (memory: LLM-must-be-subscription-spawn) | A hosted backend that holds plan state                        | New external dependency in the LLM path; cost/auth model diverges.                                                                     |
| Recaps generated server-side at the **archive chokepoint**, persisted, viewed in-app (`DoneRecapPanel`, PR #665)  | A hosted shareable URL + PR sticky-comment                    | Duplicates an existing, durable, in-app surface — and routes unreleased diffs/schema to an external render.                            |
| Plan-gate: adversarial read-only review, gate flag, in-app `PlanPanel` (PR #375)                                  | A hosted commentable plan with reviewer-annotation round-trip | Shepherd's plan review loop already steers findings back to the planning agent via PTY.                                                |

Net: the skills' _value_ is the hosted renderer + block model; their _cost_ is an external SaaS (or a whole self-hosted app) plus reversing the spawn-isolation posture. For Shepherd that trade is upside-down — we'd take on the operational and security cost to reach a surface we already have in flatter form.

## Where Shepherd is today (the baseline these would replace)

- **Recap** (`src/recap.ts`, `src/recap-core.ts`): transient Write-only Claude spawn (Sonnet default) at the `beforeArchive` hook + idle sweep; writes a JSON verdict (`{ verdict, headline, body (markdown), openItems }`) to `.shepherd-recap.json`; persisted as a durable `Recap` row; rendered in `DoneRecapPanel.svelte` via lazy `marked` + DOMPurify.
- **Plan** (`src/plan-gate.ts`, `src/reviewer-argv.ts`): `.shepherd-plan.md` written by the planning agent; adversarial read-only reviewer (≤5 rounds) writes `{ decision, summary, body, findings }`; gate flag releases execution; rendered in `PlanPanel.svelte` (same `marked` + DOMPurify path).
- **Rendering ceiling:** both panels render **sanitized markdown — DOMPurify strips `<img>`/SVG/embedded HTML.** So today the recap/plan is text, lists, code blocks, links. No diagrams, no file-tree, no annotated diff, no wireframe. _This is the actual gap the BuilderIO block model fills._

## Recommendation

**Don't adopt the skills or the hosted/self-hosted Agent-Native app.** Wrong cost/benefit and a direct fight with the egress + spawn-isolation posture; it would duplicate, not replace, working in-app surfaces.

**Do consider borrowing the concept incrementally** — a richer, structured render of the recap/plan Shepherd _already generates_, entirely in-app, no new dependency and no spawn-policy change:

1. **Have the recap/plan spawn emit optional structured blocks**, not just markdown prose. The agent already has the diff and changed-file list; ask it to also return a small, fixed, validated block array (e.g. `file-tree` with change flags, `diff` hunks it already cites, a `data-model`/`api-endpoint` summary when schema/routes changed, an optional `mermaid` diagram). Grounding rule worth stealing verbatim: structured blocks must be true-by-construction from real changed lines; the model only writes the prose. Keep it a **superset** of today's JSON — old recaps still render.
2. **Render those blocks in-app** with existing primitives: `mermaid` is already a candidate (UI already ships `shiki` for code; a mermaid renderer is a small add), `file-tree`/`diff`/`data-model` are plain Svelte components reading structured JSON — no `{@html}`, so no DOMPurify `<img>` problem. Reuse the design-system tokens (the `--wf-*` parallel is direct).
3. **Stay server-side / post-generation.** No MCP, no skill catalog, no external host — the block array rides in the same verdict JSON the spawn already writes. Spawn isolation is untouched.

This is a contained enhancement to `DoneRecapPanel` / `PlanPanel` + the two `*-core.ts` prompt/parse modules — and it's a **user-facing feature**, so it needs a `feature-announcements.ts` entry and EN+DE keys when built.

### Open questions (for the follow-up, not this eval)

- Worth the spawn-prompt complexity, or is flat markdown + better typography enough? (Recaps are already short by budget.)
- Which blocks earn their keep first — `file-tree` + `diff` are cheapest/highest-signal; `mermaid` diagrams risk LLM-invented architecture (violates the grounding rule unless constrained).
- Add a mermaid renderer to the UI bundle, or render diagrams to inline SVG server-side and allow only that one sanitized tag?
