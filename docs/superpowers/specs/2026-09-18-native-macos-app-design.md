# Native macOS app (iOS-ready) — design

**Date:** 2026-09-18 · **Status:** approved (brainstormed in-session) · **Scope:** MVP of a fully
native SwiftUI client for Shepherd that runs a local Shepherd server on macOS or connects to a
remote one; the shared Swift core is built so an iOS target can follow without re-architecting.

## Problem

Shepherd's UI is a SvelteKit SPA served by the Bun server and assumed to be same-origin: REST calls
use relative paths, the event and PTY WebSockets build their URL from `location.host`, and there is
no "connect to a server" surface. macOS is a second-class server target today (no launchd unit, no
`.app`, manual `bun run start`). The UI is already optimised for phones, so the operator wants a
native macOS app now and an iOS app later, with the macOS app able to stand up a sensible local
environment when no remote server is configured.

`docs/research/native-ios-client-vs-pwa.md` recommends against a native iOS app because Web Push
cannot work inside any iOS app wrapper. That constraint does not apply to macOS, and this design
does not use Web Push at all (see Notifications).

## Decisions (with the operator)

| Decision | Choice |
| --- | --- |
| Architecture | Fully native SwiftUI UI against the Shepherd HTTP/WS API. No embedded web view. |
| MVP scope | Connect (local or remote), login, session list, native terminal, local notifications. Epics, review, merge train, settings surfaces come in later sub-projects. |
| Local server | The app manages the existing installer checkout under `~/.shepherd/app`. It does not bundle Bun/Node/herdr. |
| API contract | Hand-written OpenAPI 3.1 for the subset the native client uses, validated in CI against the real server, Swift code generated from it. |
| Terminal | SwiftTerm via Swift Package Manager. |
| Distribution | Ad-hoc / unsigned local builds for now. Developer ID + notarisation is a later sub-project. Mac App Store is ruled out (sandbox forbids child processes and `~/.shepherd`). |
| Location | Sixth package in the monorepo under `native/`, plus `contracts/` at the root. |
| Platforms | macOS 15+, iOS 18+ (Xcode 26, Swift 6.3 available on the operator's machine). |

## Sub-project decomposition

The full native app is too large for one plan. This spec is the umbrella architecture; each row
below gets its own implementation plan under `docs/superpowers/plans/`.

| # | Sub-project | Depends on | Deliverable |
| --- | --- | --- | --- |
| 1 | API contract | — | `contracts/openapi.yaml`, Bun drift test, CI job |
| 2 | ShepherdKit | 1 | Swift package: client, auth, event stream, PTY connection, stores, tests |
| 3 | ShepherdLocalServer | — (parallel with 2) | macOS-only Swift module: toolchain check, installer bridge, process supervisor, log parser |
| 4 | Shepherd for Mac (MVP) | 2, 3 | SwiftUI app: welcome/connect, session list, terminal, menu bar, notifications |
| 5 | Remaining surfaces | 4 | Epics, review, merge train, settings, uploads |
| 6 | iOS target | 2, 4 | Same kit, mobile navigation, no local server |
| 7 | Signing & release | 4 | Developer ID, notarisation, Sparkle, release-please wiring |

Sub-projects 5 to 7 are out of scope for this spec beyond the constraints they impose on 1 to 4.

## Architecture

```
native/
  Package.swift                    # SPM manifest: ShepherdKit, ShepherdLocalServer, tests
  Sources/ShepherdKit/             # platform-neutral (macOS 15+, iOS 18+)
    Generated/                     # swift-openapi-generator output from contracts/openapi.yaml
    Client/                        # ShepherdClient: REST, auth header, retry, error mapping
    Realtime/                      # EventStream (/events), PTYConnection (/pty/:id)
    Model/                         # ServerProfile, SessionStore, ConnectionState
    Credentials/                   # CredentialStore protocol + Keychain implementation
  Sources/ShepherdLocalServer/     # macOS only
    Toolchain/                     # ToolchainProbe: bun, node, herdr, claude, gh, git
    Install/                       # InstallerBridge around deploy/install.sh
    Supervisor/                    # ServerProcess: spawn, log parse, restart policy, SIGTERM
  Apps/ShepherdMac/                # Xcode project, SwiftUI, AppKit where needed
  Apps/ShepherdMobile/             # placeholder iOS target compiling against ShepherdKit
  Tests/ShepherdKitTests/
  Tests/ShepherdLocalServerTests/
  scripts/gen-strings.sh           # ui/messages/{en,de}.json -> Localizable.xcstrings subset
contracts/
  openapi.yaml                     # the contract; only source of server types in Swift
test/contract/                     # Bun drift test (runs under `bun run test`)
```

Principles:

- **ShepherdKit has no UI dependency.** It exposes `@Observable` stores and `AsyncStream`s.
  Both apps are thin SwiftUI layers.
- **Server profiles replace same-origin.** `ServerProfile { id, name, baseURL, mode: .local |
  .remote, credentialKey }`. The app keeps any number of profiles; one is active.
- **The contract is the only type source.** No hand-written `Codable` for server payloads. A route
  or event the client needs must be added to `contracts/openapi.yaml` first.
- **Localisation mirrors the web catalogs.** `scripts/gen-strings.sh` extracts the keys the app
  uses from `ui/messages/en.json` and `de.json` into an `.xcstrings` catalog. New app-only copy is
  added to both JSON catalogs first (repo i18n rule), never only in Swift.
- **No App Sandbox.** Required for child processes and `~/.shepherd`. Hardened Runtime is enabled
  from the start so signing later is a config change, not a refactor.

## Sub-project 1: API contract

`contracts/openapi.yaml` (OpenAPI 3.1) describes exactly the routes and realtime messages the
native client uses. Initial surface:

| Area | Routes |
| --- | --- |
| Health / auth | `GET /api/health`, `POST /api/login`, `POST /api/logout`, `POST /api/access-tokens`, `GET /api/access-tokens`, `DELETE /api/access-tokens/{id}` |
| Settings | `GET /api/settings`, `PUT /api/settings` (repoRoot only) |
| Sessions | `GET /api/sessions`, `GET /api/sessions/done`, `GET /api/sessions/{id}`, `POST /api/sessions`, `DELETE /api/sessions/{id}`, `POST /api/sessions/{id}/interrupt` |
| Repos | `GET /api/repos` |
| Realtime | `WS /events` envelope `{event, data}` with schemas for `session:new`, `session:status`, `session:renamed`, `session:archived`, `session:block`, `session:ready`, `automerge:status`, `usage:limits`; inbound presence frame. `WS /pty/{id}` documented as an `x-shepherd-pty` extension (query `cols`, `rows`; raw bytes; resize frame `\x00resize:<cols>:<rows>\n`; close codes 4000 superseded, 4001 gone). |

Schemas are written from `src/types.ts` (`Session`, `SessionStatus`, `AgentProvider`, models,
efforts, `CreateSessionInput`, `RepoEntry`, access-token entry). Enums are copied verbatim so
Swift gets real enums.

Drift test (`test/contract/openapi.test.ts`, Bun): starts the real HTTP/WS server in-process
with `serve(deps, 0)` and the stubbed `herdr`/`worktree` deps that `test/server.test.ts` already
uses (CI has neither herdr nor `claude` installed, and no existing test boots `src/index.ts`).
It logs in, mints a token, calls every route in the contract with fixture inputs, and validates
each response with `ajv` (already a dependency) against the contract's response schema. It also
subscribes to `/events`, drives one session through create → archive so the server emits real
`session:new` / `session:archived` frames, and emits the remaining contract events through the
same `EventHub` from fixtures typed with the server's own TypeScript types, so a type change in
`src/` breaks `bun run typecheck` before it can drift. Unknown event names are ignored. Any route
or event in the contract that the test does not exercise fails the test, so the contract cannot
contain untested surface.

Generator input: Apple's swift-openapi-generator does not support `oneOf`/`anyOf` branches of
`type: "null"`, `null` inside `enum`, or `const`, and its enums are closed. The truth file keeps
those constructs (the drift test needs them); `scripts/gen-contract-swift.ts` derives the
committed `contracts/openapi.swift.yaml` (nullable refs become optional, `null` leaves enum
lists, `const` is dropped, read-side enums flagged `x-shepherd-open-enum` become the open-enum
`anyOf` pattern with a named `<Name>Known` closed enum). `bun run check:contract-swift` and a
freshness test under `bun run test` keep the derived file current. Swift is generated ONLY from
the derived file.

CI: the existing `ci.yml` runs the drift and freshness tests as part of `bun run test`. A new
`native.yml` job on `macos-latest` (owned by sub-project 2) runs `check:contract-swift`, checks
that the copy of the derived file inside the Swift package is current, and runs `swift build` +
`swift test`. Generated Swift is not committed (build plugin), so "current derived file plus a
green build" is the freshness gate.

Server changes required: none for auth or transport. One addition: `GET /api/health` gains
`{ok, version, minClient?}` so the app can show "server newer/older than app". `version` is the
root `package.json` version.

## Sub-project 2: ShepherdKit

**ShepherdClient.** Wraps the generated OpenAPI client. Adds the `Authorization: Bearer` header
from `CredentialStore`, maps HTTP 401 to `ShepherdError.unauthenticated` (clears the token and
publishes a `needsLogin` state), 409 `first_run_pending` to `.firstRunPending`, decode failures to
`.contractMismatch(route, underlying)`. Retries idempotent GETs three times with backoff.

**Auth flow.** `ProfileSetup.login(profile, password)` posts to `/api/login` with an ephemeral
cookie jar, immediately mints an access token (`name: "Shepherd for Mac (<hostname>)"`, `scope:
full`, `expiresInDays: null`), stores it in the Keychain under `profile.credentialKey`, then
discards the cookie. The password is never persisted. Logout revokes the token via
`DELETE /api/access-tokens/{id}` when reachable and always clears the Keychain entry.

**EventStream.** Opens `/events` with the Bearer header on the upgrade request. Yields decoded
envelopes as an `AsyncStream<ServerEvent>`. Reconnects after 1 s on close, immediately on
`applicationDidBecomeActive`. Sends `{type:"presence", active}` on focus changes so the server
suppresses browser push while the app is focused.

**SessionStore.** `@Observable`. Holds `[Session]` keyed by id, applies events the way
`ui/src/lib/store.svelte.ts::apply` does for the events in the contract, exposes `create`,
`archive`, `interrupt`, `refresh`. Initial load: `GET /api/sessions`, `GET /api/settings`,
`GET /api/repos`.

**PTYConnection.** One per attached terminal. Connects to `/pty/{id}?cols=&rows=` with the Bearer
header, exposes `AsyncStream<Data>` for output, `send(Data)` for input, `resize(cols, rows)` which
writes the control frame. Close 4000 → `.superseded` (no auto-reconnect; caller offers "take
over"), 4001 → `.gone`. Other closes retry every 1 s; eight consecutive attaches that die within
4 s → `.unreachable`, mirroring `ui/src/lib/pty.ts`.

**CredentialStore.** Protocol with a Keychain implementation and an in-memory implementation for
tests and previews.

**Tests.** A `FakeShepherdServer` (Swift, `URLProtocol` + a local WebSocket listener) replays
fixtures built by encoding the generated contract types, so kit fixtures cannot disagree with
the contract and need no build-order coupling to the Bun drift test. Coverage: auth flow, 401 handling, store event application, PTY close-code semantics,
reconnect policy.

## Sub-project 3: ShepherdLocalServer (macOS)

**ToolchainProbe.** Locates `bun`, `node`, `herdr`, `claude`, `gh`, `git` on the PATH the app
constructs (login-shell PATH plus `~/.local/bin`, `~/.bun/bin`, Homebrew prefixes). Reports
version and status per tool. `herdr` must equal `HERDR_LAST_SUPPORTED_VERSION` from
`src/herdr-capabilities.ts`; the probe reads that file from the checkout rather than hard-coding.

**InstallerBridge.** Runs `deploy/install.sh` with `SHEPHERD_INSTALL_LIB=1` semantics for the
steps the app needs (clone/update `~/.shepherd/app`, install Bun, Node, pinned herdr, build UI).
The script gains a non-interactive mode flag if any step currently prompts; the app streams its
output into the setup checklist. `claude` and `gh` logins stay external: the app detects the
missing login and links the docs. The app does not reimplement installer logic.

**ServerProcess.** Spawns `bun run start` (working directory `~/.shepherd/app`, environment from
`~/.shepherd/env` plus `SHEPHERD_HOST=127.0.0.1`) via `Process`. Parses stdout for
`shepherd core on http://localhost:<port>` (ready), the one-time password banner (surfaced once in
the UI and used for the first login), and exit codes. Restart policy: up to three automatic
restarts within five minutes, then `.failed` with the tail of the log. Shutdown: SIGTERM, wait up
to 10 s, then SIGKILL. The server lives as long as the app; "keep running after quit" is not in
the MVP.

**External server detection.** Before spawning, `GET http://localhost:7330/api/health`. If it
answers, the profile is marked `.local(externallyManaged)` and the app does not supervise it.

**Update.** A menu action runs the installer bridge's update step (`git pull` + UI build) and
restarts the process. Never automatic.

## Sub-project 4: Shepherd for Mac (MVP app)

**Welcome / connect.** Shown when no profile is active. Two cards: "Run on this Mac" (default when
port 7330 is free or a local Shepherd answers) and "Connect to a remote server" (URL, password).
Remote URL validation accepts `http(s)://host[:port]`; Tailscale hostnames are the expected case.

**Local setup.** A four-step checklist (detect, check, install, start) backed by
`ShepherdLocalServer`, each step with status, expandable log, and retry. After start, the app logs
in with the parsed one-time password, mints the token, shows the password once with a copy button,
then presents a native folder picker for the workspace root and calls `PUT /api/settings`.

**Main window.** `NavigationSplitView`: sidebar with session list (status badge, designation,
name, provider), detail pane with the terminal. Toolbar: new session, interrupt, archive, profile
switcher. New-session sheet covers the `StandardCreateInput` fields in the contract (repo, prompt,
provider, model, effort). Multiple terminals may be open in tabs; each is one `PTYConnection`.

**Terminal view.** SwiftTerm `TerminalView` bound to a `PTYConnection`. Font JetBrains Mono when
installed, otherwise the system monospace font. Option-drag forces local selection (Claude Code
enables mouse tracking). Superseded state shows an overlay with "Take over"; gone state shows
"Session ended".

**Menu bar item.** Server status dot (green running, yellow starting, red failed, grey remote),
active profile name, actions: open window, restart local server, show logs, quit.

**Notifications.** `UNUserNotificationCenter` local notifications from `session:status` (done),
`session:block` (blocked/needs review), `automerge:status` (merge attention), `usage:limits`.
Titles and bodies come from the same catalog keys `src/push.ts::buildPayload` uses. Suppressed for
the session currently in the foreground terminal. Clicking opens the session.

**Error surfaces.** 401 → back to the profile with a login sheet. Network loss → non-blocking
banner with retry; the store keeps its last state. Contract mismatch → banner "Server and app
versions differ" with both versions from `/api/health`.

## Cross-cutting

- **i18n.** EN and DE only, keys mirrored from the web catalogs, generated at build time.
- **Logging.** `os.Logger` subsystems `run.shepherd.kit`, `run.shepherd.localserver`,
  `run.shepherd.mac`. Server stdout is kept in a ring buffer of 2 000 lines for the log window.
- **Security.** Tokens only in the Keychain. Remote profiles require `https` unless the host is
  loopback or a `.ts.net` name. No password persistence. Server bound to loopback when the app
  spawns it.
- **Docs.** `docs-site` gets a "Shepherd for Mac" getting-started page in sub-project 4, and the
  macOS row in the support table is updated.

## Testing summary

| Layer | Tool | What it proves |
| --- | --- | --- |
| Contract | Bun + ajv against real server | Every contract route/event matches reality |
| ShepherdKit | `swift test` with fixture-driven fake server | Client, store, PTY, auth semantics |
| LocalServer | `swift test` with fake `Process` output | Probe, log parsing, restart policy |
| App | Xcode UI tests (smoke) | Welcome → local start → session list renders |
| CI | `ci.yml` (contract), `native.yml` on `macos-latest` (build, test, generated-code drift) | Nothing merges with a stale contract or client |

## Orchestration plan (how this gets built)

1. Sub-project 1 first, single Opus worker, Claude review plus a `codex review` pass.
2. Sub-projects 2 and 3 in parallel git worktrees. Kit core (client, realtime, auth) on Opus;
   fixtures, LocalServer probe/parser and tests on Sonnet.
3. Sub-project 4 after 2 and 3 land; views on Sonnet, integration and lifecycle glue on Opus.
4. Every plan task ends with `swift build`/`swift test` (or `bun run test`) evidence, a Claude
   code review and a Codex review. Findings are triaged by the orchestrator before merge.
5. Each sub-project is one PR from a branch cut from `origin/main`, rebased, never merged forward.

## Out of scope for the MVP

Epics, review queue, merge train, settings beyond repo root, uploads, previews, plugin
management, Sparkle updates, code signing, the iOS app itself (only a compiling placeholder
target), "keep server running after quit", multiple simultaneous local servers.
