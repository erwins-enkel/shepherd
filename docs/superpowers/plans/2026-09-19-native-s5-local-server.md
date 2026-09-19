# Stream S5 — Local server supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Shepherd for Mac detect, install, start, supervise and stop the operator's own Shepherd server (the installer checkout in `~/.shepherd/app`) as a child process, and sign in to it from the Welcome screen's "Run on this Mac" card.

**Architecture:** All process, file and health logic is a platform-guarded corner of ShepherdKit (`Sources/ShepherdKit/LocalServer/**`), with no UI and no `AppModel` knowledge: a `LocalServerSupervisor` actor spawns `bun run src/index.ts` with `cwd = ~/.shepherd/app`, streams stdout/stderr into a redacting ring buffer, polls `/api/health`, restarts on crash with backoff. The app layer (`Apps/ShepherdMac/Sources/LocalServer/**`) owns one `@Observable @MainActor LocalServerModel`, installs its UI through the S0-prep `WelcomeSlots.localPanel` slot and its per-store state through `AppExtension`. This stream edits **no** shared file: not `AppModel.swift`, `WelcomeView.swift`, `MainWindow.swift`, `ShepherdApp.swift`, `Package.swift`, `project.yml`, nor `contracts/openapi.yaml` — S5 adds no routes (route inventory, section S5).

