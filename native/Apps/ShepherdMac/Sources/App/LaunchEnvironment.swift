import Foundation
import ShepherdKit

/// Whether this process was launched normally or *isolated* from the operator's
/// own state, and what an isolated launch should do once it is up.
///
/// An automated launch — an XCUITest, or the unit bundle's host app — starts the
/// real `run.shepherd.mac` bundle, and by default that means the operator's
/// saved profiles out of `UserDefaults.standard` and their access token out of
/// the login Keychain. The Keychain read is the blocker: `SecItemCopyMatching`
/// against the legacy keychain waits on a SecurityAgent dialog ("Shepherd möchte
/// deine vertraulichen Informationen verwenden…") that nobody is there to
/// answer, so every unattended run stalls behind it. Isolated mode swaps both
/// stores for throwaway ones — a private `UserDefaults` suite and an
/// `InMemoryCredentialStore` — so an automated launch reads and writes nothing
/// of the operator's.
///
/// Parsing only, and side-effect free: `IsolatedLaunch` below does the work, and
/// `LaunchEnvironmentTests` covers every spelling accepted here. Opt-in — with
/// neither switch set the app behaves exactly as it always has.
enum LaunchEnvironment {
    /// `app.launchArguments += ["-ShepherdIsolated", "1"]`.
    static let isolatedFlag = "ShepherdIsolated"
    /// `SHEPHERD_ISOLATED=1`, which `native/scripts/test-app.sh` exports.
    static let isolatedVariable = "SHEPHERD_ISOLATED"
    /// `app.launchArguments += ["-ShepherdRevokeOnExit", "1"]`: revoke the token
    /// the live seed minted when the app quits, instead of leaving it on the
    /// server until an operator cleans it up by hand.
    static let revokeOnExitFlag = "ShepherdRevokeOnExit"
    static let revokeOnExitVariable = "SHEPHERD_REVOKE_ON_EXIT"
    /// The live server an isolated launch signs in to, if both are set.
    static let liveBaseURLVariable = "SHEPHERD_LIVE_BASE_URL"
    static let livePasswordVariable = "SHEPHERD_LIVE_PASSWORD"

    /// A real server for an isolated launch to sign in to before showing its
    /// window, so a UI test can assert against live data.
    struct LiveSeed: Equatable, Sendable {
        let baseURL: String
        /// Read from the environment, used for the one `ProfileSetup.login`
        /// call, and never persisted, logged or written anywhere.
        let password: String
    }

    struct Configuration: Equatable, Sendable {
        var isIsolated = false
        /// Only ever non-nil for an isolated launch: signing in automatically
        /// is safe precisely because the minted token lands in memory.
        var live: LiveSeed?
        var revokesOnExit = false

        /// The launch log line. Names the mode, never a secret and never an
        /// address.
        var logDescription: String {
            guard isIsolated else { return "normal launch" }
            var parts = ["isolated launch (private defaults suite, in-memory credentials)"]
            if live != nil { parts.append("live server seed armed") }
            if revokesOnExit { parts.append("revoking the minted token on quit") }
            return parts.joined(separator: ", ")
        }
    }

