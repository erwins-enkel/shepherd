# Anonymous usage telemetry via Aptabase

## Problem

Shepherd ships as a locally-installed dev tool (Bun/Node herdr-server +
SvelteKit UI on `127.0.0.1`). There is **no signal** on how many installs are
active, on which platforms/versions, or which features get used — every product
decision is made blind. Vercel Web Analytics (recently added to the marketing +
docs sites) is browser/deployment-bound and cannot observe a local install, so
it is the wrong tool for this.

We want **privacy-first, anonymous** telemetry from local installs, with
explicit consent and a clean opt-out — appropriate for a technical, privacy-
sensitive audience and a BUSL-licensed tool.

## Goal

Add opt-in, anonymous usage telemetry emitted from the herdr-server to
[Aptabase](https://aptabase.com) (open-source, privacy-first, GDPR-by-design,
managed cloud **or** self-hostable), gated behind an explicit first-run consent
prompt and a Settings toggle, honouring the `DO_NOT_TRACK` standard.

## Non-goals

- **No error/crash telemetry.** Health + feature usage only. Error capture
  overlaps Sentry's role and risks leaking paths/messages; out of scope for v1.
- **No client-side (`@aptabase/web`) instrumentation.** Server-only egress in
  v1 — one consent gate, one scrub surface. UI-only events are not collected.
- **No persistent install identifier.** We do not store a device/install UUID
  (see Anonymity). Unique-install counts are therefore approximate — accepted.
- **No offline/disk event persistence.** Best-effort in-memory buffering only;
  dropped events on a dev tool are acceptable.
- **No hosting decision baked into code.** Self-host vs. Aptabase Cloud is a
  deploy-time env value, not a code change (see Hosting-agnostic).
- **No new runtime SDK dependency.** Aptabase has no official Node/server SDK
  (only browser-oriented `@aptabase/web`/`react`/`angular`/Electron/Tauri); we
  post directly to the documented HTTP API.

## Decisions (locked)

| Question         | Decision                                                             |
| ---------------- | ------------------------------------------------------------------- |
| Provider         | Aptabase                                                            |
| Consent model    | **Prompt on first run, no default** (`telemetryConsent = "unset"`)  |
| Data scope       | **Health + feature usage** (curated events, no errors)             |
| Emit surface     | Server-side thin HTTP client (approach A)                           |
| DNT              | Honour `DO_NOT_TRACK` env (hard-off, skips prompt)                  |
| Hosting          | Undecided — designed hosting-agnostic (config-only switch)          |

## Design

### 1. Config (`src/config.ts`)

Three new inputs, following the existing env-seeds-config pattern:

- `SHEPHERD_APTABASE_APP_KEY` — the Aptabase App-Key (e.g. `A-EU-1234567890`).
  **Absent ⇒ telemetry is a hard no-op** (forks, CI, and dev send nothing by
  default). This is the master enable.
- `SHEPHERD_APTABASE_HOST` — optional endpoint override for **self-hosting**
  (e.g. `https://analytics.example.com`). When unset, the host is derived from
  the App-Key region prefix: `A-EU-…` → `https://eu.aptabase.com`, `A-US-…` →
  `https://us.aptabase.com`. `A-SH-…` (self-hosted keys) **require** the host
  override, else telemetry no-ops with a one-line startup warning.