**Tech Stack:** Swift 6 language mode, strict concurrency `complete`, Foundation `Process` / `FileHandle.bytes`, `Synchronization.Mutex`, Swift Testing, SwiftUI, `os.Logger`, Bun for the string-catalog generator.

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`). No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)` outside the test `URLProtocol` stub.
- **ShepherdKit has no UI dependency.** Nothing under `Sources/ShepherdKit/` imports SwiftUI or AppKit.
- **iOS-compilable kit.** `native/Package.swift` declares `.iOS(.v18)`, where `Process`, `kill(2)` and `/bin/bash` do not exist. **Every file this stream adds under `Sources/ShepherdKit/LocalServer/` and `Tests/ShepherdKitTests/` is wrapped in `#if os(macOS) … #endif`** (decision D1).
- **Strings** go through `L.t()` with keys present in **both** `ui/messages/en.json` and `ui/messages/de.json`, and in `KEYS_LOCALSERVER` in `native/scripts/gen-strings.ts`. Never add a string only in Swift.
- **No secrets in logs.** The generated operator password is captured from the child's stdout, then **redacted from the visible ring buffer and from every later line**. Never sent to `os.Logger`, never persisted, never committed.
- **Commits:** conventional, lowercase subjects; body lines ≤ 100 chars; every body ends with `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Branch:** `feat/native-local-server`, cut from `origin/main` **after S0-prep merges**. Rebase to update; never `git merge main`.
- **Never run bare `bun test`.**
- **The four gates:** `swift test --package-path native --filter LocalServer` · `./native/scripts/test-app.sh -only-testing:ShepherdTests` · `./native/scripts/build-app.sh` · `bun run check:strings`.

### File ownership (hard rule)

Creates/edits **only**: `native/Sources/ShepherdKit/LocalServer/**`, `native/Tests/ShepherdKitTests/{LocalServer*,LocalHealthCheck,InstallerRun}Tests.swift`, `native/Apps/ShepherdMac/Sources/LocalServer/**`, `native/Apps/ShepherdMac/Tests/LocalServer*.swift`, the `KEYS_LOCALSERVER` array in `native/scripts/gen-strings.ts`, additive keys in `ui/messages/{en,de}.json`, and the generated `Resources/Localizable.xcstrings`. If a step seems to need any other file — **stop** and report a handoff.

### Seams from S0-prep this plan codes against

Authoritative (Appendix B of `2026-09-19-native-parallel-streams.md`). Verify before Task 1 with
`test -f native/Apps/ShepherdMac/Sources/App/WelcomeSlots.swift && test -f native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift`.

```swift
@MainActor enum WelcomeSlots { static var localPanel: ((AppModel) -> AnyView)? }
@MainActor protocol AppExtension: AnyObject { init(store: SessionStore, app: AppModel); func teardown() }
extension AppModel { func register<E: AppExtension>(_ type: E.Type); func extension<E: AppExtension>(_ type: E.Type) -> E? }
```

Existing app API this plan **consumes and never modifies** (verified in the Gate-2 worktree):

```swift
@Observable @MainActor final class AppModel {
    init(profileStore: ProfileStore)
    @discardableResult func addLocalProfile() -> ServerProfile   // idempotent, http://127.0.0.1:7330, .local
    @discardableResult func beginLocalLogin() -> ServerProfile   // addLocalProfile() + sheet = .login(profile)
    var sheet: AppSheet?
}
struct LocalServerProbe: Sendable {           // Sources/App/LocalServerProbe.swift — do not edit
    init(session: URLSession = .shared)
    func probe(url: URL = LocalServerProbe.defaultURL) async -> LocalServerStatus
}
enum LocalServerStatus: Sendable, Equatable { case found(version: String), absent }
```

### Integration handoff (the one line S0-int adds)

S5 ships `LocalServerFeature.install()`. The integration lane adds **one line** to `ShepherdApp.init()` on its own branch: `LocalServerFeature.install()`.

**No `project.yml` change is needed.** The target already has `ENABLE_APP_SANDBOX: NO` / `com.apple.security.app-sandbox: false`; the hardened runtime restricts loading unsigned code *into this process* (handled by `com.apple.security.cs.disable-library-validation`), not spawning children. Task 8 proves this on hardware. If it ever fails with an entitlement error, report it — do not edit `project.yml` here.

### Server facts this plan depends on (verified in the repo)

| Fact | Source |
| --- | --- |
| Install dir default `~/.shepherd/app` (`SHEPHERD_DIR`); `SHEPHERD_REF` default `main` | `deploy/install.sh:53` |
| `SHEPHERD_NO_SERVICE=1` skips the systemd unit; set automatically on macOS | `deploy/install.sh` `decide()` |
| Overrides in `~/.shepherd/env`, sourced with `set -a` | `deploy/install.sh` `main()` |
| Start command `bun run src/index.ts` | root `package.json` `"start"` |
| Port 7330 via `SHEPHERD_PORT`; host via `SHEPHERD_HOST` (default `127.0.0.1`) | `src/config.ts:536`, `:617` |
| Ready line `shepherd core on http://localhost:7330` | `src/index.ts:3282` |
| Password banner `  Operator password (shown ONCE): <pw>`; `<pw>` = `randomBytes(18).toString("base64url")` → 24 chars of `[A-Za-z0-9_-]` | `src/operator-auth.ts:~217`, `:42` |
| `SHEPHERD_PASSWORD` set ⇒ re-seeds the hash every boot; unset ⇒ persisted hash, else a generated password printed **once** | `src/operator-auth.ts:~205-225` |
| A checkout is Shepherd iff `package.json`'s `name` is `shepherd` | root `package.json` |

### Decisions

**D1 — kit, guarded, not a second target.** The code stays in the existing `ShepherdKit` target under `Sources/ShepherdKit/LocalServer/`, every file wrapped in `#if os(macOS)`. SwiftPM has no per-platform target exclusion, so a separate target would still compile on iOS and still need the same guards — *plus* an edit to `native/Package.swift`, which this stream does not own. Guards cost five lines per file and zero handoffs.

**D2 — actor supervisor, `nonisolated` quit kill.** `applicationWillTerminate` gets no `await`, so `stop()` alone cannot guarantee the child dies. The supervisor keeps the live child's **pid** (`Int32`, trivially `Sendable`) in a `Mutex<Int32?>` and exposes `nonisolated func terminateNow()` that `kill(2)`s it synchronously. A `Mutex<Process?>` would not compile — `Process` is not `Sendable`.

**D3 — health is an injected closure.** The kit ships `LocalHealthCheck` (URLSession, injectable session, stubbed via `URLProtocol`); the supervisor takes `health: @Sendable () async -> Bool`. The app's *pre-flight* "is something already listening" check reuses the existing `LocalServerProbe`, which this stream must not edit.

**D4 — the captured password is shown once, never stored.** Held in memory on `LocalServerModel`, offered as a "Sign in" prefill plus a copy button, consumed on use, redacted from the ring the instant it is parsed. Trade-off, stated in the panel copy: an operator who did not write it down must set `SHEPHERD_PASSWORD` in `~/.shepherd/env` and restart. Persisting it would make this app a second, weaker home for the server's master password; we mint a scoped token at sign-in and let the password go.

### Task order

| # | Task | Deliverable |
| --- | --- | --- |
| 1 | Paths, checkout detection, bun locator, env file | `LocalServerEnvironment` |
| 2 | Redacting log ring, boot-line parsing | `LogRing`, `BootLineScanner` |
| 3 | Child process supervision | `LocalServerSupervisor` start/stop/`terminateNow` |
| 4 | Health poll, restart backoff, crash-loop stop | `LocalHealthCheck` + restart tests |
| 5 | Installer bridge | `InstallerRun` |
| 6 | App model, strings, feature install, quit hook | `LocalServerModel`, `LocalServerFeature` |
| 7 | Welcome local panel | `LocalServerPanel` |
| 8 | Verification, live check, PR | four gates green, PR opened |

---

### Task 1: Paths, checkout detection, bun locator, env file

**Files:** Create `native/Sources/ShepherdKit/LocalServer/LocalServerEnvironment.swift`; Test `native/Tests/ShepherdKitTests/LocalServerEnvironmentTests.swift`

**Interfaces:** Consumes nothing. Produces `LocalServerFailure`, and `LocalServerEnvironment` (`init(home:fileManager:pathEntries:)`, `appDirectory`, `envFilePath`, `isShepherdCheckout() -> Bool`, `locateBun() -> URL?`, `envFileValues() -> [String: String]`, `spawnEnvironment(bun: URL) -> [String: String]`).

- [ ] **Step 1: Write the failing tests** — `native/Tests/ShepherdKitTests/LocalServerEnvironmentTests.swift`

```swift
#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

func makeTempHome() throws -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("s5-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func makeExecutable(_ url: URL) throws {
    try Data().write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
}

@Suite struct LocalServerEnvironmentTests {
    @Test func pathsFollowTheInstallerDefaults() throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let env = LocalServerEnvironment(home: home)
        #expect(env.appDirectory.path == home.appendingPathComponent(".shepherd/app").path)
        #expect(env.envFilePath.path == home.appendingPathComponent(".shepherd/env").path)
    }

    @Test func onlyAPackageNamedShepherdIsACheckout() throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let env = LocalServerEnvironment(home: home)
        try FileManager.default.createDirectory(at: env.appDirectory, withIntermediateDirectories: true)
        #expect(env.isShepherdCheckout() == false)                       // no package.json
        let manifest = env.appDirectory.appendingPathComponent("package.json")
        try #"{"name":"something-else"}"#.write(to: manifest, atomically: true, encoding: .utf8)
        #expect(env.isShepherdCheckout() == false)
        try #"{"name":"shepherd","version":"1.0.0"}"#.write(to: manifest, atomically: true, encoding: .utf8)
        #expect(env.isShepherdCheckout() == true)
    }

    /// A Finder-launched app inherits launchd's PATH, which has neither ~/.bun/bin
    /// nor a Homebrew prefix — so the fallbacks must work with PATH empty.
    @Test func bunIsFoundByFallbackPathAndExecutabilityIsRequired() throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let bunBin = home.appendingPathComponent(".bun/bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bunBin, withIntermediateDirectories: true)
        let bun = bunBin.appendingPathComponent("bun")
        try Data().write(to: bun)                                        // mode 0644
        #expect(LocalServerEnvironment(home: home, pathEntries: []).locateBun() == nil)
        try makeExecutable(bun)
        #expect(LocalServerEnvironment(home: home, pathEntries: []).locateBun()?.path == bun.path)
    }

    @Test func pathEntriesWinOverTheFallbacks() throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let custom = home.appendingPathComponent("custom", isDirectory: true)
        try FileManager.default.createDirectory(at: custom, withIntermediateDirectories: true)
        let bun = custom.appendingPathComponent("bun")
        try makeExecutable(bun)
        #expect(LocalServerEnvironment(home: home, pathEntries: [custom.path]).locateBun()?.path == bun.path)
    }

    @Test func envFileParsesExportsQuotesAndComments() throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let env = LocalServerEnvironment(home: home)
        try FileManager.default.createDirectory(
            at: env.envFilePath.deletingLastPathComponent(), withIntermediateDirectories: true)
        try """
        # a comment
        SHEPHERD_PORT=7331
        export SHEPHERD_DB="/tmp/my db.sqlite"
        SHEPHERD_TOKEN='abc def'

        NOT_A_PAIR
        """.write(to: env.envFilePath, atomically: true, encoding: .utf8)

        let values = env.envFileValues()
        #expect(values["SHEPHERD_PORT"] == "7331")
        #expect(values["SHEPHERD_DB"] == "/tmp/my db.sqlite")
        #expect(values["SHEPHERD_TOKEN"] == "abc def")
        #expect(values["NOT_A_PAIR"] == nil)
        #expect(values.keys.contains { $0.hasPrefix("#") } == false)
    }

    @Test func aMissingEnvFileIsEmptyNotAnError() throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        #expect(LocalServerEnvironment(home: home).envFileValues().isEmpty)
    }

    @Test func spawnEnvironmentPinsLoopbackAndPrependsBunToPath() throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let env = LocalServerEnvironment(home: home, pathEntries: ["/usr/bin"])
        try FileManager.default.createDirectory(
            at: env.envFilePath.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "SHEPHERD_PORT=7331\n".write(to: env.envFilePath, atomically: true, encoding: .utf8)

        let spawn = env.spawnEnvironment(bun: URL(fileURLWithPath: "/opt/bun/bin/bun"))
        #expect(spawn["SHEPHERD_HOST"] == "127.0.0.1")
        #expect(spawn["SHEPHERD_PORT"] == "7331")             // operator override survives
        #expect(spawn["HOME"] == home.path)
        #expect(spawn["PATH"]?.hasPrefix("/opt/bun/bin:") == true)
    }
}
#endif
```

- [ ] **Step 2: Run to verify it fails** — `swift test --package-path native --filter LocalServerEnvironment`. Expected: FAIL, `cannot find 'LocalServerEnvironment' in scope`.

- [ ] **Step 3: Write the implementation** — `native/Sources/ShepherdKit/LocalServer/LocalServerEnvironment.swift`

```swift
#if os(macOS)
import Foundation

/// Why the local server is not usable. One catalog key per case in the app layer;
/// nothing here is an operator-facing sentence.
public enum LocalServerFailure: Error, Equatable, Sendable {
    case bunMissing
    case notAShepherdCheckout(path: String)
    case installFailed(exitCode: Int32)
    case exited(code: Int32)
    case crashLoop(restarts: Int)
}

/// Everything about *this Mac* the supervisor needs, with filesystem and PATH
/// injected so tests never touch the real `~/.shepherd`. macOS-only: `Process`
/// and `/bin/bash` do not exist on iOS and the kit compiles for `.iOS(.v18)` (D1).
public struct LocalServerEnvironment: Sendable {
    public let appDirectory: URL     // the installer's SHEPHERD_DIR default
    public let envFilePath: URL      // sourced by install.sh and the systemd units

    private let home: URL
    private let pathEntries: [String]
    private let fileManager: FileManager

    public init(
        home: URL = URL(fileURLWithPath: NSHomeDirectory()),
        fileManager: FileManager = .default,
        pathEntries: [String]? = nil
    ) {
        self.home = home
        self.fileManager = fileManager
        self.pathEntries = pathEntries
            ?? (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        self.appDirectory = home.appendingPathComponent(".shepherd/app", isDirectory: true)
        self.envFilePath = home.appendingPathComponent(".shepherd/env", isDirectory: false)
    }

    /// Always appended: a Finder-launched app inherits launchd's PATH, which
    /// carries none of these.
    private var bunFallbacks: [String] {
        [home.appendingPathComponent(".bun/bin").path, "/opt/homebrew/bin", "/usr/local/bin"]
    }

    /// Cheaper and less brittle than shelling out to git, and it is what the app
    /// needs: `bun run src/index.ts` wants that manifest, not a `.git`.
    public func isShepherdCheckout() -> Bool {
        let manifest = appDirectory.appendingPathComponent("package.json")
        guard let data = fileManager.contents(atPath: manifest.path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = object["name"] as? String
        else { return false }
        return name == "shepherd"
    }

    public func locateBun() -> URL? {
        for directory in pathEntries + bunFallbacks {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent("bun")
            if fileManager.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// `KEY=value` lines the way `set -a; . env` reads them: `export ` stripped,
    /// one layer of matching quotes removed, blanks/comments/`=`-less lines skipped.
    /// Deliberately not a shell — no `$VAR` expansion, no command substitution: the
    /// file is data here, never code.
    public func envFileValues() -> [String: String] {
        guard let text = try? String(contentsOf: envFilePath, encoding: .utf8) else { return [:] }
        var values: [String: String] = [:]
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("export ") { line = String(line.dropFirst("export ".count)) }
            guard let separator = line.firstIndex(of: "=") else { continue }
            let key = line[line.startIndex..<separator].trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            var value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
            if value.count >= 2, let first = value.first, let last = value.last,
               first == last, first == "\"" || first == "'" {
                value = String(value.dropFirst().dropLast())
            }
            values[key] = value
        }
        return values
    }

    /// This process's environment, then `~/.shepherd/env` (operator overrides win
    /// over ours), then the two we insist on: `HOME` so the child finds the same
    /// state dir, and `SHEPHERD_HOST` pinned to loopback so supervising a server
    /// can never expose it on a LAN.
    public func spawnEnvironment(bun: URL) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in envFileValues() { environment[key] = value }
        environment["HOME"] = home.path
        environment["SHEPHERD_HOST"] = "127.0.0.1"
        environment["PATH"] = ([bun.deletingLastPathComponent().path] + pathEntries + bunFallbacks)
            .joined(separator: ":")
        return environment
    }
}
#endif
```

- [ ] **Step 4: Run to verify it passes** — `swift test --package-path native --filter LocalServerEnvironment`. Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/LocalServer/LocalServerEnvironment.swift \
        native/Tests/ShepherdKitTests/LocalServerEnvironmentTests.swift
git commit -m "feat(mac): local server environment, checkout detection and bun locator"
```

---

### Task 2: Redacting log ring and boot-line parsing

**Files:** Create `native/Sources/ShepherdKit/LocalServer/LogRing.swift` and `.../BootLineScanner.swift`; Test `native/Tests/ShepherdKitTests/LocalServerLogTests.swift`

**Interfaces:** Consumes nothing. Produces `LogRing` (`actor`; `init(capacity:)`, `lines`, `append(_:)`, `redact(_:)`, `clear()`, `static placeholder`) and `BootLineScanner` (`static readyPort(in:) -> Int?`, `static generatedPassword(in:) -> String?`).

- [ ] **Step 1: Write the failing tests** — `native/Tests/ShepherdKitTests/LocalServerLogTests.swift`

```swift
#if os(macOS)
import Testing
@testable import ShepherdKit

@Suite struct BootLineScannerTests {
    @Test func theReadyLineYieldsItsPort() {
        #expect(BootLineScanner.readyPort(in: "shepherd core on http://localhost:7330") == 7330)
        #expect(BootLineScanner.readyPort(in: "shepherd core on http://localhost:7331") == 7331)
        #expect(BootLineScanner.readyPort(in: "loaded 12 sessions") == nil)
        #expect(BootLineScanner.readyPort(in: "shepherd core on http://localhost:") == nil)
    }

    /// A configured password prints no banner; a line that merely mentions the
    /// phrase must not be mistaken for one.
    @Test func onlyTheFullBannerYieldsAPassword() {
        #expect(BootLineScanner.generatedPassword(
            in: "  Operator password (shown ONCE): aB3-_xyz01234567890abcd") == "aB3-_xyz01234567890abcd")
        #expect(BootLineScanner.generatedPassword(in: "CHANGE THIS: set SHEPHERD_PASSWORD") == nil)
        #expect(BootLineScanner.generatedPassword(in: "Operator password (shown ONCE):") == nil)
    }
}

@Suite struct LogRingTests {
    @Test func theRingKeepsOnlyTheLastNLinesAndClears() async {
        let ring = LogRing(capacity: 3)
        for index in 1...5 { await ring.append("line \(index)") }
        #expect(await ring.lines == ["line 3", "line 4", "line 5"])
        await ring.clear()
        #expect(await ring.lines.isEmpty)
    }

    /// The whole point: once captured, the password must be gone from what the
    /// operator can open AND from anything appended afterwards.
    @Test func redactionScrubsPastAndFutureLines() async {
        let ring = LogRing(capacity: 10)
        await ring.append("Operator password (shown ONCE): s3cr3t-token-value-abcd")
        await ring.redact("s3cr3t-token-value-abcd")
        await ring.append("retrying login with s3cr3t-token-value-abcd")
        let lines = await ring.lines
        #expect(lines.allSatisfy { !$0.contains("s3cr3t-token-value-abcd") })
        #expect(lines[0].contains(LogRing.placeholder))
        #expect(lines[1] == "retrying login with \(LogRing.placeholder)")
    }

    @Test func redactingAnEmptySecretIsANoOp() async {
        let ring = LogRing(capacity: 10)
        await ring.append("hello")
        await ring.redact("")
        #expect(await ring.lines == ["hello"])
    }
}
#endif
```

- [ ] **Step 2: Run to verify it fails** — `swift test --package-path native --filter "LogRing|BootLineScanner"`. Expected: FAIL, `cannot find 'LogRing' in scope`.

- [ ] **Step 3: Write the implementations**

`native/Sources/ShepherdKit/LocalServer/LogRing.swift`:

```swift
#if os(macOS)
import Foundation

/// A bounded, redacting buffer of child-process output. Bounded because a server
/// run for a day prints far more than a log disclosure should hold. Redacting
/// because the boot banner contains the operator password in clear text: once
/// told a secret, the ring scrubs it from what is already buffered **and** from
/// everything appended afterwards, so no later reader of `lines` can see it.
public actor LogRing {
    public static let placeholder = "••••"

    private var buffer: [String] = []
    private var secrets: [String] = []
    private let capacity: Int

    public init(capacity: Int = 500) { self.capacity = max(1, capacity) }

    public var lines: [String] { buffer }

    public func append(_ line: String) {
        buffer.append(scrub(line))
        if buffer.count > capacity { buffer.removeFirst(buffer.count - capacity) }
    }

    public func clear() { buffer.removeAll(keepingCapacity: true) }

    /// Registers `secret` and rewrites the existing buffer. Idempotent.
    public func redact(_ secret: String) {
        guard !secret.isEmpty, !secrets.contains(secret) else { return }
        secrets.append(secret)
        buffer = buffer.map { $0.replacingOccurrences(of: secret, with: Self.placeholder) }
    }

    private func scrub(_ line: String) -> String {
        secrets.reduce(line) { $0.replacingOccurrences(of: $1, with: Self.placeholder) }
    }
}
#endif
```

`native/Sources/ShepherdKit/LocalServer/BootLineScanner.swift`:

```swift
#if os(macOS)
import Foundation

/// The two lines of `bun run src/index.ts` output the app reacts to:
///   src/index.ts:3282      `shepherd core on http://localhost:<port>`
///   src/operator-auth.ts   `  Operator password (shown ONCE): <pw>`
/// If either format changes, the supervisor falls back to the health poll for
/// readiness and simply never captures a password — degraded, not broken.
public enum BootLineScanner {
    public static func readyPort(in line: String) -> Int? {
        guard let range = line.range(of: "shepherd core on http://localhost:") else { return nil }
        let digits = line[range.upperBound...].prefix { $0.isNumber }
        return digits.isEmpty ? nil : Int(digits)
    }

    /// `generatePassword()` is `randomBytes(18).toString("base64url")` — 24 chars
    /// of `[A-Za-z0-9_-]` — so anything shorter is not it.
    public static func generatedPassword(in line: String) -> String? {
        guard let range = line.range(of: "Operator password (shown ONCE): ") else { return nil }
        let candidate = line[range.upperBound...]
            .prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        return candidate.count >= 20 ? String(candidate) : nil
    }
}
#endif
```

- [ ] **Step 4: Run to verify it passes** — `swift test --package-path native --filter "LogRing|BootLineScanner"`. Expected: PASS, 5 tests across two suites.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/LocalServer/LogRing.swift \
        native/Sources/ShepherdKit/LocalServer/BootLineScanner.swift \
        native/Tests/ShepherdKitTests/LocalServerLogTests.swift
git commit -m "feat(mac): redacting log ring and boot-line scanner for the local server"
```

---

### Task 3: Child process supervision — start, stop, terminateNow

**Files:** Create `native/Sources/ShepherdKit/LocalServer/LocalServerSupervisor.swift`; Test `native/Tests/ShepherdKitTests/LocalServerSupervisorTests.swift`

**Interfaces:** Consumes `LocalServerEnvironment`, `LocalServerFailure`, `LogRing`, `BootLineScanner`. Produces `LocalServerState`, `SupervisorClock`, `SystemSupervisorClock`, `LocalServerLaunch`, and `LocalServerSupervisor` (`init(environment:log:health:clock:policy:launch:)`, `state`, `capturedPassword`, `logLines()`, `clearCapturedPassword()`, `start()`, `stop()`, `restart()`, `nonisolated terminateNow(gracePeriod:)`, `static defaultLaunch(_:)`, `RestartPolicy`).

- [ ] **Step 1: Write the failing tests** — `native/Tests/ShepherdKitTests/LocalServerSupervisorTests.swift`

```swift
#if os(macOS)
import Foundation
import Synchronization
import Testing
@testable import ShepherdKit

/// A clock that never really sleeps: records what it was asked to wait for and
/// advances `now` by that much. Backoff assertions become exact and instant.
actor TestClock: SupervisorClock {
    private(set) var slept: [TimeInterval] = []
    private var current = Date(timeIntervalSince1970: 0)
    var now: Date { current }
    func sleep(for seconds: TimeInterval) async throws {
        slept.append(seconds)
        current = current.addingTimeInterval(seconds)
    }
    func advance(_ seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }
}

/// Writes a /bin/sh script into a temp dir and returns a launch spec for it.
/// Nothing in this file runs bun, install.sh or a real Shepherd server.
func fakeScript(_ body: String) throws -> (launch: LocalServerLaunch, cleanup: () -> Void) {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("s5-proc-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let script = dir.appendingPathComponent("fake.sh")
    try ("#!/bin/sh\n" + body).write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    let launch = LocalServerLaunch(
        executable: URL(fileURLWithPath: "/bin/sh"), arguments: [script.path],
        workingDirectory: dir, environment: ["PATH": "/usr/bin:/bin"])
    return (launch, { try? FileManager.default.removeItem(at: dir) })
}

/// Polls every 20 ms up to `timeout` — neither flaky nor slow.
func waitUntil(timeout: TimeInterval = 5, _ condition: @Sendable () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(20))
    }
    Issue.record("condition not met within \(timeout)s")
}

@Suite(.serialized) struct LocalServerSupervisorProcessTests {
    private func supervisor(_ launch: LocalServerLaunch) -> LocalServerSupervisor {
        LocalServerSupervisor(
            environment: LocalServerEnvironment(home: launch.workingDirectory),
            log: LogRing(capacity: 200), health: { true }, clock: TestClock(), launch: { launch })
    }

    @Test func startingRunsTheChildAndLogsItsOutput() async throws {
        let (launch, cleanup) = try fakeScript(
            "echo 'shepherd core on http://localhost:7330'\necho 'loaded 3 sessions'\nsleep 30\n")
        defer { cleanup() }
        let sut = supervisor(launch)
        await sut.start()
        #expect(await sut.state.isRunning)
        try await waitUntil { await sut.logLines().contains("loaded 3 sessions") }
        await sut.stop()
    }

    /// The password must reach `capturedPassword` and must NOT survive in the log.
    @Test func theGeneratedPasswordIsCapturedAndRedacted() async throws {
        let password = "Zx9_test-password-abcdefgh"
        let (launch, cleanup) = try fakeScript("""
        echo '  Operator password (shown ONCE): \(password)'
        echo 'shepherd core on http://localhost:7330'
        sleep 30
        """)
        defer { cleanup() }
        let sut = supervisor(launch)
        await sut.start()
        try await waitUntil { await sut.capturedPassword == password }
        let lines = await sut.logLines()
        #expect(lines.allSatisfy { !$0.contains(password) })
        #expect(lines.contains { $0.contains(LogRing.placeholder) })
        await sut.stop()
    }

    @Test func stopTerminatesTheChildAndReportsStopped() async throws {
        let (launch, cleanup) = try fakeScript("sleep 60\n")
        defer { cleanup() }
        let sut = supervisor(launch)
        await sut.start()
        let pid = await sut.state.pid
        #expect(pid != nil)
        await sut.stop()
        #expect(await sut.state == .stopped)
        #expect(kill(pid!, 0) != 0)                 // ESRCH — the pid is gone
    }

    /// The quit path: synchronous, no await, reachable from
    /// applicationWillTerminate. The script ignores SIGTERM, so only the SIGKILL
    /// fallback can end it.
    @Test func terminateNowKillsAChildThatIgnoresSIGTERM() async throws {
        let (launch, cleanup) = try fakeScript("trap '' TERM\nsleep 60\n")
        defer { cleanup() }
        let sut = supervisor(launch)
        await sut.start()
        let pid = await sut.state.pid
        sut.terminateNow(gracePeriod: 0.3)          // nonisolated — no await
        #expect(kill(pid!, 0) != 0)
        await sut.stop()
    }

    @Test func aMissingBunOrExecutableFailsInsteadOfTrapping() async {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory())
        let environment = LocalServerEnvironment(home: temp)
        let missing = LocalServerLaunch(
            executable: URL(fileURLWithPath: "/nonexistent/bun"), arguments: [],
            workingDirectory: temp, environment: [:])
        for launch in [{ missing }, { nil as LocalServerLaunch? }] {
            let sut = LocalServerSupervisor(
                environment: environment, log: LogRing(), health: { false },
                clock: TestClock(), launch: launch)
            await sut.start()
            #expect(await sut.state == .failed(.bunMissing))
        }
    }
}
#endif
```

- [ ] **Step 2: Run to verify it fails** — `swift test --package-path native --filter LocalServerSupervisorProcess`. Expected: FAIL, `cannot find 'LocalServerSupervisor' in scope`.

- [ ] **Step 3: Write the implementation** — `native/Sources/ShepherdKit/LocalServer/LocalServerSupervisor.swift`. Task 4 adds no code to this file; write it whole now.

```swift
#if os(macOS)
import Foundation
import Synchronization
import os

/// `externallyManaged` is a server we did not start and must not stop — the
/// operator's own `bun run start` in a terminal, or a launchd job.
public enum LocalServerState: Sendable, Equatable {
    case notInstalled, installing, stopped, starting
    case running(pid: Int32)
    case externallyManaged
    case failed(LocalServerFailure)

    public var isRunning: Bool { if case .running = self { return true }; return false }
    public var pid: Int32? { if case .running(let pid) = self { return pid }; return nil }
}

/// Injected so backoff is asserted, not waited out.
public protocol SupervisorClock: Sendable {
    var now: Date { get async }
    func sleep(for seconds: TimeInterval) async throws
}

public struct SystemSupervisorClock: SupervisorClock {
    public init() {}
    public var now: Date { get async { Date() } }
    public func sleep(for seconds: TimeInterval) async throws {
        try await Task.sleep(for: .seconds(seconds))
    }
}

/// Everything needed to spawn one child. A value type so tests can point the
/// supervisor at a /bin/sh script instead of bun.
public struct LocalServerLaunch: Sendable {
    public let executable: URL
    public let arguments: [String]
    public let workingDirectory: URL
    public let environment: [String: String]
    public init(executable: URL, arguments: [String], workingDirectory: URL, environment: [String: String]) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

/// Owns at most one child Shepherd server: spawn, output capture, health, crash
/// restart, shutdown. No UI, no AppModel — the app layer mirrors `state`.
public actor LocalServerSupervisor {
    static let logger = Logger(subsystem: "run.shepherd.mac", category: "localserver")

    /// At most `maxRestarts` within `window` seconds, then stop trying.
    public struct RestartPolicy: Sendable {
        public var maxRestarts = 3
        public var window: TimeInterval = 300
        public var backoff: [TimeInterval] = [1, 2, 4]
        public init() {}
    }

    private let environment: LocalServerEnvironment
    private let log: LogRing
    private let health: @Sendable () async -> Bool
    private let clock: any SupervisorClock
    private let makeLaunch: @Sendable () -> LocalServerLaunch?
    private let policy: RestartPolicy

    public private(set) var state: LocalServerState = .stopped
    /// In memory only, for the one "sign in with the generated password" offer.
    /// Never persisted, never logged (D4).
    public private(set) var capturedPassword: String?

    private var process: Process?
    private var pump: Task<Void, Never>?
    private var supervision: Task<Void, Never>?
    private var crashTimes: [Date] = []
    /// Set while `stop()` tears the child down, so the exit is not read as a crash.
    private var stopping = false

    /// The live child's pid, readable without hopping onto the actor so
    /// `terminateNow()` can run inside `applicationWillTerminate` (D2). A
    /// `Mutex<Process?>` would not compile — `Process` is not `Sendable`.
    private let livePID = Mutex<Int32?>(nil)

    public init(
        environment: LocalServerEnvironment,
        log: LogRing = LogRing(),
        health: @escaping @Sendable () async -> Bool,
        clock: any SupervisorClock = SystemSupervisorClock(),
        policy: RestartPolicy = RestartPolicy(),
        launch: @escaping @Sendable () -> LocalServerLaunch?
    ) {
        self.environment = environment
        self.log = log
        self.health = health
        self.clock = clock
        self.policy = policy
        self.makeLaunch = launch
    }

    /// The production launch spec: `bun run src/index.ts` in `~/.shepherd/app`.
    public static func defaultLaunch(
        _ environment: LocalServerEnvironment
    ) -> @Sendable () -> LocalServerLaunch? {
        {
            guard let bun = environment.locateBun() else { return nil }
            return LocalServerLaunch(
                executable: bun, arguments: ["run", "src/index.ts"],
                workingDirectory: environment.appDirectory,
                environment: environment.spawnEnvironment(bun: bun))
        }
    }

    public func logLines() async -> [String] { await log.lines }
    public func clearCapturedPassword() { capturedPassword = nil }

    /// Spawns the child and waits until it answers `/api/health`. Idempotent.
    public func start() async {
        guard !state.isRunning, state != .starting else { return }
        guard let launch = makeLaunch() else { state = .failed(.bunMissing); return }
        stopping = false
        state = .starting
        do { try spawn(launch) } catch {
            Self.logger.error("spawn failed: \(String(describing: error), privacy: .public)")
            state = .failed(.bunMissing)
            return
        }
        await waitForHealth()
    }

    /// SIGTERM, then SIGKILL after the grace period. Cancels the pumps first, so
    /// the exit that follows is not read as a crash.
    public func stop() async {
        stopping = true
        supervision?.cancel(); supervision = nil
        terminateNow(gracePeriod: 5)
        pump?.cancel(); pump = nil
        process = nil
        if case .failed = state {} else { state = .stopped }
    }

    public func restart() async {
        await stop()
        crashTimes.removeAll()
        await start()
    }

    /// Synchronous, actor-free child kill for `applicationWillTerminate`, which
    /// gets no `await`. Safe to call when nothing is running.
    public nonisolated func terminateNow(gracePeriod: TimeInterval = 2) {
        guard let pid = livePID.withLock({ $0 }) else { return }
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(gracePeriod)
        while Date() < deadline {
            if kill(pid, 0) != 0 { livePID.withLock { $0 = nil }; return }
            usleep(20_000)
        }
        kill(pid, SIGKILL)
        var status: Int32 = 0
        _ = waitpid(pid, &status, WNOHANG)     // reap, so no zombie outlives us
        livePID.withLock { $0 = nil }
    }

    private func spawn(_ launch: LocalServerLaunch) throws {
        let pipe = Pipe()
        let child = Process()
        child.executableURL = launch.executable
        child.arguments = launch.arguments
        child.currentDirectoryURL = launch.workingDirectory
        child.environment = launch.environment
        // One pipe for both streams: the operator reads a single interleaved log,
        // and two pipes would need two pumps and could deadlock on a full buffer.
        child.standardOutput = pipe
        child.standardError = pipe
        try child.run()

        process = child
        let pid = child.processIdentifier
        livePID.withLock { $0 = pid }
        state = .running(pid: pid)
        Self.logger.info("local server started, pid \(pid, privacy: .public)")

        let handle = pipe.fileHandleForReading
        pump = Task { [weak self] in
            do { for try await line in handle.bytes.lines { await self?.ingest(line) } }
            catch { /* a closed pipe on child exit is the normal end of this loop */ }
            await self?.childStreamEnded()
        }
    }

    /// One line of child output. Nothing here reaches os.Logger: the child may
    /// print anything, including the password we are about to redact.
    private func ingest(_ line: String) async {
        if let password = BootLineScanner.generatedPassword(in: line) {
            capturedPassword = password
            await log.redact(password)
        }
        await log.append(line)
    }

    private func childStreamEnded() async {
        guard !stopping else { return }
        let code = process?.terminationStatus ?? -1
        livePID.withLock { $0 = nil }
        process = nil
        Self.logger.error("local server exited with \(code, privacy: .public)")
        await handleCrash(exitCode: code)
    }

    /// Polls health for up to 30 s. Readiness is the health answer, not the ready
    /// line: the line is a nicety the server may stop printing, `/api/health` is
    /// the contract.
    private func waitForHealth() async {
        for _ in 0..<60 {
            if Task.isCancelled || stopping { return }
            if await health() {
                if let pid = livePID.withLock({ $0 }) { state = .running(pid: pid) }
                return
            }
            if process == nil { return }   // died meanwhile; childStreamEnded handles it
            try? await clock.sleep(for: 0.5)
        }
        state = .failed(.exited(code: -1))
    }

    /// `maxRestarts` within `window`, with `backoff` between them, then give up
    /// and leave `.failed(.crashLoop:)` on screen.
    private func handleCrash(exitCode: Int32) async {
        let now = await clock.now
        crashTimes.append(now)
        crashTimes.removeAll { now.timeIntervalSince($0) > policy.window }

        guard crashTimes.count <= policy.maxRestarts else {
            state = .failed(.crashLoop(restarts: policy.maxRestarts))
            Self.logger.error("local server crash-looped after exit \(exitCode, privacy: .public)")
            return
        }
        let delay = policy.backoff[min(crashTimes.count - 1, policy.backoff.count - 1)]
        state = .starting
        supervision = Task { [weak self] in
            try? await self?.clock.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.relaunch()
        }
    }

    private func relaunch() async {
        guard !stopping, let launch = makeLaunch() else { return }
        do { try spawn(launch); await waitForHealth() } catch { state = .failed(.bunMissing) }
    }
}
#endif
```

- [ ] **Step 4: Run to verify it passes** — `swift test --package-path native --filter LocalServerSupervisorProcess`. Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/LocalServer/LocalServerSupervisor.swift \
        native/Tests/ShepherdKitTests/LocalServerSupervisorTests.swift
git commit -m "feat(mac): supervise the local shepherd server as a child process"
```

