# ShepherdKit core (sub-project 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `native/`, a Swift package whose `ShepherdKit` library lets a SwiftUI app connect to a Shepherd server, log in, mint and store a token, stream `/events`, keep a live session list, and resolve first run — generated entirely from the contract.

**Architecture:** `swift-openapi-generator` runs as an SPM **build plugin** over a copy of `contracts/openapi.swift.yaml` — the generator-friendly document that `bun run gen:contract-swift` derives from the truth file `contracts/openapi.yaml` — so the generated `Client`/`Components.Schemas` are regenerated on every build and never committed. `ShepherdClient` wraps that generated client with an auth middleware (Bearer from a `CredentialStore`) and a retry middleware, and maps every documented response case onto a `ShepherdError`. `EventStream` is a `URLSessionWebSocketTask` actor that decodes the generated `EventEnvelope`, switches on the generated `EventName`, and yields a `ServerEvent` enum whose payloads are all generated types. `SessionStore` is an `@Observable @MainActor` store that bootstraps from three GETs and then applies events with the same semantics as `ui/src/lib/store.svelte.ts::apply`.

**Tech Stack:** Swift 6.1 tools / Swift 6 language mode, `swift-openapi-generator` 1.13.1, `swift-openapi-runtime` 1.12.1, `swift-openapi-urlsession` 1.3.1, `swift-testing`, `Network.framework` (`NWListener` + `NWProtocolWebSocket`) for the fake `/events` server, `Security.framework` for the Keychain.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-18-native-macos-app-design.md` (sections Architecture, Sub-project 2, Cross-cutting, Testing summary). Read it before Task 1.
- **Platforms:** "macOS 15+, iOS 18+ (Xcode 26, Swift 6.3 available on the operator's machine)." The manifest declares `platforms: [.macOS(.v15), .iOS(.v18)]`.
- **Swift 6 language mode with strict concurrency.** `swift-tools-version: 6.1` and `swiftLanguageModes: [.v6]`. No `@preconcurrency import`, no `nonisolated(unsafe)` globals. Shared mutable state uses a lock-guarded `final class … : @unchecked Sendable` box or `Synchronization.Mutex` (macOS 15+).
- **"ShepherdKit has no UI dependency. It exposes `@Observable` stores and `AsyncStream`s."** No `import SwiftUI`, no `import AppKit`, no `import UIKit` anywhere under `native/Sources/ShepherdKit`.
- **"The contract is the only type source. No hand-written `Codable` for server payloads."** Zero exceptions in this sub-project. Every `/events` payload is now a named component schema (`SessionStatusEvent`, `SessionRenamedEvent`, `SessionArchivedEvent`, `SessionBlockEvent`, `SessionReadyEvent`, `Session`, `AutoMergeStatus`, `UsageLimits`) reached through `EventEnvelope` + `EventName`, so the hand-written `ServerEvent` enum is a **dispatch** over generated types and declares no payload models of its own. The only hand-written `Encodable` is `PresenceFrame`, the one frame the client sends, which the contract describes in prose rather than as a schema.
- **Swift is generated from `contracts/openapi.swift.yaml`, never from `contracts/openapi.yaml`.** The truth file keeps `const`, `null` inside enum lists and `oneOf`-with-`null` for the ajv drift test; `bun run gen:contract-swift` (`scripts/gen-contract-swift.ts`) derives the generator-friendly document. Never hand-edit `contracts/openapi.swift.yaml`, and never "fix" the truth file to please the Swift generator.
- **"Tokens only in the Keychain."** No token in `UserDefaults`, no token in a plist, no token in a log line. The password is never persisted anywhere.
- **"Remote profiles require `https` unless the host is loopback or a `.ts.net` name."** Enforced by `ServerProfile.requireSecureRemote(_:)`, called before any remote request.
- **"Logging. `os.Logger` subsystems `run.shepherd.kit`."** Every log call in this package uses subsystem `run.shepherd.kit`. Never log a token, a password or a prompt body.
- **Toolchain:** Xcode 26.6 / Swift 6.3.3 on the operator's machine (`swift --version` → `Apple Swift version 6.3.3`). CI needs Swift 6.1+ because all three Apple dependencies ship `// swift-tools-version:6.1`.
- **Commits:** conventional commits with lowercase subjects (`feat(native): …`, `test(native): …`, `fix(contract): …`, `ci(native): …`). End every commit body with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Branch:** `feat/native-shepherdkit`, cut from `origin/main`. Never `git merge main` into it; rebase. One feature per branch.
- **CI:** a new `.github/workflows/native.yml` job on `macos-latest` running `swift build`, `swift test` and a generated-code freshness check (Task 12 defines it concretely).
- **NOT in this sub-project:** `PTYConnection`, SwiftTerm, any Xcode app target, any SwiftUI view, localisation/`gen-strings.sh`, `ShepherdLocalServer`. Those are 2b/3/4.
- Run the Swift suite with `swift test --package-path native`. The repo's `bun run test` rule applies to the Bun packages; Task 1 touches `contracts/` and runs `bun run test:contract` from the repo root.

---

## File structure

| File | Responsibility |
| --- | --- |
| `contracts/openapi.swift.yaml` (read only) | The derived, generator-friendly contract. Produced by `bun run gen:contract-swift` in sub-project 1. This plan never edits it or `contracts/openapi.yaml`. |
| `native/Package.swift` | SPM manifest: `ShepherdKit` library with the `OpenAPIGenerator` build plugin, `ShepherdKitTests` test target. |
| `native/scripts/sync-contract.sh` | Copies `contracts/openapi.swift.yaml` → `native/Sources/ShepherdKit/openapi.yaml`. `--check` diffs instead of copying (the CI gate). |
| `native/Sources/ShepherdKit/openapi.yaml` | Committed copy of the derived contract. The build plugin finds it here. Never hand-edited. |
| `native/Sources/ShepherdKit/Model/OpenEnum.swift` | `OpenEnum` protocol + conformances, so callers see `.known` / `rawValue` instead of the generator's `anyOf` wrapper. |
| `native/Sources/ShepherdKit/Model/PublicTypes.swift` | Short public typealiases (`Session`, `Settings`, …) over `Components.Schemas.*`. |
| `native/Sources/ShepherdKit/openapi-generator-config.yaml` | `generate: [types, client]`, `accessModifier: public`, `namingStrategy: idiomatic`. |
| `native/Sources/ShepherdKit/Logging.swift` | `ShepherdLog` — the `os.Logger` instances for subsystem `run.shepherd.kit`. |
| `native/Sources/ShepherdKit/Model/ServerProfile.swift` | `ServerProfile` value type + the remote-URL security policy. |
| `native/Sources/ShepherdKit/Model/ShepherdError.swift` | `ShepherdError` + mapping from generated outputs and thrown `ClientError`s. |
| `native/Sources/ShepherdKit/Credentials/CredentialStore.swift` | `StoredCredential` + the `CredentialStore` protocol. |
| `native/Sources/ShepherdKit/Credentials/InMemoryCredentialStore.swift` | Lock-guarded in-memory implementation for tests and previews. |
| `native/Sources/ShepherdKit/Credentials/KeychainCredentialStore.swift` | `kSecClassGenericPassword` implementation, service `run.shepherd.kit`. |
| `native/Sources/ShepherdKit/Client/AuthenticationMiddleware.swift` | Injects `Authorization: Bearer`, detects 401, clears the credential, fires `needsLogin`. |
| `native/Sources/ShepherdKit/Client/RetryingMiddleware.swift` | Retries bodyless GETs 3× with backoff. |
| `native/Sources/ShepherdKit/Client/ShepherdClient.swift` | The public async API: one method per contract operation, all errors mapped. |
| `native/Sources/ShepherdKit/Client/ProfileSetup.swift` | `login(profile:password:)` / `logout(profile:)` over an ephemeral cookie jar. |
| `native/Sources/ShepherdKit/Realtime/ServerEvent.swift` | `ServerEvent` enum: decodes the generated `EventEnvelope`, switches on `EventName`, decodes `data` into the generated `*Event` types. Plus `PresenceFrame`. |
| `native/Sources/ShepherdKit/Realtime/EventStream.swift` | `/events` WebSocket actor: `AsyncStream<ServerEvent>`, 1 s reconnect, presence frames. |
| `native/Sources/ShepherdKit/Model/SessionStore.swift` | `@Observable @MainActor` store: bootstrap, `apply`, `create`, `archive`, `interrupt`, `refresh`, `resolveFirstRun`. |
| `native/Tests/ShepherdKitTests/FakeShepherdServer.swift` | `URLProtocol` fake + route table + `URLSession` factory. |
| `native/Tests/ShepherdKitTests/Fixtures.swift` | JSON fixture strings and generated-type builders shared by the tests. |
| `native/Tests/ShepherdKitTests/FakeEventServer.swift` | `NWListener` + `NWProtocolWebSocket` in-process `/events` server. |
| `native/Tests/ShepherdKitTests/*Tests.swift` | One file per unit under test. |
| `native/README.md` | What the package is, how the contract gets in, how to regenerate, how to run the tests. |
| `.github/workflows/native.yml` | `macos-latest`: contract freshness, `swift build`, `swift test`. |

---

## Decisions this plan locks in (read before Task 1)

**1. Generated code is NOT committed; the build plugin regenerates it every build.**
The generator ships two plugins. The **build plugin** (`plugins: [.plugin(name: "OpenAPIGenerator", …)]`) writes to `.build/plugins/outputs/native/ShepherdKit/destination/OpenAPIGenerator/GeneratedSources/` — outside the source tree. The **command plugin** (`swift package generate-code-from-openapi`) writes `Sources/<Target>/GeneratedSources/` into the source tree so it can be committed. This plan uses the **build plugin**, because:

- code regenerated on every build *cannot* be stale, which is exactly the failure the spec's "fails if generated output differs from what is committed" gate exists to catch;
- the generator's own docs state "The number and names of generated files are _not_ considered to be stable, and can change at any time", so a committed snapshot churns on every dependency bump (1.13.1 already split `Types.swift` into eight files);
- with the command plugin and no build plugin attached, SwiftPM emits `found 2 file(s) which are unhandled` for `openapi.yaml`/`openapi-generator-config.yaml`, and `exclude:`-ing them breaks the command plugin, which reads them from `target.sourceFiles`.

The spec's CI intent is realised as `bun run check:contract-swift` (the derived contract still matches the truth file) **plus** `native/scripts/sync-contract.sh --check` (the copy inside the target still matches the derived contract) **plus** `swift build` + `swift test` on `macos-latest`. Task 12 implements all four.

**2. The contract reaches the target by copy, not symlink.**
The build plugin filters `swiftTarget.sourceFiles` by last path component for exactly one of `openapi.yaml|openapi.yml|openapi.json`. A committed real file is guaranteed to enumerate, keeps `swift build --package-path native` working from a source tarball, and gives CI a literal byte-diff to gate on. A symlink adds a resolution risk for no benefit.

