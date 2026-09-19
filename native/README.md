# Shepherd for Mac

The macOS app under `Apps/ShepherdMac`, built on the `ShepherdKit` package in this directory.
The Xcode project is **generated** from `Apps/ShepherdMac/project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen) — never edit `Shepherd.xcodeproj`, it is
gitignored.

## Prerequisites

- Xcode 26.6 or newer (`xcodebuild -version`)
- `brew install xcodegen`
- [`bun`](https://bun.sh) (generates the string catalog and runs the sync/contract scripts)

## Build

```
native/scripts/build-app.sh Release
```

Produces `native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app`.

## Run

```
open native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app
```

## Test

```
native/scripts/test-app.sh
```

Runs both the Swift Testing unit bundle (`ShepherdTests`) and the XCUITest smoke bundle
(`ShepherdUITests`); the latter needs a real, logged-in GUI session — a window flashes on screen
while it runs. Pass `-only-testing:ShepherdTests` to scope the run to the unit bundle, which is
what CI's blocking job does:

```
native/scripts/test-app.sh -only-testing:ShepherdTests
```

Scope a run to just the UI smoke suite the same way:

```
native/scripts/test-app.sh -only-testing:ShepherdUITests
```

## Localisation

EN and DE only, mirrored from the web catalogs. Add or change copy in
`ui/messages/en.json` **and** `ui/messages/de.json` first, then regenerate:

```
native/scripts/gen-strings.sh
```

`bun native/scripts/gen-strings.ts --check` fails if the committed catalog is
stale; CI runs that via `bun run check:strings`.

## Signing

Ad-hoc (`CODE_SIGN_IDENTITY: "-"`), App Sandbox off, Hardened Runtime on.
Developer ID and notarisation are a later sub-project — switching is a
`project.yml` edit, not a refactor.

### Local code signing (stable Keychain access)

An ad-hoc signature carries no identity, so **every rebuild is a different signer** as far as
the Keychain is concerned. The "Always Allow" you granted the last build does not apply to the
next one, macOS asks again, and an unattended run stalls: the app gives up on its credential
probe after 8 s and falls back to the login sheet. Signing every local build with one
long-lived, self-signed identity gives that Keychain ACL something stable to point at — the
bundle's designated requirement becomes `identifier "run.shepherd.mac" and certificate root =
H"…"`, and that requirement is identical from one build to the next.

Run this once per machine:

```
native/scripts/dev-signing-identity.sh
```

It is idempotent: a second run says "Already present" and changes nothing.

#### Why a keychain of its own

The identity does **not** live in your login keychain. A private key there has an empty
"partition list", and macOS answers every `codesign` request against such a key with a modal
_"codesign wants to use your confidential information"_ dialog. The one scripted cure,
`security set-key-partition-list`, needs the **keychain's** password on the command line — and
this project will not ask you for your login password. So the script makes a keychain it owns
and knows the password to:

|          |                                                                                          |
| -------- | ---------------------------------------------------------------------------------------- |
| keychain | `~/Library/Keychains/shepherd-dev-signing.keychain-db`                                   |
| password | `~/Library/Application Support/Shepherd/dev-signing.keychain-pass` (random, mode `0600`) |
| identity | `Shepherd Local Dev`, self-signed, 3650 days                                             |

The script creates the keychain, appends it to your **user** keychain search list (keeping
every entry that was already there), turns auto-lock off with `security set-keychain-settings`,
unlocks it, imports the identity with `-T /usr/bin/codesign`, and finally runs
`security set-key-partition-list -S apple-tool:,apple:,codesign:`. That last call is the one
that stops the prompt. Nothing in your login keychain is read or written except the one-time
migration below.

The certificate is deliberately left **untrusted**. Marking a self-signed certificate "always
trust" is itself a modal authorisation dialog, and `codesign` does not need one: handed the
certificate's SHA-1 it signs perfectly happily, and `codesign --verify --strict` passes on the
result. That is why `build-app.sh`/`test-app.sh` pass the **hash**, not the name, as
`CODE_SIGN_IDENTITY`, together with `--keychain …` in `OTHER_CODE_SIGN_FLAGS`. They also unlock
the signing keychain before `xcodebuild` runs, and print the mode they chose on their first
line. `SHEPHERD_CODESIGN_IDENTITY=…` still overrides the choice; with nothing installed they
fall back to `project.yml`'s ad-hoc default, which is exactly what CI does — `native.yml` still
asserts an ad-hoc, hardened-runtime, sandbox-off bundle.

Hardened Runtime stays on in every mode. The
`com.apple.security.cs.disable-library-validation` entitlement already in `project.yml` is what
lets a hardened bundle load code signed by a team-less identity, so the dev-identity path needs
no relaxation.

#### Migrating off the login keychain (one-time)

An earlier version of this script put `Shepherd Local Dev` in the login keychain. Re-running
`dev-signing-identity.sh` migrates it: a private key cannot be exported from there without a
password dialog, so the script instead deletes that identity by exact common name
(`security delete-identity -c "Shepherd Local Dev"`, which needs no dialog) and generates a
fresh one in the dedicated keychain.

**A new certificate means a new root hash, so the app's designated requirement changes ONE more
time.** The next launch of a freshly built `Shepherd.app` asks once for its own stored token —
click **Always Allow**. After that the requirement is stable for good, and no build, test or
launch asks again. (The old certificate's per-user trust entry is left behind on purpose:
removing it is another modal dialog, and with the certificate gone the entry refers to nothing.
Clear it by hand in Keychain Access if it bothers you.)

#### Tests never touch a Keychain by default

The `SecItem*` round-trip tests in `CredentialStoreTests` are opt-in, because a freshly built
test runner is a different signer too and would make macOS ask about items an earlier run
created. They — and the availability probe itself, which is a real write — only run with:

```
SHEPHERD_KEYCHAIN_TESTS=1 swift test --package-path native
```

Both the plain and the `TEST_RUNNER_`-prefixed spelling are read, so it works under
`xcodebuild` too. Without it those tests report as _skipped_ and a plain
`swift test --package-path native` or `native/scripts/test-app.sh -only-testing:ShepherdTests`
performs zero Keychain access. CI sets the variable in the `Test` step, right after the step
that prepares a throwaway keychain; `keychainIsUsableOnCI` fails if CI ever loses either half,
so the suite cannot go quietly silent.

#### Checking and reverting

```
native/scripts/dev-signing-identity.sh --check    # exit 0 if usable, 1 if not
native/scripts/dev-signing-identity.sh --remove   # identity, search-list entry, keychain, password
```

`--check` also flags a stale copy left in the login keychain. `--remove` takes the keychain out
of the search list first, then deletes the keychain file and the password file. Builds go back
to ad-hoc immediately — no edit to `project.yml` or the scripts is involved. The app's Keychain
item survives, but its ACL now points at a certificate that is gone, so the next build prompts
again. Nothing about CI changes either way.

## Parallel streams: seams and rules

Milestone 2 is built by several streams running at once in separate worktrees. They stay out of
each other's way by extending the app through seams instead of editing shared files.

| Want to add                      | Use                                                                                   | Never edit                       |
| -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| A tab in the session detail pane | `DetailTabRegistry.register(_:)` with your own `DetailTab`                            | `SessionDetailView.swift`        |
| A replacement sidebar            | `SidebarSlot.content`                                                                 | `MainWindow.swift`               |
| The "Run on this Mac" card body  | `WelcomeSlots.localPanel`                                                             | `WelcomeView.swift`              |
| A quick-action bar               | `ActionBarSlot.content`                                                               | `MainWindow.swift`               |
| A long-lived sub-model           | `AppModel.register(MyExtension.self)` with `AppExtension`                             | `AppModel.swift`                 |
| A kit route wrapper              | your own `ShepherdClient+<Stream>.swift`, over the internal `generated` client        | `ShepherdClient.swift`           |
| Handling a server event          | `store.events()` — match the raw name on `.unknown(name:payload:)`                    | `ServerEvent.swift`, `EventName` |
| Copy                             | your stream's own `KEYS_*` array in `native/scripts/gen-strings.ts`                   | `KEYS_CORE`                      |
| Schemas, routes and events       | your three `# ── stream: <name> ──` blocks in `contracts/openapi.yaml`                | anything outside them            |
| Contract fixtures                | your own `test/contract/<stream>.test.ts`, gated on `operationsForStream("<stream>")` | the gate in `openapi.test.ts`    |