---

### Task 4: Health polling and restart backoff

**Files:** Create `native/Sources/ShepherdKit/LocalServer/LocalHealthCheck.swift` and `native/Tests/ShepherdKitTests/LocalHealthCheckTests.swift`; Modify `native/Tests/ShepherdKitTests/LocalServerSupervisorTests.swift` (append one suite before its final `#endif`).

**Interfaces:** Consumes `LocalServerSupervisor`, `TestClock`, `fakeScript`, `waitUntil` from Task 3. Produces `LocalHealthCheck` (`init(port:session:)`, `url`, `callAsFunction() async -> Bool`).

- [ ] **Step 1: Write the failing tests** — `native/Tests/ShepherdKitTests/LocalHealthCheckTests.swift`

```swift
#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

/// URLProtocol is a class cluster with no injection point, so the stub needs the
/// escape hatch the global constraints allow exactly here. Suite is .serialized.
final class HealthStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct LocalHealthCheckTests {
    private func check(
        _ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> LocalHealthCheck {
        HealthStubProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HealthStubProtocol.self]
        return LocalHealthCheck(port: 7330, session: URLSession(configuration: config))
    }

    private func body(_ text: String, status: Int = 200)
        -> @Sendable (URLRequest) throws -> (HTTPURLResponse, Data) {
        { request in
            (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
             Data(text.utf8))
        }
    }

    @Test func theURLIsLoopbackHealthOnTheGivenPort() {
        #expect(LocalHealthCheck(port: 7330).url.absoluteString == "http://127.0.0.1:7330/api/health")
        #expect(LocalHealthCheck(port: 7331).url.absoluteString == "http://127.0.0.1:7331/api/health")
    }

    @Test func okTrueIsHealthyAndNothingElseIs() async {
        #expect(await check(body(#"{"ok":true,"version":"3.41.0"}"#))() == true)
        #expect(await check(body(#"{"ok":false,"version":"3.41.0"}"#))() == false)
        #expect(await check(body(#"{"ok":true,"version":"3"}"#, status: 503))() == false)
        #expect(await check(body("<html>nginx</html>"))() == false)
        #expect(await check({ _ in throw URLError(.cannotConnectToHost) })() == false)
    }
}
#endif
```