**3. Swift is generated from the derived contract, and this plan never edits either contract.**
`swift-openapi-generator` 1.13.1 cannot represent several constructs the ajv drift test needs: `oneOf`/`anyOf` branches with `type: "null"` (#817 — the property is **silently dropped**), `null` inside an enum list (#118 — generation **fails**), and `const` (#261). Its enums are also closed, so a server that learns a new `SessionStatus` would break decoding on an old client.

Sub-project 1 resolved this with two files. `contracts/openapi.yaml` stays the truth file. `bun run gen:contract-swift` (`scripts/gen-contract-swift.ts`) derives `contracts/openapi.swift.yaml`, where:

- nullable `$ref` properties become plain `$ref`s that are simply **not** in `required` (the generator emits an optional, and `decodeIfPresent` turns an explicit JSON `null` into `nil`);
- `null` is dropped from enum lists;
- `const` is removed;
- read-side enums flagged `x-shepherd-open-enum` — `SessionStatus`, `HerdrState`, `SessionArchiveReason`, `ExperimentRole`, `BlockReason.shape`, `BlockReason.quotaKind`, `Session.planPhase`, `Session.haltReason`, `EventName` — become the generator's open-enum pattern, `anyOf: [{type: string, enum: [...]}, {type: string}]`, which generates a wrapper struct that survives an unknown value.

`bun run check:contract-swift` regenerates and runs `git diff --exit-code`, so the derived file can never lag the truth file. Task 2 of this plan consumes the derived file; Task 2's facade hides the `anyOf` wrapper behind `.known` / `rawValue` so no caller in the kit or the app deals with it.

---

### Task 1: Branch, and verify the derived Swift contract

**Files:** none created or modified. This task is a gate: it proves sub-project 1's derived contract is present and usable before any Swift is written against it.

**Interfaces:**
- Consumes: `contracts/openapi.yaml`, `scripts/gen-contract-swift.ts`, the `gen:contract-swift` and `check:contract-swift` package scripts.
- Produces: a verified `contracts/openapi.swift.yaml` on the branch, and a recorded list of the open-enum schemas the facade in Task 2 must wrap.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git checkout -b feat/native-shepherdkit origin/main
```

- [ ] **Step 2: Confirm sub-project 1 landed the generator script**

```bash
ls contracts/openapi.yaml contracts/openapi.swift.yaml scripts/gen-contract-swift.ts
grep -n '"gen:contract-swift"\|"check:contract-swift"' package.json
```

Expected: all three files exist and both scripts are listed. If `contracts/openapi.swift.yaml` or `scripts/gen-contract-swift.ts` is missing, sub-project 1 has not merged yet — **stop and tell the orchestrator**. Do not write the derivation script here; it belongs to sub-project 1 and its ajv drift test.

- [ ] **Step 3: Regenerate and confirm the derived contract is current**

```bash
bun run gen:contract-swift
bun run check:contract-swift
```

Expected: `check:contract-swift` exits 0 with no diff. A diff here means the truth file moved without the derived file being regenerated — regenerate, commit that, and tell the orchestrator.

- [ ] **Step 4: Record what the derivation actually produced**

```bash
grep -c 'type: "null"' contracts/openapi.swift.yaml
grep -n "const:" contracts/openapi.swift.yaml
grep -n "anyOf" contracts/openapi.swift.yaml | head -20
grep -n "x-shepherd-open-enum" contracts/openapi.swift.yaml
```

Expected: zero `type: "null"`, zero `const:`, nine `anyOf` open-enum wrappers (`SessionStatus`, `HerdrState`, `SessionArchiveReason`, `ExperimentRole`, `EventName`, and the four inline ones on `BlockReason.shape`, `BlockReason.quotaKind`, `Session.planPhase`, `Session.haltReason`), and zero remaining `x-shepherd-open-enum` markers — the flag is an input to the derivation, not an output.

If the counts differ, the derivation changed; update Task 2's `OpenEnum` conformance list to match exactly what `anyOf` appears on, and say so in the PR body.

- [ ] **Step 5: Confirm the event schemas the realtime layer needs are named components**

```bash
grep -n "    EventName:\|    EventEnvelope:\|    Session.*Event:" contracts/openapi.swift.yaml
```

Expected: `EventName`, `EventEnvelope`, `SessionStatusEvent`, `SessionRenamedEvent`, `SessionArchivedEvent`, `SessionBlockEvent`, `SessionReadyEvent`. Task 9 depends on every one of these existing as a generated type; if any is missing, stop.

- [ ] **Step 6: No commit**

This task changes nothing. If Step 3 had to regenerate, commit only that:

```bash
git add contracts/openapi.swift.yaml
git commit -m "chore(contract): regenerate the derived swift contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Swift package skeleton, generated client, and the public facade

**Files:**
- Create: `native/Package.swift`
- Create: `native/scripts/sync-contract.sh`
- Create: `native/Sources/ShepherdKit/openapi.yaml` (copied, never hand-written)
- Create: `native/Sources/ShepherdKit/openapi-generator-config.yaml`
- Create: `native/Sources/ShepherdKit/Logging.swift`
- Create: `native/Sources/ShepherdKit/Model/OpenEnum.swift`
- Create: `native/Sources/ShepherdKit/Model/PublicTypes.swift`
- Create: `native/Tests/ShepherdKitTests/GeneratedContractTests.swift`
- Create: `native/Tests/ShepherdKitTests/Fixtures.swift`
- Create: `native/.gitignore`

**Interfaces:**
- Consumes: `contracts/openapi.swift.yaml`, verified in Task 1.
- Produces: `Components.Schemas.Health` (`ok: Swift.Bool`, `version: Swift.String`, `minClient: Swift.String?`), `.Session`, `.SessionList = [Components.Schemas.Session]`, `.Settings`, `.RepoList`, `.Repo`, `.CreateSessionRequest`, `.HeldTask`, `.AccessTokenMinted`, `.AccessTokenSummary`, `.AccessTokenMintRequest`, `.LoginRequest`, `.RepoRootRequest`, `.RepoRootResponse`, `.Ok`, `.BlockReason`, `.AutoMergeStatus`, `.UsageLimits`, `.SessionStatus`, `.HerdrState`, `.AgentProvider`, `.TokenScope`, `.SandboxProfile`, `.Effort`, `.EventName`, `.EventEnvelope`, `.SessionStatusEvent`, `.SessionRenamedEvent`, `.SessionArchivedEvent`, `.SessionBlockEvent`, `.SessionReadyEvent`, and `Components.Schemas._Error` — note the underscore, because `Error` collides with `Swift.Error`. Also `Components.Responses.Unauthorized` with `.body` → `.json(Components.Schemas._Error)`. Every server-produced schema additionally carries `public var additionalProperties: OpenAPIRuntime.OpenAPIObjectContainer` because the contract sets `additionalProperties: true`.
- Produces: the generated `Client` with `public init(serverURL: Foundation.URL, configuration: Configuration = .init(), transport: any ClientTransport, middlewares: [any ClientMiddleware] = [])` and one method per operation — `getHealth`, `login`, `logout`, `listAccessTokens`, `mintAccessToken`, `revokeAccessToken`, `getSettings`, `putRepoRoot`, `listSessions`, `createSession`, `listDoneSessions`, `getSession`, `archiveSession`, `interruptSession`, `listRepos` — each `func name(_ input: Operations.Name.Input) async throws -> Operations.Name.Output`, with the namespace type in UpperCamelCase (`Operations.GetHealth`) because `namingStrategy: idiomatic` is set.
- Produces: `enum ShepherdLog { public static let subsystem: String; public static let client: Logger; public static let realtime: Logger; public static let store: Logger; public static let credentials: Logger }`.
- Produces: `public protocol OpenEnum` with `associatedtype Known: RawRepresentable & Hashable & Sendable where Known.RawValue == String`, `var value1: Known? { get }`, `var value2: String? { get }`, `init(value1: Known?, value2: String?)`; and the extension members `var known: Known?`, `var rawValue: String`, `init(known: Known)`, `init(unknown raw: String)`.
- Produces the public typealiases every later task and the app shell use: `Session`, `Settings`, `Repo`, `RepoList`, `HeldTask`, `SessionStatus`, `CreateSessionRequest`, `AgentProvider`, `Effort`, `Health`.
- Produces: `Fixtures.session(id:name:desig:status:readyToMerge:branch:)`, `.sessionJSON(id:name:)`, `.settings(firstRunPending:repoRoot:)`, `.repoList()`, `.health(version:)`, `.json(_:)`, `.errorJSON(_:code:)`.

- [ ] **Step 1: Write the contract sync script**

Create `native/scripts/sync-contract.sh`:

```bash
#!/usr/bin/env bash
# Copy contracts/openapi.swift.yaml into the ShepherdKit target.
#
# The SOURCE is the DERIVED contract (`bun run gen:contract-swift`), not the
# truth file: swift-openapi-generator cannot represent the const, null-in-enum
# and oneOf-with-null constructs the ajv drift test needs.
#
# swift-openapi-generator's build plugin looks for exactly one file named
# openapi.yaml / openapi.yml / openapi.json inside the target's own sources
# (it filters SwiftPM's `target.sourceFiles` by last path component), so the
# contract has to physically live next to openapi-generator-config.yaml.
#
#   ./native/scripts/sync-contract.sh          copy contracts/ -> native/
#   ./native/scripts/sync-contract.sh --check  fail if the copy is stale (CI)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src="$repo_root/contracts/openapi.swift.yaml"
dst="$repo_root/native/Sources/ShepherdKit/openapi.yaml"

if [ ! -f "$src" ]; then
  echo "sync-contract: missing $src — run 'bun run gen:contract-swift' first" >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  if [ ! -f "$dst" ]; then
    echo "sync-contract: missing $dst — run native/scripts/sync-contract.sh" >&2
    exit 1
  fi
  if ! diff -u "$src" "$dst"; then
    echo "sync-contract: native/Sources/ShepherdKit/openapi.yaml is stale." >&2
    echo "sync-contract: run native/scripts/sync-contract.sh and commit the result." >&2
    exit 1
  fi
  echo "sync-contract: up to date"
  exit 0
fi

cp "$src" "$dst"
echo "sync-contract: contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml"
```

- [ ] **Step 2: Make it executable and run it**

```bash
mkdir -p native/Sources/ShepherdKit/Model native/Tests/ShepherdKitTests native/scripts
chmod +x native/scripts/sync-contract.sh
./native/scripts/sync-contract.sh
```

Expected: `sync-contract: contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml`

- [ ] **Step 3: Write the generator config**

Create `native/Sources/ShepherdKit/openapi-generator-config.yaml`:

```yaml
# Consumed by the OpenAPIGenerator build plugin. Must sit in the target's
# sources next to openapi.yaml. Generated output lands in .build/ and is
# never committed — see native/README.md.
generate:
  - types
  - client
accessModifier: public
namingStrategy: idiomatic
```

- [ ] **Step 4: Write the manifest**

Create `native/Package.swift`:

```swift
// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "ShepherdKit",
  platforms: [.macOS(.v15), .iOS(.v18)],
  products: [
    .library(name: "ShepherdKit", targets: ["ShepherdKit"])
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.13.1"),
    .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.1"),
    .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
  ],
  targets: [
    .target(
      name: "ShepherdKit",
      dependencies: [
        .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
        .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
      ],
      plugins: [
        .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
      ]
    ),
    .testTarget(
      name: "ShepherdKitTests",
      dependencies: ["ShepherdKit"]
    ),
  ],
  swiftLanguageModes: [.v6]
)
```

`openapi.yaml` and `openapi-generator-config.yaml` need **no** `exclude:` and **no** `resources:` entry: the build plugin declares both as build-command `inputFiles`, which is what suppresses SwiftPM's "unhandled files" warning.

- [ ] **Step 5: Write the logging namespace**

Create `native/Sources/ShepherdKit/Logging.swift`:

```swift
import os

/// `os.Logger` instances for this package. The subsystem is fixed by the
/// design spec: ShepherdKit logs under `run.shepherd.kit` and nothing else.
///
/// Never interpolate a token, a password or a prompt body into these.
public enum ShepherdLog {
  public static let subsystem = "run.shepherd.kit"

  public static let client = Logger(subsystem: subsystem, category: "client")
  public static let realtime = Logger(subsystem: subsystem, category: "realtime")
  public static let store = Logger(subsystem: subsystem, category: "store")
  public static let credentials = Logger(subsystem: subsystem, category: "credentials")
}
```

- [ ] **Step 6: Ignore the build directory**

Create `native/.gitignore`:

```gitignore
.build/
.swiftpm/
*.xcodeproj
```

`Package.resolved` is deliberately **not** ignored — it pins the exact dependency graph CI resolves.

- [ ] **Step 7: Write the open-enum facade**

The derived contract turns nine read-side enums into `anyOf: [{type: string, enum: [...]}, {type: string}]`, which the generator emits as a wrapper struct with two optionals — `value1` holding the closed case when the value is known, `value2` holding the raw string always. That shape must not reach callers.

Create `native/Sources/ShepherdKit/Model/OpenEnum.swift`:

```swift
import Foundation

/// A generated open enum: `anyOf: [{type: string, enum: […]}, {type: string}]`.
///
/// swift-openapi-generator's enums are closed, so a server that learns a new
/// `SessionStatus` would break decoding on an older client. The derived
/// contract sidesteps that with an `anyOf` whose second branch is a bare
/// string; this protocol hides the resulting two-optional wrapper behind
/// `known` (the case we understand) and `rawValue` (what actually came over
/// the wire).
public protocol OpenEnum {
  associatedtype Known: RawRepresentable & Hashable & Sendable where Known.RawValue == String

  var value1: Known? { get }
  var value2: String? { get }
  init(value1: Known?, value2: String?)
}

extension OpenEnum {
  /// The case this client understands, or `nil` when the server sent
  /// something newer. Switch on this and handle `nil` as "unrecognised".
  public var known: Known? { value1 }

  /// The wire value, known or not. Safe to log and to show in a diagnostic.
  public var rawValue: String { value1?.rawValue ?? value2 ?? "" }

  /// Build a value the client understands.
  public init(known: Known) { self.init(value1: known, value2: known.rawValue) }

  /// Build a value the client does not understand — used by tests to prove
  /// an unknown value survives a round trip.
  public init(unknown raw: String) { self.init(value1: nil, value2: raw) }
}

// The nine schemas the derivation flags with `x-shepherd-open-enum`. The
// generated code lives in this same module, so these are not retroactive
// conformances across a module boundary.
extension Components.Schemas.SessionStatus: OpenEnum {}
extension Components.Schemas.HerdrState: OpenEnum {}
extension Components.Schemas.SessionArchiveReason: OpenEnum {}
extension Components.Schemas.ExperimentRole: OpenEnum {}
extension Components.Schemas.EventName: OpenEnum {}
extension Components.Schemas.BlockReason.ShapePayload: OpenEnum {}
extension Components.Schemas.BlockReason.QuotaKindPayload: OpenEnum {}
extension Components.Schemas.Session.PlanPhasePayload: OpenEnum {}
extension Components.Schemas.Session.HaltReasonPayload: OpenEnum {}
```

Task 1 Step 4 printed the exact set of `anyOf` schemas and Task 2 Step 11 prints the generated type names. If a nested payload type is spelled differently — say `Components.Schemas.BlockReason.ShapePayload` came out as something else — match the generated spelling here rather than guessing, and drop any conformance whose schema the derivation did not flag.

- [ ] **Step 8: Write the public typealiases**

Create `native/Sources/ShepherdKit/Model/PublicTypes.swift`:

```swift
import Foundation

// Short names for the generated schemas the app uses constantly. These are
// typealiases, not wrappers: there is still exactly one definition of each
// type, and it still comes from the contract.

public typealias Session = Components.Schemas.Session
public typealias Settings = Components.Schemas.Settings
public typealias Repo = Components.Schemas.Repo
public typealias RepoList = Components.Schemas.RepoList
public typealias HeldTask = Components.Schemas.HeldTask
public typealias SessionStatus = Components.Schemas.SessionStatus
public typealias CreateSessionRequest = Components.Schemas.CreateSessionRequest
public typealias AgentProvider = Components.Schemas.AgentProvider
public typealias Effort = Components.Schemas.Effort
public typealias Health = Components.Schemas.Health
```

- [ ] **Step 9: Write the test that proves generation and the facade work**

Create `native/Tests/ShepherdKitTests/GeneratedContractTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("Generated contract types")
struct GeneratedContractTests {
  @Test("Health carries ok, version and the optional minClient")
  func healthShape() throws {
    let health = Health(ok: true, version: "1.47.0", minClient: "0.9.0")
    #expect(health.ok == true)
    #expect(health.version == "1.47.0")
    #expect(health.minClient == "0.9.0")
    #expect(Fixtures.health().minClient == nil)
  }

  @Test("nullable refs survive the derivation as optionals")
  func nullableRefsBecameOptionals() throws {
    // In the truth file these are `oneOf: [$ref, {type: "null"}]`, which the
    // generator silently drops. The derivation turns them into optional
    // plain $refs, so their presence here is the regression test.
    let session = Fixtures.session(id: "s1")
    #expect(session.sandboxApplied == nil)
    #expect(session.archiveReason == nil)
    #expect(session.experimentRole == nil)
  }

  @Test("UsageLimits keeps its nullable windows")
  func usageLimitWindowsSurvivedGeneration() throws {
    let limits = Components.Schemas.UsageLimits(
      session5h: nil, week: nil, perModelWeek: [], credits: nil,
      stale: false, calibratedAt: nil, subscriptionOnly: true
    )
    #expect(limits.session5h == nil)
    #expect(limits.credits == nil)
  }

  @Test("a known open-enum value decodes to .known and keeps its raw value")
  func openEnumKnown() throws {
    let status = try JSONDecoder().decode(SessionStatus.self, from: Data(#""running""#.utf8))
    #expect(status.known == .running)
    #expect(status.rawValue == "running")
  }

  @Test("an open-enum value this client does not know still decodes")
  func openEnumUnknown() throws {
    let status = try JSONDecoder().decode(SessionStatus.self, from: Data(#""quiescing""#.utf8))
    #expect(status.known == nil)
    #expect(status.rawValue == "quiescing")
  }

  @Test("an open enum round-trips through JSON")
  func openEnumRoundTrip() throws {
    let encoded = try JSONEncoder().encode(SessionStatus(known: .blocked))
    #expect(try JSONDecoder().decode(SessionStatus.self, from: encoded).known == .blocked)

    let unknownEncoded = try JSONEncoder().encode(SessionStatus(unknown: "quiescing"))
    #expect(try JSONDecoder().decode(SessionStatus.self, from: unknownEncoded).rawValue == "quiescing")
  }

  @Test("EventName is an open enum too")
  func eventNameIsOpen() throws {
    let known = try JSONDecoder().decode(
      Components.Schemas.EventName.self, from: Data(#""session:ready""#.utf8))
    #expect(known.rawValue == "session:ready")

    let unknown = try JSONDecoder().decode(
      Components.Schemas.EventName.self, from: Data(#""epic:progress""#.utf8))
    #expect(unknown.known == nil)
    #expect(unknown.rawValue == "epic:progress")
  }

  @Test("the public typealiases point at the generated types")
  func typealiasesResolve() {
    #expect(Session.self == Components.Schemas.Session.self)
    #expect(Settings.self == Components.Schemas.Settings.self)
    #expect(Repo.self == Components.Schemas.Repo.self)
    #expect(RepoList.self == Components.Schemas.RepoList.self)
    #expect(HeldTask.self == Components.Schemas.HeldTask.self)
    #expect(SessionStatus.self == Components.Schemas.SessionStatus.self)
    #expect(CreateSessionRequest.self == Components.Schemas.CreateSessionRequest.self)
    #expect(AgentProvider.self == Components.Schemas.AgentProvider.self)
    #expect(Effort.self == Components.Schemas.Effort.self)
    #expect(Health.self == Components.Schemas.Health.self)
  }

  @Test("logging uses the subsystem the spec fixes")
  func loggingSubsystem() {
    #expect(ShepherdLog.subsystem == "run.shepherd.kit")
  }
}
```

- [ ] **Step 10: Write the shared fixture builder**

Create `native/Tests/ShepherdKitTests/Fixtures.swift`:

```swift
import Foundation
@testable import ShepherdKit

/// Builders and raw JSON shared by every suite. One place knows the generated
/// memberwise initialisers, so a contract change breaks exactly one file.
enum Fixtures {
  /// A minimal valid `Session`. Every argument here is a *required* property
  /// of `#/components/schemas/Session`; optionals are left to their defaults.
  static func session(
    id: String,
    name: String = "session",
    desig: String = "TASK-01",
    status: SessionStatus = SessionStatus(known: .running),
    readyToMerge: Bool = false,
    branch: String? = nil
  ) -> Session {
    Session(
      id: id,
      desig: desig,
      name: name,
      prompt: "do the thing",
      repoPath: "/repos/demo",
      baseBranch: "main",
      branch: branch,
      worktreePath: "/repos/demo-\(id)",
      isolated: false,
      herdrSession: "herdr-\(id)",
      herdrAgentId: "agent-\(id)",
      claudeSessionId: "claude-\(id)",
      model: nil,
      effort: nil,
      readyToMerge: readyToMerge,
      mergingSince: nil,
      autopilotEnabled: nil,
      autopilotPaused: false,
      autopilotComplete: false,
      planGateEnabled: nil,
      planPhase: nil,
      autoMergeEnabled: nil,
      auto: false,
      issueNumber: nil,
      sandboxApplied: nil,
      status: status,
      lastState: Components.Schemas.HerdrState(known: .working),
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_001,
      archivedAt: nil,
      archiveReason: nil,
      haltReason: nil,
      haltedAt: nil,
      manualSteps: []
    )
  }

  /// `Session` as the server would send it. Encoded from the builder so the
  /// JSON can never disagree with the generated type.
  static func sessionJSON(id: String, name: String = "session") throws -> Data {
    try JSONEncoder().encode(session(id: id, name: name))
  }

  static func settings(firstRunPending: Bool = false, repoRoot: String = "/repos") -> Settings {
    Settings(
      repoRoot: repoRoot,
      repoRootDisplay: repoRoot,
      firstRunPending: firstRunPending,
      defaultModel: "sonnet",
      defaultCodexModel: nil,
      defaultEffort: "medium",
      defaultAgentProvider: .claude,
      authMode: .subscription,
      operatorLanguage: .en
    )
  }

  static func repoList() -> RepoList {
    RepoList(
      repos: [
        Repo(
          name: "demo",
          path: "/repos/demo",
          display: "demo",
          realPath: "/repos/demo",
          isFork: false,
          hidden: false
        )
      ],
      recentWindowDays: 14
    )
  }

  static func health(version: String = "1.47.0", minClient: String? = nil) -> Health {
    Health(ok: true, version: version, minClient: minClient)
  }

  static func json(_ value: some Encodable) throws -> Data { try JSONEncoder().encode(value) }

  static func errorJSON(_ message: String, code: String? = nil) throws -> Data {
    try JSONEncoder().encode(Components.Schemas._Error(error: message, code: code))
  }
}
```

If the compiler rejects an argument label here, read the generated initialiser (Step 12 prints its path) and match it exactly — do not guess. Fixing it here fixes it for every later task.

- [ ] **Step 11: Build**

Run: `swift build --package-path native`
Expected: exit 0. The generator prints its configuration banner and **no** `warning: Schema "null" is not supported` lines. If a `skipping` warning appears, the derived contract is wrong — do **not** patch `native/Sources/ShepherdKit/openapi.yaml`; fix `scripts/gen-contract-swift.ts`, re-run `bun run gen:contract-swift` and `./native/scripts/sync-contract.sh`, and tell the orchestrator that sub-project 1's derivation needs a change.

- [ ] **Step 12: Read the generated sources once, to confirm the shapes this plan relies on**

```bash
GEN=native/.build/plugins/outputs/native/ShepherdKit/destination/OpenAPIGenerator/GeneratedSources
ls "$GEN"
grep -n "public func " "$GEN/Client.swift"
grep -n "public struct SessionStatus\|public enum Value1Payload\|ShapePayload\|QuotaKindPayload\|PlanPhasePayload\|HaltReasonPayload" "$GEN/Types+Components+Schemas.swift"
```

Expected file list: `Client.swift`, `Server.swift` (0 bytes), `Types.swift`, `Types+Components.swift`, `Types+Components+Headers.swift`, `Types+Components+Parameters.swift`, `Types+Components+RequestBodies.swift`, `Types+Components+Responses.swift`, `Types+Components+Schemas.swift`, `Types+Operations.swift`.
Expected methods: the fifteen named in this task's Interfaces block.
Expected open-enum shape: `SessionStatus` is a `struct` with `public var value1: …Value1Payload?` and `public var value2: Swift.String?`. If the generator named the inner enum or the properties differently, update `OpenEnum.swift` from Step 7 to match before continuing — every later task reads `.known` and `rawValue`, which is all the rest of the plan depends on.

- [ ] **Step 13: Run the tests**

Run: `swift test --package-path native`
Expected: `Suite "Generated contract types" passed` — 9 tests, 0 failures.

- [ ] **Step 14: Commit**

```bash
git add native/
git commit -m "feat(native): shepherdkit package skeleton with generated openapi client

Build-plugin generation from a synced copy of contracts/openapi.swift.yaml.
Generated code stays in .build and is never committed; the synced copy is what
CI diffs. Open enums get a .known/rawValue facade so the anyOf wrapper never
reaches callers. macOS 15 / iOS 18, Swift 6 language mode.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: ServerProfile and CredentialStore

**Files:**
- Create: `native/Sources/ShepherdKit/Model/ServerProfile.swift`
- Create: `native/Sources/ShepherdKit/Credentials/CredentialStore.swift`
- Create: `native/Sources/ShepherdKit/Credentials/InMemoryCredentialStore.swift`
- Create: `native/Sources/ShepherdKit/Credentials/KeychainCredentialStore.swift`
- Create: `native/Tests/ShepherdKitTests/ServerProfileTests.swift`
- Create: `native/Tests/ShepherdKitTests/CredentialStoreTests.swift`

**Interfaces:**
- Consumes: `ShepherdLog` from Task 2.
- Produces: `public struct ServerProfile: Codable, Hashable, Sendable, Identifiable` with `public let id: UUID`, `public var name: String`, `public var baseURL: URL`, `public var mode: ServerProfile.Mode`, `public var credentialKey: String`; `public enum Mode: String, Codable, Hashable, Sendable { case local, remote }`; `public init(id: UUID = UUID(), name: String, baseURL: URL, mode: Mode, credentialKey: String? = nil)`; `public static func requireSecureRemote(_ url: URL) throws`; `@discardableResult public func validated() throws -> ServerProfile`.
- Produces: `public enum ServerProfileError: Error, Equatable, Sendable { case insecureRemoteURL(String); case missingHost }`.
- Produces: `public struct StoredCredential: Codable, Hashable, Sendable { public let token: String; public let tokenId: String; public init(token: String, tokenId: String) }`.
- Produces: `public protocol CredentialStore: Sendable { func load(for key: String) throws -> StoredCredential?; func save(_ credential: StoredCredential, for key: String) throws; func delete(for key: String) throws }`.
- Produces: `public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable { public init(); public init(seed: [String: StoredCredential]) }`.
- Produces: `public struct KeychainCredentialStore: CredentialStore, Sendable { public init(service: String = ShepherdLog.subsystem) }` and `public enum KeychainError: Error, Equatable { case unexpectedStatus(OSStatus); case malformedItem }`.

- [ ] **Step 1: Write the failing profile tests**

Create `native/Tests/ShepherdKitTests/ServerProfileTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("ServerProfile")
struct ServerProfileTests {
  @Test("credentialKey defaults to the profile id")
  func defaultCredentialKey() {
    let id = UUID()
    let p = ServerProfile(
      id: id, name: "Mac", baseURL: URL(string: "http://localhost:7330")!, mode: .local)
    #expect(p.credentialKey == "profile.\(id.uuidString)")
  }

  @Test("https remote is accepted")
  func httpsRemoteAccepted() throws {
    try ServerProfile.requireSecureRemote(URL(string: "https://shepherd.example.com")!)
  }

  @Test("plain http to a public host is rejected")
  func plainHttpRejected() {
    #expect(throws: ServerProfileError.insecureRemoteURL("shepherd.example.com")) {
      try ServerProfile.requireSecureRemote(URL(string: "http://shepherd.example.com:7330")!)
    }
  }

  @Test(
    "loopback over http is accepted",
    arguments: ["http://localhost:7330", "http://127.0.0.1:7330", "http://[::1]:7330"])
  func loopbackAccepted(_ raw: String) throws {
    try ServerProfile.requireSecureRemote(URL(string: raw)!)
  }

  @Test("tailnet names over http are accepted")
  func tailnetAccepted() throws {
    try ServerProfile.requireSecureRemote(URL(string: "http://mac-mini.tail1234.ts.net:7330")!)
  }

  @Test("a hostless URL is rejected")
  func hostlessRejected() {
    #expect(throws: ServerProfileError.missingHost) {
      try ServerProfile.requireSecureRemote(URL(string: "http:///api")!)
    }
  }

  @Test("validated() only gates remote profiles")
  func localProfileSkipsThePolicy() throws {
    let local = ServerProfile(
      name: "This Mac", baseURL: URL(string: "http://localhost:7330")!, mode: .local)
    try local.validated()
    let remote = ServerProfile(
      name: "Box", baseURL: URL(string: "http://box.example.com")!, mode: .remote)
    #expect(throws: ServerProfileError.insecureRemoteURL("box.example.com")) {
      try remote.validated()
    }
  }

  @Test("round-trips through JSON")
  func codable() throws {
    let p = ServerProfile(name: "Mac", baseURL: URL(string: "https://a.ts.net")!, mode: .remote)
    let back = try JSONDecoder().decode(ServerProfile.self, from: JSONEncoder().encode(p))
    #expect(back == p)
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter ServerProfile`
Expected: FAIL — `error: cannot find 'ServerProfile' in scope`.