- `DO_NOT_TRACK` — the [console DNT standard](https://consoledonottrack.com).
  Truthy (`1`/`true`) ⇒ telemetry hard-off **and** the first-run prompt is
  skipped (treated as denied, never persisted, always wins over stored consent).

### 2. Consent state (settings/DB, `/api/settings`)

Add `telemetryConsent: "unset" | "granted" | "denied"` to the settings store
(default `"unset"`), exposed through the existing `/api/settings` GET and
PUT-patch endpoints. This is the single persisted consent record.

### 3. Gating — all must be true to emit

1. `telemetryConsent === "granted"`
2. `DO_NOT_TRACK` unset/falsey
3. `SHEPHERD_APTABASE_APP_KEY` present (and host resolvable)

When any fails, `TelemetryService.track()` is a genuine no-op — no buffering, no
network. This matrix is the core tested invariant.

### 4. First-run consent prompt (no default)

On `telemetryConsent === "unset"` (and DNT unset), the UI surfaces a one-time
prompt wired to the existing `first-run` gate (`src/first-run.ts`):

- Design-system modal (`.scrim`/`overlay`, dims+blurs — per CLAUDE.md rule).
- Plain-language "what we collect / what we never collect" summary.
- Two explicit actions → sets `telemetryConsent` to `granted` / `denied` via
  the settings PUT. No pre-selected default.
- **No events emitted until answered.** `app_launched` fires only after grant.

### 5. `TelemetryService` (`src/telemetry.ts`)

A self-contained service (dependency-injected HTTP client for testability; no
store/server import cycles):

- **`track(event: TelemetryEvent, props?)`** — gate-checks, enriches, buffers.
- **Typed event registry** — the only events that can be sent, so nothing
  free-form leaks. v1 set: `app_launched`, `session_created`, `epic_drained`,
  `pr_opened`. Props are an allowlist of primitives (counts/enums), never
  strings/paths/messages.
- **`systemProps` (auto-enrichment):** `osName`, `osVersion`, `arch`,
  `appVersion` (from package.json, currently `1.40.0`), runtime + version
  (`bun@x`/`node@x`), `locale`, `sdkVersion` (our client id). **Never**
  hostname, username, cwd, or repo paths.
- **Session:** per-process `sessionId` generated at boot (crypto-random),
  rotating after Aptabase's inactivity window (≈1h) — matches how Aptabase
  derives sessions. No persistent identifier.

### 6. Transport (thin client → Aptabase HTTP API)

Post to `POST {host}/api/v0/events` (documented batch endpoint, ≤25
`EventBody` objects) with header `App-Key: {appKey}`:

- Best-effort, **never blocks** the app or agent work.
- In-memory buffer, flush in batches on interval / at capacity.
- Retry with bounded backoff; **drop silently** on persistent failure.
- No response body needed (Aptabase returns `200 {}`).

`EventBody` shape (per Aptabase docs): `timestamp` (ISO 8601), `sessionId`,
`eventName`, `systemProps`, `props`.

### 7. Anonymity

No persistent install ID is stored. Aptabase derives **approximate** unique
counts server-side from a daily-rotating `HMAC-SipHash(IP + User-Agent)`; we
do not defeat or supplement this. Consequence: two installs behind one NAT with
identical `systemProps` may collapse into one "user" for a day. Accepted as the
cost of maximal anonymity (see open question).

### 8. Hosting-agnostic

Self-host vs. Cloud is **purely** `SHEPHERD_APTABASE_HOST` + which App-Key is
provisioned — zero code difference. The undecided hosting choice is deferred to
a deploy-time env value; both are first-class.

### 9. UI surfaces (repo rules apply)

- **First-run consent prompt** component (§4).
- **Settings toggle** in `Settings.svelte`: "Send anonymous usage telemetry"
  with a link/disclosure of what's collected; flips `telemetryConsent`.
- **i18n:** all strings in EN + DE (`ui/messages/{en,de}.json`); `check:i18n`
  parity enforced.
- **Design system:** tokens only, canonical modal/scrim + toggle recipes.
- **Feature announcement:** one entry
  `ui/src/lib/feature-announcements/entries/v<next>-telemetry.ts` in the same
  PR (user-facing `feat`).
- **Glossary:** add a `telemetry` entry (external term → Wikipedia EN+DE) with
  EN+DE `gloss_telemetry_term`/`_def` keys.

## Testing

- **Gate matrix** — consent × DNT × app-key: `track()` is a no-op unless all
  three pass; the granted path emits. This is the load-bearing test.
- **Enrichment/scrub** — `systemProps` populated; no hostname/path/username;
  props restricted to the allowlist.
- **Batching/transport** — buffers, flushes ≤25, retries then drops; never
  throws into callers.
- **Real wiring (not a vacuous stub)** — assert the actual `track()` call site
  (e.g. `app_launched` in `index.ts`) POSTs the correct `App-Key` + body when
  granted, and is **not** invoked when denied/DNT/no-key (per house rule).
- **Settings** — PUT persists `telemetryConsent`; GET reflects it.

## Manual operator steps (deploy-time)

- Provision an Aptabase app (Cloud or self-hosted) and set
  `SHEPHERD_APTABASE_APP_KEY` (+ `SHEPHERD_APTABASE_HOST` if self-hosted) in the
  server environment. Without it telemetry stays a no-op — safe default.

## Open questions

- Persistent anonymous install ID for accurate unique counts, or none?
  (recommended: **none** — max anonymity, approximate counts)
- ~~Confirm v1 event set (`app_launched`, `session_created`, `epic_drained`,
  `pr_opened`) — right four, or adjust?~~ **RESOLVED (issue #1329):** the four-event
  set is ratified. Wiring decisions: `session_created` fires at the
  `SessionService.create()` choke point for every session; `epic_drained` at the
  drain's running→idle completion edge; `pr_opened` on a session's non-open→open PR
  transition (session PRs only — epic landing PRs are covered by `epic_drained`).
  Props are a primitive allowlist — `session_created`:
  `{ agentProvider, autopilot, research, planGate, fromIssue }`, `epic_drained`:
  `{ childCount }`, `pr_opened`: `{ agentProvider, isDraft }` — with **no `model`**
  (a `--model` value can be arbitrary free-form text).
- Data scope confirm: **health + feature usage** (the assumed default while you
  were away) — keep, or narrow to health-only / widen to include errors?