- **One call site.** Everything is wired up from `Sources/App/StreamRegistrations.swift`, owned by
  the integration lane: a merged stream adds exactly one line there. Your own `install(_:)`
  function lives in your own directory.
- **Lifecycle.** An `AppExtension` is built in `AppModel.activate(_:)` right after the
  `SessionStore` exists and torn down right before that store stops, in reverse creation order. It
  may hold its store strongly. Anything that suspends must capture `app.activationGeneration`
  before the first `await` and drop its result once that value has moved on.
- **Tabs.** `order` is the sort key (terminal = 0), ties break on `id`, the built-in `"prompt"` tab
  is `1_000`. Registering `"prompt"` replaces it.
- **Copy.** Add keys to `ui/messages/en.json` _and_ `de.json` first, then to your own `KEYS_*`
  array, then run `native/scripts/gen-strings.sh`. A key in two arrays fails the generator.
- **Events.** Consume them through `SessionStore.events()`: one independent `AsyncStream` per call,
  every frame, finished on `stop()`. Match the raw name on `.unknown(name:payload:)` and decode
  `payload` with the generated schema your own contract block declares — the contract stays the only
  type source. **Never add a case to `EventName` or edit `ServerEvent.swift`:** that switch is
  exhaustive and S0-owned, so every stream that touched it would collide with every other.