- [ ] **Step 3: Implement ServerProfile**

Create `native/Sources/ShepherdKit/Model/ServerProfile.swift`:

```swift
import Foundation

/// Why a profile's base URL is not acceptable.
public enum ServerProfileError: Error, Equatable, Sendable {
  /// A `.remote` profile used plain http to a host that is neither loopback
  /// nor a tailnet name. The associated value is the offending host.
  case insecureRemoteURL(String)
  /// The URL has no host component at all.
  case missingHost
}

/// One server the app can talk to. Replaces the web UI's same-origin
/// assumption: the app keeps any number of these and one is active.
public struct ServerProfile: Codable, Hashable, Sendable, Identifiable {
  public enum Mode: String, Codable, Hashable, Sendable {
    /// A server this Mac runs (sub-project 3 supervises it).
    case local
    /// A server reached over the network.
    case remote
  }

  public let id: UUID
  public var name: String
  public var baseURL: URL
  public var mode: Mode
  /// Keychain account name for this profile's access token.
  public var credentialKey: String

  public init(
    id: UUID = UUID(),
    name: String,
    baseURL: URL,
    mode: Mode,
    credentialKey: String? = nil
  ) {
    self.id = id
    self.name = name
    self.baseURL = baseURL
    self.mode = mode
    self.credentialKey = credentialKey ?? "profile.\(id.uuidString)"
  }

  /// The security policy from the design spec: "Remote profiles require
  /// `https` unless the host is loopback or a `.ts.net` name."
  ///
  /// A `.local` profile is exempt because sub-project 3 binds that server to
  /// loopback itself.
  public static func requireSecureRemote(_ url: URL) throws {
    guard let host = url.host(percentEncoded: false), !host.isEmpty else {
      throw ServerProfileError.missingHost
    }
    if url.scheme?.lowercased() == "https" { return }
    if isLoopback(host) { return }
    if host.lowercased().hasSuffix(".ts.net") { return }
    throw ServerProfileError.insecureRemoteURL(host)
  }

  /// Returns `self` when the profile satisfies the policy, throws otherwise.
  @discardableResult
  public func validated() throws -> ServerProfile {
    if mode == .remote { try Self.requireSecureRemote(baseURL) }
    return self
  }

  private static func isLoopback(_ host: String) -> Bool {
    let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
    return bare == "localhost" || bare == "127.0.0.1" || bare == "::1"
  }
}
```

- [ ] **Step 4: Run the profile tests**

Run: `swift test --package-path native --filter ServerProfile`
Expected: PASS — 8 tests (the loopback case runs three times), 0 failures.

- [ ] **Step 5: Write the failing credential-store tests**

Create `native/Tests/ShepherdKitTests/CredentialStoreTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("CredentialStore")
struct CredentialStoreTests {
  @Test("in-memory store round-trips and deletes")
  func inMemoryRoundTrip() throws {
    let store = InMemoryCredentialStore()
    #expect(try store.load(for: "k") == nil)

    let credential = StoredCredential(token: "shp_abc", tokenId: "tok_1")
    try store.save(credential, for: "k")
    #expect(try store.load(for: "k") == credential)

    try store.delete(for: "k")
    #expect(try store.load(for: "k") == nil)
  }

  @Test("deleting a key that was never stored is not an error")
  func inMemoryDeleteMissing() throws {
    try InMemoryCredentialStore().delete(for: "nope")
  }

  @Test("saving twice replaces the credential")
  func inMemoryReplace() throws {
    let store = InMemoryCredentialStore()
    try store.save(StoredCredential(token: "a", tokenId: "1"), for: "k")
    try store.save(StoredCredential(token: "b", tokenId: "2"), for: "k")
    #expect(try store.load(for: "k")?.token == "b")
  }

  @Test("seeded store reads back its seed")
  func inMemorySeed() throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "t", tokenId: "i")])
    #expect(try store.load(for: "k")?.tokenId == "i")
  }

  // Writes to the login keychain, so it uses a service name unique to this
  // run and cleans up after itself.
  @Test("keychain store round-trips, replaces and deletes")
  func keychainRoundTrip() throws {
    let service = "run.shepherd.kit.test.\(UUID().uuidString)"
    let store = KeychainCredentialStore(service: service)
    let key = "profile.test"
    defer { try? store.delete(for: key) }

    #expect(try store.load(for: key) == nil)
    let credential = StoredCredential(token: "shp_keychain", tokenId: "tok_k")
    try store.save(credential, for: key)
    #expect(try store.load(for: key) == credential)

    try store.save(StoredCredential(token: "shp_second", tokenId: "tok_k2"), for: key)
    #expect(try store.load(for: key)?.token == "shp_second")

    try store.delete(for: key)
    #expect(try store.load(for: key) == nil)
  }
}
```

- [ ] **Step 6: Run it and watch it fail**

Run: `swift test --package-path native --filter CredentialStore`
Expected: FAIL — `error: cannot find 'InMemoryCredentialStore' in scope`.

- [ ] **Step 7: Implement the protocol and the in-memory store**

Create `native/Sources/ShepherdKit/Credentials/CredentialStore.swift`:

```swift
import Foundation

/// A minted access token plus the id needed to revoke it. Stored as one
/// Keychain item so logout can revoke server-side before clearing locally.
public struct StoredCredential: Codable, Hashable, Sendable {
  /// The `shp_…` plaintext. Never logged, never written outside the store.
  public let token: String
  /// `AccessTokenSummary.id`, for `DELETE /api/access-tokens/{id}`.
  public let tokenId: String

  public init(token: String, tokenId: String) {
    self.token = token
    self.tokenId = tokenId
  }
}

/// Where a profile's access token lives. Synchronous and `Sendable` so the
/// auth middleware can read it from whatever executor the transport uses —
/// `ClientMiddleware.intercept` has no cheap place to await an actor hop.
public protocol CredentialStore: Sendable {
  /// Returns the credential for `key`, or `nil` when there is none.
  func load(for key: String) throws -> StoredCredential?
  /// Stores `credential` under `key`, replacing any previous value.
  func save(_ credential: StoredCredential, for key: String) throws
  /// Removes the credential for `key`. A missing key is not an error.
  func delete(for key: String) throws
}
```

Create `native/Sources/ShepherdKit/Credentials/InMemoryCredentialStore.swift`:

```swift
import Foundation

/// Non-persistent `CredentialStore` for tests and SwiftUI previews.
///
/// Lock-guarded rather than an actor, because `CredentialStore` is
/// synchronous by design (see the protocol's doc comment).
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String: StoredCredential]

  public init() { storage = [:] }

  public init(seed: [String: StoredCredential]) { storage = seed }

  public func load(for key: String) throws -> StoredCredential? {
    lock.lock()
    defer { lock.unlock() }
    return storage[key]
  }

  public func save(_ credential: StoredCredential, for key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    storage[key] = credential
  }

  public func delete(for key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    storage[key] = nil
  }
}
```

- [ ] **Step 8: Implement the Keychain store**

Create `native/Sources/ShepherdKit/Credentials/KeychainCredentialStore.swift`:

```swift
import Foundation
import Security

public enum KeychainError: Error, Equatable {
  /// `SecItem*` returned something other than `errSecSuccess` / `errSecItemNotFound`.
  case unexpectedStatus(OSStatus)
  /// The stored blob is not the JSON this store writes.
  case malformedItem
}

/// The real credential store: one `kSecClassGenericPassword` item per
/// profile, keyed by `service` + `credentialKey`. The design spec fixes the
/// rule — "Tokens only in the Keychain."
public struct KeychainCredentialStore: CredentialStore, Sendable {
  private let service: String

  public init(service: String = ShepherdLog.subsystem) {
    self.service = service
  }

  public func load(for key: String) throws -> StoredCredential? {
    var query = baseQuery(for: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    guard let data = item as? Data else { throw KeychainError.malformedItem }
    do {
      return try JSONDecoder().decode(StoredCredential.self, from: data)
    } catch {
      throw KeychainError.malformedItem
    }
  }

  public func save(_ credential: StoredCredential, for key: String) throws {
    let data = try JSONEncoder().encode(credential)
    // Replace rather than update-or-add: a malformed leftover item would let
    // SecItemUpdate succeed while leaving undecodable bytes in place.
    try delete(for: key)

    var attributes = baseQuery(for: key)
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    ShepherdLog.credentials.debug("stored credential for \(key, privacy: .public)")
  }

  public func delete(for key: String) throws {
    let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError.unexpectedStatus(status)
    }
  }

  private func baseQuery(for key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }
}
```

- [ ] **Step 9: Run the credential tests**

Run: `swift test --package-path native --filter CredentialStore`
Expected: PASS — 5 tests, 0 failures. If the keychain test fails with `unexpectedStatus(-34018)` (`errSecMissingEntitlement`), the test binary has no keychain access; run `swift test --package-path native` from Terminal rather than from an SSH session, and see the note Task 12 adds to `native/README.md`.

- [ ] **Step 10: Commit**

```bash
git add native/Sources/ShepherdKit/Model native/Sources/ShepherdKit/Credentials native/Tests/ShepherdKitTests
git commit -m "feat(native): server profiles and credential stores

ServerProfile carries the https-unless-loopback-or-tailnet policy; tokens go
to the Keychain under run.shepherd.kit, with an in-memory store for tests.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: ShepherdError and the two middlewares

**Files:**
- Create: `native/Sources/ShepherdKit/Model/ShepherdError.swift`
- Create: `native/Sources/ShepherdKit/Client/AuthenticationMiddleware.swift`
- Create: `native/Sources/ShepherdKit/Client/RetryingMiddleware.swift`
- Create: `native/Tests/ShepherdKitTests/MiddlewareTests.swift`

**Interfaces:**
- Consumes: `CredentialStore`, `StoredCredential`, `ShepherdLog`.
- Produces: `public enum ShepherdError: Error, Equatable, Sendable` with cases `unauthenticated`, `forbidden`, `firstRunPending`, `notFound`, `badRequest(String)`, `conflict(code: String?, message: String)`, `unprocessable(String)`, `upstreamFailure(String)`, `contractMismatch(route: String, underlying: String)`, `insecureProfile(ServerProfileError)`, `transport(String)`.
- Produces: `public static func ShepherdError.from(_ error: any Error, route: String) -> ShepherdError` and `public static func ShepherdError.fromUndocumented(statusCode: Int, route: String) -> ShepherdError`.
- Produces: `public struct AuthenticationMiddleware: ClientMiddleware, Sendable` with `public init(store: any CredentialStore, credentialKey: String, onUnauthorized: @escaping @Sendable () -> Void)`.
- Produces: `public struct RetryingMiddleware: ClientMiddleware, Sendable` with `public init(maxAttempts: Int = 3, initialBackoff: Duration = .milliseconds(200))`.

- [ ] **Step 1: Write the failing middleware tests**

Create `native/Tests/ShepherdKitTests/MiddlewareTests.swift`:

```swift
import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
@testable import ShepherdKit

@Suite("Middlewares")
struct MiddlewareTests {
  private let baseURL = URL(string: "http://localhost:7330")!

  @Test("the bearer token from the store is attached")
  func attachesBearer() async throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "shp_x", tokenId: "t")])
    let middleware = AuthenticationMiddleware(store: store, credentialKey: "k", onUnauthorized: {})

    let seen = Box<HTTPRequest?>(nil)
    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { request, _, _ in
      seen.set(request)
      return (HTTPResponse(status: .ok), nil)
    }
    #expect(seen.get()?.headerFields[.authorization] == "Bearer shp_x")
  }

  @Test("no credential means no Authorization header")
  func noCredentialNoHeader() async throws {
    let middleware = AuthenticationMiddleware(
      store: InMemoryCredentialStore(), credentialKey: "k", onUnauthorized: {})

    let seen = Box<HTTPRequest?>(nil)
    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { request, _, _ in
      seen.set(request)
      return (HTTPResponse(status: .ok), nil)
    }
    #expect(seen.get()?.headerFields[.authorization] == nil)
  }

  @Test("a 401 clears the credential and signals needsLogin")
  func unauthorizedClearsAndSignals() async throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "shp_x", tokenId: "t")])
    let fired = Box(false)
    let middleware = AuthenticationMiddleware(
      store: store, credentialKey: "k", onUnauthorized: { fired.set(true) })

    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in (HTTPResponse(status: .unauthorized), nil) }

    #expect(try store.load(for: "k") == nil)
    #expect(fired.get() == true)
  }

  @Test("a 200 leaves the credential alone")
  func okKeepsCredential() async throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "shp_x", tokenId: "t")])
    let fired = Box(false)
    let middleware = AuthenticationMiddleware(
      store: store, credentialKey: "k", onUnauthorized: { fired.set(true) })

    _ = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in (HTTPResponse(status: .ok), nil) }

    #expect(try store.load(for: "k") != nil)
    #expect(fired.get() == false)
  }

  @Test("a bodyless GET is retried three times then gives up")
  func retriesIdempotentGet() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    await #expect(throws: (any Error).self) {
      _ = try await middleware.intercept(
        HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
        body: nil, baseURL: baseURL, operationID: "listSessions"
      ) { _, _, _ in
        attempts.set(attempts.get() + 1)
        throw URLError(.networkConnectionLost)
      }
    }
    #expect(attempts.get() == 3)
  }

  @Test("a GET that recovers on the second attempt returns the good response")
  func retryRecovers() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    let (response, _) = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in
      attempts.set(attempts.get() + 1)
      if attempts.get() == 1 { throw URLError(.timedOut) }
      return (HTTPResponse(status: .ok), nil)
    }
    #expect(attempts.get() == 2)
    #expect(response.status == .ok)
  }

  @Test("a 500 on a GET is retried")
  func retriesServerError() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    let (response, _) = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions"),
      body: nil, baseURL: baseURL, operationID: "listSessions"
    ) { _, _, _ in
      attempts.set(attempts.get() + 1)
      return (HTTPResponse(status: attempts.get() < 3 ? .internalServerError : .ok), nil)
    }
    #expect(attempts.get() == 3)
    #expect(response.status == .ok)
  }

  @Test("a POST is never retried")
  func doesNotRetryPost() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    await #expect(throws: (any Error).self) {
      _ = try await middleware.intercept(
        HTTPRequest(method: .post, scheme: nil, authority: nil, path: "/api/sessions"),
        body: HTTPBody("{}"), baseURL: baseURL, operationID: "createSession"
      ) { _, _, _ in
        attempts.set(attempts.get() + 1)
        throw URLError(.networkConnectionLost)
      }
    }
    #expect(attempts.get() == 1)
  }

  @Test("a 404 is not retried")
  func doesNotRetryNotFound() async throws {
    let attempts = Box(0)
    let middleware = RetryingMiddleware(maxAttempts: 3, initialBackoff: .milliseconds(1))

    let (response, _) = try await middleware.intercept(
      HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/sessions/x"),
      body: nil, baseURL: baseURL, operationID: "getSession"
    ) { _, _, _ in
      attempts.set(attempts.get() + 1)
      return (HTTPResponse(status: .notFound), nil)
    }
    #expect(attempts.get() == 1)
    #expect(response.status == .notFound)
  }
}

/// Minimal lock box so test closures can mutate state under Swift 6 strict
/// concurrency without an actor hop. The middleware's `next` closure is
/// `@Sendable` and runs on whatever executor the caller is on.
final class Box<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value
  init(_ value: Value) { self.value = value }
  func get() -> Value {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func set(_ newValue: Value) {
    lock.lock()
    defer { lock.unlock() }
    value = newValue
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter Middlewares`
Expected: FAIL — `error: cannot find 'AuthenticationMiddleware' in scope`.

- [ ] **Step 3: Implement ShepherdError**

Create `native/Sources/ShepherdKit/Model/ShepherdError.swift`:

```swift
import Foundation
import OpenAPIRuntime

/// Every failure `ShepherdClient` can surface. Deliberately `Equatable` with
/// `String` payloads rather than wrapped `Error`s so tests can assert on an
/// exact value instead of a type check.
public enum ShepherdError: Error, Equatable, Sendable {
  /// 401. The middleware has already cleared the stored token and fired
  /// `needsLogin`; the caller should show the login sheet.
  case unauthenticated
  /// 403. The caller used a bearer token where an operator session is needed.
  case forbidden
  /// 409 with `{"error":"first_run_pending"}`. The workspace root must be
  /// picked before anything else works.
  case firstRunPending
  /// 404.
  case notFound
  /// 400, with the server's `error` text.
  case badRequest(String)
  /// 409 other than first run: name taken, worktree occupied, herdr restart.
  case conflict(code: String?, message: String)
  /// 422 — the base branch does not resolve to a ref.
  case unprocessable(String)
  /// 502 — git or the agent runner failed downstream.
  case upstreamFailure(String)
  /// The server answered with something the contract does not describe, or a
  /// body that would not decode. `route` is the operation id.
  case contractMismatch(route: String, underlying: String)
  /// The profile violates the remote-URL policy.
  case insecureProfile(ServerProfileError)
  /// The request never produced an HTTP response.
  case transport(String)

  /// Maps a thrown error from the generated client. The generated client only
  /// throws for transport failures and body decoding failures — documented
  /// statuses come back as `Output` cases instead.
  public static func from(_ error: any Error, route: String) -> ShepherdError {
    if let shepherd = error as? ShepherdError { return shepherd }
    if let profile = error as? ServerProfileError { return .insecureProfile(profile) }
    guard let clientError = error as? ClientError else {
      return .transport(String(describing: error))
    }
    let underlying = clientError.underlyingError
    if underlying is DecodingError {
      return .contractMismatch(
        route: clientError.operationID, underlying: String(describing: underlying))
    }
    if let runtime = underlying as? RuntimeError {
      return .contractMismatch(
        route: clientError.operationID, underlying: String(describing: runtime))
    }
    return .transport(clientError.causeDescription)
  }

  /// Maps the generated `.undocumented(statusCode:_)` case. A 401 there means
  /// a route the contract did not mark as returning 401 answered with one —
  /// still an auth failure, not a contract bug.
  public static func fromUndocumented(statusCode: Int, route: String) -> ShepherdError {
    switch statusCode {
    case 401: return .unauthenticated
    case 403: return .forbidden
    default:
      return .contractMismatch(route: route, underlying: "undocumented status \(statusCode)")
    }
  }

  /// Maps a documented 409 body onto `.firstRunPending` or `.conflict`.
  public static func fromConflict(_ body: Components.Schemas._Error) -> ShepherdError {
    body.error == "first_run_pending"
      ? .firstRunPending
      : .conflict(code: body.code, message: body.error)
  }
}
```

- [ ] **Step 4: Implement AuthenticationMiddleware**

Create `native/Sources/ShepherdKit/Client/AuthenticationMiddleware.swift`:

```swift
import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Attaches `Authorization: Bearer <token>` from the `CredentialStore`, and
/// turns a 401 into a logout: the stored credential is cleared and
/// `onUnauthorized` fires so `ShepherdClient` can publish `needsLogin`.
///
/// The 401 is *not* converted into a thrown error here — the generated client
/// maps it to a documented `.unauthorized` output case, and `ShepherdClient`
/// turns that into `ShepherdError.unauthenticated`. Doing the mapping in one
/// place keeps the middleware free of per-operation knowledge.
public struct AuthenticationMiddleware: ClientMiddleware, Sendable {
  private let store: any CredentialStore
  private let credentialKey: String
  private let onUnauthorized: @Sendable () -> Void

  public init(
    store: any CredentialStore,
    credentialKey: String,
    onUnauthorized: @escaping @Sendable () -> Void
  ) {
    self.store = store
    self.credentialKey = credentialKey
    self.onUnauthorized = onUnauthorized
  }

  public func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    var request = request
    if let credential = try? store.load(for: credentialKey) {
      request.headerFields[.authorization] = "Bearer \(credential.token)"
    }

    let (response, responseBody) = try await next(request, body, baseURL)

    if response.status == .unauthorized {
      ShepherdLog.client.notice(
        "401 on \(operationID, privacy: .public) — clearing the stored credential")
      try? store.delete(for: credentialKey)
      onUnauthorized()
    }
    return (response, responseBody)
  }
}
```

- [ ] **Step 5: Implement RetryingMiddleware**

Create `native/Sources/ShepherdKit/Client/RetryingMiddleware.swift`:

```swift
import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Retries idempotent GETs with exponential backoff, per the design spec:
/// "Retries idempotent GETs three times with backoff."
///
/// Only bodyless GETs are eligible. `HTTPBody` is a single-pass stream, so
/// replaying a request that carries one would send an empty body the second
/// time — silently corrupting the call. GETs in this contract never have a
/// body, so the guard costs nothing and removes the whole class of bug.
public struct RetryingMiddleware: ClientMiddleware, Sendable {
  private let maxAttempts: Int
  private let initialBackoff: Duration

  public init(maxAttempts: Int = 3, initialBackoff: Duration = .milliseconds(200)) {
    precondition(maxAttempts >= 1, "maxAttempts must be at least 1")
    self.maxAttempts = maxAttempts
    self.initialBackoff = initialBackoff
  }

  public func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    guard request.method == .get, body == nil else {
      return try await next(request, body, baseURL)
    }

    var backoff = initialBackoff
    var attempt = 1
    while true {
      do {
        let (response, responseBody) = try await next(request, body, baseURL)
        if response.status.kind == .serverError, attempt < maxAttempts {
          ShepherdLog.client.debug(
            "retrying \(operationID, privacy: .public) after \(response.status.code)")
          try await Task.sleep(for: backoff)
          backoff *= 2
          attempt += 1
          continue
        }
        return (response, responseBody)
      } catch {
        if attempt >= maxAttempts { throw error }
        ShepherdLog.client.debug(
          "retrying \(operationID, privacy: .public) after a transport failure")
        try await Task.sleep(for: backoff)
        backoff *= 2
        attempt += 1
      }
    }
  }
}
```

- [ ] **Step 6: Run the middleware tests**

Run: `swift test --package-path native --filter Middlewares`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add native/Sources/ShepherdKit/Model/ShepherdError.swift native/Sources/ShepherdKit/Client native/Tests/ShepherdKitTests/MiddlewareTests.swift
git commit -m "feat(native): shepherd error taxonomy, auth and retry middlewares

401 clears the stored token and signals needsLogin; bodyless GETs retry three
times with backoff. Request bodies are never replayed — HTTPBody is one-shot.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: FakeShepherdServer

**Files:**
- Create: `native/Tests/ShepherdKitTests/FakeShepherdServer.swift`
- Create: `native/Tests/ShepherdKitTests/FakeShepherdServerTests.swift`

**Interfaces:**
- Consumes: `Fixtures` from Task 2.
- Produces: `struct FakeResponse: Sendable { var statusCode: Int; var headers: [String: String]; var body: Data; init(statusCode: Int = 200, headers: [String: String] = ["Content-Type": "application/json"], body: Data = Data()) }`.
- Produces: `struct RecordedRequest: Sendable { let method: String; let path: String; let query: String?; let headers: [String: String]; let body: Data? }`.
- Produces: `final class FakeShepherdServer: Sendable` with `init()`, `var baseURL: URL` (`http://fake.shepherd.invalid`), `func on(_ method: String, _ path: String, _ handler: @escaping @Sendable (RecordedRequest) throws -> FakeResponse)`, `func stub(_ method: String, _ path: String, status: Int, json: Data)`, `func requests() -> [RecordedRequest]`, `func urlSession() -> URLSession`, `func tearDown()`.
- Produces: `enum FakeServerError: Error, Equatable { case noRoute(String) }`.