    static func configuration(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Configuration {
        var configuration = Configuration()
        configuration.isIsolated = isOn(
            flag: isolatedFlag, variable: isolatedVariable,
            arguments: arguments, environment: environment)
        // Everything below is a *consequence* of isolation. A normal launch
        // never seeds and never revokes, whatever is in the environment: those
        // paths mint and delete real tokens, and the one on the operator's
        // machine is not this mode's to touch.
        guard configuration.isIsolated else { return configuration }

        configuration.revokesOnExit = isOn(
            flag: revokeOnExitFlag, variable: revokeOnExitVariable,
            arguments: arguments, environment: environment)
        if let baseURL = value(of: liveBaseURLVariable, in: environment),
            let password = value(of: livePasswordVariable, in: environment)
        {
            configuration.live = LiveSeed(baseURL: baseURL, password: password)
        }
        return configuration
    }

    /// True when the environment variable says so, or when the launch argument
    /// does. The argument accepts `-Flag 1`, `-Flag=1` and a bare `-Flag`; an
    /// explicit `-Flag 0` is off, which is how a caller overrides an inherited
    /// variable it cannot unset.
    private static func isOn(
        flag: String, variable: String, arguments: [String], environment: [String: String]
    ) -> Bool {
        let token = "-\(flag)"
        for (index, argument) in arguments.enumerated() {
            if argument.hasPrefix("\(token)=") {
                return isTruthy(String(argument.dropFirst(token.count + 1)))
            }
            guard argument == token else { continue }
            guard index + 1 < arguments.count else { return true }
            let next = arguments[index + 1]
            // `-Flag -Other` is a bare flag, not a flag with the value "-Other".
            return next.hasPrefix("-") ? true : isTruthy(next)
        }
        if let raw = value(of: variable, in: environment) { return isTruthy(raw) }
        return false
    }

    /// A non-empty environment value, in either the plain spelling or the
    /// `TEST_RUNNER_`-prefixed one `xcodebuild` uses to reach a hosted test
    /// process (the runner strips the prefix before the process sees it, but
    /// not on every toolchain — reading both means nobody has to remember
    /// which). Mirrors `LiveServerEnvironment` in the unit bundle.
    private static func value(of name: String, in environment: [String: String]) -> String? {
        for candidate in [name, "TEST_RUNNER_\(name)"] {
            guard let raw = environment[candidate] else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    private static func isTruthy(_ raw: String) -> Bool {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on": true
        default: false
        }
    }
}

/// The throwaway storage an isolated launch runs on, the optional live sign-in
/// that lets a UI test see a real session list, and the cleanup that gives both
/// back when the app quits.
///
/// Built once, in `ShepherdApp.init()`, and only when `LaunchEnvironment` says
/// the launch is isolated. It owns its own wiring — the terminate observer and
/// the seeding task — rather than leaving it to modifiers on the scene: an
/// `.onReceive` of `NSApplication.willTerminateNotification` in the `App`'s body
/// cost the app its window entirely under XCUITest (the accessibility tree came
/// up with a menu bar and nothing under it, and every welcome assertion timed
/// out). Nothing here names `NSApplication`.
@MainActor
final class IsolatedLaunch {
    /// The name the seeded profile is listed under. Not operator-facing copy —
    /// no isolated launch outlives its test — so it is not in the catalogs.
    static let liveProfileName = "Live"

    /// `NSApplication.willTerminateNotification`, spelled out so that observing
    /// it touches no AppKit type. Same notification, none of the cost above.
    private static let willTerminate = Notification.Name("NSApplicationWillTerminateNotification")

    private let configuration: LaunchEnvironment.Configuration
    /// The private suite, or `nil` when one could not be opened.
    private let suiteName: String?
    private let defaults: UserDefaults
    /// Never `KeychainCredentialStore`. This is the whole point of the mode.
    private let credentials: any CredentialStore = InMemoryCredentialStore()
    /// The model this launch built, for the quit-time revoke. Strong, and so is
    /// the observer's capture of `self`: this object is meant to live exactly as
    /// long as the process does, which is why `ShepherdApp` stores it.
    private var model: AppModel?
    private var terminationObserver: (any NSObjectProtocol)?

    init(configuration: LaunchEnvironment.Configuration) {
        self.configuration = configuration
        let name =
            "run.shepherd.mac.isolated."
            + "\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString)"
        if let suite = UserDefaults(suiteName: name) {
            suiteName = name
            defaults = suite
        } else {
            // Not reachable with a name like the one above — it is neither the
            // bundle identifier nor a reserved domain — but a force-unwrap here
            // would crash the app rather than fail a test. Even this path keeps
            // the Keychain out of it, which is the part that blocks an
            // unattended run.
            Log.app.error("could not open a private defaults suite for the isolated launch")
            suiteName = nil
            defaults = .standard
        }
    }

    /// An `AppModel` on the throwaway suite and the in-memory credential store,
    /// with this launch's quit handler armed and its live seed, if any, started.
    ///
    /// The suite is empty, so `restoreActiveProfile()` finds no persisted
    /// profile and activates nothing: an isolated launch comes up on the welcome
    /// screen unless the live seed puts it somewhere else. The seed cannot race
    /// that restore into a double activation either — `activate(_:)` bumps the
    /// activation counter before its first suspension, and the restore backs off
    /// as soon as it has moved.
    func makeModel() -> AppModel {
        let model = AppModel(defaults: defaults, credentials: credentials)
        self.model = model
        terminationObserver = NotificationCenter.default.addObserver(
            forName: Self.willTerminate, object: nil, queue: nil
        ) { _ in
            // `queue: nil` runs this synchronously on the posting thread, and
            // AppKit posts this one on the main thread. Both matter: the app is
            // on its way out, and work hopped onto a later turn of the run loop
            // would never happen.
            MainActor.assumeIsolated { self.tearDown() }
        }
        if configuration.live != nil {
            Task { await self.seedLiveServer() }
        }
        return model
    }

    /// Signs in to the configured live server and activates it, so the app is on
    /// the main window with a real session list by the time a test looks.
    ///
    /// Goes through the app's own `signIn` — `ProfileSetup.login` mints a real
    /// token against a real server — and the token lands in the in-memory store,
    /// so nothing reaches the Keychain.
    private func seedLiveServer() async {
        guard let live = configuration.live, let model else { return }
        do {
            let profile = try model.addRemoteProfile(
                name: Self.liveProfileName, address: live.baseURL)
            try await model.signIn(profile: profile, password: live.password)
            Log.connect.info("the isolated launch signed in to the live server")
        } catch {
            Log.connect.error(
                """
                the isolated launch could not sign in to the live server: \
                \(String(describing: error), privacy: .public)
                """)
        }
    }

    /// Quit-time cleanup, best effort: revoke the token the live seed minted
    /// (only with `-ShepherdRevokeOnExit 1`), then drop the private suite.
    ///
    /// Synchronous, because nothing waits for async work once the terminate
    /// notification is out. The revoke therefore runs on a detached task that
    /// this call waits on under a deadline; no main-actor work happens inside it
    /// — `ProfileSetup.logout` is `nonisolated` — so the wait cannot deadlock
    /// against the thread it blocks, and the deadline bounds a server that never
    /// answers.
    private func tearDown() {
        if configuration.revokesOnExit, let profile = model?.activeProfile {
            let credentials = self.credentials
            let finished = DispatchSemaphore(value: 0)
            Task.detached {
                try? await ProfileSetup.logout(profile: profile, credentials: credentials)
                finished.signal()
            }
            if finished.wait(timeout: .now() + 5) == .timedOut {
                Log.connect.error("the isolated launch's token revocation did not finish in time")
            }
        }
        guard let suiteName else { return }
        defaults.removePersistentDomain(forName: suiteName)
        UserDefaults.standard.removeSuite(named: suiteName)
    }
}
