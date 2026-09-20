# Developing Shepherd for Mac and ShepherdKit

[← Shepherd for Mac](../README.md) · [Get started](getting-started.md) · [Development](development.md) · [Screenshots](screenshots.md)

Run commands from the repository root.

[Contributor workflow](#contributor-workflow) · [Test](#test) · [Localisation](#localisation) · [Signing](#signing) · [Parallel streams: seams and rules](#parallel-streams-seams-and-rules) · [ShepherdKit](#shepherdkit) · [Layout](#layout) · [Two contracts, one truth](#two-contracts-one-truth) · [Building and testing the package](#building-and-testing-the-package) · [Using it from an app](#using-it-from-an-app) · [CI](#ci)

The macOS app lives under `native/Apps/ShepherdMac`, built on the `ShepherdKit` package in `native/`.
The Xcode project is **generated** from `native/Apps/ShepherdMac/project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen) — never edit `Shepherd.xcodeproj`, it is
gitignored.

## Contributor workflow

First complete [setup, build and connection](getting-started.md).

1. Tests:

   ```
   native/scripts/test-app.sh -only-testing:ShepherdTests
   ```

   Runs just the Swift Testing unit bundle — no Keychain access, isolated launch (see
   [Isolated launches](#isolated-launches)). This is what CI's blocking job runs.

   ```
   native/scripts/test-app.sh
   ```

   Runs the unit bundle plus the XCUITest smoke bundle (`ShepherdUITests`). This needs a real,
   logged-in GUI session — a window flashes on screen while it runs — and, the first time
   XCUITest drives the app on a fresh machine, macOS shows an "Enable UI Automation"
   authorization prompt that has to be approved before the run can proceed.

   ```
   swift test --package-path native
   git checkout -- native/Package.resolved
   ```

   Tests the `ShepherdKit` package on its own. Run the `git checkout` afterwards: SwiftTerm is
   pinned by the app's `project.yml`, not by the package, so `swift test` rewrites
   `native/Package.resolved` as a side effect and that rewrite should not end up in your diff.

   The live suites (`ShepherdUITests/LiveSmokeUITests`, `ShepherdTests/LiveServerTests`) are
   opt-in and gated behind environment variables — `SHEPHERD_LIVE_BASE_URL` and
   `SHEPHERD_LIVE_PASSWORD` (plain, or `TEST_RUNNER_`-prefixed for `xcodebuild`), plus
   `SHEPHERD_REVOKE_ON_EXIT=1` so the token they mint is revoked when the run ends. Point them
   only at a server you control, and never commit the values. See
   [The live UI smoke test](#the-live-ui-smoke-test) and
   [Live smoke](#parallel-streams-seams-and-rules) for the exact invocations.

2. Contract changes: edit `contracts/openapi.yaml` only — never the derived
   `contracts/openapi.swift.yaml` or the copy under `native/Sources/ShepherdKit/`. Then, from
   the repo root:

   ```
   bun run gen:contract-swift
   native/scripts/sync-contract.sh
   ```

   Regenerate the string catalog if you touched copy (`ui/messages/en.json` and `de.json`
   first, then `native/scripts/gen-strings.ts` — see [Localisation](#localisation)), and before
   pushing run:

   ```
   bun run check:strings
   bun run typecheck
   bun run test:contract
   ```

   See [Two contracts, one truth](#two-contracts-one-truth) and
   [Changing the contract](#changing-the-contract) for the full picture, including why the
   derived file exists at all.

3. Branch hygiene: cut your branch from `origin/main`, rebase rather than merging `main` back
   in, and keep one feature per PR — see this repo's `CLAUDE.md`. If your change touches a
   Milestone 2 stream, also read
   [Parallel streams: seams and rules](#parallel-streams-seams-and-rules) before editing any
   shared file.

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

### Isolated launches

Every automated launch of the app runs **isolated**, and the real app is unaffected: the switch is
`-ShepherdIsolated 1` as a launch argument (what each `XCUIApplication` passes) or
`SHEPHERD_ISOLATED=1` in the environment (what `test-app.sh` exports, in the plain and the
`TEST_RUNNER_`-prefixed spelling, so the unit bundle's host app gets it too). An isolated launch
builds its `AppModel` on a throwaway `UserDefaults` suite — `run.shepherd.mac.isolated.<pid>-<uuid>`,
removed again on quit — and an `InMemoryCredentialStore`, so it reads neither the operator's saved
profiles nor the login Keychain, and restores no persisted profile: the suite is empty. Launching
Shepherd.app yourself passes neither switch, so nothing about a normal run changes — your profiles
and your token stay exactly where they were.

That is the whole reason the mode exists. The real store's `SecItemCopyMatching` blocks on a
SecurityAgent dialog ("Shepherd möchte deine vertraulichen Informationen verwenden…"), and an
unattended run has nobody to answer it. See `Sources/App/LaunchEnvironment.swift`; the parsing is
covered by `ShepherdTests/LaunchEnvironmentTests`.

### The live UI smoke test

`ShepherdUITests/LiveSmokeUITests` is the end-to-end run: an isolated launch that signs in to a
**real** server and has to land on the session list. Skipped — so silent in CI, which has no server
— unless both variables are set:

```
TEST_RUNNER_SHEPHERD_LIVE_BASE_URL='https://your-server:7330/' \
TEST_RUNNER_SHEPHERD_LIVE_PASSWORD='…' \
  native/scripts/test-app.sh -only-testing:ShepherdUITests
```

The test hands both values to the app through `launchEnvironment`; the app adds a remote profile
named "Live", signs in through the same `AppModel.signIn` the login sheet uses, and activates it.
The minted token goes to the in-memory store and the profile to the throwaway suite — never the
Keychain, never `run.shepherd.mac` — and `-ShepherdRevokeOnExit 1` gives the token back to the
server when the app quits. One caveat, measured rather than assumed: `XCUIApplication.terminate()`
does not deliver `NSApplicationWillTerminate`, so a run driven by the test does **not** revoke —
expect one access token named `Shepherd for Mac (<host>)` per live run in the server's token list,
and revoke it there if it bothers you. Keep the values out of files and shell history; they are an
operator's real server and real password.

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

**A locked keychain stops the build.** If — and only if — the dedicated identity is the one
chosen and its keychain cannot be unlocked (the password file is gone, or `security` refuses it),
`build-app.sh`/`test-app.sh` exit non-zero **before** `xcodebuild` starts, naming both ways out:
re-run `dev-signing-identity.sh --remove` then `dev-signing-identity.sh`, or build this once with
`SHEPHERD_CODESIGN_IDENTITY="-"`. Carrying on would hand the build to `codesign`, which opens the
password dialog the dedicated keychain exists to prevent — and an unattended run just hangs on it.
The other three modes need no key of ours, so they never fail here.

**The password never leaves the file.** Every use of a keychain password goes through
`shepherd_security_with_pass` in `native/scripts/keychain-secret.sh`, which feeds the command to
`security -i` on **stdin** and turns `set -x` off around the value. `security unlock-keychain -p
"$(cat …)"` would put the password in argv, where `ps` shows it to every user on the machine
(`security`'s own help says "Use of the -p option is insecure"), and would echo it from any build
run with `bash -x`. The throwaway PKCS#12 password inside `dev-signing-identity.sh` goes the same
way, through a file in its own `0700` temp directory.

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

Milestone 2 was built by four parallel streams (`terminal`, `detail`, `sidebar`, `actions`) and
milestone 3 adds six more (`herd`, `plan`, `merge`, `queues`, `compose`, `settings`). They stay out
of each other's way by extending the app through seams instead of editing shared files.

| Want to add                      | Use                                                                                   | Never edit                       |
| -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| A tab in the session detail pane | `DetailTabRegistry.register(_:)` with your own `DetailTab`                            | `SessionDetailView.swift`        |
| A replacement sidebar            | `SidebarSlot.content`                                                                 | `MainWindow.swift`               |
| The "Run on this Mac" card body  | `WelcomeSlots.localPanel`                                                             | `WelcomeView.swift`              |
| A quick-action bar               | `ActionBarSlot.content`                                                               | `MainWindow.swift`               |
| A long-lived sub-model           | `AppModel.register(MyExtension.self)` with `AppExtension`                             | `AppModel.swift`                 |
| A settings pane                  | `SettingsPaneRegistry.register(_:)` with your own `SettingsPane`                      | `ShepherdApp.swift`              |
| A menu-bar command               | `CommandRegistry.register(_:)` with a `MenuCommand`                                   | `ShepherdApp.swift`              |
| New Task fields, or a composer   | `NewSessionSlot.options` (additive) or `.content` (replacement)                       | `NewSessionSheet.swift`          |
| A kit route wrapper              | your own `ShepherdClient+<Stream>.swift`, over the internal `generated` client        | `ShepherdClient.swift`           |
| Handling a server event          | `store.events()` — match the raw name on `.unknown(name:payload:)`                    | `ServerEvent.swift`, `EventName` |
| Copy                             | your stream's own `KEYS_*` array in `native/scripts/gen-strings.ts`                   | `KEYS_CORE`                      |
| Schemas, routes and events       | your three `# ── stream: <name> ──` blocks in `contracts/openapi.yaml`                | anything outside them            |
| Contract fixtures                | your own `test/contract/<stream>.test.ts`, gated on `operationsForStream("<stream>")` | the gate in `openapi.test.ts`    |

- **One registration file.** Everything is wired up from `Sources/App/StreamRegistrations.swift`,
  owned by the integration lane: a merged stream adds its installer calls to the scene pass,
  the model pass, or both as needed. Your own `installScene()` and `install(_:)` functions live
  in your own directory.
- **Two registration passes.** `StreamRegistrations.installScene()` runs from `ShepherdApp.init()`,
  before any `Scene` exists, and is where settings panes and menu commands register — `ShepherdApp.body`
  reads both registries while the scene is being built, and neither is `@Observable`, so anything
  registered later never appears. Command actions receive the model when invoked, so their
  registration still belongs in `installScene()`. `installAll(into:)` keeps model-bound setup
  and everything that touches `NSApp.mainMenu` (which is nil during `init()`).
- **Lifecycle.** An `AppExtension` is built in `AppModel.activate(_:)` right after the
  `SessionStore` exists and torn down right before that store stops, in reverse creation order. It
  may hold its store strongly. Anything that suspends must capture `app.activationGeneration`
  before the first `await` and drop its result once that value has moved on.
- **Tabs.** `order` is the sort key (terminal = 0), ties break on `id`, the built-in `"prompt"` tab
  is `1_000`. Registering `"prompt"` replaces it. With exactly one tab registered the detail pane
  renders that tab's content on its own (`DetailTabRegistry.layout == .single`) — a tab bar with
  nothing to switch to is chrome that reads as a bug — so **your first tab is what brings the bar
  back**. Both layouts render your view unchanged, accessibility identifiers included.
- **Copy.** Add keys to `ui/messages/en.json` _and_ `de.json` first, then to your own `KEYS_*`
  array, then run `native/scripts/gen-strings.sh`. A key in two arrays fails the generator.
- **Events.** Consume them through `SessionStore.events()`: one independent `AsyncStream` per call,
  every frame, finished on `stop()`. Match the raw name on `.unknown(name:payload:)` and decode
  `payload` with the generated schema your own contract block declares — the contract stays the only
  type source. **Never add a case to `EventName` or edit `ServerEvent.swift`:** that switch is
  exhaustive and S0-owned, so every stream that touched it would collide with every other.
- **Stop reading, drop the stream.** A `break` or a `return` out of `for await` ends the loop but
  **not** the tap: the stream keeps collecting frames into a 64-slot buffer nobody reads for as long
  as the store runs. Only cancelling the reading task or releasing the `AsyncStream` value
  unregisters it. `for await event in store.events() { … }` is safe as written; a stream you keep in
  a property has to be nil'd out (or its task cancelled) when you are done with it.
- **Reconcile after a drop.** Events are not a guaranteed-complete log, so **never** keep state that
  only an unbroken sequence of frames can rebuild. Each tap buffers 64 and drops its own oldest past
  that; `SessionStore.apply` drops the oldest past 256 while a snapshot load is in flight; and
  `EventStream` loses frames while a socket is down. Derive what you show from `store.sessions`,
  `store.settings` and `store.repos` — every reconnect re-reads all three — and treat an event as a
  prompt to refresh, not as the only copy of a fact.
- **Kit routes.** Wrap generated operations in your own `ShepherdClient+<Stream>.swift`. The
  `generated` property is `internal` for exactly that, and never `public`. For an operation
  that legitimately waits minutes (S11 prompt shaping, future merge/train operations), use the
  internal sibling `longRunning` instead. It shares credentials, `needsLogin` and retry policy,
  with a dedicated session whose request timeout is 300 seconds and resource timeout is at
  least 300 seconds. Ordinary `generated` calls retain their existing session and 60-second
  default. No route registration or core edit is needed: change only the generated-client
  receiver in your stream wrapper and keep its output/error mapping. For example, using a
  health operation already in the contract:

  ```swift
  let input = Operations.GetHealth.Input()
  let output = try await longRunning.getHealth(input)
  // Keep the wrapper's existing Output-to-value and ShepherdError mapping.
  ```

  `ShepherdClient.init(profile:credentials:urlSession:longRunningRequestTimeout:)` permits
  shorter timeouts in tests. The long-running session copies the supplied session's
  configuration, including protocol classes and headers, but not its delegate. The supplied
  session is unchanged. Request timeouts measure the wait for additional data, not a total
  operation deadline; the existing GET-only retry policy still applies.

- **Contract blocks — three per stream.** You own a marked block in `components.schemas:`, in
  `paths:` _and_ in `x-shepherd-events:`, so a stream declares its own event frames next to its
  own routes. Same grammar in all three, same ten streams in the same order, blocks last in
  their section. See `contracts/README.md`.
- **Contract fixtures.** The gate in `openapi.test.ts` only polices paths and events _outside_ the
  markers. Your blocks are yours to cover: end your own `test/contract/<stream>.test.ts` with a
  gate over `operationsForStream("<stream>")` and `eventsForStream("<stream>")`, and exercise every
  status you declare — 401 included — from that same file, because Bun's file order does not
  guarantee the global sweep ran first.
- **No `.toolbar` inside a `DetailTab`.** `SessionDetailView` hosts the tabs in a `TabView`, which
  keeps every visited child alive, and a child's `.toolbar` contribution is never withdrawn when
  that child goes off screen. The window grows one copy of your item per tab the operator has ever
  opened and AppKit eventually throws out of
  `-[NSToolbar _insertNewItemWithItemIdentifier:atIndex:propertyListRepresentation:notifyFlags:]`,
  killing the app — reproduced live, four tabs deep. Put the control in the tab's own body instead;
  `DetailRefreshBar` (`Sources/Detail/DetailFeature.swift`) is the shape to copy. The window
  toolbar stays S0-owned, and no stream needs it to have a button.
- **A cancelled tap still hands you buffered frames.** Cancelling the task around
  `for await … in store.events()` does not empty what the tap already collected: the iterator
  yields the buffered frames first and only then ends, so a handler can run _after_ `teardown()`
  and write into a model whose store is gone. Cancellation is a request, not a fence. Stamp the
  work instead — capture a generation before the loop and drop any frame whose generation has
  moved on (`SidebarModel`'s `mine == generation` guard around `refresh()`), or check a teardown
  flag at the top of the handler. The same applies to any `AsyncStream` you tap, not just events.
- **Never park a long-lived watcher on a bare `withCheckedContinuation`.** Cancellation cannot
  resume one, so `Task.cancel()` in `teardown()` leaves the loop suspended forever, holding its
  captures and an observation registration inside the store — one more leak per profile switch and
  per closed window. Wait on an `AsyncStream` you **finish** in `teardown()` instead:
  `withObservationTracking { … } onChange: { signal.yield() }`, then `await iterator.next()`, and
  `nil` is the exit. See `DetailModel.beginSessionsWatch` and `AppModel.watchConnection`. Finishing
  twice, or yielding into a finished stream, is a no-op, so there is no double-resume to get wrong.
- **`bun run typecheck` is a gate,** alongside `bun run lint` and `bun run test:contract`. A
  contract fixture or harness type that only `tsc` rejects passes every other check on the branch
  and fails in CI.
- **Test hygiene on this hardware.** Set `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1` for any live run
  so the token the harness mints is revoked when the run ends. Run the UI bundle **one worktree at
  a time** — parallel `xcodebuild` runs fight over `testmanagerd` and fail with "Channel
  disconnected" or "hung before establishing connection" and zero tests executed; `pkill -9
testmanagerd` and rerun clears it, and never `pkill -f`/`killall` on a pattern that would match
  another worktree's run. `swift test --package-path native` rewrites `native/Package.resolved`, so
  `git checkout -- native/Package.resolved` afterwards keeps it out of your diff. Never set
  `SHEPHERD_KEYCHAIN_TESTS=1`, and never launch a build outside isolated mode
  (`-ShepherdIsolated 1`) on the operator's Mac: it would prompt against their saved Keychain item.
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

## ShepherdKit

The Swift client for Shepherd's HTTP/WS API, and the package the Mac app is built on.
Platform-neutral (macOS 15+, iOS 18+), no UI dependency: it exposes an `@Observable` store
and `AsyncStream`s, and the app is a thin SwiftUI layer on top.

Sub-project 2a of `docs/superpowers/specs/2026-09-18-native-macos-app-design.md`.
`PTYConnection` and the terminal are 2b.

## Layout

Paths below are relative to `native/`.

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
`swift test --package-path native` for the package, then builds and tests the Mac app:

1. `bun run check:strings` — the committed string catalog must match `ui/messages/{en,de}.json`.
2. `native/scripts/build-app.sh Release` — the app must build.
3. A signature check — the bundle must be ad-hoc signed, hardened-runtime and sandbox-off.
4. `native/scripts/test-app.sh -only-testing:ShepherdTests` — the unit bundle.

Job `shepherd-mac-ui` (`continue-on-error: true`, **non-blocking**) runs
`native/scripts/test-app.sh -only-testing:ShepherdUITests`. XCUITest needs a real GUI login
session, so a red run there is a prompt to investigate, not a merge blocker. Both bundles launch
the app isolated (see [Isolated launches](#isolated-launches)), so neither can stall on a Keychain
prompt; `LiveSmokeUITests` skips itself there, because CI sets neither live variable.