- [ ] **Step 1: Write the failing harness test**

Create `native/Tests/ShepherdKitTests/FakeShepherdServerTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("FakeShepherdServer")
struct FakeShepherdServerTests {
  @Test("serves a stubbed route and records the request")
  func servesAndRecords() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))

    var request = URLRequest(url: server.baseURL.appending(path: "api/health"))
    request.setValue("Bearer shp_test", forHTTPHeaderField: "Authorization")
    let (data, response) = try await server.urlSession().data(for: request)

    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    let health = try JSONDecoder().decode(Components.Schemas.Health.self, from: data)
    #expect(health.version == "1.47.0")

    let recorded = server.requests()
    #expect(recorded.count == 1)
    #expect(recorded[0].method == "GET")
    #expect(recorded[0].path == "/api/health")
    #expect(recorded[0].headers["Authorization"] == "Bearer shp_test")
  }

  @Test("an unstubbed route fails the request rather than hanging")
  func unstubbedRouteFails() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }

    await #expect(throws: (any Error).self) {
      _ = try await server.urlSession().data(
        from: server.baseURL.appending(path: "api/sessions"))
    }
  }

  @Test("a handler sees the request body")
  func handlerSeesBody() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.on("PUT", "/api/settings") { request in
      let decoded = try JSONDecoder().decode(
        Components.Schemas.RepoRootRequest.self, from: request.body ?? Data())
      #expect(decoded.repoRoot == "/repos")
      return FakeResponse(
        body: try JSONEncoder().encode(
          Components.Schemas.RepoRootResponse(repoRoot: "/repos", repoRootDisplay: "~/repos")))
    }

    var request = URLRequest(url: server.baseURL.appending(path: "api/settings"))
    request.httpMethod = "PUT"
    request.httpBody = try JSONEncoder().encode(
      Components.Schemas.RepoRootRequest(repoRoot: "/repos"))
    let (data, _) = try await server.urlSession().data(for: request)

    let decoded = try JSONDecoder().decode(Components.Schemas.RepoRootResponse.self, from: data)
    #expect(decoded.repoRootDisplay == "~/repos")
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter FakeShepherdServer`
Expected: FAIL — `error: cannot find 'FakeShepherdServer' in scope`.

- [ ] **Step 3: Implement the fake**

Create `native/Tests/ShepherdKitTests/FakeShepherdServer.swift`:

```swift
import Foundation
@testable import ShepherdKit

struct FakeResponse: Sendable {
  var statusCode: Int
  var headers: [String: String]
  var body: Data

  init(
    statusCode: Int = 200,
    headers: [String: String] = ["Content-Type": "application/json"],
    body: Data = Data()
  ) {
    self.statusCode = statusCode
    self.headers = headers
    self.body = body
  }
}

struct RecordedRequest: Sendable {
  let method: String
  let path: String
  let query: String?
  let headers: [String: String]
  let body: Data?
}

enum FakeServerError: Error, Equatable {
  case noRoute(String)
}

/// An in-process Shepherd for the HTTP half of the kit's tests.
///
/// `URLProtocol` is registered on one `URLSessionConfiguration.ephemeral`, so
/// the fake is scoped to the session handed to `URLSessionTransport` and
/// nothing leaks between suites. Each instance gets a unique host, so
/// parallel suites route to their own registry entry.
final class FakeShepherdServer: Sendable {
  private let host: String
  private let registryKey: String

  let baseURL: URL

  init() {
    let id = UUID().uuidString.lowercased()
    host = "\(id).fake.shepherd.invalid"
    registryKey = host
    baseURL = URL(string: "http://\(host)")!
    FakeServerRegistry.shared.register(registryKey)
  }

  /// Installs a handler for `method path`. The handler runs on the URL
  /// loading system's thread; throw to fail the request.
  func on(
    _ method: String,
    _ path: String,
    _ handler: @escaping @Sendable (RecordedRequest) throws -> FakeResponse
  ) {
    FakeServerRegistry.shared.setHandler(
      registryKey, route: "\(method.uppercased()) \(path)", handler: handler)
  }

  /// Convenience for the common "answer this status with this JSON" case.
  func stub(_ method: String, _ path: String, status: Int, json: Data) {
    on(method, path) { _ in FakeResponse(statusCode: status, body: json) }
  }

  /// Every request the fake has served, oldest first.
  func requests() -> [RecordedRequest] {
    FakeServerRegistry.shared.requests(registryKey)
  }

  /// A session wired to this fake. Hand it to `URLSessionTransport`.
  func urlSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FakeURLProtocol.self]
    return URLSession(configuration: configuration)
  }

  func tearDown() {
    FakeServerRegistry.shared.unregister(registryKey)
  }
}

/// Lock-guarded route/recording table. `URLProtocol.startLoading()` is
/// synchronous and runs on `com.apple.CFNetwork.CustomProtocols`, so this
/// cannot be an actor.
private final class FakeServerRegistry: @unchecked Sendable {
  static let shared = FakeServerRegistry()

  private struct Entry {
    var handlers: [String: @Sendable (RecordedRequest) throws -> FakeResponse] = [:]
    var recorded: [RecordedRequest] = []
  }

  private let lock = NSLock()
  private var entries: [String: Entry] = [:]

  func register(_ key: String) {
    lock.lock()
    defer { lock.unlock() }
    entries[key] = Entry()
  }

  func unregister(_ key: String) {
    lock.lock()
    defer { lock.unlock() }
    entries[key] = nil
  }

  func setHandler(
    _ key: String, route: String,
    handler: @escaping @Sendable (RecordedRequest) throws -> FakeResponse
  ) {
    lock.lock()
    defer { lock.unlock() }
    entries[key]?.handlers[route] = handler
  }

  func requests(_ key: String) -> [RecordedRequest] {
    lock.lock()
    defer { lock.unlock() }
    return entries[key]?.recorded ?? []
  }

  func knows(host: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return entries[host] != nil
  }

  /// Records the request and returns its handler, without calling out while
  /// the lock is held.
  func take(_ request: RecordedRequest, host: String)
    -> (@Sendable (RecordedRequest) throws -> FakeResponse)?
  {
    lock.lock()
    entries[host]?.recorded.append(request)
    let handler = entries[host]?.handlers["\(request.method) \(request.path)"]
    lock.unlock()
    return handler
  }
}

/// The `URLProtocol` that serves `FakeShepherdServer`.
private final class FakeURLProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool {
    // On current macOS the URL loading system DOES route a
    // URLSessionWebSocketTask upgrade through URLProtocol, and a stub cannot
    // emit 101 Switching Protocols — it would break the socket. Let upgrades
    // pass through untouched. (Harmless on OS versions that never ask.)
    if request.value(forHTTPHeaderField: "Upgrade")?.lowercased() == "websocket" { return false }
    guard let host = request.url?.host() else { return false }
    return FakeServerRegistry.shared.knows(host: host)
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let host = url.host() else {
      client?.urlProtocol(self, didFailWithError: FakeServerError.noRoute("<no host>"))
      return
    }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let recorded = RecordedRequest(
      method: request.httpMethod?.uppercased() ?? "GET",
      path: url.path(percentEncoded: false),
      query: components?.query,
      headers: request.allHTTPHeaderFields ?? [:],
      body: request.httpBody ?? request.httpBodyStream.map(Self.drain)
    )

    guard let handler = FakeServerRegistry.shared.take(recorded, host: host) else {
      client?.urlProtocol(
        self, didFailWithError: FakeServerError.noRoute("\(recorded.method) \(recorded.path)"))
      return
    }

    do {
      let fake = try handler(recorded)
      let response = HTTPURLResponse(
        url: url, statusCode: fake.statusCode, httpVersion: "HTTP/1.1",
        headerFields: fake.headers)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: fake.body)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}

  /// `URLSession` converts a `httpBody` into a stream before the protocol
  /// sees it, so read it back for the handler.
  private static func drain(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    let size = 4096
    var buffer = [UInt8](repeating: 0, count: size)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: size)
      if read <= 0 { break }
      data.append(contentsOf: buffer[0..<read])
    }
    return data
  }
}
```

- [ ] **Step 4: Run the harness tests**

Run: `swift test --package-path native --filter FakeShepherdServer`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add native/Tests/ShepherdKitTests/FakeShepherdServer.swift native/Tests/ShepherdKitTests/FakeShepherdServerTests.swift
git commit -m "test(native): urlprotocol-backed fake shepherd server

Per-instance host so parallel suites do not collide, request recording, and a
canInit guard that lets websocket upgrades pass through untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: ShepherdClient — construction and read operations

**Files:**
- Create: `native/Sources/ShepherdKit/Client/ShepherdClient.swift`
- Create: `native/Tests/ShepherdKitTests/ShepherdClientReadTests.swift`

**Interfaces:**
- Consumes: `ServerProfile`, `CredentialStore`, `StoredCredential`, `ShepherdError`, `AuthenticationMiddleware`, `RetryingMiddleware`, `FakeShepherdServer`, `Fixtures`.
- Produces: `public final class ShepherdClient: Sendable` with:
  - `public init(profile: ServerProfile, credentials: any CredentialStore, urlSession: URLSession = .shared) throws`
  - `public let profile: ServerProfile`
  - `public let needsLogin: AsyncStream<Void>`
  - `public func currentToken() -> String?`
  - `public func health() async throws -> Components.Schemas.Health`
  - `public func settings() async throws -> Components.Schemas.Settings`
  - `public func sessions() async throws -> [Components.Schemas.Session]`
  - `public func doneSessions() async throws -> [Components.Schemas.Session]`
  - `public func session(id: String) async throws -> Components.Schemas.Session`
  - `public func repos() async throws -> Components.Schemas.RepoList`
- Produces: `public func ShepherdClient.signalNeedsLogin()` is **internal**, not public — only the middleware calls it.

- [ ] **Step 1: Write the failing read tests**

Create `native/Tests/ShepherdKitTests/ShepherdClientReadTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("ShepherdClient reads")
struct ShepherdClientReadTests {
  /// Builds a client pointed at `server`, with `token` already stored.
  private func makeClient(
    _ server: FakeShepherdServer,
    credentials: InMemoryCredentialStore = InMemoryCredentialStore(),
    token: String? = "shp_test"
  ) throws -> (ShepherdClient, InMemoryCredentialStore) {
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    if let token { try credentials.save(StoredCredential(token: token, tokenId: "tok"), for: "k") }
    let client = try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
    return (client, credentials)
  }

  @Test("health decodes and sends no Authorization requirement")
  func health() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))
    let (client, _) = try makeClient(server)

    let health = try await client.health()
    #expect(health.ok == true)
    #expect(health.version == "1.47.0")
  }

  @Test("the stored token reaches the wire")
  func sendsBearer() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/sessions", status: 200, json: try Fixtures.json([Fixtures.session(id: "a")]))
    let (client, _) = try makeClient(server)

    _ = try await client.sessions()
    #expect(server.requests().last?.headers["Authorization"] == "Bearer shp_test")
  }

  @Test("sessions, done sessions and one session decode")
  func sessionReads() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/sessions", status: 200,
                json: try Fixtures.json([Fixtures.session(id: "a"), Fixtures.session(id: "b")]))
    server.stub("GET", "/api/sessions/done", status: 200,
                json: try Fixtures.json([Fixtures.session(id: "z")]))
    server.stub("GET", "/api/sessions/a", status: 200,
                json: try Fixtures.json(Fixtures.session(id: "a", name: "alpha")))
    let (client, _) = try makeClient(server)

    #expect(try await client.sessions().map(\.id) == ["a", "b"])
    #expect(try await client.doneSessions().map(\.id) == ["z"])
    #expect(try await client.session(id: "a").name == "alpha")
  }

  @Test("settings and repos decode")
  func settingsAndRepos() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/settings", status: 200,
                json: try Fixtures.json(Fixtures.settings(firstRunPending: true)))
    server.stub("GET", "/api/repos", status: 200, json: try Fixtures.json(Fixtures.repoList()))
    let (client, _) = try makeClient(server)

    #expect(try await client.settings().firstRunPending == true)
    #expect(try await client.repos().repos.first?.name == "demo")
  }

  @Test("a 401 becomes unauthenticated, clears the token and fires needsLogin")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/sessions", status: 401,
                json: try Fixtures.errorJSON("unauthorized"))
    let (client, credentials) = try makeClient(server)

    let signal = Task { for await _ in client.needsLogin { return true }; return false }

    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.sessions() }
    #expect(try credentials.load(for: "k") == nil)
    #expect(await signal.value == true)
  }

  @Test("a 404 on one session becomes notFound")
  func notFound() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/sessions/gone", status: 404, json: try Fixtures.errorJSON("no such session"))
    let (client, _) = try makeClient(server)

    await #expect(throws: ShepherdError.notFound) { _ = try await client.session(id: "gone") }
  }

  @Test("a body that does not match the contract becomes contractMismatch")
  func contractMismatch() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/settings", status: 200, json: Data(#"{"repoRoot":42}"#.utf8))
    let (client, _) = try makeClient(server)

    do {
      _ = try await client.settings()
      Issue.record("expected a contract mismatch")
    } catch let error as ShepherdError {
      guard case .contractMismatch(let route, _) = error else {
        Issue.record("expected contractMismatch, got \(error)")
        return
      }
      #expect(route == "getSettings")
    }
  }

  @Test("an undocumented status becomes contractMismatch")
  func undocumentedStatus() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/repos", status: 418, json: try Fixtures.errorJSON("teapot"))
    let (client, _) = try makeClient(server)

    await #expect(
      throws: ShepherdError.contractMismatch(route: "listRepos", underlying: "undocumented status 418")
    ) { _ = try await client.repos() }
  }

  @Test("an insecure remote profile is refused at construction")
  func insecureProfileRefused() throws {
    let profile = ServerProfile(
      name: "box", baseURL: URL(string: "http://box.example.com")!, mode: .remote)
    #expect(throws: ServerProfileError.insecureRemoteURL("box.example.com")) {
      _ = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore())
    }
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter "ShepherdClient reads"`
Expected: FAIL — `error: cannot find 'ShepherdClient' in scope`.

- [ ] **Step 3: Implement ShepherdClient's construction and read half**

Create `native/Sources/ShepherdKit/Client/ShepherdClient.swift`:

```swift
import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// The kit's HTTP surface. One instance per active `ServerProfile`.
///
/// Every method maps the generated `Output` enum onto a value or a
/// `ShepherdError`; callers never see generated response cases. The generated
/// client is `Sendable` and this type holds only `let`s, so it is too.
public final class ShepherdClient: Sendable {
  public let profile: ServerProfile

  /// Fires once each time a request comes back 401. The stored token has
  /// already been cleared by then; the app should present a login sheet.
  public let needsLogin: AsyncStream<Void>

  private let generated: Client
  private let credentials: any CredentialStore
  private let needsLoginContinuation: AsyncStream<Void>.Continuation

  /// - Throws: `ServerProfileError` when a `.remote` profile violates the
  ///   https-unless-loopback-or-tailnet policy.
  public init(
    profile: ServerProfile,
    credentials: any CredentialStore,
    urlSession: URLSession = .shared
  ) throws {
    let validated = try profile.validated()
    self.profile = validated
    self.credentials = credentials

    let (stream, continuation) = AsyncStream<Void>.makeStream()
    needsLogin = stream
    needsLoginContinuation = continuation

    let auth = AuthenticationMiddleware(
      store: credentials,
      credentialKey: validated.credentialKey,
      onUnauthorized: { continuation.yield(()) }
    )
    generated = Client(
      serverURL: validated.baseURL,
      transport: URLSessionTransport(configuration: .init(session: urlSession)),
      // Auth runs outermost so it sees the final response status; retry sits
      // inside it so a retried request is re-signed from the same credential.
      middlewares: [auth, RetryingMiddleware()]
    )
  }

  deinit { needsLoginContinuation.finish() }

  /// The token currently in the store, for callers that have to build their
  /// own request — `EventStream` needs it for the WebSocket upgrade.
  public func currentToken() -> String? {
    (try? credentials.load(for: profile.credentialKey))?.token
  }

  // MARK: - Reads

  public func health() async throws -> Components.Schemas.Health {
    do {
      switch try await generated.getHealth(.init()) {
      case .ok(let ok): return try ok.body.json
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getHealth")
      }
    } catch { throw ShepherdError.from(error, route: "getHealth") }
  }

  public func settings() async throws -> Components.Schemas.Settings {
    do {
      switch try await generated.getSettings(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getSettings")
      }
    } catch { throw ShepherdError.from(error, route: "getSettings") }
  }

  public func sessions() async throws -> [Components.Schemas.Session] {
    do {
      switch try await generated.listSessions(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listSessions")
      }
    } catch { throw ShepherdError.from(error, route: "listSessions") }
  }

  public func doneSessions() async throws -> [Components.Schemas.Session] {
    do {
      switch try await generated.listDoneSessions(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listDoneSessions")
      }
    } catch { throw ShepherdError.from(error, route: "listDoneSessions") }
  }

  public func session(id: String) async throws -> Components.Schemas.Session {
    do {
      switch try await generated.getSession(.init(path: .init(id: id))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getSession")
      }
    } catch { throw ShepherdError.from(error, route: "getSession") }
  }

  public func repos() async throws -> Components.Schemas.RepoList {
    do {
      switch try await generated.listRepos(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listRepos")
      }
    } catch { throw ShepherdError.from(error, route: "listRepos") }
  }
}
```

