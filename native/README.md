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
the login Keychain is concerned. The "Always Allow" you granted the last build does not apply
to the next one, macOS asks again, and an unattended run stalls: the app gives up on its
credential probe after 8 s and falls back to the login sheet. Signing every local build with
one long-lived, self-signed identity gives that Keychain ACL something stable to point at —
the bundle's designated requirement becomes `identifier "run.shepherd.mac" and certificate
root = H"…"`, and that requirement is identical from one build to the next.

Run this once per machine:

```
native/scripts/dev-signing-identity.sh
```

It creates a self-signed code-signing certificate named exactly `Shepherd Local Dev` in your
login keychain (`openssl req` → `openssl pkcs12` → `security import -T /usr/bin/codesign -T
/usr/bin/security`), trusts it for the `codeSign` policy for your user only, and prints the
identity's SHA-1. It is idempotent: a second run says "Already present" and changes nothing.

`--check` reports whether the identity is usable (exit 0) or not (exit 1); `--remove` deletes
the certificate, its private key and the trust setting again.

From then on `build-app.sh` and `test-app.sh` find it themselves and pass
`CODE_SIGN_IDENTITY="Shepherd Local Dev" CODE_SIGN_STYLE=Manual` to `xcodebuild`. Both scripts
print the mode they chose on their first line. `SHEPHERD_CODESIGN_IDENTITY=…` overrides the
choice; with neither set nor installed they fall back to `project.yml`'s ad-hoc default, which
is exactly what CI does — `native.yml` is untouched and still asserts an ad-hoc,
hardened-runtime, sandbox-off bundle.

Hardened Runtime stays on in every mode. The
`com.apple.security.cs.disable-library-validation` entitlement already in `project.yml` is what
lets a hardened bundle load code signed by a team-less identity, so the dev-identity path needs
no relaxation: `codesign --verify --strict` passes on the result.

#### The prompts

- **Creating the identity.** Writing the per-user trust setting needs no admin account. macOS
  may still show one "You are making changes to your Certificate Trust Settings" dialog asking
  for your **login password**. If it is refused or cancelled, the script does not fail silently
  — it prints the exact Keychain Access steps (login keychain → My Certificates → _Shepherd
  Local Dev_ → Trust → Code Signing → Always Trust) and exits non-zero.
- **The first build afterwards.** `codesign` has to unlock the new private key, so macOS may
  ask once: _"codesign wants to sign using key … in your keychain."_ Click **Always Allow**,
  not "Allow" — that writes `codesign` into the key's ACL for good. This is the last Keychain
  prompt for these builds. The scripted equivalent, `security set-key-partition-list`, wants
  your keychain password on the command line, so it is deliberately not automated.
- **Running the app.** Nothing new. The bundle is built locally and never quarantined, so
  Gatekeeper does not gate it, and the app's own token item is asked for once and then
  remembered for as long as the identity lives.

#### Reverting

```
native/scripts/dev-signing-identity.sh --remove
```

Builds go back to ad-hoc immediately — no edit to `project.yml` or the scripts is involved. The
app's Keychain item survives, but its ACL now points at a certificate that is gone, so the next
build prompts again. Nothing about CI changes either way.

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