Append to `native/Tests/ShepherdKitTests/LocalServerSupervisorTests.swift`, before its final `#endif`:

```swift
@Suite(.serialized) struct LocalServerRestartTests {
    /// A child that exits immediately is restarted after 1 s, 2 s, 4 s; the fourth
    /// crash inside the window stops the supervisor.
    @Test func threeRestartsThenCrashLoop() async throws {
        let (launch, cleanup) = try fakeScript("exit 1\n")
        defer { cleanup() }
        let clock = TestClock()
        let sut = LocalServerSupervisor(
            environment: LocalServerEnvironment(home: launch.workingDirectory),
            log: LogRing(capacity: 50), health: { false }, clock: clock, launch: { launch })
        await sut.start()
        try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 3)) }
        #expect(await clock.slept.filter { [1, 2, 4].contains($0) } == [1, 2, 4])
    }

    /// `restart()` clears the crash history, so a server that dies once an hour
    /// stays supervised forever instead of accumulating into a crash loop.
    @Test func restartClearsTheCrashHistory() async throws {
        let (launch, cleanup) = try fakeScript("exit 1\n")
        defer { cleanup() }
        var policy = LocalServerSupervisor.RestartPolicy()
        policy.maxRestarts = 1
        let clock = TestClock()
        let sut = LocalServerSupervisor(
            environment: LocalServerEnvironment(home: launch.workingDirectory),
            log: LogRing(capacity: 50), health: { false }, clock: clock, policy: policy,
            launch: { launch })
        await sut.start()
        try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 1)) }
        await clock.advance(400)                  // past the 300 s window
        await sut.restart()
        try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 1)) }
    }

    /// Health, not the ready line, is what flips `.starting` to `.running`.
    @Test func healthDecidesReadiness() async throws {
        let (launch, cleanup) = try fakeScript("sleep 30\n")
        defer { cleanup() }
        let healthy = Mutex(true)
        let sut = LocalServerSupervisor(
            environment: LocalServerEnvironment(home: launch.workingDirectory),
            log: LogRing(), health: { healthy.withLock { $0 } }, clock: TestClock(),
            launch: { launch })
        await sut.start()
        #expect(await sut.state.isRunning)
        await sut.stop()
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `swift test --package-path native --filter "LocalHealthCheck|LocalServerRestart"`. Expected: FAIL, `cannot find 'LocalHealthCheck' in scope`.

- [ ] **Step 3: Write the implementation** — `native/Sources/ShepherdKit/LocalServer/LocalHealthCheck.swift`

```swift
#if os(macOS)
import Foundation