`ShepherdError.from` returns a `ShepherdError` unchanged, so the `catch` wrapping each `switch` re-throws the mapped error without double-wrapping.

- [ ] **Step 4: Run the read tests**

Run: `swift test --package-path native --filter "ShepherdClient reads"`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient.swift native/Tests/ShepherdKitTests/ShepherdClientReadTests.swift
git commit -m "feat(native): shepherd client reads with mapped errors

health, settings, sessions, done sessions, one session, repos. 401 clears the
token and publishes needsLogin; a bad body becomes contractMismatch(route:).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: ShepherdClient — write operations

**Files:**
- Modify: `native/Sources/ShepherdKit/Client/ShepherdClient.swift` (append a `// MARK: - Writes` section)
- Create: `native/Tests/ShepherdKitTests/ShepherdClientWriteTests.swift`

**Interfaces:**
- Consumes: everything Task 6 produced.
- Produces: `public enum CreateOutcome: Equatable, Sendable { case created(Session); case held(HeldTask) }`.
- Produces on `ShepherdClient`:
  - `public func createSession(_ request: CreateSessionRequest) async throws -> CreateOutcome`
  - `public func archiveSession(id: String) async throws`
  - `public func interruptSession(id: String) async throws`
  - `public func putRepoRoot(_ path: String) async throws -> Components.Schemas.RepoRootResponse`

- [ ] **Step 1: Write the failing write tests**

Create `native/Tests/ShepherdKitTests/ShepherdClientWriteTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("ShepherdClient writes")
struct ShepherdClientWriteTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_test", tokenId: "tok")])
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  private func createRequest() -> CreateSessionRequest {
    CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "do the thing")
  }

  @Test("201 yields the created session")
  func created() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions", status: 201,
                json: try Fixtures.json(Fixtures.session(id: "new")))
    let client = try makeClient(server)

    #expect(try await client.createSession(createRequest()) == .created(Fixtures.session(id: "new")))
  }

  @Test("200 yields a held task instead of a session")
  func heldTask() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let held = HeldTask(held: true, id: "held-1", count: 3)
    server.stub("POST", "/api/sessions", status: 200, json: try Fixtures.json(held))
    let client = try makeClient(server)

    #expect(try await client.createSession(createRequest()) == .held(held))
  }

  @Test("the request body is the contract's CreateSessionRequest")
  func sendsRequestBody() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions", status: 201,
                json: try Fixtures.json(Fixtures.session(id: "new")))
    let client = try makeClient(server)

    _ = try await client.createSession(createRequest())
    let body = try #require(server.requests().last?.body)
    let decoded = try JSONDecoder().decode(CreateSessionRequest.self, from: body)
    #expect(decoded.repoPath == "/repos/demo")
    #expect(decoded.baseBranch == "main")
    #expect(decoded.prompt == "do the thing")
  }

  @Test("409 first_run_pending becomes firstRunPending")
  func firstRunPending() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions", status: 409,
                json: try Fixtures.errorJSON("first_run_pending"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.firstRunPending) {
      _ = try await client.createSession(createRequest())
    }
  }

  @Test("any other 409 keeps the server's error and code")
  func otherConflict() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions", status: 409,
                json: try Fixtures.errorJSON("name taken", code: "name_taken"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.conflict(code: "name_taken", message: "name taken")) {
      _ = try await client.createSession(createRequest())
    }
  }

  @Test("400, 422 and 502 map to their own cases", arguments: [
    (400, "bad input"), (422, "no such ref"), (502, "git exploded"),
  ])
  func createFailures(_ pair: (Int, String)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions", status: pair.0, json: try Fixtures.errorJSON(pair.1))
    let client = try makeClient(server)

    let expected: ShepherdError = switch pair.0 {
    case 400: .badRequest(pair.1)
    case 422: .unprocessable(pair.1)
    default: .upstreamFailure(pair.1)
    }
    await #expect(throws: expected) { _ = try await client.createSession(createRequest()) }
  }

  @Test("archive and interrupt succeed quietly")
  func archiveAndInterrupt() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("DELETE", "/api/sessions/a", status: 200,
                json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    server.stub("POST", "/api/sessions/a/interrupt", status: 200,
                json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let client = try makeClient(server)

    try await client.archiveSession(id: "a")
    try await client.interruptSession(id: "a")
    #expect(server.requests().map(\.method) == ["DELETE", "POST"])
  }

  @Test("interrupting an unknown session is notFound")
  func interruptNotFound() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions/gone/interrupt", status: 404,
                json: try Fixtures.errorJSON("no such session"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.notFound) { try await client.interruptSession(id: "gone") }
  }

  @Test("putRepoRoot returns the stored root")
  func putRepoRoot() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("PUT", "/api/settings", status: 200,
                json: try Fixtures.json(Components.Schemas.RepoRootResponse(
                  repoRoot: "/repos", repoRootDisplay: "~/repos")))
    let client = try makeClient(server)

    #expect(try await client.putRepoRoot("/repos").repoRootDisplay == "~/repos")
  }

  @Test("a rejected repo root is badRequest")
  func putRepoRootRejected() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("PUT", "/api/settings", status: 400, json: try Fixtures.errorJSON("not a directory"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.badRequest("not a directory")) {
      _ = try await client.putRepoRoot("/nope")
    }
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter "ShepherdClient writes"`
Expected: FAIL — `error: value of type 'ShepherdClient' has no member 'createSession'`.

- [ ] **Step 3: Append the write half to ShepherdClient**

Append to `native/Sources/ShepherdKit/Client/ShepherdClient.swift`, immediately before the closing brace of `public final class ShepherdClient`:

```swift
  // MARK: - Writes

  /// `POST /api/sessions` either spawns the session or queues it behind the
  /// usage hold. Both are success; the caller decides what to show.
  public func createSession(
    _ request: CreateSessionRequest
  ) async throws -> CreateOutcome {
    do {
      switch try await generated.createSession(.init(body: .json(request))) {
      case .created(let created): return .created(try created.body.json)
      case .ok(let ok): return .held(try ok.body.json)
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .unprocessableContent(let bad):
        throw ShepherdError.unprocessable(try bad.body.json.error)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "createSession")
      }
    } catch { throw ShepherdError.from(error, route: "createSession") }
  }

  /// `DELETE /api/sessions/{id}`. The contract documents 200 and 401 only —
  /// archiving an unknown id is a no-op server-side.
  public func archiveSession(id: String) async throws {
    do {
      switch try await generated.archiveSession(.init(path: .init(id: id))) {
      case .ok: return
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "archiveSession")
      }
    } catch { throw ShepherdError.from(error, route: "archiveSession") }
  }

  public func interruptSession(id: String) async throws {
    do {
      switch try await generated.interruptSession(.init(path: .init(id: id))) {
      case .ok: return
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "interruptSession")
      }
    } catch { throw ShepherdError.from(error, route: "interruptSession") }
  }

  /// `PUT /api/settings` with the repoRoot form. This is also what resolves a
  /// pending first run.
  public func putRepoRoot(_ path: String) async throws -> Components.Schemas.RepoRootResponse {
    do {
      switch try await generated.putRepoRoot(.init(body: .json(.init(repoRoot: path)))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "putRepoRoot")
      }
    } catch { throw ShepherdError.from(error, route: "putRepoRoot") }
  }
```

And add, at file scope below the class:

```swift
/// What `POST /api/sessions` did. The contract documents both 201 (spawned)
/// and 200 (queued behind the usage hold) as success.
public enum CreateOutcome: Equatable, Sendable {
  case created(Session)
  case held(HeldTask)
}
```

- [ ] **Step 4: Run the write tests**

Run: `swift test --package-path native --filter "ShepherdClient writes"`
Expected: PASS — 12 tests (the status-mapping case runs three times), 0 failures.

- [ ] **Step 5: Run the whole suite and commit**

Run: `swift test --package-path native`
Expected: all suites pass.

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient.swift native/Tests/ShepherdKitTests/ShepherdClientWriteTests.swift
git commit -m "feat(native): shepherd client writes

create (spawned or held), archive, interrupt, repo root. 409 first_run_pending
maps to .firstRunPending; every other documented status has its own case.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: ProfileSetup — login, token mint, logout

**Files:**
- Create: `native/Sources/ShepherdKit/Client/ProfileSetup.swift`
- Create: `native/Tests/ShepherdKitTests/ProfileSetupTests.swift`

**Interfaces:**
- Consumes: `ServerProfile`, `CredentialStore`, `StoredCredential`, `ShepherdError`, `FakeShepherdServer`, `Fixtures`.
- Produces: `public enum ProfileSetup` with
  - `public static func tokenName(hostName: String = ProcessInfo.processInfo.hostName) -> String`
  - `public static func login(profile: ServerProfile, password: String, credentials: any CredentialStore, urlSessionFactory: @Sendable (URLSessionConfiguration) -> URLSession = { URLSession(configuration: $0) }) async throws -> StoredCredential`
  - `public static func logout(profile: ServerProfile, credentials: any CredentialStore, urlSession: URLSession = .shared) async throws`

- [ ] **Step 1: Write the failing setup tests**

Create `native/Tests/ShepherdKitTests/ProfileSetupTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("ProfileSetup")
struct ProfileSetupTests {
  private func profile(_ server: FakeShepherdServer) -> ServerProfile {
    ServerProfile(name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
  }

  /// `POST /api/login`'s 200 declares `Set-Cookie` as a **required** response
  /// header, so the generated type refuses to decode a response without it.
  /// Every login stub has to send one.
  private func stubLogin(_ server: FakeShepherdServer, status: Int = 200) throws {
    let body = status == 200
      ? try Fixtures.json(Components.Schemas.Ok(ok: true))
      : try Fixtures.errorJSON("bad password")
    server.on("POST", "/api/login") { _ in
      FakeResponse(
        statusCode: status,
        headers: [
          "Content-Type": "application/json",
          "Set-Cookie": "shepherd_session=fake-session; Path=/; HttpOnly",
        ],
        body: body)
    }
  }

  private func mintedJSON() throws -> Data {
    try Fixtures.json(
      Components.Schemas.AccessTokenMinted(
        token: "shp_minted",
        entry: Components.Schemas.AccessTokenSummary(
          id: "tok_1", name: "Shepherd for Mac (probe)", hint: "…nted",
          createdAt: 1, lastUsedAt: nil, expiresAt: nil, scope: .full)))
  }

  @Test("the token name carries the hostname and fits the contract's 64 chars")
  func tokenName() {
    #expect(ProfileSetup.tokenName(hostName: "probe") == "Shepherd for Mac (probe)")
    let long = ProfileSetup.tokenName(hostName: String(repeating: "x", count: 200))
    #expect(long.count <= 64)
    #expect(long.hasPrefix("Shepherd for Mac ("))
    #expect(long.hasSuffix(")"))
  }

  @Test("login posts the password, mints a full non-expiring token and stores it")
  func loginMintsAndStores() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())
    let credentials = InMemoryCredentialStore()

    let stored = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2", credentials: credentials,
      urlSessionFactory: { _ in server.urlSession() })

    #expect(stored == StoredCredential(token: "shp_minted", tokenId: "tok_1"))
    #expect(try credentials.load(for: "k") == stored)

    let login = try #require(server.requests().first { $0.path == "/api/login" })
    let sent = try JSONDecoder().decode(
      Components.Schemas.LoginRequest.self, from: try #require(login.body))
    #expect(sent.password == "hunter2")

    let mint = try #require(server.requests().first { $0.path == "/api/access-tokens" })
    let mintBody = try JSONDecoder().decode(
      Components.Schemas.AccessTokenMintRequest.self, from: try #require(mint.body))
    #expect(mintBody.scope == .full)
    #expect(mintBody.expiresInDays == nil)
    #expect(mintBody.name.hasPrefix("Shepherd for Mac ("))
  }

  @Test("the mint call is not sent with a bearer header — it rides the cookie")
  func mintUsesTheCookieNotABearer() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())

    _ = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2",
      credentials: InMemoryCredentialStore(),
      urlSessionFactory: { _ in server.urlSession() })

    let mint = try #require(server.requests().first { $0.path == "/api/access-tokens" })
    #expect(mint.headers["Authorization"] == nil)
  }

  @Test("a wrong password is unauthenticated and stores nothing")
  func wrongPassword() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server, status: 401)
    let credentials = InMemoryCredentialStore()

    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await ProfileSetup.login(
        profile: profile(server), password: "nope", credentials: credentials,
        urlSessionFactory: { _ in server.urlSession() })
    }
    #expect(try credentials.load(for: "k") == nil)
  }

  @Test("a 403 on the mint is forbidden and stores nothing")
  func mintForbidden() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 403,
                json: try Fixtures.errorJSON("not an operator session"))
    let credentials = InMemoryCredentialStore()

    await #expect(throws: ShepherdError.forbidden) {
      _ = try await ProfileSetup.login(
        profile: profile(server), password: "hunter2", credentials: credentials,
        urlSessionFactory: { _ in server.urlSession() })
    }
    #expect(try credentials.load(for: "k") == nil)
  }

  @Test("logout revokes the token then clears the Keychain entry")
  func logoutRevokesAndClears() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("DELETE", "/api/access-tokens/tok_1", status: 200,
                json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_minted", tokenId: "tok_1")])

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(server.requests().contains { $0.path == "/api/access-tokens/tok_1" })
    #expect(try credentials.load(for: "k") == nil)
  }

  @Test("logout clears locally even when the server is unreachable")
  func logoutClearsWhenUnreachable() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    // No stub for the revoke route, so the fake fails the request.
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_minted", tokenId: "tok_1")])

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(try credentials.load(for: "k") == nil)
  }

  @Test("logout with nothing stored is a no-op")
  func logoutWithoutCredential() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let credentials = InMemoryCredentialStore()

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(server.requests().isEmpty)
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter ProfileSetup`
Expected: FAIL — `error: cannot find 'ProfileSetup' in scope`.

- [ ] **Step 3: Implement ProfileSetup**

Create `native/Sources/ShepherdKit/Client/ProfileSetup.swift`:

```swift
import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// First contact with a server: exchange the operator password for a durable
/// access token, and give it back on logout.
///
/// The password is used exactly once and never persisted. The session cookie
/// lives in an ephemeral `URLSession` that is invalidated as soon as the
/// token has been minted, so nothing cookie-shaped survives this call.
public enum ProfileSetup {
  /// The contract caps `AccessTokenMintRequest.name` at 64 characters.
  private static let maxTokenNameLength = 64

  /// `Shepherd for Mac (<hostname>)`, truncated to fit the contract.
  public static func tokenName(hostName: String = ProcessInfo.processInfo.hostName) -> String {
    let prefix = "Shepherd for Mac ("
    let budget = maxTokenNameLength - prefix.count - 1  // the closing paren
    let host = hostName.count <= budget ? hostName : String(hostName.prefix(budget))
    return "\(prefix)\(host))"
  }

  /// Logs in with `password`, mints a full-scope token that never expires,
  /// stores it under `profile.credentialKey`, and discards the cookie.
  ///
  /// - Parameter urlSessionFactory: injected so tests can hand back a session
  ///   wired to `FakeShepherdServer`. Production passes the default, which
  ///   builds an ephemeral session with its own private cookie storage.
  /// - Returns: the credential that was stored.
  @discardableResult
  public static func login(
    profile: ServerProfile,
    password: String,
    credentials: any CredentialStore,
    urlSessionFactory: @Sendable (URLSessionConfiguration) -> URLSession = {
      URLSession(configuration: $0)
    }
  ) async throws -> StoredCredential {
    let validated = try profile.validated()

    // `.ephemeral` gives this exchange its own in-memory cookie jar: the
    // shepherd_session cookie never touches the shared storage.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = HTTPCookieStorage()
    configuration.httpShouldSetCookies = true
    let session = urlSessionFactory(configuration)
    defer {
      configuration.httpCookieStorage?.removeCookies(since: .distantPast)
      session.invalidateAndCancel()
    }

    // No AuthenticationMiddleware here on purpose: these two calls
    // authenticate with the cookie, and the contract refuses token
    // management from a bearer caller.
    let client = Client(
      serverURL: validated.baseURL,
      transport: URLSessionTransport(configuration: .init(session: session))
    )

    do {
      switch try await client.login(.init(body: .json(.init(password: password)))) {
      case .ok: break
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "login")
      }
    } catch { throw ShepherdError.from(error, route: "login") }

    let minted: Components.Schemas.AccessTokenMinted
    do {
      let request = Components.Schemas.AccessTokenMintRequest(
        name: tokenName(), expiresInDays: nil, scope: .full)
      switch try await client.mintAccessToken(.init(body: .json(request))) {
      case .created(let created): minted = try created.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .forbidden: throw ShepherdError.forbidden
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "mintAccessToken")
      }
    } catch { throw ShepherdError.from(error, route: "mintAccessToken") }

    let credential = StoredCredential(token: minted.token, tokenId: minted.entry.id)
    try credentials.save(credential, for: validated.credentialKey)
    ShepherdLog.client.notice(
      "minted an access token for \(validated.name, privacy: .public)")
    return credential
  }

  /// Revokes the stored token when the server is reachable, and always clears
  /// the local entry. A logout must never leave the app holding a token it
  /// believes is valid.
  public static func logout(
    profile: ServerProfile,
    credentials: any CredentialStore,
    urlSession: URLSession = .shared
  ) async throws {
    guard let credential = try credentials.load(for: profile.credentialKey) else { return }

    // Revocation needs an operator session, which a logged-out app does not
    // have — but the server also accepts the cookie-less call when the token
    // itself authenticates the request, so try it and tolerate any failure.
    let client = Client(
      serverURL: profile.baseURL,
      transport: URLSessionTransport(configuration: .init(session: urlSession)),
      middlewares: [
        AuthenticationMiddleware(
          store: credentials, credentialKey: profile.credentialKey, onUnauthorized: {})
      ]
    )
    do {
      _ = try await client.revokeAccessToken(.init(path: .init(id: credential.tokenId)))
    } catch {
      ShepherdLog.client.notice("token revocation failed; clearing locally anyway")
    }

    try credentials.delete(for: profile.credentialKey)
  }
}
```

The `AuthenticationMiddleware` in `logout` would clear the credential itself on a 401. That is the desired outcome anyway, and the explicit `delete` afterwards is idempotent.

- [ ] **Step 4: Run the setup tests**

Run: `swift test --package-path native --filter ProfileSetup`
Expected: PASS — 8 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Client/ProfileSetup.swift native/Tests/ShepherdKitTests/ProfileSetupTests.swift
git commit -m "feat(native): password login that mints and stores an access token

Ephemeral cookie jar, one full-scope non-expiring token named after the host,
Keychain storage, cookie discarded. Logout revokes then always clears.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: ServerEvent

**Files:**
- Create: `native/Sources/ShepherdKit/Realtime/ServerEvent.swift`
- Create: `native/Tests/ShepherdKitTests/ServerEventTests.swift`

**Interfaces:**
- Consumes: the generated `Components.Schemas.{EventEnvelope, EventName, Session, SessionStatusEvent, SessionRenamedEvent, SessionArchivedEvent, SessionBlockEvent, SessionReadyEvent, AutoMergeStatus, UsageLimits}` and the `OpenEnum` facade from Task 2.
- Produces: `public enum ServerEvent: Decodable, Equatable, Sendable` with cases `sessionNew(Session)`, `sessionStatus(Components.Schemas.SessionStatusEvent)`, `sessionRenamed(Components.Schemas.SessionRenamedEvent)`, `sessionArchived(Components.Schemas.SessionArchivedEvent)`, `sessionBlock(Components.Schemas.SessionBlockEvent)`, `sessionReady(Components.Schemas.SessionReadyEvent)`, `automergeStatus(Components.Schemas.AutoMergeStatus)`, `usageLimits(Components.Schemas.UsageLimits)`, `unknown(name: String)`.
- Produces: `public struct PresenceFrame: Encodable, Sendable { public let type: String; public let active: Bool; public init(active: Bool) }`.
- **Declares no payload models.** Every `data` shape is a named component schema in the contract; this file only decodes the envelope and dispatches on `EventName`.