- **Kit routes.** Wrap generated operations in your own `ShepherdClient+<Stream>.swift`. The
  `generated` property is `internal` for exactly that, and never `public`.
- **Contract blocks — three per stream.** You own a marked block in `components.schemas:`, in
  `paths:` _and_ in `x-shepherd-events:`, so a stream declares its own event frames next to its
  own routes. Same grammar in all three, same four streams in the same order, blocks last in
  their section. See `contracts/README.md`.
- **Contract fixtures.** The gate in `openapi.test.ts` only polices paths and events _outside_ the
  markers. Your blocks are yours to cover: end your own `test/contract/<stream>.test.ts` with a
  gate over `operationsForStream("<stream>")` and `eventsForStream("<stream>")`, and exercise every
  status you declare — 401 included — from that same file, because Bun's file order does not
  guarantee the global sweep ran first.
- **Live smoke.** `ShepherdTests/LiveServerTests` connects to a real server and asserts the session
  list renders. It is skipped unless `SHEPHERD_LIVE_BASE_URL` is set alongside either
  `SHEPHERD_LIVE_PASSWORD` (a real sign-in, then a relaunch-restore check) or `SHEPHERD_LIVE_TOKEN`
  (a pre-minted token, no login round-trip), and it never runs in CI:

```
TEST_RUNNER_SHEPHERD_LIVE_BASE_URL=https://your-server.example.ts.net:7330/ \
TEST_RUNNER_SHEPHERD_LIVE_PASSWORD=shepherd \
native/scripts/test-app.sh -only-testing:ShepherdTests/LiveServerTests
```

The plain `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` / `SHEPHERD_LIVE_TOKEN` spelling
works too, where `xcodebuild` forwards the shell environment; `LiveServerEnvironment` reads
either. The password-gated test signs in for real through `ProfileSetup.login` and revokes the
token it mints on the way out; the token-gated test drops a pre-minted token straight into an
in-memory credential store and never revokes anything, because it never signs in.

# ShepherdKit

The Swift client for Shepherd's HTTP/WS API, and the package the app above is built on.
Platform-neutral (macOS 15+, iOS 18+), no UI dependency: it exposes an `@Observable` store
and `AsyncStream`s, and the app is a thin SwiftUI layer on top.

Sub-project 2a of `docs/superpowers/specs/2026-09-18-native-macos-app-design.md`.
`PTYConnection` and the terminal are 2b.

## Layout