/// `GET http://127.0.0.1:<port>/api/health` — the one route with `security: []`
/// in the contract, so no token and no profile are needed. This is the kit's own
/// check, used by the supervisor's poll; the app's welcome card keeps using its
/// existing `LocalServerProbe`, which also reports the server version.
public struct LocalHealthCheck: Sendable {
    public let url: URL
    private let session: URLSession

    public init(port: Int = 7330, session: URLSession = .shared) {
        self.url = URL(string: "http://127.0.0.1:\(port)/api/health")!
        self.session = session
    }

    private struct Health: Decodable { let ok: Bool }

    /// Short timeout: this runs in a poll loop while the operator watches a
    /// spinner. Any failure at all reads as "not healthy yet".
    public func callAsFunction() async -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
            return try JSONDecoder().decode(Health.self, from: data).ok
        } catch { return false }
    }
}
#endif
```

- [ ] **Step 4: Run to verify it passes** — `swift test --package-path native --filter "LocalHealthCheck|LocalServerRestart"`. Expected: PASS, 2 health tests and 3 restart tests.

- [ ] **Step 5: Run the whole kit stream** — `swift test --package-path native --filter LocalServer`. Expected: PASS across `LocalServerEnvironmentTests`, `LogRingTests`, `BootLineScannerTests`, `LocalServerSupervisorProcessTests`, `LocalServerRestartTests`.

- [ ] **Step 6: Commit**

```bash
git add native/Sources/ShepherdKit/LocalServer/LocalHealthCheck.swift \
        native/Tests/ShepherdKitTests/LocalHealthCheckTests.swift \
        native/Tests/ShepherdKitTests/LocalServerSupervisorTests.swift