- [ ] **Step 1: Write the failing event tests**

Create `native/Tests/ShepherdKitTests/ServerEventTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("ServerEvent")
struct ServerEventTests {
  private func decode(_ json: String) throws -> ServerEvent {
    try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8))
  }

  @Test("session:new carries the whole generated Session")
  func sessionNew() throws {
    let payload = String(decoding: try Fixtures.sessionJSON(id: "a", name: "alpha"), as: UTF8.self)
    let event = try decode(#"{"event":"session:new","data":\#(payload)}"#)
    guard case .sessionNew(let session) = event else {
      Issue.record("expected sessionNew, got \(event)")
      return
    }
    #expect(session.id == "a")
    #expect(session.name == "alpha")
  }

  @Test("session:status decodes into the generated SessionStatusEvent")
  func sessionStatus() throws {
    let event = try decode(#"{"event":"session:status","data":{"id":"a","status":"blocked"}}"#)
    guard case .sessionStatus(let payload) = event else {
      Issue.record("expected sessionStatus, got \(event)")
      return
    }
    #expect(payload.id == "a")
    #expect(payload.status.known == .blocked)
    #expect(payload.hasScratchpadFiles == nil)
  }

  @Test("a status value this client does not know still decodes")
  func sessionStatusUnknownValue() throws {
    let event = try decode(#"{"event":"session:status","data":{"id":"a","status":"quiescing"}}"#)
    guard case .sessionStatus(let payload) = event else {
      Issue.record("expected sessionStatus, got \(event)")
      return
    }
    #expect(payload.status.known == nil)
    #expect(payload.status.rawValue == "quiescing")
  }

  @Test("session:status carries the turn-end scratchpad flag when present")
  func sessionStatusScratchpad() throws {
    let event = try decode(
      #"{"event":"session:status","data":{"id":"a","status":"idle","hasScratchpadFiles":true}}"#)
    guard case .sessionStatus(let payload) = event else {
      Issue.record("expected sessionStatus, got \(event)")
      return
    }
    #expect(payload.hasScratchpadFiles == true)
  }

  @Test("session:renamed keeps a null branch as nil")
  func sessionRenamed() throws {
    let event = try decode(
      #"{"event":"session:renamed","data":{"id":"a","name":"new","branch":null}}"#)
    guard case .sessionRenamed(let payload) = event else {
      Issue.record("expected sessionRenamed, got \(event)")
      return
    }
    #expect(payload.id == "a")
    #expect(payload.name == "new")
    #expect(payload.branch == nil)
  }

  @Test("session:archived decodes")
  func sessionArchived() throws {
    let event = try decode(#"{"event":"session:archived","data":{"id":"a"}}"#)
    guard case .sessionArchived(let payload) = event else {
      Issue.record("expected sessionArchived, got \(event)")
      return
    }
    #expect(payload.id == "a")
  }

  @Test("session:ready decodes")
  func sessionReady() throws {
    let event = try decode(#"{"event":"session:ready","data":{"id":"a","ready":true}}"#)
    guard case .sessionReady(let payload) = event else {
      Issue.record("expected sessionReady, got \(event)")
      return
    }
    #expect(payload.ready == true)
  }

  @Test("session:block carries a BlockReason, and null clears it")
  func sessionBlock() throws {
    let set = try decode(
      #"""
      {"event":"session:block","data":{"id":"a","block":{"shape":"yes-no",
      "options":[{"label":"Yes","send":"y"}],"tail":["continue?"]}}}
      """#)
    guard case .sessionBlock(let payload) = set else {
      Issue.record("expected sessionBlock, got \(set)")
      return
    }
    #expect(payload.block?.shape.rawValue == "yes-no")
    #expect(payload.block?.options.first?.send == "y")

    let cleared = try decode(#"{"event":"session:block","data":{"id":"a","block":null}}"#)
    guard case .sessionBlock(let clearedPayload) = cleared else {
      Issue.record("expected sessionBlock, got \(cleared)")
      return
    }
    #expect(clearedPayload.block == nil)
  }

  @Test("automerge:status decodes")
  func automerge() throws {
    let event = try decode(
      #"""
      {"event":"automerge:status","data":{"repoPath":"/repos/demo","enabled":true,
      "state":"waiting","detail":null,"sessionId":"a"}}
      """#)
    guard case .automergeStatus(let status) = event else {
      Issue.record("expected automergeStatus, got \(event)")
      return
    }
    #expect(status.repoPath == "/repos/demo")
    #expect(status.enabled == true)
  }

  @Test("usage:limits decodes")
  func usageLimits() throws {
    let event = try decode(
      #"""
      {"event":"usage:limits","data":{"session5h":null,"week":null,"perModelWeek":[],
      "credits":null,"stale":false,"calibratedAt":null,"subscriptionOnly":true}}
      """#)
    guard case .usageLimits(let limits) = event else {
      Issue.record("expected usageLimits, got \(event)")
      return
    }
    #expect(limits.subscriptionOnly == true)
  }

  @Test("an event the contract does not list becomes .unknown, not an error")
  func unknownEvent() throws {
    let event = try decode(#"{"event":"epic:progress","data":{"anything":1}}"#)
    #expect(event == .unknown(name: "epic:progress"))
  }

  @Test("a known event name with an undecodable payload becomes .unknown, not a throw")
  func knownNameBadPayload() throws {
    // A frame the client cannot make sense of must not kill the stream.
    let event = try decode(#"{"event":"session:ready","data":{"id":"a"}}"#)
    #expect(event == .unknown(name: "session:ready"))
  }

  @Test("a frame with no event key fails to decode")
  func malformedFrame() {
    #expect(throws: (any Error).self) { try decode(#"{"data":{}}"#) }
  }

  @Test("the presence frame encodes the shape the server expects")
  func presenceFrame() throws {
    let data = try JSONEncoder().encode(PresenceFrame(active: true))
    let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(decoded?["type"] as? String == "presence")
    #expect(decoded?["active"] as? Bool == true)
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter ServerEvent`
Expected: FAIL — `error: cannot find 'ServerEvent' in scope`.

- [ ] **Step 3: Implement ServerEvent**

Create `native/Sources/ShepherdKit/Realtime/ServerEvent.swift`:

```swift
import Foundation

/// One decoded `/events` frame.
///
/// The contract describes every frame as an `EventEnvelope` — `{event, data}`
/// — and names a component schema for each `data` shape, so this file holds no
/// payload models of its own: it reads the envelope's `event`, then decodes
/// `data` into the generated type that `x-shepherd-events` names for it.
///
/// `EventName` is an open enum, so a name this client has never heard of
/// arrives as a plain string rather than failing to decode.
public enum ServerEvent: Decodable, Equatable, Sendable {
  case sessionNew(Session)
  case sessionStatus(Components.Schemas.SessionStatusEvent)
  case sessionRenamed(Components.Schemas.SessionRenamedEvent)
  case sessionArchived(Components.Schemas.SessionArchivedEvent)
  case sessionBlock(Components.Schemas.SessionBlockEvent)
  case sessionReady(Components.Schemas.SessionReadyEvent)
  case automergeStatus(Components.Schemas.AutoMergeStatus)
  case usageLimits(Components.Schemas.UsageLimits)
  /// An event this client does not handle — either a name the contract does
  /// not list, or a listed name whose payload would not decode. Ignored by
  /// the store, never an error: the server emits many events the native
  /// client does not use yet, and one bad frame must not kill the stream.
  case unknown(name: String)

  private enum CodingKeys: String, CodingKey {
    case event, data
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    // Decoding the name is the only hard requirement: a frame without one is
    // not an EventEnvelope at all.
    let name = try container.decode(Components.Schemas.EventName.self, forKey: .event)

    func payload<T: Decodable>(_ type: T.Type) -> T? {
      try? container.decode(type, forKey: .data)
    }

    switch name.known {
    case .sessionNew:
      self = payload(Session.self).map(ServerEvent.sessionNew) ?? .unknown(name: name.rawValue)
    case .sessionStatus:
      self = payload(Components.Schemas.SessionStatusEvent.self).map(ServerEvent.sessionStatus)
        ?? .unknown(name: name.rawValue)
    case .sessionRenamed:
      self = payload(Components.Schemas.SessionRenamedEvent.self).map(ServerEvent.sessionRenamed)
        ?? .unknown(name: name.rawValue)
    case .sessionArchived:
      self = payload(Components.Schemas.SessionArchivedEvent.self).map(ServerEvent.sessionArchived)
        ?? .unknown(name: name.rawValue)
    case .sessionBlock:
      self = payload(Components.Schemas.SessionBlockEvent.self).map(ServerEvent.sessionBlock)
        ?? .unknown(name: name.rawValue)
    case .sessionReady:
      self = payload(Components.Schemas.SessionReadyEvent.self).map(ServerEvent.sessionReady)
        ?? .unknown(name: name.rawValue)
    case .automergeStatus:
      self = payload(Components.Schemas.AutoMergeStatus.self).map(ServerEvent.automergeStatus)
        ?? .unknown(name: name.rawValue)
    case .usageLimits:
      self = payload(Components.Schemas.UsageLimits.self).map(ServerEvent.usageLimits)
        ?? .unknown(name: name.rawValue)
    case nil:
      self = .unknown(name: name.rawValue)
    }
  }
}

/// The one frame the client sends. The contract documents it in prose under
/// `x-shepherd-events` rather than as a schema, so it is written out here.
/// The server never replies to it; it uses it to suppress push notifications
/// while the app is focused.
public struct PresenceFrame: Encodable, Sendable {
  public let type: String = "presence"
  public let active: Bool

  public init(active: Bool) { self.active = active }
}
```

The `EventName.Known` case labels come from `namingStrategy: idiomatic` applied to the contract's `session:new`, `session:status`, … values. Task 2 Step 12 printed the generated enum; if the cases are spelled differently (for example `sessionColonNew`), match the generated spelling here. The `case nil:` branch covers every unknown name and must stay.

- [ ] **Step 4: Run the event tests**

Run: `swift test --package-path native --filter ServerEvent`
Expected: PASS — 13 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Realtime/ServerEvent.swift native/Tests/ShepherdKitTests/ServerEventTests.swift
git commit -m "feat(native): typed server events for the /events socket

Decodes the generated EventEnvelope and dispatches on the open EventName enum
into the generated *Event schemas. No hand-written payload models. An unknown
name or an undecodable payload degrades to .unknown instead of throwing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: EventStream and the fake /events server

**Files:**
- Create: `native/Sources/ShepherdKit/Realtime/EventStream.swift`
- Create: `native/Tests/ShepherdKitTests/FakeEventServer.swift`
- Create: `native/Tests/ShepherdKitTests/EventStreamTests.swift`

**Interfaces:**
- Consumes: `ServerEvent`, `PresenceFrame`, `ShepherdLog`, `ShepherdClient.currentToken()`.
- Produces: `public actor EventStream` with
  - `public init(baseURL: URL, tokenProvider: @escaping @Sendable () -> String?, urlSession: URLSession = .shared, reconnectDelay: Duration = .seconds(1))`
  - `public nonisolated func events() -> AsyncStream<ServerEvent>`
  - `public func start()`
  - `public func stop()`
  - `public func setActive(_ active: Bool)`
  - `public func reconnectNow()`
- Produces (test target): `final class FakeEventServer: Sendable` with `init() throws`, `var url: URL`, `func send(_ json: String)`, `func closeCurrentConnection()`, `func receivedTexts() -> [String]`, `func upgradeHeaders() -> [String: String]`, `func connectionCount() -> Int`, `func stop()`.

- [ ] **Step 1: Write the fake /events server**

Create `native/Tests/ShepherdKitTests/FakeEventServer.swift`:

```swift
import Foundation
import Network

/// An in-process WebSocket server for `/events`.
///
/// `URLProtocol` cannot fake a WebSocket — it has no way to emit a 101
/// Switching Protocols — so this is a real `NWListener` on an ephemeral
/// loopback port speaking `NWProtocolWebSocket`.
final class FakeEventServer: Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "run.shepherd.kit.tests.events")
  private let state = State()

  let url: URL

  init() throws {
    let parameters = NWParameters.tcp
    let options = NWProtocolWebSocket.Options(.version13)
    options.autoReplyPing = true
    let state = self.state
    // The upgrade request's non-mechanical headers (including Authorization)
    // are handed to this callback — that is how the bearer assertion works.
    options.setClientRequestHandler(queue) { _, headers in
      state.recordUpgrade(headers)
      return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
    }
    parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)

    listener = try NWListener(using: parameters, on: .any)

    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
    listener.newConnectionHandler = { [state, queue] connection in
      state.adopt(connection)
      connection.start(queue: queue)
      FakeEventServer.receiveLoop(connection, state: state)
    }
    listener.start(queue: queue)
    guard ready.wait(timeout: .now() + 5) == .success, let port = listener.port else {
      listener.cancel()
      throw FakeEventServerError.didNotBind
    }
    url = URL(string: "ws://127.0.0.1:\(port.rawValue)/events")!
  }

  /// Sends one text frame on the newest connection.
  func send(_ json: String) {
    guard let connection = state.current() else { return }
    let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
    let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
    connection.send(
      content: Data(json.utf8), contentContext: context, isComplete: true,
      completion: .contentProcessed { _ in })
  }

  /// Closes the newest connection normally, so the client's reconnect policy
  /// is what brings it back.
  func closeCurrentConnection() {
    guard let connection = state.current() else { return }
    let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
    metadata.closeCode = .protocolCode(.normalClosure)
    let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
    connection.send(
      content: nil, contentContext: context, isComplete: true,
      completion: .contentProcessed { _ in connection.cancel() })
  }

  func receivedTexts() -> [String] { state.texts() }
  func upgradeHeaders() -> [String: String] { state.headers() }
  func connectionCount() -> Int { state.connections() }

  func stop() {
    state.cancelAll()
    listener.cancel()
  }

  private static func receiveLoop(_ connection: NWConnection, state: State) {
    connection.receiveMessage { content, _, _, error in
      if error != nil { return }
      if let content, let text = String(data: content, encoding: .utf8) {
        state.recordText(text)
      }
      receiveLoop(connection, state: state)
    }
  }

  /// Every `NWListener`/`NWConnection` handler is `@Sendable` and runs on the
  /// listener's queue, so all shared state goes through this lock box.
  private final class State: @unchecked Sendable {
    private let lock = NSLock()
    private var connectionsList: [NWConnection] = []
    private var receivedTexts: [String] = []
    private var lastHeaders: [String: String] = [:]
    private var upgrades = 0

    func adopt(_ connection: NWConnection) {
      lock.lock()
      defer { lock.unlock() }
      connectionsList.append(connection)
    }

    func current() -> NWConnection? {
      lock.lock()
      defer { lock.unlock() }
      return connectionsList.last
    }

    func recordText(_ text: String) {
      lock.lock()
      defer { lock.unlock() }
      receivedTexts.append(text)
    }

    func recordUpgrade(_ headers: [(name: String, value: String)]) {
      lock.lock()
      defer { lock.unlock() }
      upgrades += 1
      lastHeaders = Dictionary(headers.map { ($0.name, $0.value) }, uniquingKeysWith: { _, b in b })
    }

    func texts() -> [String] {
      lock.lock()
      defer { lock.unlock() }
      return receivedTexts
    }

    func headers() -> [String: String] {
      lock.lock()
      defer { lock.unlock() }
      return lastHeaders
    }

    func connections() -> Int {
      lock.lock()
      defer { lock.unlock() }
      return upgrades
    }

    func cancelAll() {
      lock.lock()
      let all = connectionsList
      connectionsList = []
      lock.unlock()
      for connection in all { connection.cancel() }
    }
  }
}

enum FakeEventServerError: Error, Equatable {
  case didNotBind
}
```

- [ ] **Step 2: Write the failing EventStream tests**

Create `native/Tests/ShepherdKitTests/EventStreamTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@Suite("EventStream")
struct EventStreamTests {
  /// Polls `condition` until it holds or the deadline passes. Network.framework
  /// handlers run on their own queue, so tests observe them by polling rather
  /// than by awaiting a continuation the server never resumes.
  private func eventually(
    timeout: Duration = .seconds(5),
    _ condition: @Sendable () -> Bool
  ) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(25))
    }
    return condition()
  }

  @Test("the bearer token rides the upgrade request")
  func sendsBearerOnUpgrade() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { "shp_events" })
    await stream.start()
    defer { Task { await stream.stop() } }

    #expect(try await eventually { server.connectionCount() == 1 })
    #expect(server.upgradeHeaders()["Authorization"] == "Bearer shp_events")
  }

  @Test("frames arrive as decoded ServerEvents")
  func yieldsDecodedEvents() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { "shp_events" })
    let events = stream.events()
    await stream.start()
    defer { Task { await stream.stop() } }

    #expect(try await eventually { server.connectionCount() == 1 })
    server.send(#"{"event":"session:ready","data":{"id":"a","ready":true}}"#)

    var iterator = events.makeAsyncIterator()
    let first = await iterator.next()
    #expect(first == .sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
  }

  @Test("an unknown event name still reaches the consumer as .unknown")
  func yieldsUnknownEvents() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    let events = stream.events()
    await stream.start()
    defer { Task { await stream.stop() } }

    #expect(try await eventually { server.connectionCount() == 1 })
    server.send(#"{"event":"epic:progress","data":{}}"#)

    var iterator = events.makeAsyncIterator()
    #expect(await iterator.next() == .unknown(name: "epic:progress"))
  }

  @Test("a malformed frame is dropped and the stream keeps going")
  func dropsMalformedFrames() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    let events = stream.events()
    await stream.start()
    defer { Task { await stream.stop() } }

    #expect(try await eventually { server.connectionCount() == 1 })
    server.send("not json at all")
    server.send(#"{"event":"session:archived","data":{"id":"a"}}"#)

    var iterator = events.makeAsyncIterator()
    #expect(
      await iterator.next() == .sessionArchived(Components.Schemas.SessionArchivedEvent(id: "a")))
  }

  @Test("presence is reported on connect and on every change")
  func reportsPresence() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    await stream.start()
    defer { Task { await stream.stop() } }

    #expect(try await eventually { server.receivedTexts().count == 1 })
    #expect(server.receivedTexts().first?.contains("\"presence\"") == true)
    #expect(server.receivedTexts().first?.contains("\"active\":true") == true)

    await stream.setActive(false)
    #expect(try await eventually { server.receivedTexts().count == 2 })
    #expect(server.receivedTexts().last?.contains("\"active\":false") == true)
  }

  @Test("a server close reconnects after the delay")
  func reconnectsAfterClose() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(
      baseURL: server.url, tokenProvider: { nil }, reconnectDelay: .milliseconds(50))
    await stream.start()
    defer { Task { await stream.stop() } }

    #expect(try await eventually { server.connectionCount() == 1 })
    server.closeCurrentConnection()
    #expect(try await eventually { server.connectionCount() == 2 })
  }

  @Test("stop() does not reconnect")
  func stopIsFinal() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(
      baseURL: server.url, tokenProvider: { nil }, reconnectDelay: .milliseconds(50))
    await stream.start()

    #expect(try await eventually { server.connectionCount() == 1 })
    await stream.stop()
    server.closeCurrentConnection()

    try await Task.sleep(for: .milliseconds(400))
    #expect(server.connectionCount() == 1)
  }
}
```

- [ ] **Step 3: Run it and watch it fail**

Run: `swift test --package-path native --filter EventStream`
Expected: FAIL — `error: cannot find 'EventStream' in scope`.

- [ ] **Step 4: Implement EventStream**

Create `native/Sources/ShepherdKit/Realtime/EventStream.swift`:

```swift
import Foundation

/// The `/events` WebSocket.
///
/// Opens `baseURL` with `Authorization: Bearer` on the upgrade, yields
/// decoded frames on `events`, reports presence so the server can suppress
/// push while the app is focused, and reconnects after `reconnectDelay` on
/// any close that `stop()` did not cause.
public actor EventStream {
  private let baseURL: URL
  private let tokenProvider: @Sendable () -> String?
  private let urlSession: URLSession
  private let reconnectDelay: Duration
  private let continuation: AsyncStream<ServerEvent>.Continuation

  private var task: URLSessionWebSocketTask?
  private var pump: Task<Void, Never>?
  private var stopped = true
  private var active = true

  /// Decoded frames, oldest first. Single-consumer: the `SessionStore` owns
  /// it. Calling this twice hands back the same stream, so the second caller
  /// would steal elements from the first — don't.
  public nonisolated func events() -> AsyncStream<ServerEvent> { eventStream }

  private nonisolated let eventStream: AsyncStream<ServerEvent>

  /// - Parameters:
  ///   - baseURL: the full `ws(s)://…/events` URL.
  ///   - tokenProvider: read on every (re)connect, so a token minted after
  ///     construction is picked up without rebuilding the stream.
  ///   - reconnectDelay: the design spec fixes this at 1 s; tests shorten it.
  public init(
    baseURL: URL,
    tokenProvider: @escaping @Sendable () -> String?,
    urlSession: URLSession = .shared,
    reconnectDelay: Duration = .seconds(1)
  ) {
    self.baseURL = baseURL
    self.tokenProvider = tokenProvider
    self.urlSession = urlSession
    self.reconnectDelay = reconnectDelay
    let (stream, continuation) = AsyncStream<ServerEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(256))
    eventStream = stream
    self.continuation = continuation
  }

  /// Convenience for the common case: derive the `/events` URL and the token
  /// from a live client.
  public init(client: ShepherdClient, urlSession: URLSession = .shared) {
    self.init(
      baseURL: Self.eventsURL(for: client.profile.baseURL),
      tokenProvider: { client.currentToken() },
      urlSession: urlSession
    )
  }

  /// `http(s)://host/` → `ws(s)://host/events`.
  public static func eventsURL(for baseURL: URL) -> URL {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = "/events"
    return components.url!
  }

  public func start() {
    guard stopped else { return }
    stopped = false
    connect()
  }

  public func stop() {
    stopped = true
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  /// Report whether the app is in the foreground. The server uses this to
  /// suppress push banners while the operator is already looking.
  public func setActive(_ active: Bool) {
    guard self.active != active else { return }
    self.active = active
    sendPresence()
  }

  /// Drop the current socket and open a new one immediately — the app calls
  /// this on `applicationDidBecomeActive` rather than waiting out the delay.
  public func reconnectNow() {
    guard !stopped else { return }
    pump?.cancel()
    task?.cancel(with: .goingAway, reason: nil)
    connect()
  }

  private func connect() {
    var request = URLRequest(url: baseURL)
    if let token = tokenProvider() {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let socket = urlSession.webSocketTask(with: request)
    task = socket
    socket.resume()
    sendPresence()

    pump = Task { [weak self] in
      await self?.receiveLoop(socket)
    }
  }

  private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await socket.receive()
        switch message {
        case .string(let text): yield(Data(text.utf8))
        case .data(let data): yield(data)
        @unknown default: break
        }
      } catch {
        // Any receive failure means the socket is gone: a clean close, a
        // dropped network, or our own cancel(). `stopped` tells them apart.
        break
      }
    }
    await scheduleReconnect(after: socket)
  }

  private func scheduleReconnect(after socket: URLSessionWebSocketTask) async {
    guard !stopped, task === socket else { return }
    ShepherdLog.realtime.debug("events socket closed; reconnecting")
    do {
      try await Task.sleep(for: reconnectDelay)
    } catch {
      return  // cancelled while waiting
    }
    guard !stopped else { return }
    connect()
  }

  private func yield(_ data: Data) {
    do {
      continuation.yield(try JSONDecoder().decode(ServerEvent.self, from: data))
    } catch {
      // A frame the client cannot parse is dropped, exactly like the web
      // store's `catch { /* ignore malformed frames */ }`.
      ShepherdLog.realtime.debug("dropped an unparseable /events frame")
    }
  }

  private func sendPresence() {
    guard let socket = task, let json = try? JSONEncoder().encode(PresenceFrame(active: active))
    else { return }
    socket.send(.string(String(decoding: json, as: UTF8.self))) { _ in }
  }

  deinit { continuation.finish() }
}
```

- [ ] **Step 5: Run the EventStream tests**

Run: `swift test --package-path native --filter EventStream`
Expected: PASS — 7 tests, 0 failures. These tests bind a loopback listener; if macOS prompts for an incoming-connection firewall exception, allow it once.

- [ ] **Step 6: Run the whole suite and commit**

Run: `swift test --package-path native`
Expected: all suites pass.

```bash
git add native/Sources/ShepherdKit/Realtime/EventStream.swift native/Tests/ShepherdKitTests/FakeEventServer.swift native/Tests/ShepherdKitTests/EventStreamTests.swift
git commit -m "feat(native): /events websocket with presence and reconnect

Bearer on the upgrade, AsyncStream of decoded events, malformed frames
dropped, 1s reconnect on any close we did not ask for. Tests drive a real
NWListener because URLProtocol cannot emit a 101.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: SessionStore

**Files:**
- Create: `native/Sources/ShepherdKit/Model/SessionStore.swift`
- Create: `native/Tests/ShepherdKitTests/SessionStoreTests.swift`

**Interfaces:**
- Consumes: `ShepherdClient` (all reads and writes), `CreateOutcome`, `ServerEvent` and the generated `*Event` payloads, `EventStream`, `ShepherdError`, `ShepherdLog`, the `OpenEnum` facade and the public typealiases.
- Produces: `@Observable @MainActor public final class SessionStore` with
  - `public init(client: ShepherdClient)`
  - `public private(set) var sessions: [Session]`
  - `public private(set) var blocks: [String: Components.Schemas.BlockReason]`
  - `public private(set) var settings: Settings?`
  - `public private(set) var repos: [Repo]`
  - `public private(set) var autoMerge: [String: Components.Schemas.AutoMergeStatus]`
  - `public private(set) var usageLimits: Components.Schemas.UsageLimits?`
  - `public private(set) var lastError: ShepherdError?`
  - `public var firstRunPending: Bool { get }`
  - `public func session(id: String) -> Session?`
  - `public func bootstrap() async throws`
  - `public func refresh() async throws`
  - `public func apply(_ event: ServerEvent)`
  - `public func consume(_ events: AsyncStream<ServerEvent>) async`
  - `public func create(_ input: CreateSessionRequest) async throws -> CreateOutcome`
  - `public func archive(id: String) async throws`
  - `public func interrupt(id: String) async throws`
  - `public func resolveFirstRun(path: String) async throws`

**Event semantics to mirror** (from `ui/src/lib/store.svelte.ts::apply`, lines ~442-520):

| Event | Web store does | This store does |
| --- | --- | --- |
| `session:new` | `addSession` — append, ignoring a duplicate id | same |
| `session:status` | `applyStatus` — patch `status`, and `hasScratchpadFiles` **only when the push carries it** | same |
| `session:renamed` | `applyRenamed` — patch `name` + `branch` (the toast is UI, not kit) | patch `name` + `branch` |
| `session:ready` | patch `readyToMerge` | same |
| `session:archived` | drop the row from `sessions` **and** drop its `blocks` entry | same |
| `session:block` | `setBlock` — `nil` drops the entry, otherwise set | same |
| `automerge:status` | keyed by `repoPath` | same |
| `usage:limits` | replace wholesale | same |

One deliberate narrowing: the web store spreads the whole `session:status` payload (`{...d}`), so when the server sends the entire row on a status change it picks up every field. `SessionStatusEvent` is a typed schema with `id`, `status` and `hasScratchpadFiles`; any extra fields land in its `additionalProperties` and are **not** applied. The next `refresh()` or `session:new` reconciles them. Widening this would mean re-introducing a hand-written payload model, which the contract rule forbids.

- [ ] **Step 1: Write the failing store tests**

Create `native/Tests/ShepherdKitTests/SessionStoreTests.swift`:

```swift
import Foundation
import Testing
@testable import ShepherdKit

@MainActor
@Suite("SessionStore")
struct SessionStoreTests {
  private func makeStore(_ server: FakeShepherdServer) throws -> SessionStore {
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_test", tokenId: "tok")])
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return SessionStore(
      client: try ShepherdClient(
        profile: profile, credentials: credentials, urlSession: server.urlSession()))
  }

  private func stubBootstrap(
    _ server: FakeShepherdServer,
    sessions: [Session] = [],
    firstRunPending: Bool = false
  ) throws {
    server.stub("GET", "/api/sessions", status: 200, json: try Fixtures.json(sessions))
    server.stub("GET", "/api/settings", status: 200,
                json: try Fixtures.json(Fixtures.settings(firstRunPending: firstRunPending)))
    server.stub("GET", "/api/repos", status: 200, json: try Fixtures.json(Fixtures.repoList()))
  }

  private func statusEvent(
    id: String, status: SessionStatus, hasScratchpadFiles: Bool? = nil
  ) -> ServerEvent {
    .sessionStatus(Components.Schemas.SessionStatusEvent(
      id: id, status: status, hasScratchpadFiles: hasScratchpadFiles))
  }

  // MARK: bootstrap

  @Test("bootstrap loads sessions, settings and repos")
  func bootstrapLoadsEverything() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a"), Fixtures.session(id: "b")])
    let store = try makeStore(server)

    try await store.bootstrap()

    #expect(store.sessions.map(\.id) == ["a", "b"])
    #expect(store.settings?.repoRoot == "/repos")
    #expect(store.repos.map(\.name) == ["demo"])
    #expect(store.firstRunPending == false)
  }

  @Test("firstRunPending reflects settings")
  func firstRunPendingFlag() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, firstRunPending: true)
    let store = try makeStore(server)

    try await store.bootstrap()
    #expect(store.firstRunPending == true)
  }

  // MARK: apply

  @Test("session:new appends, and a duplicate id is ignored")
  func applySessionNew() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.sessionNew(Fixtures.session(id: "a")))
    store.apply(.sessionNew(Fixtures.session(id: "a", name: "duplicate")))

    #expect(store.sessions.map(\.id) == ["a"])
    #expect(store.sessions[0].name == "session")
  }

  @Test("session:status patches status without clobbering the scratchpad flag")
  func applyStatusKeepsScratchpadFlag() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(statusEvent(
      id: "a", status: SessionStatus(known: .idle), hasScratchpadFiles: true))
    #expect(store.session(id: "a")?.status.known == .idle)
    #expect(store.session(id: "a")?.hasScratchpadFiles == true)

    // A status-only push must not reset the live flag to falsy.
    store.apply(statusEvent(id: "a", status: SessionStatus(known: .running)))
    #expect(store.session(id: "a")?.status.known == .running)
    #expect(store.session(id: "a")?.hasScratchpadFiles == true)
  }

  @Test("a status value this client does not know is still stored")
  func applyUnknownStatusValue() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(statusEvent(id: "a", status: SessionStatus(unknown: "quiescing")))
    #expect(store.session(id: "a")?.status.known == nil)
    #expect(store.session(id: "a")?.status.rawValue == "quiescing")
  }

  @Test("a status for an unknown id is ignored")
  func applyStatusUnknownId() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(statusEvent(id: "ghost", status: SessionStatus(known: .done)))
    #expect(store.sessions.isEmpty)
  }

  @Test("session:renamed patches name and branch")
  func applyRenamed() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a", branch: "old")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.sessionRenamed(Components.Schemas.SessionRenamedEvent(
      id: "a", name: "fresh", branch: "feat/x")))
    #expect(store.session(id: "a")?.name == "fresh")
    #expect(store.session(id: "a")?.branch == "feat/x")
  }

  @Test("session:ready patches readyToMerge")
  func applyReady() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
    #expect(store.session(id: "a")?.readyToMerge == true)
  }

  @Test("session:block sets then clears the block")
  func applyBlock() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    let reason = Components.Schemas.BlockReason(
      shape: Components.Schemas.BlockReason.ShapePayload(known: .stall),
      options: [], tail: ["waiting"])
    store.apply(.sessionBlock(Components.Schemas.SessionBlockEvent(id: "a", block: reason)))
    #expect(store.blocks["a"]?.shape.rawValue == "stall")

    store.apply(.sessionBlock(Components.Schemas.SessionBlockEvent(id: "a", block: nil)))
    #expect(store.blocks["a"] == nil)
  }

  @Test("session:archived removes the row and its block")
  func applyArchived() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a"), Fixtures.session(id: "b")])
    let store = try makeStore(server)
    try await store.bootstrap()
    store.apply(.sessionBlock(Components.Schemas.SessionBlockEvent(
      id: "a",
      block: Components.Schemas.BlockReason(
        shape: Components.Schemas.BlockReason.ShapePayload(known: .stall),
        options: [], tail: []))))

    store.apply(.sessionArchived(Components.Schemas.SessionArchivedEvent(id: "a")))

    #expect(store.sessions.map(\.id) == ["b"])
    #expect(store.blocks["a"] == nil)
  }

  @Test("automerge:status is keyed by repoPath and usage:limits replaces wholesale")
  func applyGlobals() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.automergeStatus(Components.Schemas.AutoMergeStatus(
      repoPath: "/repos/demo", enabled: true, state: "waiting", detail: nil, sessionId: "a")))
    #expect(store.autoMerge["/repos/demo"]?.enabled == true)

    store.apply(.usageLimits(Components.Schemas.UsageLimits(
      session5h: nil, week: nil, perModelWeek: [], credits: nil,
      stale: true, calibratedAt: nil, subscriptionOnly: false)))
    #expect(store.usageLimits?.stale == true)
  }

  @Test("an unknown event changes nothing")
  func applyUnknown() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.unknown(name: "epic:progress"))
    #expect(store.sessions.map(\.id) == ["a"])
  }

  // MARK: commands

  @Test("create adds the session immediately")
  func createAddsSession() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub("POST", "/api/sessions", status: 201,
                json: try Fixtures.json(Fixtures.session(id: "new")))
    let store = try makeStore(server)
    try await store.bootstrap()

    let outcome = try await store.create(
      CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))

    #expect(outcome == .created(Fixtures.session(id: "new")))
    #expect(store.sessions.map(\.id) == ["new"])
  }

  @Test("a held create adds nothing")
  func createHeldAddsNothing() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub("POST", "/api/sessions", status: 200,
                json: try Fixtures.json(HeldTask(held: true, id: "h", count: 1)))
    let store = try makeStore(server)
    try await store.bootstrap()

    _ = try await store.create(
      CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))
    #expect(store.sessions.isEmpty)
  }

  @Test("archive drops the row without waiting for the event")
  func archiveDropsRow() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    server.stub("DELETE", "/api/sessions/a", status: 200,
                json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let store = try makeStore(server)
    try await store.bootstrap()

    try await store.archive(id: "a")
    #expect(store.sessions.isEmpty)
  }

  @Test("interrupt leaves the row alone")
  func interruptKeepsRow() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    server.stub("POST", "/api/sessions/a/interrupt", status: 200,
                json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let store = try makeStore(server)
    try await store.bootstrap()

    try await store.interrupt(id: "a")
    #expect(store.sessions.map(\.id) == ["a"])
  }

  @Test("resolveFirstRun stores the root and reloads")
  func resolveFirstRun() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, firstRunPending: true)
    server.stub("PUT", "/api/settings", status: 200,
                json: try Fixtures.json(Components.Schemas.RepoRootResponse(
                  repoRoot: "/repos", repoRootDisplay: "~/repos")))
    let store = try makeStore(server)
    try await store.bootstrap()
    #expect(store.firstRunPending == true)

    // After the root is set the server stops reporting first run.
    server.stub("GET", "/api/settings", status: 200,
                json: try Fixtures.json(Fixtures.settings(firstRunPending: false)))
    try await store.resolveFirstRun(path: "/repos")

    #expect(store.firstRunPending == false)
    #expect(server.requests().contains { $0.method == "PUT" && $0.path == "/api/settings" })
  }

  @Test("a failed command records lastError and rethrows")
  func failedCommandRecordsError() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub("POST", "/api/sessions", status: 409,
                json: try Fixtures.errorJSON("first_run_pending"))
    let store = try makeStore(server)
    try await store.bootstrap()

    await #expect(throws: ShepherdError.firstRunPending) {
      _ = try await store.create(
        CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))
    }
    #expect(store.lastError == .firstRunPending)
  }

  @Test("consume() applies a whole stream of events")
  func consumeStream() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    let (stream, continuation) = AsyncStream<ServerEvent>.makeStream()
    continuation.yield(.sessionNew(Fixtures.session(id: "a")))
    continuation.yield(.sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
    continuation.finish()

    await store.consume(stream)

    #expect(store.sessions.map(\.id) == ["a"])
    #expect(store.session(id: "a")?.readyToMerge == true)
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path native --filter SessionStore`
Expected: FAIL — `error: cannot find 'SessionStore' in scope`.

- [ ] **Step 3: Implement SessionStore**

Create `native/Sources/ShepherdKit/Model/SessionStore.swift`:

```swift
import Foundation
import Observation

/// The live view of one server, for a SwiftUI app to render.
///
/// Event application mirrors `ui/src/lib/store.svelte.ts::apply` for the eight
/// events in the contract, so the native client and the web UI cannot disagree
/// about what a push means. `@MainActor` because every property here drives UI.
@Observable
@MainActor
public final class SessionStore {
  public private(set) var sessions: [Session] = []
  /// Blocked sessions, keyed by session id. Absent means not blocked.
  public private(set) var blocks: [String: Components.Schemas.BlockReason] = [:]
  public private(set) var settings: Settings?
  public private(set) var repos: [Repo] = []
  /// Auto-merge state keyed by `repoPath`, like the web store's `autoMerge`.
  public private(set) var autoMerge: [String: Components.Schemas.AutoMergeStatus] = [:]
  public private(set) var usageLimits: Components.Schemas.UsageLimits?
  /// The last command failure, for a banner. Cleared by the next success.
  public private(set) var lastError: ShepherdError?

  private let client: ShepherdClient

  public init(client: ShepherdClient) {
    self.client = client
  }

  /// True while the server still needs a workspace root.
  public var firstRunPending: Bool { settings?.firstRunPending ?? false }

  public func session(id: String) -> Session? {
    sessions.first { $0.id == id }
  }

  // MARK: - Loading

  /// Initial load: sessions, settings, repos. The design spec fixes these
  /// three as the bootstrap set.
  public func bootstrap() async throws {
    try await refresh()
  }

  public func refresh() async throws {
    do {
      async let sessions = client.sessions()
      async let settings = client.settings()
      async let repos = client.repos()
      let (loadedSessions, loadedSettings, loadedRepos) = try await (sessions, settings, repos)
      self.sessions = loadedSessions
      self.settings = loadedSettings
      self.repos = loadedRepos.repos
      lastError = nil
    } catch {
      let mapped = ShepherdError.from(error, route: "bootstrap")
      lastError = mapped
      throw mapped
    }
  }

  // MARK: - Events

  /// Drains `events` until it finishes. The app runs this in a long-lived
  /// task alongside `EventStream.start()`.
  public func consume(_ events: AsyncStream<ServerEvent>) async {
    for await event in events { apply(event) }
  }

  public func apply(_ event: ServerEvent) {
    switch event {
    case .sessionNew(let session):
      addSession(session)
    case .sessionStatus(let payload):
      // Patch `status`, and `hasScratchpadFiles` ONLY when this push carried
      // it: a status-only push (e.g. → running) must not clobber the live
      // flag back to falsy.
      patch(id: payload.id) {
        $0.status = payload.status
        if let flag = payload.hasScratchpadFiles { $0.hasScratchpadFiles = flag }
      }
    case .sessionRenamed(let payload):
      patch(id: payload.id) {
        $0.name = payload.name
        $0.branch = payload.branch
      }
    case .sessionReady(let payload):
      patch(id: payload.id) { $0.readyToMerge = payload.ready }
    case .sessionArchived(let payload):
      sessions.removeAll { $0.id == payload.id }
      blocks[payload.id] = nil
    case .sessionBlock(let payload):
      blocks[payload.id] = payload.block
    case .automergeStatus(let status):
      autoMerge[status.repoPath] = status
    case .usageLimits(let limits):
      usageLimits = limits
    case .unknown(let name):
      ShepherdLog.store.debug("ignoring event \(name, privacy: .public)")
    }
  }

  /// Append on `session:new`, ignoring a duplicate id — a push can race the
  /// bootstrap, and the create call also inserts optimistically.
  private func addSession(_ session: Session) {
    guard !sessions.contains(where: { $0.id == session.id }) else { return }
    sessions.append(session)
  }

  /// Mutate one session in place. An unknown id is a no-op, matching the web
  /// store's `if (s) Object.assign(...)`.
  private func patch(id: String, _ mutate: (inout Session) -> Void) {
    guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
    mutate(&sessions[index])
  }

  // MARK: - Commands

  @discardableResult
  public func create(_ input: CreateSessionRequest) async throws -> CreateOutcome {
    do {
      let outcome = try await client.createSession(input)
      // Insert optimistically so the list moves before session:new lands.
      if case .created(let session) = outcome { addSession(session) }
      lastError = nil
      return outcome
    } catch {
      let mapped = ShepherdError.from(error, route: "createSession")
      lastError = mapped
      throw mapped
    }
  }

  public func archive(id: String) async throws {
    do {
      try await client.archiveSession(id: id)
      sessions.removeAll { $0.id == id }
      blocks[id] = nil
      lastError = nil
    } catch {
      let mapped = ShepherdError.from(error, route: "archiveSession")
      lastError = mapped
      throw mapped
    }
  }

  public func interrupt(id: String) async throws {
    do {
      try await client.interruptSession(id: id)
      lastError = nil
    } catch {
      let mapped = ShepherdError.from(error, route: "interruptSession")
      lastError = mapped
      throw mapped
    }
  }

  /// Picks the workspace root, which is also what clears a pending first run.
  public func resolveFirstRun(path: String) async throws {
    do {
      _ = try await client.putRepoRoot(path)
      lastError = nil
    } catch {
      let mapped = ShepherdError.from(error, route: "putRepoRoot")
      lastError = mapped
      throw mapped
    }
    try await refresh()
  }
}
```