| Path                                                | What                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Sources/ShepherdKit/openapi.yaml`                  | A **copy** of `contracts/openapi.swift.yaml`. Never edit it here.                                        |
| `Sources/ShepherdKit/openapi-generator-config.yaml` | Generator settings.                                                                                      |
| `Sources/ShepherdKit/Client/`                       | `ShepherdClient`, the two middlewares, `ProfileSetup`.                                                   |
| `Sources/ShepherdKit/Realtime/`                     | `ServerEvent`, `EventStream`.                                                                            |
| `Sources/ShepherdKit/Model/`                        | `ServerProfile`, `ShepherdError`, `SessionStore`, `ConnectionState`, `OpenEnum`, the public typealiases. |
| `Sources/ShepherdKit/Credentials/`                  | `CredentialStore` and its two implementations.                                                           |

## Two contracts, one truth

`contracts/openapi.yaml` is the truth file: the ajv drift test in
`test/contract/` validates the real server against it, and it uses `const`,
`null` inside enum lists and `oneOf`-with-`null` — none of which
`swift-openapi-generator` can represent.

`bun run gen:contract-swift` derives `contracts/openapi.swift.yaml` from it:
nullable `$ref`s become optional plain `$ref`s, `null` leaves enum lists,
`const` is dropped, and read-side enums marked `x-shepherd-open-enum` become
an `anyOf` wrapper so an unfamiliar value still decodes — a named `<Name>Known`
component (`SessionStatusKnown`, `HerdrStateKnown`, `SessionArchiveReasonKnown`,
`ExperimentRoleKnown`, `EventNameKnown`) for the five named schemas, an inline
`{enum}`/`{string}` pair for the four inline properties. `bun run
check:contract-swift` is the freshness gate.

ShepherdKit generates from the **derived** file. `Model/OpenEnum.swift` hides
either wrapper: use `status.known` for the case you understand and
`status.rawValue` for what actually arrived.

Every server payload type comes from that generation, including all eight
`/events` payloads — the contract names a component schema for each, so
`Realtime/ServerEvent.swift` only decodes the envelope and dispatches. The one
hand-written `Encodable` is `PresenceFrame`, the single frame the client sends.

### Changing the contract

1. Edit `contracts/openapi.yaml` — the truth file, never the derived one.
2. `bun run test:contract` — the Bun drift test checks it against the real server.
3. `bun run gen:contract-swift` — derive the Swift-friendly document.
4. `./native/scripts/sync-contract.sh` — copy it into the target.
5. `swift build --package-path native` — regenerate and compile.
6. Commit all three files. CI (`native.yml`) fails if step 3 or 4 was skipped.

If the generator reports `Schema "null" is not supported … skipping`, the
derivation is at fault — fix `scripts/gen-contract-swift.ts`, not the copy in
this package.

## Building and testing the package

```console
$ swift build --package-path native
$ swift test --package-path native
$ swift test --package-path native --filter SessionStore
```

`CredentialStoreTests` writes to the login keychain under a per-run service
name and cleans up after itself. If it fails with `unexpectedStatus(-34018)`
the test process has no keychain access — run it from Terminal.app rather than
over SSH.

`EventStreamTests` binds a loopback `NWListener` on an ephemeral port. macOS
may ask once for an incoming-connection exception; allow it.

## Using it from an app

```swift
let store = try SessionStore(profile: profile, credentials: KeychainCredentialStore())
let runner = Task { await store.start() }   // bootstrap, then the event loop
// …render store.sessions and switch on store.connection…
store.stop()
runner.cancel()
```

`start()` never throws: `store.connection` moves through `.connecting`, `.live`,
`.firstRunPending`, `.needsLogin` and `.offline(message:)`, and it is
`@Observable`-tracked, so SwiftUI — or `withObservationTracking` outside a view —
sees every transition without polling. `bootstrap()`, `apply(_:)` and
`consume(_:)` remain available for a caller that would rather drive the loop
itself; build such a store with `SessionStore(client:)`.

`start()` opens the `/events` socket and subscribes to it **before** it reads the
first snapshot, and events that arrive while a snapshot load is in flight are
replayed on top of the snapshot rather than under it — so a push that races the
bootstrap is never lost, and a session archived during the load does not come
back. A socket that drops shows as `.connecting`, not `.offline`: the stream is
already reconnecting with capped backoff, and every reconnect re-reads sessions,
settings and repos, which is what covers the pushes the 256-frame buffer may have
dropped while the socket was down.

A 401 on a request the store made surfaces as `store.lastError ==
.unauthenticated` plus `connection == .needsLogin`. A 401 on a request the store
did **not** make reaches the app through `store.client.needsLogin`, an
`AsyncStream<Void>` with exactly one consumer — the app, never the store:

```swift
Task { for await _ in store.client.needsLogin { presentLoginSheet() } }
```

A cancelled call is not a failure: it maps to `ShepherdError.cancelled`, and the
store leaves `connection` and `lastError` alone rather than painting `.offline`.

Call `await store.setActive(_:)` from the app's foreground notifications
(`applicationDidBecomeActive` / `scenePhase`) so the server can suppress push
while the operator is already looking; a store built with `init(client:)` and
no socket ignores it.

`stop()` ends the store for good — it does not merely pause it: cancelling the
event consumer finishes `EventStream.events()`, so calling `start()` again
afterwards will not reopen the socket. A store that is simply released does the
same tidying from `deinit`, so a dropped store cannot leave a socket
reconnecting behind it. Build a fresh `SessionStore` (and the `EventStream` it
owns) per activation rather than restarting one that was stopped; that
per-activation contract is also what keeps `start()`'s internal `running` flag
safe against a `start()`/`stop()` race, as its own doc comment explains.

## CI

`.github/workflows/native.yml` runs two jobs on `macos-latest`, paths-filtered to `native/**`,
`contracts/**`, `scripts/gen-contract-swift.ts` and `ui/messages/*.json` (the app's string
catalog source).

Job `shepherdkit` (blocking) runs `bun run check:contract-swift`,
`./native/scripts/sync-contract.sh --check`, `swift build --package-path native` and
`swift test --package-path native` for the package, then builds and tests the app above:

1. `bun run check:strings` — the committed string catalog must match `ui/messages/{en,de}.json`.
2. `native/scripts/build-app.sh Release` — the app must build.
3. A signature check — the bundle must be ad-hoc signed, hardened-runtime and sandbox-off.
4. `native/scripts/test-app.sh -only-testing:ShepherdTests` — the unit bundle.

Job `shepherd-mac-ui` (`continue-on-error: true`, **non-blocking**) runs
`native/scripts/test-app.sh -only-testing:ShepherdUITests`. XCUITest needs a real GUI login
session, so a red run there is a prompt to investigate, not a merge blocker.
