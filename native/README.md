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

Runs the Swift Testing unit bundle (`ShepherdTests`). The scheme also builds
and runs the `ShepherdUITests` XCUITest bundle, but that bundle has no source
files until Task 11 adds a smoke test, so xcodebuild cannot find its compiled
executable and the bare invocation above currently fails at the test step
(the build itself succeeds). Pass `-only-testing:ShepherdTests` to scope the
run to the unit bundle, which is what CI does:

```
native/scripts/test-app.sh -only-testing:ShepherdTests
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

Call `await store.setActive(_:)` from the app's foreground notifications
(`applicationDidBecomeActive` / `scenePhase`) so the server can suppress push
while the operator is already looking; a store built with `init(client:)` and
no socket ignores it.

`stop()` ends the store for good — it does not merely pause it: cancelling the
event consumer finishes `EventStream.events()`, so calling `start()` again
afterwards will not reopen the socket. Build a fresh `SessionStore` (and the
`EventStream` it owns) per activation rather than restarting one that was
stopped; that per-activation contract is also what keeps `start()`'s internal
`running` flag safe against a `start()`/`stop()` race, as its own doc comment
explains.

## CI

`.github/workflows/native.yml`, job `shepherdkit` on `macos-latest`, runs
`bun run check:contract-swift`, `./native/scripts/sync-contract.sh --check`,
`swift build --package-path native` and `swift test --package-path native` for
the package, then builds and tests the app above (`bun run check:strings`,
`native/scripts/build-app.sh Release`, a signature check, and
`native/scripts/test-app.sh -only-testing:ShepherdTests`) in the same job. It
is paths-filtered to `native/**`, `contracts/**`, `scripts/gen-contract-swift.ts`
and `ui/messages/*.json` (the app's string catalog source).