- [ ] **Step 4: Run the store tests**

Run: `swift test --package-path native --filter SessionStore`
Expected: PASS — 18 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Model/SessionStore.swift native/Tests/ShepherdKitTests/SessionStoreTests.swift
git commit -m "feat(native): observable session store

Bootstrap from sessions+settings+repos, then apply the eight contract events
with the same semantics as ui/src/lib/store.svelte.ts. Commands insert and
drop optimistically so the list moves before the push lands.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: CI, README and the PR

**Files:**
- Create: `.github/workflows/native.yml`
- Create: `native/README.md`
- Modify: `CLAUDE.md` (the package list at the top)

**Interfaces:**
- Consumes: everything. No new Swift API.
- Produces: a `native` CI job that fails on a stale contract copy, a build error, or a test failure.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/native.yml`:

```yaml
name: native

# ShepherdKit is generated from contracts/openapi.swift.yaml, so this job is the
# gate that a contract change still produces code that compiles and passes.
# Paths-filtered so a PR that touches neither the contract nor native/ does
# not pay for a macOS runner.
on:
  pull_request:
    branches: [main, "epic/**"]
    paths:
      - "native/**"
      - "contracts/**"
      - "scripts/gen-contract-swift.ts"
      - ".github/workflows/native.yml"
  push:
    branches: [main]
    paths:
      - "native/**"
      - "contracts/**"
      - "scripts/gen-contract-swift.ts"
      - ".github/workflows/native.yml"

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  shepherdkit:
    name: ShepherdKit
    runs-on: macos-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Report the toolchain
        run: |
          swift --version
          xcodebuild -version

      # The three Apple OpenAPI packages all ship swift-tools-version:6.1, so
      # an older default Xcode on the runner would fail with a confusing
      # manifest error instead of a clear one.
      - name: Require Swift 6.1 or newer
        run: |
          set -euo pipefail
          version="$(swift -version 2>&1 | sed -n 's/.*Swift version \([0-9][0-9.]*\).*/\1/p' | head -1)"
          echo "detected swift $version"
          major="${version%%.*}"
          rest="${version#*.}"
          minor="${rest%%.*}"
          if [ "$major" -lt 6 ] || { [ "$major" -eq 6 ] && [ "$minor" -lt 1 ]; }; then
            echo "::error::Swift $version is too old; ShepherdKit needs 6.1+."
            echo "Installed Xcodes:"; ls /Applications | grep -i '^Xcode' || true
            echo "Pin a newer one with: sudo xcode-select -s /Applications/<Xcode>.app"
            exit 1
          fi

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: latest

      - name: Install root deps
        run: bun install --frozen-lockfile

      # Gate 1: the derived Swift contract still matches the truth file.
      # (Regenerates contracts/openapi.swift.yaml and runs git diff --exit-code.)
      - name: Derived contract is current
        run: bun run check:contract-swift

      # Gate 2: the copy inside the ShepherdKit target still matches the
      # derived contract. The generated Swift itself is never committed — the
      # build plugin regenerates it every build, so it cannot go stale; these
      # two copies are the only artefacts that CAN drift.
      - name: Contract copy is in sync
        run: ./native/scripts/sync-contract.sh --check

      # Gate 3: the contract still generates code that compiles and passes.
      - name: Build
        run: swift build --package-path native

      - name: Test
        run: swift test --package-path native
```

- [ ] **Step 2: Prove the freshness gate actually fails**

```bash
printf '\n# drift\n' >> native/Sources/ShepherdKit/openapi.yaml
./native/scripts/sync-contract.sh --check || echo "gate fired as expected"
./native/scripts/sync-contract.sh
./native/scripts/sync-contract.sh --check
```

Expected: the first `--check` prints a diff plus `sync-contract: native/Sources/ShepherdKit/openapi.yaml is stale.` followed by `gate fired as expected`; the final `--check` prints `sync-contract: up to date`.

- [ ] **Step 3: Write the package README**

Create `native/README.md`:

```markdown
# ShepherdKit

The Swift client for Shepherd's HTTP/WS API. Platform-neutral (macOS 15+,
iOS 18+), no UI dependency: it exposes an `@Observable` store and
`AsyncStream`s, and the apps are thin SwiftUI layers on top.

Sub-project 2a of `docs/superpowers/specs/2026-09-18-native-macos-app-design.md`.
`PTYConnection` and the terminal are 2b.

## Layout

| Path | What |
| --- | --- |
| `Sources/ShepherdKit/openapi.yaml` | A **copy** of `contracts/openapi.swift.yaml`. Never edit it here. |
| `Sources/ShepherdKit/openapi-generator-config.yaml` | Generator settings. |
| `Sources/ShepherdKit/Client/` | `ShepherdClient`, the two middlewares, `ProfileSetup`. |
| `Sources/ShepherdKit/Realtime/` | `ServerEvent`, `EventStream`. |
| `Sources/ShepherdKit/Model/` | `ServerProfile`, `ShepherdError`, `SessionStore`, `OpenEnum`, the public typealiases. |
| `Sources/ShepherdKit/Credentials/` | `CredentialStore` and its two implementations. |

## Two contracts, one truth

`contracts/openapi.yaml` is the truth file: the ajv drift test in
`test/contract/` validates the real server against it, and it uses `const`,
`null` inside enum lists and `oneOf`-with-`null` — none of which
`swift-openapi-generator` can represent.

`bun run gen:contract-swift` derives `contracts/openapi.swift.yaml` from it:
nullable `$ref`s become optional plain `$ref`s, `null` leaves enum lists,
`const` is dropped, and read-side enums marked `x-shepherd-open-enum` become
`anyOf: [{enum}, {string}]` so an unfamiliar value still decodes.
`bun run check:contract-swift` is the freshness gate.

ShepherdKit generates from the **derived** file. `Model/OpenEnum.swift` hides
the `anyOf` wrapper: use `status.known` for the case you understand and
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

## Building and testing

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
```

- [ ] **Step 4: Add the package to the repo's CLAUDE.md**

In `CLAUDE.md`, replace the opening paragraph:

```markdown
Five packages, each with its own deps and lockfile: root (herdr/server, `bun`), `ui/` (SvelteKit),
`extension/`, `docs-site/` (Astro Starlight, docs.shepherd.run) and `site/` (Astro, the marketing
site).
```

with:

```markdown
Five Bun/Node packages, each with its own deps and lockfile: root (herdr/server, `bun`), `ui/`
(SvelteKit), `extension/`, `docs-site/` (Astro Starlight, docs.shepherd.run) and `site/` (Astro,
the marketing site). Plus `native/`, a Swift package (`ShepherdKit`) generated from
`contracts/openapi.swift.yaml` (derived from `contracts/openapi.yaml` by
`bun run gen:contract-swift`) — build and test it with `swift build --package-path native` and
`swift test --package-path native`, never with `bun`. See `native/README.md`.
```

- [ ] **Step 5: Run everything one last time**

```bash
bun run check:contract-swift
./native/scripts/sync-contract.sh --check
swift build --package-path native
swift test --package-path native
bun run test:contract
bun run lint
```

Expected: `check:contract-swift` exits 0 with no diff; `sync-contract: up to date`; a clean build; every Swift suite passing; the Bun contract test passing; lint clean.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/native.yml native/README.md CLAUDE.md
git commit -m "ci(native): macos job for build, test and contract freshness

Generated code is regenerated on every build so it cannot be stale; the gate
is the synced contract copy plus a green build and suite.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Rebase and push**

```bash
git fetch origin main
git rebase origin/main
swift test --package-path native
git push -u origin feat/native-shepherdkit
```

- [ ] **Step 8: Open the PR**

```bash
gh pr create --title "feat(native): ShepherdKit core — client, auth, events, session store" --body "$(cat <<'EOF'
Sub-project 2a of docs/superpowers/specs/2026-09-18-native-macos-app-design.md.

A Swift package under `native/` that a SwiftUI app can use to connect to a
server, log in, mint a token, list sessions live, and resolve first run.

- `native/`: SPM package, macOS 15 / iOS 18, Swift 6 language mode. The OpenAPI
  build plugin regenerates the client on every build from a synced copy of
  `contracts/openapi.swift.yaml`; generated code is not committed, the copy is.
  No change to either contract in this PR.
- Open enums (`SessionStatus`, `HerdrState`, `EventName`, …) arrive as the
  generator's `anyOf` wrapper; `OpenEnum` exposes `.known` and `.rawValue` so
  nothing downstream sees the wrapper, and an unfamiliar server value decodes
  instead of throwing.
- `ShepherdClient`: every contract operation, Bearer auth, 3× retry on bodyless
  GETs, 401 → `.unauthenticated` (token cleared, `needsLogin` published),
  409 `first_run_pending` → `.firstRunPending`, decode failure →
  `.contractMismatch(route:underlying:)`.
- `ProfileSetup`: password login over an ephemeral cookie jar, mints one
  full-scope non-expiring token named after the host, stores it in the Keychain,
  discards the cookie. Logout revokes then always clears.
- `EventStream`: `/events` over `URLSessionWebSocketTask`, `events()` as an
  `AsyncStream<ServerEvent>`, presence frames, 1 s reconnect. `ServerEvent`
  decodes the generated `EventEnvelope` and dispatches on `EventName` into the
  generated `*Event` schemas — no hand-written payload models.
- `SessionStore`: `@Observable @MainActor`, bootstrap + the eight contract events
  applied exactly as `ui/src/lib/store.svelte.ts` applies them.
- Tests: `URLProtocol` fake server for HTTP, a real `NWListener` WebSocket server
  for `/events`.
- `.github/workflows/native.yml` on `macos-latest`: `check:contract-swift`,
  `sync-contract.sh --check`, `swift build`, `swift test`.

Not in this PR (sub-project 2b): `PTYConnection`, SwiftTerm, any UI.

Verified with `bun run check:contract-swift`, `swift build --package-path native`,
`swift test --package-path native`, `bun run test:contract` and `bun run lint`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

| Spec requirement (sub-project 2 + cross-cutting) | Task |
| --- | --- |
| `native/Package.swift` with `ShepherdKit`, macOS 15+/iOS 18+ | 2 |
| `Sources/ShepherdKit/Generated/` from the contract | 2 (build-plugin output in `.build`; decision recorded above) |
| `ShepherdClient` wraps the generated client, adds Bearer from `CredentialStore` | 4, 6 |
| 401 → `.unauthenticated`, clears the token, publishes `needsLogin` | 4 (middleware), 6 (`needsLogin` stream) |
| 409 `first_run_pending` → `.firstRunPending` | 7 |
| decode failure → `.contractMismatch(route, underlying)` | 4 (`ShepherdError.from`), 6 (test) |
| retries idempotent GETs 3× with backoff | 4 |
| `ProfileSetup.login(profile, password)`, ephemeral cookie jar, token name, scope full, no expiry, Keychain, cookie discarded | 8 |
| Logout revokes via `DELETE /api/access-tokens/{id}` when reachable, always clears | 8 |
| `EventStream`: `/events` with Bearer, `AsyncStream<ServerEvent>`, 1 s reconnect, presence frame | 10 |
| Reconnect "immediately on `applicationDidBecomeActive`" | 10 (`reconnectNow()`; the app wires the notification in sub-project 4) |
| `SessionStore` `@Observable`, keyed sessions, applies events like the web store, `create`/`archive`/`interrupt`/`refresh` | 11 |
| Initial load `GET /api/sessions`, `/api/settings`, `/api/repos` | 11 |
| `resolveFirstRun(path)` | 11 |
| `CredentialStore` protocol + Keychain + in-memory | 3 |
| `ServerProfile { id, name, baseURL, mode, credentialKey }` | 3 |
| Remote profiles require https unless loopback or `.ts.net` | 3 (policy), 6 (enforced at client construction) |
| Tokens only in the Keychain, no password persistence | 3, 8 |
| `os.Logger` subsystem `run.shepherd.kit` | 2 |
| `FakeShepherdServer` (`URLProtocol` + a local WebSocket listener) replaying fixtures | 5, 10 |
| Coverage: auth flow, 401 handling, store event application, reconnect policy | 8, 6, 11, 10 |
| `native.yml` on `macos-latest`: build, test, generated-code drift | 12 |
| No UI dependency in ShepherdKit | Global Constraints; no task imports SwiftUI/AppKit/UIKit |
| **Coordinator's contract decisions:** Swift generated from `contracts/openapi.swift.yaml`, never the truth file | Global Constraints, Decision 3, Task 1, Task 2 (sync script) |
| Open enums get a `.known` / `rawValue` facade | 2 (`OpenEnum.swift`), asserted in 2, 9 and 11 |
| `ServerEvent` decodes `EventEnvelope`, switches on `EventName`, uses the generated `*Event` types | 9 |
| `native.yml` runs `check:contract-swift` as well as the copy check | 12 |
| `Health.minClient` | 2 (`Fixtures.health(version:minClient:)`, asserted in the generated-types suite) |
| Login/logout 200 declare a **required** `Set-Cookie` header | 8 (`stubLogin` sends one; without it the generated type refuses to decode) |
| Names the app-shell plan assumed: `SessionStore.create(_:) -> CreateOutcome`, `ProfileSetup.logout(profile:credentials:)`, `EventStream.events()`, the ten typealiases | 11, 8, 10, 2 |

Deliberately out of scope and stated as such: `PTYConnection` and its close-code semantics, SwiftTerm, `scripts/gen-strings.sh`, the `Apps/` targets, `ShepherdLocalServer`. The spec's "fixtures exported by the drift test, so kit tests and the server contract share one fixture set" is implemented as Task 2's `Fixtures.swift`, which builds its JSON by encoding the **generated** types rather than importing a JSON file the Bun test writes — the fixtures cannot disagree with the contract, and the two suites need no build-order coupling. That is a deviation from the literal wording; it is listed as an open question below.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries complete code; every command step states the expected output. Four places tell the implementer to read a generated file and match it rather than guess (Task 2 Step 7's `OpenEnum` conformance list, Task 2 Step 10's `Session` initialiser, Task 2 Step 12's open-enum property names, Task 9 Step 3's `EventName` case labels); each names the exact file and symbol, because argument labels and case spellings in generated code are the one thing this plan cannot verify without running the generator over the derived contract — which Task 2 Step 12 makes the implementer do before any of those tasks depend on it. Task 1 Step 2 has a hard stop rather than a fallback if sub-project 1 has not merged.

**3. Type consistency.** Checked across tasks:
- Public typealiases `Session`, `Settings`, `Repo`, `RepoList`, `HeldTask`, `SessionStatus`, `CreateSessionRequest`, `AgentProvider`, `Effort`, `Health` — defined Task 2, used unqualified in Tasks 2, 5, 6, 7, 8, 9, 11. Types with no alias (`BlockReason`, `AutoMergeStatus`, `UsageLimits`, `Ok`, `RepoRootResponse`, `_Error`, the five `*Event`s, `EventName`, `HerdrState`) are always written `Components.Schemas.…`.
- `OpenEnum` members `known`, `rawValue`, `init(known:)`, `init(unknown:)` — defined Task 2, used in Tasks 2, 9, 11.
- `StoredCredential(token:tokenId:)` — Task 3; used Tasks 4, 6, 7, 8, 11.
- `CredentialStore.load(for:)/save(_:for:)/delete(for:)` — one spelling everywhere.
- `ShepherdError` cases `.unauthenticated`, `.forbidden`, `.firstRunPending`, `.notFound`, `.badRequest`, `.conflict(code:message:)`, `.unprocessable`, `.upstreamFailure`, `.contractMismatch(route:underlying:)`, `.insecureProfile`, `.transport` — Task 4; Tasks 6, 7, 8, 11 use only these. `ShepherdError.fromConflict` defined Task 4, used Task 7.
- `ShepherdClient.currentToken()` — Task 6; used by `EventStream.init(client:)` in Task 10.
- `CreateOutcome` with `.created(Session)` / `.held(HeldTask)` — defined Task 7, used in Tasks 7 and 11. The older name `CreateSessionOutcome` appears nowhere.
- `SessionStore.create(_ input: CreateSessionRequest)` — unlabelled first parameter, matching the app-shell plan's call site.
- `ProfileSetup.logout(profile:credentials:urlSession:)` with `urlSession` defaulted, so `logout(profile:credentials:)` compiles — Task 8.
- `EventStream.events()` as a method — Task 10 interfaces, implementation and tests all use `stream.events()`.
- `ServerProfileError.insecureRemoteURL(String)` / `.missingHost` — Task 3, asserted in Tasks 3 and 6.
- `FakeShepherdServer.stub(_:_:status:json:)` / `.on(_:_:_:)` / `.requests()` / `.urlSession()` / `.tearDown()` and `FakeResponse(statusCode:headers:body:)` — Task 5, used identically in Tasks 6, 7, 8, 11.
- `Fixtures.session(id:name:desig:status:readyToMerge:branch:)`, `.settings(firstRunPending:repoRoot:)`, `.repoList()`, `.health(version:minClient:)`, `.json(_:)`, `.errorJSON(_:code:)`, `.sessionJSON(id:name:)` — Task 2, used in Tasks 2, 5, 6, 7, 8, 9, 11.
- `Box<Value>` — declared once, in Task 4's test file; Task 5's fake uses `FakeServerRegistry` and Task 10's uses its own private `State`, so there is no redeclaration.
- `ShepherdLog.subsystem/client/realtime/store/credentials` — Task 2, used in Tasks 3, 4, 6, 8, 10, 11.
- `PresenceFrame(active:)` — Task 9, used in Task 10.

**4. Open questions for the orchestrator:**
- The spec says `native.yml` "regenerates Swift from the contract and fails if the generated output differs from what is committed". This plan does not commit generated Swift, so that literal diff has nothing to compare; the gate is `check:contract-swift` + `sync-contract.sh --check` + a green build and suite. Confirm that substitution, or ask for the command plugin and a committed `GeneratedSources/`.
- The spec says the kit's fake server replays "recorded fixtures exported by the drift test". This plan builds fixtures by encoding the generated types instead. Confirm, or add an export step to sub-project 1's Bun test and a fixture-loading step here.
- `SessionStatusEvent` is now a typed schema with `id`, `status` and `hasScratchpadFiles`, so the web store's "the push may carry the whole row, spread all of it" behaviour narrows to those three fields (Task 11 documents this). If the full-row merge matters for the MVP, the contract should say so — either by making `session:status`'s payload a `oneOf` over `Session`, or by dropping the full-row emission server-side.
- Task 1 hard-stops if `contracts/openapi.swift.yaml`, `scripts/gen-contract-swift.ts` or the two package scripts are missing. Confirm sub-project 1 merges to `main` before this plan starts, or tell the executor which branch to cut from instead.