git commit -m "feat(mac): health polling and crash-loop restart policy for the local server"
```

---

### Task 5: Installer bridge

**Files:** Create `native/Sources/ShepherdKit/LocalServer/InstallerRun.swift`; Test `native/Tests/ShepherdKitTests/InstallerRunTests.swift`

**Interfaces:** Consumes `LocalServerEnvironment`, `LogRing`, `LocalServerFailure`, `makeTempHome` (Task 1). Produces `InstallerRun` (`init(environment:log:scriptOverride:)`, `scriptURL`, `run() async -> Result<Void, LocalServerFailure>`).

- [ ] **Step 1: Write the failing test** — `native/Tests/ShepherdKitTests/InstallerRunTests.swift`

```swift
#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.serialized) struct InstallerRunTests {
    /// Stands in for deploy/install.sh: echoes what it was given, exits with the
    /// code the test asked for. No real install runs in this suite.
    private func fakeInstaller(exit code: Int32) throws -> (script: URL, home: URL) {
        let home = try makeTempHome()
        let script = home.appendingPathComponent("install.sh")
        try """
        #!/bin/bash
        echo "no-service=$SHEPHERD_NO_SERVICE"
        echo "dir=$SHEPHERD_DIR"
        exit \(code)
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (script, home)
    }

    @Test func aSuccessfulRunStreamsItsOutputAndSucceeds() async throws {
        let (script, home) = try fakeInstaller(exit: 0)
        defer { try? FileManager.default.removeItem(at: home) }
        let log = LogRing(capacity: 50)
        let environment = LocalServerEnvironment(home: home)
        #expect(await InstallerRun(environment: environment, log: log, scriptOverride: script).run()
                == .success(()))
        let lines = await log.lines
        #expect(lines.contains("no-service=1"))
        #expect(lines.contains("dir=\(environment.appDirectory.path)"))
    }

    @Test func aFailingRunReportsItsExitCode() async throws {
        let (script, home) = try fakeInstaller(exit: 3)
        defer { try? FileManager.default.removeItem(at: home) }
        let run = InstallerRun(
            environment: LocalServerEnvironment(home: home), log: LogRing(), scriptOverride: script)
        #expect(await run.run() == .failure(.installFailed(exitCode: 3)))
    }

    @Test func aMissingScriptFailsCleanly() async throws {
        let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let run = InstallerRun(
            environment: LocalServerEnvironment(home: home), log: LogRing(),
            scriptOverride: home.appendingPathComponent("nope.sh"))
        #expect(await run.run() == .failure(.installFailed(exitCode: 127)))
    }
}
#endif
```

- [ ] **Step 2: Run to verify it fails** — `swift test --package-path native --filter InstallerRun`. Expected: FAIL, `cannot find 'InstallerRun' in scope`.

- [ ] **Step 3: Write the implementation** — `native/Sources/ShepherdKit/LocalServer/InstallerRun.swift`

```swift
#if os(macOS)
import Foundation
import os

/// Runs the repo's own `deploy/install.sh` and streams its output into the same
/// `LogRing` the server's output goes to, so the panel shows one continuous log.
/// The app never reimplements installer logic (design spec, sub-project 3). It
/// sets exactly the two values the macOS path needs:
///   SHEPHERD_NO_SERVICE=1  no systemd unit (install.sh sets this itself on
///                          Darwin; we set it too so a changed script cannot
///                          surprise us)
///   SHEPHERD_DIR           the same ~/.shepherd/app the supervisor will run in
/// `SHEPHERD_REF` is left alone: whatever the operator put in ~/.shepherd/env
/// wins, and the script's own default is `main`.
public struct InstallerRun: Sendable {
    private let environment: LocalServerEnvironment
    private let log: LogRing
    private let scriptOverride: URL?

    public init(environment: LocalServerEnvironment, log: LogRing, scriptOverride: URL? = nil) {
        self.environment = environment
        self.log = log
        self.scriptOverride = scriptOverride
    }

    /// `deploy/install.sh` inside the checkout. On a cold start there is none, so
    /// this fails with 127 and `LocalServerModel.install()` surfaces that — the
    /// app downloads nothing itself.
    public var scriptURL: URL {
        scriptOverride ?? environment.appDirectory.appendingPathComponent("deploy/install.sh")
    }

    public func run() async -> Result<Void, LocalServerFailure> {
        guard FileManager.default.isReadableFile(atPath: scriptURL.path) else {
            await log.append("installer not found at \(scriptURL.path)")
            return .failure(.installFailed(exitCode: 127))
        }

        var childEnvironment = ProcessInfo.processInfo.environment
        for (key, value) in environment.envFileValues() { childEnvironment[key] = value }
        childEnvironment["HOME"] =
            environment.appDirectory.deletingLastPathComponent().deletingLastPathComponent().path
        childEnvironment["SHEPHERD_NO_SERVICE"] = "1"
        childEnvironment["SHEPHERD_DIR"] = environment.appDirectory.path

        let pipe = Pipe()
        let process = Process()
        // /bin/bash explicitly: install.sh is `#!/usr/bin/env bash` and uses
        // bash-only syntax; the app must not depend on the operator's shell.
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [scriptURL.path]
        process.currentDirectoryURL = scriptURL.deletingLastPathComponent()
        process.environment = childEnvironment
        process.standardOutput = pipe
        process.standardError = pipe

        do { try process.run() } catch {
            await log.append("could not start the installer: \(error)")
            return .failure(.installFailed(exitCode: 127))
        }

        do { for try await line in pipe.fileHandleForReading.bytes.lines { await log.append(line) } }
        catch { /* a closed pipe at exit is the normal end of this loop */ }
        process.waitUntilExit()

        let code = process.terminationStatus
        guard code == 0 else { return .failure(.installFailed(exitCode: code)) }
        Logger(subsystem: "run.shepherd.mac", category: "localserver").info("installer finished")
        return .success(())
    }
}
#endif
```

- [ ] **Step 4: Run to verify it passes** — `swift test --package-path native --filter InstallerRun`. Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/LocalServer/InstallerRun.swift \
        native/Tests/ShepherdKitTests/InstallerRunTests.swift
git commit -m "feat(mac): stream deploy/install.sh output through the local server log"
```

---

### Task 6: App model, strings, feature installation, quit hook

**Files:** Create `native/Apps/ShepherdMac/Sources/LocalServer/LocalServerModel.swift` and `.../LocalServerFeature.swift`; Modify `native/scripts/gen-strings.ts` (`KEYS_LOCALSERVER` only), `ui/messages/en.json`, `ui/messages/de.json`; Test `native/Apps/ShepherdMac/Tests/LocalServerModelTests.swift`

**Interfaces:** Consumes the kit types above plus `AppModel`, `AppExtension`, `WelcomeSlots`, `LocalServerProbe`, `L`, `Log`. Produces `LocalServerCopy.label(for:)` / `.message(for:)`, `LocalServerModel` (`shared`, `init(environment:probeExternal:)`, `state`, `logLines`, `busy`, `capturedPassword`, `pendingPassword`, `canInstall/canStart/canStop/canRestart`, `refresh()`, `install()`, `start()`, `stop()`, `restart()`, `connect(_:)`, `takePendingPassword()`, `nonisolated terminateForQuit()`), `LocalServerSessionExtension`, `LocalServerFeature.install()`.

- [ ] **Step 1: Add the catalog keys** — insert into `ui/messages/en.json`, keeping the file's alphabetical order:

```json
  "native_local_connect": "Sign in",
  "native_local_error_bun_missing": "Bun was not found. Install it with: curl -fsSL https://bun.sh/install | bash",
  "native_local_error_crash_loop": "The server crashed {count} times in a row. Open the log to see why.",
  "native_local_error_exited": "The server stopped unexpectedly (exit {code}).",
  "native_local_error_install_failed": "The installer failed (exit {code}). Open the log to see why.",
  "native_local_error_not_checkout": "{path} exists but is not a Shepherd checkout. Move it aside, then install again.",
  "native_local_install": "Install",
  "native_local_log_hide": "Hide log",
  "native_local_log_show": "Show log",
  "native_local_password_body": "Shown once. Sign in now, or set SHEPHERD_PASSWORD in ~/.shepherd/env and restart the server.",
  "native_local_password_copy": "Copy password",
  "native_local_password_title": "The server generated a password",
  "native_local_restart": "Restart",
  "native_local_start": "Start",
  "native_local_state_external": "A server you started yourself is running on port 7330.",
  "native_local_state_installing": "Installing…",
  "native_local_state_not_installed": "Not installed yet. Install puts a checkout in ~/.shepherd/app.",
  "native_local_state_running": "Running (process {pid}).",
  "native_local_state_starting": "Starting…",
  "native_local_state_stopped": "Installed, not running.",
  "native_local_stop": "Stop",
```

and the same 21 keys into `ui/messages/de.json`:

```json
  "native_local_connect": "Anmelden",
  "native_local_error_bun_missing": "Bun wurde nicht gefunden. Installiere es mit: curl -fsSL https://bun.sh/install | bash",
  "native_local_error_crash_loop": "Der Server ist {count}-mal hintereinander abgestürzt. Öffne das Log, um zu sehen, warum.",
  "native_local_error_exited": "Der Server hat sich unerwartet beendet (Exit-Code {code}).",
  "native_local_error_install_failed": "Die Installation ist fehlgeschlagen (Exit-Code {code}). Öffne das Log, um zu sehen, warum.",
  "native_local_error_not_checkout": "{path} existiert, ist aber kein Shepherd-Checkout. Verschiebe es und installiere erneut.",
  "native_local_install": "Installieren",
  "native_local_log_hide": "Log ausblenden",
  "native_local_log_show": "Log anzeigen",
  "native_local_password_body": "Wird nur einmal angezeigt. Melde dich jetzt an, oder setze SHEPHERD_PASSWORD in ~/.shepherd/env und starte den Server neu.",
  "native_local_password_copy": "Passwort kopieren",
  "native_local_password_title": "Der Server hat ein Passwort erzeugt",
  "native_local_restart": "Neu starten",
  "native_local_start": "Starten",
  "native_local_state_external": "Auf Port 7330 läuft ein Server, den du selbst gestartet hast.",
  "native_local_state_installing": "Wird installiert…",
  "native_local_state_not_installed": "Noch nicht installiert. „Installieren“ legt einen Checkout in ~/.shepherd/app an.",
  "native_local_state_running": "Läuft (Prozess {pid}).",
  "native_local_state_starting": "Wird gestartet…",
  "native_local_state_stopped": "Installiert, läuft nicht.",
  "native_local_stop": "Stoppen",
```

In `native/scripts/gen-strings.ts`, edit **only** the `KEYS_LOCALSERVER` array (S0-prep created it empty), filling it with exactly those 21 key names in the same alphabetical order.

- [ ] **Step 2: Regenerate and verify the catalog**

```bash
bun native/scripts/gen-strings.ts
bun run check:strings
(cd ui && bun run check:i18n)
```
Expected: `Wrote …/Localizable.xcstrings (… keys, en + de).`, then `Localizable.xcstrings is up to date (… keys).`, then the i18n check passing with no missing-DE report.

- [ ] **Step 3: Write the failing tests** — `native/Apps/ShepherdMac/Tests/LocalServerModelTests.swift`

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

@Suite(.serialized) @MainActor struct LocalServerModelTests {
    private func tempHome() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("s5-app-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func checkout(in home: URL) throws -> LocalServerEnvironment {
        let environment = LocalServerEnvironment(home: home)
        try FileManager.default.createDirectory(at: environment.appDirectory, withIntermediateDirectories: true)
        try #"{"name":"shepherd"}"#.write(
            to: environment.appDirectory.appendingPathComponent("package.json"),
            atomically: true, encoding: .utf8)
        return environment
    }

    private func freshApp() -> AppModel {
        AppModel(profileStore: ProfileStore(defaults: UserDefaults(suiteName: UUID().uuidString)!))
    }

    @Test func aMissingCheckoutReadsAsNotInstalled() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(environment: LocalServerEnvironment(home: home), probeExternal: { false })
        await model.refresh()
        #expect(model.state == .notInstalled)
        #expect(model.canInstall)
    }

    @Test func aCheckoutWithNoRunningServerReadsAsStopped() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(environment: try checkout(in: home), probeExternal: { false })
        await model.refresh()
        #expect(model.state == .stopped)
        #expect(model.canStart)
    }

    /// A server we did not start must never be stoppable from this panel.
    @Test func somethingAlreadyOnPort7330IsExternallyManaged() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(environment: LocalServerEnvironment(home: home), probeExternal: { true })
        await model.refresh()
        #expect(model.state == .externallyManaged)
        #expect(model.canStop == false)
    }

    @Test func everyStateHasACatalogSentence() {
        let states: [LocalServerState] = [
            .notInstalled, .installing, .stopped, .starting, .running(pid: 42), .externallyManaged,
            .failed(.bunMissing), .failed(.notAShepherdCheckout(path: "/tmp/x")),
            .failed(.installFailed(exitCode: 3)), .failed(.exited(code: 1)),
            .failed(.crashLoop(restarts: 3)),
        ]
        for state in states {
            let text = LocalServerCopy.label(for: state)
            #expect(!text.isEmpty)
            #expect(text.hasPrefix("native_local_") == false)   // a leaked key = missing catalog entry
        }
    }

    /// Offered once, then dropped — never written anywhere that outlives the panel.
    @Test func connectingHandsThePasswordToTheLoginSheetExactlyOnce() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let app = freshApp()
        let model = LocalServerModel(environment: LocalServerEnvironment(home: home), probeExternal: { false })
        model.capturedPassword = "Zx9_test-password-abcdefgh"

        model.connect(app)
        #expect(app.sheet == .login(app.addLocalProfile()))
        #expect(model.capturedPassword == nil)
        #expect(model.takePendingPassword() == "Zx9_test-password-abcdefgh")
        #expect(model.takePendingPassword() == nil)
    }

    @Test func installingTheFeatureFillsTheWelcomeSlotAndIsIdempotent() {
        WelcomeSlots.localPanel = nil
        LocalServerFeature.install()
        #expect(WelcomeSlots.localPanel != nil)
        LocalServerFeature.install()
        #expect(WelcomeSlots.localPanel != nil)
    }
}
```

- [ ] **Step 4: Run to verify it fails** — `./native/scripts/test-app.sh -only-testing:ShepherdTests/LocalServerModelTests`. Expected: FAIL, `cannot find 'LocalServerModel' in scope`.

- [ ] **Step 5: Write the implementations** — `native/Apps/ShepherdMac/Sources/LocalServer/LocalServerModel.swift`

```swift
import Foundation
import Observation
import ShepherdKit

/// One catalog sentence per state. Next to the model rather than in the view so
/// the "every state is explained" test reaches it without SwiftUI.
enum LocalServerCopy {
    static func label(for state: LocalServerState) -> String {
        switch state {
        case .notInstalled: L.t("native_local_state_not_installed")
        case .installing: L.t("native_local_state_installing")
        case .stopped: L.t("native_local_state_stopped")
        case .starting: L.t("native_local_state_starting")
        case .running(let pid): L.t("native_local_state_running", String(pid))
        case .externallyManaged: L.t("native_local_state_external")
        case .failed(let failure): message(for: failure)
        }
    }

    static func message(for failure: LocalServerFailure) -> String {
        switch failure {
        case .bunMissing: L.t("native_local_error_bun_missing")
        case .notAShepherdCheckout(let path): L.t("native_local_error_not_checkout", path)
        case .installFailed(let code): L.t("native_local_error_install_failed", String(code))
        case .exited(let code): L.t("native_local_error_exited", String(code))
        case .crashLoop(let restarts): L.t("native_local_error_crash_loop", String(restarts))
        }
    }
}

/// The Welcome panel's view model. App-lifetime, because the panel exists before
/// any profile is active and the child server must outlive an activation — an
/// `AppExtension` alone could not hold it (extensions are born with a store).
/// The per-store half lives in `LocalServerSessionExtension` below.
@Observable
@MainActor
final class LocalServerModel {
    static let shared = LocalServerModel()

    private(set) var state: LocalServerState = .stopped
    private(set) var logLines: [String] = []
    private(set) var busy = false
    /// In memory only, offered once, then dropped (D4): persisting the server's
    /// master password would make this app a second, weaker home for it.
    var capturedPassword: String?
    /// Read once by the login sheet's prefill.
    private(set) var pendingPassword: String?

    private let environment: LocalServerEnvironment
    private let log = LogRing(capacity: 500)
    private let supervisor: LocalServerSupervisor
    /// "Is something already answering on 7330?" — injected so tests need no
    /// loopback listener. Production reuses the app's existing `LocalServerProbe`.
    private let probeExternal: @Sendable () async -> Bool

    init(
        environment: LocalServerEnvironment = LocalServerEnvironment(),
        probeExternal: (@Sendable () async -> Bool)? = nil
    ) {
        self.environment = environment
        self.probeExternal = probeExternal ?? {
            if case .found = await LocalServerProbe().probe() { return true }
            return false
        }
        let ring = log
        self.supervisor = LocalServerSupervisor(
            environment: environment, log: ring,
            health: { await LocalHealthCheck()() },
            launch: LocalServerSupervisor.defaultLaunch(environment))
    }

    private var isFailed: Bool { if case .failed = state { return true }; return false }
    var canInstall: Bool { !busy && (state == .notInstalled || isFailed) }
    var canStart: Bool { !busy && (state == .stopped || isFailed) }
    var canStop: Bool { !busy && state.isRunning }
    var canRestart: Bool { !busy && state.isRunning }

    /// Order matters: a server we already supervise wins over the loopback probe,
    /// because the probe cannot tell our child from anyone else's.
    func refresh() async {
        let supervised = await supervisor.state
        if supervised.isRunning || supervised == .starting {
            state = supervised
            await pullLog()
            return
        }
        if await probeExternal() { state = .externallyManaged; return }
        state = environment.isShepherdCheckout() ? .stopped : .notInstalled
        await pullLog()
    }

    func install() async {
        guard !busy else { return }
        busy = true; state = .installing
        defer { busy = false }
        let result = await InstallerRun(environment: environment, log: log).run()
        await pullLog()
        switch result {
        case .success: await refresh()
        case .failure(let failure): state = .failed(failure)
        }
    }

    func start() async { await act { await self.supervisor.start() } }
    func stop() async { await act { await self.supervisor.stop() } }
    func restart() async { await act { await self.supervisor.restart() } }

    /// Routes into the app's one sheet channel, consuming the captured password so
    /// it can never be offered twice.
    func connect(_ app: AppModel) {
        pendingPassword = capturedPassword
        capturedPassword = nil
        app.beginLocalLogin()
    }

    func takePendingPassword() -> String? {
        defer { pendingPassword = nil }
        return pendingPassword
    }

    /// The quit path. Synchronous by design — `applicationWillTerminate` gets no
    /// await, so this goes straight to the supervisor's nonisolated kill.
    nonisolated func terminateForQuit() { supervisor.terminateNow(gracePeriod: 5) }

    private func act(_ body: @MainActor () async -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await body()
        state = await supervisor.state
        if let password = await supervisor.capturedPassword { capturedPassword = password }
        await pullLog()
    }

    private func pullLog() async { logLines = await log.lines }
}

/// The per-store half of this stream's state: while a store is live for the local
/// profile, the panel can stop offering "Sign in". Torn down with the store, so a
/// superseded activation can never leave it set.
@MainActor
final class LocalServerSessionExtension: AppExtension {
    private(set) var hasLiveStore = true
    init(store: SessionStore, app: AppModel) { _ = store; _ = app }
    func teardown() { hasLiveStore = false }
}
```

`native/Apps/ShepherdMac/Sources/LocalServer/LocalServerFeature.swift`:

```swift
import AppKit
import SwiftUI

/// The stream's single entry point. The integration lane calls this once from
/// `ShepherdApp.init()` — see "Integration handoff"; this stream never edits
/// `ShepherdApp.swift` itself. Idempotent: a second call replaces the slot
/// closure and does not add a second termination observer.
@MainActor
enum LocalServerFeature {
    private static var installed = false

    static func install() {
        WelcomeSlots.localPanel = { app in
            AnyView(LocalServerPanel(model: LocalServerModel.shared, app: app))
        }
        guard !installed else { return }
        installed = true
        // The child server lives exactly as long as the app (design spec: "keep
        // running after quit" is out of scope). The observer lives in this
        // stream's own file so no shared lifecycle file is touched.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { _ in LocalServerModel.shared.terminateForQuit() }
        Log.app.info("local server feature installed")
    }
}
```

- [ ] **Step 6: Run to verify it passes** — `./native/scripts/test-app.sh -only-testing:ShepherdTests/LocalServerModelTests`. Expected: PASS, 6 tests. (The `LocalServerPanel` referenced by `install()` arrives in Task 7 — if the build fails on that name, write Task 7's view first and come back; they ship in one PR.)

- [ ] **Step 7: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/LocalServer/ \
        native/Apps/ShepherdMac/Tests/LocalServerModelTests.swift \
        native/scripts/gen-strings.ts \
        native/Apps/ShepherdMac/Resources/Localizable.xcstrings \
        ui/messages/en.json ui/messages/de.json
git commit -m "feat(mac): local server app model, copy and feature installation"
```

---

### Task 7: The Welcome local panel

**Files:** Create `native/Apps/ShepherdMac/Sources/LocalServer/LocalServerPanel.swift`; Test `native/Apps/ShepherdMac/Tests/LocalServerPanelTests.swift`

**Interfaces:** Consumes `LocalServerModel`, `LocalServerCopy`, `LocalServerState`, `AppModel`, `L`. Produces `LocalServerPanelState` (`init(state:busy:)`, `statusText`, `canInstall/canStart/canStop/canRestart/canConnect`, `isBusyState`) and `LocalServerPanel` (`init(model:app:)`).

- [ ] **Step 1: Write the failing test** — `native/Apps/ShepherdMac/Tests/LocalServerPanelTests.swift`

```swift
import Testing
import ShepherdKit
@testable import Shepherd

/// The panel's enablement logic, pulled out of the view so it is testable without
/// hosting SwiftUI — same pattern as LoginSheetState.
@Suite @MainActor struct LocalServerPanelStateTests {
    @Test func aMissingCheckoutOffersOnlyInstall() {
        let state = LocalServerPanelState(state: .notInstalled, busy: false)
        #expect(state.canInstall)
        #expect(state.canStart == false)
        #expect(state.canStop == false)
        #expect(state.canConnect == false)
    }

    @Test func anInstalledStoppedServerOffersStart() {
        let state = LocalServerPanelState(state: .stopped, busy: false)
        #expect(state.canStart)
        #expect(state.canInstall == false)
        #expect(state.canStop == false)
    }

    @Test func aRunningServerOffersStopRestartAndConnect() {
        let state = LocalServerPanelState(state: .running(pid: 1234), busy: false)
        #expect(state.canStop)
        #expect(state.canRestart)
        #expect(state.canConnect)
        #expect(state.canStart == false)
    }

    /// A server the operator started themselves is connectable but must not be
    /// stoppable or restartable from here.
    @Test func anExternalServerIsConnectableOnly() {
        let state = LocalServerPanelState(state: .externallyManaged, busy: false)
        #expect(state.canConnect)
        #expect(state.canStop == false)
        #expect(state.canRestart == false)
        #expect(state.canStart == false)
    }

    @Test func aFailedServerOffersStartAndInstallAgain() {
        let state = LocalServerPanelState(state: .failed(.crashLoop(restarts: 3)), busy: false)
        #expect(state.canStart)
        #expect(state.canInstall)
        #expect(state.canConnect == false)
    }

    /// Nothing is clickable mid-action: a second Install, or a Start racing a
    /// Stop, would leave two children behind.
    @Test func busyDisablesEverything() {
        let state = LocalServerPanelState(state: .running(pid: 1), busy: true)
        #expect(state.canStop == false)
        #expect(state.canRestart == false)
        #expect(state.canConnect == false)
        #expect(state.isBusyState)
    }

    @Test func theStatusLineIsAlwaysTheStatesSentence() {
        #expect(LocalServerPanelState(state: .stopped, busy: false).statusText
                == LocalServerCopy.label(for: .stopped))
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `./native/scripts/test-app.sh -only-testing:ShepherdTests/LocalServerPanelStateTests`. Expected: FAIL, `cannot find 'LocalServerPanelState' in scope`.

- [ ] **Step 3: Write the view** — `native/Apps/ShepherdMac/Sources/LocalServer/LocalServerPanel.swift`

```swift
import AppKit
import SwiftUI
import ShepherdKit

/// The panel's enablement rules, separate from the view so they are unit-tested
/// without hosting SwiftUI (pattern: LoginSheetState).
struct LocalServerPanelState: Equatable {
    let state: LocalServerState
    let busy: Bool

    var statusText: String { LocalServerCopy.label(for: state) }
    private var isFailed: Bool { if case .failed = state { return true }; return false }

    var canInstall: Bool { !busy && (state == .notInstalled || isFailed) }
    var canStart: Bool { !busy && (state == .stopped || isFailed) }
    /// Never for `.externallyManaged`: we did not start that process and have no
    /// business killing it.
    var canStop: Bool { !busy && state.isRunning }
    var canRestart: Bool { !busy && state.isRunning }
    var canConnect: Bool { !busy && (state.isRunning || state == .externallyManaged) }
    var isBusyState: Bool { busy || state == .installing || state == .starting }
}

/// Fills `WelcomeSlots.localPanel`: status, the four lifecycle buttons, the
/// one-time password notice and a log disclosure. Renders inside the existing
/// "Run on this Mac" card, which keeps its own title and blurb.
struct LocalServerPanel: View {
    let model: LocalServerModel
    let app: AppModel

    @State private var showingLog = false

    private var panel: LocalServerPanelState {
        LocalServerPanelState(state: model.state, busy: model.busy)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            statusLine
            if let password = model.capturedPassword { passwordNotice(password) }
            controls
            logDisclosure
        }
        .task { await model.refresh() }
        .accessibilityIdentifier("welcome-local-panel")
        .accessibilityElement(children: .contain)
    }

    private var statusLine: some View {
        HStack(spacing: 6) {
            if panel.isBusyState {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol).foregroundStyle(tint)
            }
            Text(verbatim: panel.statusText)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityIdentifier("local-status")
    }

    private var symbol: String {
        switch model.state {
        case .running, .externallyManaged: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        default: "circle"
        }
    }

    private var tint: Color {
        switch model.state {
        case .running, .externallyManaged: .green
        case .failed: .orange
        default: .secondary
        }
    }

    /// Shown once, never persisted (D4). The body names the way back —
    /// SHEPHERD_PASSWORD in ~/.shepherd/env — so dismissing it is not a dead end.
    private func passwordNotice(_ password: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: L.t("native_local_password_title")).font(.callout.weight(.semibold))
            Text(verbatim: L.t("native_local_password_body"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Text(verbatim: password)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                Button(L.t("native_local_password_copy")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(password, forType: .string)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("local-password-notice")
        .accessibilityElement(children: .contain)
    }

    private var controls: some View {
        HStack(spacing: 8) {
            if panel.canInstall {
                Button(L.t("native_local_install")) { Task { await model.install() } }
                    .accessibilityIdentifier("local-install")
            }
            if panel.canStart {
                Button(L.t("native_local_start")) { Task { await model.start() } }
                    .accessibilityIdentifier("local-start")
            }
            if panel.canStop {
                Button(L.t("native_local_stop")) { Task { await model.stop() } }
                    .accessibilityIdentifier("local-stop")
            }
            if panel.canRestart {
                Button(L.t("native_local_restart")) { Task { await model.restart() } }
                    .accessibilityIdentifier("local-restart")
            }
            Spacer(minLength: 8)
            Button(L.t("native_local_connect")) { model.connect(app) }
                .buttonStyle(.borderedProminent)
                .disabled(!panel.canConnect)
                .accessibilityIdentifier("local-connect")
        }
    }

    private var logDisclosure: some View {
        DisclosureGroup(
            isExpanded: $showingLog,
            content: {
                ScrollView {
                    Text(verbatim: model.logLines.joined(separator: "\n"))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 160)
                .accessibilityIdentifier("local-log")
            },
            label: {
                Text(verbatim: showingLog ? L.t("native_local_log_hide") : L.t("native_local_log_show"))
                    .font(.caption)
            })
    }
}
```

- [ ] **Step 4: Run to verify it passes** — `./native/scripts/test-app.sh -only-testing:ShepherdTests`. Expected: PASS, the whole app unit bundle including `LocalServerModelTests` (6) and `LocalServerPanelStateTests` (7).

- [ ] **Step 5: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/LocalServer/LocalServerPanel.swift \
        native/Apps/ShepherdMac/Tests/LocalServerPanelTests.swift
git commit -m "feat(mac): welcome panel for installing, starting and stopping the local server"
```

---

### Task 8: Verification, live check and PR

**Files:** none created.

- [ ] **Step 1: Run every gate**

```bash
swift test --package-path native --filter LocalServer
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh
bun run check:strings
(cd ui && bun run check:i18n)
```
Expected, in order: kit suites pass; the app unit bundle passes; `Built: …/Release/Shepherd.app`; `Localizable.xcstrings is up to date (… keys).`; the i18n check passing.

- [ ] **Step 2: Prove the ownership rule was kept** — `git diff --name-only origin/main...HEAD | sort`
  Expected: exactly the 20 paths in "File ownership" (6 kit sources, 5 kit tests, 3 app sources, 2 app tests, `gen-strings.ts`, `Localizable.xcstrings`, `ui/messages/en.json`, `ui/messages/de.json`) and nothing else. If `AppModel.swift`, `WelcomeView.swift`, `MainWindow.swift`, `ShepherdApp.swift`, `project.yml`, `Package.swift` or `contracts/openapi.yaml` appears — **revert that file** and report it.

- [ ] **Step 3: Prove no secret can reach os.Logger**

```bash
git grep -n "capturedPassword\|pendingPassword" -- native/ | grep -iE "Logger|Log\.(app|ui|connect)" \
  || echo "no password reaches os.Logger"
```
Expected: `no password reaches os.Logger`.

- [ ] **Step 4: Live check on the operator's Mac — detection only.** **Do not install, do not start a server, do not touch `~/.shepherd`** unless the operator explicitly asks. `LocalServerFeature.install()` is not wired into `ShepherdApp.init()` yet (S0-int's one line), so verify instead that the three facts `refresh()` derives match reality:

```bash
ls -d ~/.shepherd/app 2>/dev/null && echo "checkout present" || echo "no checkout — panel will offer Install"
command -v bun || ls -l ~/.bun/bin/bun /opt/homebrew/bin/bun 2>/dev/null
curl -fsS --max-time 2 http://127.0.0.1:7330/api/health || echo "nothing listening on 7330"
open native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app
```
Expected: the three probes report checkout present/absent, bun found/absent, port busy/free; the app launches with the Welcome screen unchanged (the slot is not wired yet). Record the three facts in the PR body as the predicted panel state.

- [ ] **Step 5: Ask the integration lane for the one-line wiring.** Post to the orchestrator, verbatim:

> S5 is ready to merge. It needs exactly one integration line, on S0-int's own branch:
> `LocalServerFeature.install()` in `ShepherdApp.init()`. No `project.yml` change is needed —
> the target is already unsandboxed, and the hardened runtime does not restrict spawning
> children. After that line lands, the live check is: launch the app with no `~/.shepherd/app`
> present and confirm the local card offers **Install**.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/native-local-server
gh pr create --title "feat(mac): local server supervisor for shepherd for mac" --body-file - <<'EOF'
## What

Stream S5: Shepherd for Mac can detect, install, start, supervise and stop the operator's own
Shepherd server (`~/.shepherd/app`) as a child process, and sign in to it from Welcome.

- **Kit** (`Sources/ShepherdKit/LocalServer/`, all `#if os(macOS)`): `LocalServerEnvironment`
  (checkout detection by `package.json` name; bun on PATH / `~/.bun/bin` / Homebrew;
  `~/.shepherd/env` parsing), `LogRing` (bounded + redacting), `BootLineScanner`,
  `LocalServerSupervisor` (spawns `bun run src/index.ts`, health poll, backoff 1/2/4 s, max 3
  restarts per 5 min, `nonisolated terminateNow()` for quit), `LocalHealthCheck`, `InstallerRun`
  (`/bin/bash deploy/install.sh` with `SHEPHERD_NO_SERVICE=1`).
- **App** (`Apps/ShepherdMac/Sources/LocalServer/`): `LocalServerModel`, the Welcome local panel,
  `LocalServerFeature.install()`.

No contract change: S5 adds no routes.

## Security

The server prints a generated operator password once at boot when none is configured. It is
captured from stdout, **redacted from the log ring** (past and future lines), held in memory only,
offered once for sign-in with a copy button, then dropped. Never persisted, never logged, never
committed. The panel names the alternative: `SHEPHERD_PASSWORD` in `~/.shepherd/env`.

## Integration handoff

One line for S0-int: `LocalServerFeature.install()` in `ShepherdApp.init()`. No `project.yml`
change needed.

## Verification

`swift test --package-path native --filter LocalServer` · `./native/scripts/test-app.sh
-only-testing:ShepherdTests` · `./native/scripts/build-app.sh` · `bun run check:strings`.

No real install and no real server run in any test: process supervision is exercised against
`/bin/sh` scripts, health against a `URLProtocol` stub, backoff against an injectable clock.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```
Expected: the PR URL, and CI starting.

---

## Self-review

**Spec coverage.** Detection → Task 1 (`isShepherdCheckout`, `locateBun`) + Task 6 (`probeExternal`, reusing `LocalServerProbe`). Install/update → Task 5 + `LocalServerModel.install()`. Supervise → Tasks 3–4: `Process` with cwd `~/.shepherd/app`, env from `~/.shepherd/env`, stdout/stderr into a ring buffer, health poll, restart-on-crash with backoff, max 3 in 5 min then stop, quit-time stop via `NSApplication.willTerminateNotification` inside `LocalServerFeature`, published status enum. Password bootstrap → Task 2 (`generatedPassword`), Task 3 (capture + redact), Tasks 6–7 (offered once, copy button, trade-off in D4 and in `native_local_password_body`). Welcome panel → Task 7: status line, Install/Start/Stop/Restart, log disclosure, Connect into `beginLocalLogin()`. Tests → fake `/bin/sh` script, `URLProtocol` stub, injectable `TestClock`, log-capture assertions; no real install anywhere. Live check → Task 8 Step 4, detection only.

**Placeholders.** None. Every code step carries the whole file; every command carries expected output. One deliberate forward reference: `LocalServerPanel` (written in Task 7, called in Task 6 — Step 6 says what to do about it).

**Type consistency.** `LocalServerFailure`'s five cases are identical in Task 1 (definition), Task 3 (`.bunMissing`, `.exited`, `.crashLoop`), Task 5 (`.installFailed`) and Task 6 (`LocalServerCopy.message`). `LocalServerState`'s seven cases are identical in Task 3 and Tasks 6–7, and all eleven concrete values are covered by `everyStateHasACatalogSentence`. `SupervisorClock.now` is `async` in the protocol, in `SystemSupervisorClock`, in `TestClock` and at its one call site (`await clock.now`). `LogRing.placeholder` is referenced by name in both test files. `makeTempHome`/`makeExecutable` are defined once (Task 1) and reused by Task 5. `LocalServerModel.canInstall/canStart/canStop/canRestart` and `LocalServerPanelState`'s versions use the same rules, and the panel reads only the latter. The 21 keys in `KEYS_LOCALSERVER` are exactly those used by `LocalServerCopy` and `LocalServerPanel`, and exactly those added to `en.json` and `de.json`.
