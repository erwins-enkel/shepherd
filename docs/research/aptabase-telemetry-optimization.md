# Optimizing Shepherd's Aptabase telemetry (GDPR-safe)

**Verdict: our GDPR posture is already best-practice — keep it. The real gap is _event coverage_.** Today four coarse, server-only events (`app_launched`, `session_created`, `epic_drained`, `pr_opened`) can answer "how many installs, on which platforms" but **cannot** answer any of the three questions that motivated this research:

1. **"Which feature is never used?"** — answerable with Aptabase, but only for features we actually emit an event for. We instrument ~4 verbs today, so almost every feature is invisible (absence in the dashboard = "not instrumented", not "not used"). **Fix: curate and wire a broader server-side feature-usage event catalog.** Stays fully inside the locked v1 design.
2. **"Which feature is used most?"** — same story. Aptabase's `top-events` chart _is_ this view; it's just starved of inputs. Same fix.
3. **"Where are UI comprehension problems?"** — **Aptabase cannot do this, by design, and the answer collides with a locked v1 non-goal.** No session replay, no heatmaps, no rage-click/scroll capture, no funnels, no passive DOM instrumentation. Approximating UX friction needs _client-side_ event instrumentation, which v1 explicitly excluded. This is a genuine product decision, not a wiring task — see §6.

This was a research task; no product code was changed. Findings below are cited; every Aptabase-capability claim is grounded in the actual `aptabase/aptabase` + `aptabase/aptabase-js` source (their prose docs are thin), and separated from Aptabase's own legal/marketing positioning where that matters.

---

## 1. What we have today

Shepherd does **not** use any `@aptabase/*` SDK. There is a hand-rolled, **server-only** client (`src/telemetry.ts`, `TelemetryService`) that POSTs batches directly to Aptabase's documented ingestion endpoint (`POST {host}/api/v0/events`, `App-Key` header). The SvelteKit UI never talks to Aptabase — it only flips the consent setting through Shepherd's own `/api/settings`. Rationale is locked in `docs/superpowers/specs/2026-07-02-aptabase-telemetry-design.md`; event set ratified in issue #1329 / PR #1342.

**The complete event catalog (four events):**

| Event             | Fires when                                                          | Props                                                             | Source                                    |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| `app_launched`    | boot (once background subsystems start), and on first consent grant | _(none)_                                                          | `src/index.ts:2372`, `src/server.ts:4082` |
| `session_created` | after a session is created                                          | `agentProvider`, `autopilot`, `research`, `planGate`, `fromIssue` | `src/service.ts:2248`                     |
| `epic_drained`    | epic run completes → idle                                           | `childCount`                                                      | `src/drain.ts:640`                        |
| `pr_opened`       | a session's tracked PR first transitions → open                     | `agentProvider`, `isDraft`                                        | `src/pr-opened-telemetry.ts:44`           |

**System props on every event** (`src/telemetry.ts:99`): `osName`, `osVersion`, `arch`, `locale` (capped 10 chars), `appVersion`, `engineName`/`engineVersion` (bun/node), `sdkVersion: "shepherd-telemetry@1"`. Plus a per-process random `sessionId` (`randomUUID`, rotates every restart). **No** hostname, username, cwd, repo path, or user code.

**Gating (all must hold to emit):** `telemetryConsent === "granted"` (default `"unset"` → first-run prompt) **and** `!DO_NOT_TRACK` **and** App-Key present with a resolvable host (`A-EU-*` → `eu.aptabase.com`, `A-US-*` → `us.aptabase.com`, `A-SH-*`/unknown needs `SHEPHERD_APTABASE_HOST`). Default key is the baked-in public EU cloud key `A-EU-2837516646`; blank disables. Consent is persisted; UI surfaces a design-system consent modal + a Settings toggle.

