# Shepherd Capture — Chrome extension (Phase 1 MVP) design

Issue: [#308](https://github.com/erwins-enkel/shepherd/issues/308) — _feat: Chrome extension — capture browser context into Shepherd tasks_.

## Scope of this branch

**Spec + a working Phase 1 MVP.** The extension captures the active tab's
**screenshot + metadata** and files it as a **live Shepherd session** via the
task API (spawn-now), with a single configured target repo. This proves the
end-to-end pipe. The issue's later phases are explicitly **out of scope** here
but the architecture leaves clean seams for them (see _Out of scope_).

Settled decisions (from brainstorming):

- **Screenshot:** viewport-only (`chrome.tabs.captureVisibleTab`). Full-page
  stitch is deferred (Phase 4).
- **Delivery path:** spawn-now only (Shepherd task API). GitHub-issue path
  deferred (Phase 2).
- **i18n:** Paraglide for all popup/options chrome; manifest title is the
  untranslated product name. EN+DE parity from day one, gated.
- **Testing:** vitest on pure logic + a documented manual load-unpacked
  checklist. No `chrome.*` in automated tests.
- **Toolchain confirmed:** `@crxjs/vite-plugin@2.4.0` declares Vite `^8` peer
  support — works against this repo's Vite 8 / Svelte 5 / Tailwind 4.1 stack.

## Package & toolchain

New root package `extension/` (own `package.json`, `bun` for deps), mirroring
how `ui/` is a separate package.

- **Build:** Vite 8 + `@crxjs/vite-plugin@2.4.0` (MV3 HMR), TypeScript.
- **UI:** Svelte 5 + Tailwind 4.1 (consistent with `ui/`).
- **i18n:** `@inlang/paraglide-js` (same major as `ui/`).
- **Types:** `@types/chrome` (the only dev dep outside the repo's usual stack;
  approved).
- `manifest.config.ts` produces the MV3 manifest.

**Manifest (Phase 1):**

- `manifest_version: 3`, `name: "Shepherd Capture"`, action with
  `default_title: "Shepherd Capture"` (product name — untranslated) and
  `default_popup`.
- **Permissions:** `activeTab`, `scripting`, `tabs`, `storage`.
- **`host_permissions`:** `http://localhost:7330/*` only. **Phase 1 is
  localhost-only.** Remote/Tailscale (`*.ts.net`) requires an
  `optional_host_permissions` + `chrome.permissions.request` flow, deferred to a
  later phase (the options UI + README are scoped to localhost to match).
- **No** `debugger`, **no** `api.github.com`, **no** `commands` shortcut yet
  (Phases 2–4).

`CLAUDE.md`'s package table gains an `extension/` row:
`cd extension && bun install` / `bun run lint` / `bun run check` / `bun test`.

## Components & boundaries

The popup/options **never** call `fetch` directly — they message the background
service worker, which owns all extension-origin network calls. This gives a
single auth path and predictable CORS (`Origin: chrome-extension://<id>`).

| Unit                       | Purpose                                                                                                                                                                | Depends on                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `src/lib/types.ts`         | Shared types: `CaptureConfig`, `PageMetadata`, `CaptureResult`, `SpawnRequest`, `TransportError`, message envelopes.                                                   | —                         |
| `src/lib/config.ts`        | `chrome.storage.local` get/set of `CaptureConfig` (`baseUrl`, `token?`, `repoPath`, `baseBranch`, `model?`). `storage.local`, **not** synced (token never syncs).      | types                     |
| `src/lib/context-block.ts` | **Pure.** Formats `PageMetadata` into the fenced markdown context block appended to the prompt.                                                                         | types                     |
| `src/lib/transport.ts`     | **Pure** (takes an injected `fetch`). `uploadScreenshot()` → `POST /api/uploads` (multipart `file`) → `{path}`; `createSession()` → `POST /api/sessions`. Bearer auth. Maps non-2xx → typed `TransportError` (401/403/400/415/network). | types                     |
| `src/background.ts`        | Service worker. On action-click / popup message: `captureVisibleTab` (PNG dataURL), inject a small `document.idle` fn for page metadata, read config, run upload→session via `transport.ts`, return result/error to popup. | transport, config, capture |
| `src/lib/capture.ts`       | Helpers around capture: dataURL→`Blob`, merge `chrome.tabs.Tab` fields + injected page-info into `PageMetadata`. Pure parts unit-tested; chrome calls isolated.        | types                     |
| `popup/` (Svelte 5)        | Review/edit prompt; show screenshot thumbnail + metadata; submit (spawn-now); success shows `desig` (`TASK-NN`); readable errors; "configure first" empty state.       | messages, config (read)   |
| `options/` (Svelte 5)      | Configure `baseUrl`, `token`, `repoPath`, `baseBranch`, `model`. Save to `config.ts`.                                                                                  | config, messages          |
| `messages/{en,de}.json`    | Paraglide catalogs. All user-facing chrome. EN+DE parity.                                                                                                              | —                         |

### Why these boundaries

`transport.ts` and `context-block.ts` are pure and `fetch`-injected so the
network contract and the prompt formatting are unit-testable without a browser.
`background.ts` is the only unit that touches `chrome.*` orchestration and is
verified via the manual checklist. The popup/options are thin Svelte views over
`config.ts` + worker messages.

## Data flow (spawn-now)

1. User clicks the toolbar icon → popup opens; popup asks the background worker
   to capture.
2. Background: `chrome.tabs.captureVisibleTab` → PNG dataURL; inject metadata fn
   → `{ url, title, viewportW/H, devicePixelRatio, userAgent, locale, timestamp }`.
3. Popup renders screenshot thumbnail + metadata; prompt textarea (empty/edit);
   shows the single configured target repo. User edits prompt, submits.
4. Background runs the transport sequence:
   - `POST /api/uploads` with the PNG `Blob` as multipart `file` → `{ path }`
     (confined staging path).
   - `POST /api/sessions` with
     `{ repoPath, baseBranch, prompt: userText + "\n\n" + contextBlock, images: [path], model? }`
     and `Authorization: Bearer <token>` if a token is configured.
5. `201` → popup shows success with the returned `desig`. Session appears live
   in the HUD with the attached image. Non-2xx → typed, localized error.

The appended **context block** (Phase 1 content): URL, title, viewport size,
device pixel ratio, user agent, locale, capture timestamp — fenced so the agent
reads it as data, not instruction. (Console/network + a11y sections are added in
Phase 3; the formatter is structured to take optional sections.)

## i18n

- Paraglide in `extension/`: `messages/en.json` + `messages/de.json`, compiled
  to `m.*` imports, called from popup + options + any worker-surfaced user text.
- Port `ui/`'s `check:i18n` parity gate into `extension/` (script +
  `bun run check:i18n`), wired into the package's lint/CI and — like `ui/` —
  asserting an identical, non-empty key set across both locales.
- Manifest `name`/`action.default_title` = `"Shepherd Capture"` (product name,
  not translated). The manifest **`description`** _is_ authored chrome, so it's
  localized MV3-native via `default_locale: "en"` + `description:
  "__MSG_ext_description__"` resolved from `public/_locales/{en,de}/messages.json`
  (these ship in `dist/_locales/`). That `_locales` catalog is tiny (one key) and
  kept in EN+DE parity by hand; the keyboard `commands` description (Phase 4) will
  add to it.
- Captured/passthrough data (page URL, title, UA, the user's prompt) is **not**
  translated — only chrome the extension authors.

## Transport & auth (integration contract)

- **Origin guard:** the extension's `fetch` sends `Origin:
  chrome-extension://<id>`. Shepherd's `originAllowed` does
  `new URL(origin).hostname`, which for `chrome-extension://<id>` resolves to the
  **raw extension ID**. So the **extension ID** (not the literal
  `chrome-extension`) must be added to `SHEPHERD_ALLOWED_HOSTS`. The README
  documents this; a `403` surfaces a message naming the fix.
- **Auth token:** if configured, send `Authorization: Bearer <token>`. Stored in
  `chrome.storage.local` (never synced). A `401` surfaces a "check token"
  message.
- **Base URL:** configurable, **Phase 1 localhost-only** (`http://localhost:7330`;
  the manifest grants only that host). Remote `ts.net` is deferred (needs the
  optional-host-permission flow above). Never hardcoded; drives `host_permissions`
  guidance in the
  README.
- **Repo confinement:** `repoPath` must resolve inside `SHEPHERD_REPO_ROOT` or
  the API rejects `400`. Since `400` covers any validation failure (not just
  confinement), the popup surfaces the server's own `detail` rather than a fixed
  message.

## Errors & edge cases

| Condition                          | Behavior                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ |
| No config yet                      | Popup shows a "configure first" state with a button opening the options. |
| `chrome://` / web-store / PDF tab  | Capture/inject fails → readable "can't capture this page" message.       |
| `403` (origin not allowlisted)     | Localized error naming `SHEPHERD_ALLOWED_HOSTS` + the extension ID.       |
| `401` (auth)                       | Localized "check your Shepherd token".                                    |
| `400` (any validation failure)     | Localized "Shepherd rejected the request: <server detail>".               |
| `413` / `415` (upload too large / unsupported) | Localized "screenshot too large" / "format not supported".   |
| Network/base-URL unreachable       | Localized "couldn't reach Shepherd at <baseUrl>".                         |

All error strings route through Paraglide (EN+DE).

## Testing

- **vitest (pure units, no `chrome.*`):**
  - `transport.ts` with a mocked `fetch`: success path, upload→session
    sequencing (session uses the returned staged path), and `401/403/400/415`/
    network → correct typed `TransportError`.
  - `context-block.ts`: deterministic markdown for a known `PageMetadata`.
  - `config.ts`: shape round-trips (with a stubbed `chrome.storage.local`).
  - i18n parity (the ported `check:i18n`).
- **Manual load checklist** (`extension/README.md`): `bun run build` → load
  unpacked in Chromium → set `SHEPHERD_ALLOWED_HOSTS=<ext id>` on the server →
  configure base URL/token/repo in options → click capture → confirm a session
  appears live in the HUD with the attached screenshot and context block.
  Documents the origin/token/base-URL setup gotchas.

## Acceptance criteria (Phase 1 subset of #308)

- [ ] `extension/` builds (`bun run build`) into a loadable MV3 unpacked
      extension; lint + typecheck pass; `CLAUDE.md` package table updated.
- [ ] Clicking the icon captures screenshot + metadata and opens a populated
      popup.
- [ ] Submitting spawn-now stages the screenshot via `/api/uploads`, calls
      `/api/sessions`, and a session appears live in the HUD with the attached
      image + context block.
- [ ] All user-facing extension strings (popup, options, toasts, errors) route
      through Paraglide messages with EN+DE parity; a parity check fails the
      build if a key is missing from either locale.
- [ ] README documents `SHEPHERD_ALLOWED_HOSTS` (extension ID), `SHEPHERD_TOKEN`,
      base-URL, and repo-confinement requirements; auth/origin failures surface
      readable errors.

## Out of scope (deferred; seams left)

Filed as follow-ups; issue #308 stays open with Phase 1 checked off:

- **Phase 2:** GitHub-issue delivery path + the screenshot-attachment decision;
  URL→repo rules with manual override.
- **Phase 3:** console + network capture; axe-core a11y audit; per-signal
  toggles; element picker.
- **Phase 4:** full-page screenshot stitch; keyboard `commands` shortcut (brings
  the first translatable manifest string → revisit `_locales`); success/error
  toasts polish.

Seams that keep these cheap:

- Delivery path is a discriminated union with a single `spawn-now` variant now;
  the GitHub variant adds a case, not a rewrite.
- `context-block.ts` takes optional sections, so console/network + a11y append
  without touching the spawn path.
- `config.ts` holds a single repo now; the URL→repo rules list is an additive
  config shape + a resolver unit.

## Unresolved questions

_(All brainstorming questions resolved; recorded here for traceability.)_

1. Follow-up phases → separate GitHub issues; #308 stays open, Phase 1 boxes
   checked. ✅
2. `model` selector → options-only for MVP (no popup clutter). ✅
3. `@types/chrome` as the sole non-stack dev dep → approved. ✅