**Locked v1 non-goals** (from the spec — important, because two of the user's questions run straight into them):

- **No client-side (`@aptabase/web`) instrumentation.** Server-only egress: "one consent gate, one scrub surface." UI-only events are not collected.
- **No error/crash telemetry** (overlaps Sentry, risks leaking paths/messages).
- **No persistent install ID** (unique-install counts are approximate — accepted).
- **No new runtime SDK dependency** (Aptabase has no official Node/server SDK; we post to the HTTP API directly — this is correct, see §5).

---

## 2. Answering the three questions against Aptabase's real capabilities

### Q1 + Q2 — "which feature is unused / most used"

**This is exactly what Aptabase is for**, and it works — for instrumented features. The dashboard's `top-events` endpoint (`StatsController.cs`) ranks events by count and unique-session for a period, filterable by date / OS / app-version / country / device. "Most used" = top of that list; "never used" = a feature whose event is absent from the range **when cross-referenced against a known catalog of events we expect to see**. The `top-props` endpoint additionally breaks one event down by a chosen property's values (top values + count, and median/min/max/sum for numeric props) — so `session_created` split by `agentProvider`, or by `autopilot=true/false`, is a first-class view today.

**The blocker is coverage, not capability.** Four events describe the session/epic/PR spine and nothing else — no view/route usage, no backlog/plan/review/settings/automation actions. Everything not on that spine reads as "0" purely because we never emit it. Aptabase gives you the chart; we're not feeding it.

### Q3 — "where are UI comprehension problems"

**Aptabase cannot answer this and was deliberately built not to.** Confirmed from source and the maintainer directly (issue #108): "Aptabase does not track any events by default… We intentionally avoided tracking events from inside the framework so that the client has full control of what gets sent." Concretely absent:

- **No session replay, no heatmaps, no click/scroll/rage-click capture, no DOM observation** — zero passive instrumentation.
- **No funnels** and **no cohorts/retention** — a direct consequence of having no persistent user identifier (Aptabase's own FAQ: "it's not possible to perform user-level analytics such as Monthly Active Users or User Retention"). Custom dashboards are an open, unimplemented feature request since 2023 (issue #19, still "+1"'d in March 2026).

You can only **approximate** UX friction, and only with explicit instrumentation you write yourself:

- **Rage-click / retry proxy:** emit a distinct event when the same action is retried within N seconds (`{ retryCount }`).
- **Drop-off proxy (manual funnel):** emit one named event per step of a flow (`wizard_step_1_shown`, `…_2_shown`, …) and compare step-N vs step-(N+1) counts over the same period. There is no built-in funnel UI; you eyeball the counts.
- **Abandonment proxy:** fire an "abandoned" event on `beforeunload`/`visibilitychange` when a required step wasn't completed.

**Every one of these proxies is client-side** (they observe browser interaction), so they land squarely on the locked "no `@aptabase/web` instrumentation" non-goal. That makes Q3 a **product decision, not a task** — see §6. Aptabase is genuinely the wrong tool for deep UX-friction analysis; if that's a real need, it's a session-replay-class tool (PostHog, Sentry Replay, etc.), each with its own — heavier — DSGVO footprint.

---

## 3. GDPR / DSGVO assessment — already best-practice, keep it

Our current design is, if anything, _more_ privacy-preserving than a typical Aptabase web integration, and there is little to "fix":

- **No cookies, no localStorage, no persistent identifier** — we don't even store the ephemeral `sessionId` across restarts. (Aptabase itself sets no cookies; its web SDK sends `credentials: 'omit'`.)
- **Server-side egress means the client browser never contacts a third party at all** — the only surface that talks to Aptabase is the local herdr-server, and only after explicit consent.
- **Aptabase's own anonymization** derives an "anonymous user" as `SipHash-2-4(dailySalt, IP + UserAgent)` with a **per-app, per-day salt that is purged daily** (`DailyUserHasher.cs`, `PurgeDailySaltsCronJob`) — no raw IP stored, no cross-day or cross-app correlation. Aptabase argues this is true anonymization (GDPR Recital 26 → outside scope), hence no cookie banner required.
- **EU data residency**: our default key is `A-EU-*` → `eu.aptabase.com` (Germany region). Self-hosting is a config-only switch (`SHEPHERD_APTABASE_HOST`) with zero code change if we ever want full residency control.
- **Consent + DNT**: explicit first-run prompt, no default, `DO_NOT_TRACK` hard-off. This exceeds what Aptabase strictly requires.

**One caveat to record, not act on:** whether a daily-salted hash of (IP + UA) is legally "anonymous" vs "pseudonymous" under a strict CJEU reading is a genuinely debated question in EU data-protection circles (regulators have sometimes treated salted/hashed IPs as pseudonymous). Aptabase's daily-rotation-and-purge design is a strong good-faith argument for anonymization, but "no consent needed" is _Aptabase's_ positioning, not a regulatory ruling. **We already require opt-in consent anyway, so we're covered regardless of how that debate resolves** — this only matters if we ever consider dropping the consent gate (we shouldn't).

**Recommendation: change nothing about the privacy architecture.** Any coverage expansion in §4 must preserve the two invariants that make this clean: (a) props are a **primitive allowlist of counts/enums**, never strings/paths/free text; (b) it stays **server-side** unless §6 is explicitly decided otherwise.

---

## 4. Recommendation A — expand the server-side event catalog (the main lever)

This is the highest-value, lowest-risk change and stays entirely within the locked v1 design. Principle: **instrument the _verbs_ that already flow through a herdr-server choke point** — no client code, no new consent surface, no scrub risk. Name the _action_ as the event; use a primitive-allowlist prop for the _variant_.

Candidate additions (to be **curated** with the team, not wired blindly — this is a menu, not a spec):

| Candidate event         | Choke point           | Props (primitive allowlist)                                                   | Answers                                |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| `session_archived`      | session lifecycle end | `{ outcome, hadPr, durationBucket }`                                          | session completion vs abandonment rate |
| `session_resumed`       | resume path           | `{ }`                                                                         | is resume actually used?               |
| `plan_gate_decision`    | plan approve/reject   | `{ decision }` (approved/rejected/edited)                                     | plan-gate adoption + reject rate       |
| `review_action`         | review controls       | `{ action }` (approve/request-changes/comment)                                | is the review flow used?               |
| `backlog_drain_started` | backlog drain trigger | `{ source }` (manual/auto)                                                    | backlog feature adoption               |
| `epic_created`          | epic creation         | `{ childCount }`                                                              | epics vs single sessions               |
| `automation_toggled`    | automation panel      | `{ kind, enabled }`                                                           | which automations get turned on        |
| `setting_changed`       | `/api/settings` PUT   | `{ key }` (enum of setting keys, **never the value** unless it's a bool/enum) | which settings users actually touch    |
| `pr_merged`             | PR merge transition   | `{ agentProvider }`                                                           | full session→merge conversion          |

**Cross-reference discipline (the "never used" answer):** maintain the `TelemetryEventName` union (already the single source of truth in `src/telemetry.ts:5`) as the canonical catalog. "Feature X is never used" = "X's event is in the union but absent from `top-events`." Without this discipline, absence is ambiguous. Consider a short comment block in `telemetry.ts` mapping each event → the feature it proves, so the dashboard is interpretable months later.

**What to resist:** a single generic `ui_click` / `action` event with a free-form `target` string prop. It defeats `top-events` (everything collapses into one row), invites PII into the prop, and fights Aptabase's whole model. One named event per meaningful action is both the Aptabase-idiomatic pattern and the DSGVO-safe one.

## Recommendation B — event-modeling hygiene (cheap, do alongside A)

Confirmed hard limits from the backend validator (`EventBody.cs`) — none are documented in prose, so worth pinning here:

- **Event name ≤ 60 chars**; `snake_case` (our convention already matches).
- **Property key ≤ 40 chars.** **String value truncated to 180 chars server-side, silently** (`"…"` appended) — another reason to keep props enum/numeric, not text.
- **Booleans are stringified** to `"true"`/`"false"` server-side; arrays/objects become the literal `"[Array]"`/`"{Object}"`. So only strings and numbers carry real information — our current bool props (`autopilot`, `research`, …) are fine but are effectively low-cardinality enums.
- `SystemProps.Locale` **≤ 10 chars** or the whole event is rejected HTTP 400 — we already normalize for this (`normalizeLocale`, `src/telemetry.ts:69`); keep that guard, it silently protects every event.
- Batch endpoint **≤ 25 events/request** (we honor this: `MAX_BATCH = 25`). Timestamps older than 1 day (or future +10 min) are rejected — irrelevant for our near-real-time flush, but note if we ever add offline buffering.

## Recommendation C — small robustness touches (optional)

- **Bounded retry before drop.** Today `flush()` swallows any error and drops the batch (`src/telemetry.ts:139`). The spec envisioned "retry with bounded backoff." A single retry would materially reduce silent loss without risking the app — the counts are already approximate, so this is low-priority polish, not a correctness fix.
- **Keep `isDebug` honest.** We hardcode `isDebug: false` (`src/telemetry.ts:100`). Aptabase separates Debug vs Release in the dashboard; if we ever want to exclude dev/CI installs from product numbers, wiring `isDebug` to a dev/prod signal keeps the production dashboard clean. Minor.

---

## 5. Should we adopt the official `@aptabase/web` SDK? No.

For completeness, since "optimize our integration" could imply swapping in the SDK: **don't.** For our server-side, batched, consent-gated use case the hand-rolled client is strictly better:

- There is **no official Node/server SDK** and **no `@aptabase/svelte`** — only `@aptabase/web` (browser). `@aptabase/web` does **no batching** (one `fetch` per `trackEvent`), **no retry**, **no offline buffer**, and **no DNT/opt-out** support — all of which our client either does (batching to 25) or gates upstream (consent/DNT). Adopting it would be a downgrade _and_ would drag us onto the client, reopening the consent/scrub surface v1 deliberately closed.
- Our direct-to-HTTP-API approach is exactly what Aptabase's own "build your own SDK" wiki endorses for non-browser runtimes.

---

## 6. The one genuine product decision — client-side instrumentation for Q3

The UI-comprehension question (Q3) cannot be answered without client-side event instrumentation, which v1 explicitly excluded. This is a real trade-off for the team to decide, not something to wire silently:

- **Option 1 — Stay server-only (status quo).** Accept that "UI comprehension problems" are out of scope for telemetry; rely on qualitative signals (user reports, dogfooding, the What's-New/coachmark system). Cheapest, keeps the single consent gate and single scrub surface intact. Recommended default unless UX-friction data is a concrete, prioritized need.
- **Option 2 — Add a _narrow_ client-side layer inside the existing consent gate.** Introduce `@aptabase/web` (or route client events through the existing herdr-server so the scrub surface stays single) for a **small, curated** set of friction proxies (route-view, retry, abandonment) — reusing the _same_ `telemetryConsent`. This revisits a locked non-goal, so it needs an explicit spec amendment and a fresh scrub review, but it's the only way to get even approximate UX-friction signal from Aptabase.
- **Option 3 — Different tool for UX friction.** If real rage-click/replay/funnel analysis is wanted, that's a session-replay-class product (PostHog, Sentry Replay). Materially heavier DSGVO footprint (persistent IDs, cookies, replay data) — almost certainly not worth it for a privacy-first local dev tool, but named for completeness.

**Recommendation:** ship Recommendation A (server-side coverage) now — it delivers Q1 + Q2 fully and inside the current design. Treat Q3 as a separate, deliberate decision: default to Option 1, and only pursue Option 2 if UX-friction insight becomes a prioritized goal, via a spec amendment rather than a quiet code change.

---

## Sources

**Codebase:** `src/telemetry.ts`, `src/config.ts:464-479`, `src/index.ts:500-549,2372`, `src/server.ts:3893-4083`, `src/service.ts:2248`, `src/drain.ts:640`, `src/pr-opened-telemetry.ts`, `src/telemetry-consent.ts`, `test/telemetry.test.ts`, `docs/superpowers/specs/2026-07-02-aptabase-telemetry-design.md`, issue #1329 / PR #1342.

**Aptabase (source-authoritative, prose docs are thin):** ingestion validation `aptabase/aptabase/src/Features/Ingestion/EventBody.cs`; dashboard `…/Features/Stats/StatsController.cs`; anonymization `…/Features/Privacy/DailyUserHasher.cs`; web SDK `aptabase/aptabase-js/packages/web/src/index.ts` + `packages/shared.ts`; limitations confirmed in maintainer comments on issues [#19](https://github.com/aptabase/aptabase/issues/19) (custom dashboards, open since 2023), [#69](https://github.com/aptabase/aptabase/issues/69) (no user properties), [#108](https://github.com/aptabase/aptabase/issues/108) (no automatic/framework tracking); GDPR positioning [aptabase.com/legal/privacy](https://aptabase.com/legal/privacy) and [for-webapps](https://aptabase.com/for-webapps); self-hosting [aptabase/self-hosting](https://github.com/aptabase/self-hosting).

_Research artifact — no product code changed. Prepared 2026-07-03._
