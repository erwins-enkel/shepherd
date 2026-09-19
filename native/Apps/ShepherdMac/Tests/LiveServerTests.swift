import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// The two environment variables that arm `LiveServerTests`. Outside the
/// main-actor suite because `@Test(.enabled(if:))` evaluates its trait from a
/// `Sendable` closure with no actor to hop to.
enum LiveServerEnvironment {
    static var baseURL: String? { value("SHEPHERD_LIVE_BASE_URL") }
    static var password: String? { value("SHEPHERD_LIVE_PASSWORD") }
    /// Both set and non-empty. An unset pair skips the suite; CI never sets them.
    static var configured: Bool { baseURL != nil && password != nil }

    private static func value(_ name: String) -> String? {
        guard let raw = ProcessInfo.processInfo.environment[name], !raw.isEmpty else { return nil }
        return raw
    }
}

/// End-to-end smoke test against a *real* Shepherd server.
///
/// Gated on two environment variables so CI — which has no server — never runs
/// it: `SHEPHERD_LIVE_BASE_URL` (e.g. `http://127.0.0.1:7330`) and
/// `SHEPHERD_LIVE_PASSWORD` (the operator password). With either unset the
/// suite is skipped wholesale by the `.enabled(if:)` trait below.
///
/// What it covers that no fake can: `AppModel.signIn` → `ProfileSetup.login`
/// → Keychain-free `InMemoryCredentialStore` → `SessionStore.start()` over a
/// real socket, and the *restore* path a relaunch takes — a second `AppModel`
/// built on the same defaults suite and the same credential store, reconnected
/// by `restoreActiveProfile()` alone.
///
/// Everything is isolated: its own `UserDefaults(suiteName:)` (removed again on
/// the way out), never `run.shepherd.mac`, and an in-memory credential store, never
/// the login Keychain.
@MainActor
struct LiveServerTests {
    /// Polls `condition` on the main actor until it holds or `seconds` elapse.
    /// Real network work happens off this actor, so this sleeps rather than
    /// yields — a tight `Task.yield()` loop would starve nothing but would burn
    /// a core for the whole budget.
    private func wait(
        seconds: Double, until condition: @MainActor () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }

    private func makeModel(
        defaults: UserDefaults, credentials: any CredentialStore
    ) -> AppModel {
        AppModel(defaults: defaults, credentials: credentials)
    }

    @Test(
        "a real sign-in reaches .live, and a relaunch restores it",
        .enabled(if: LiveServerEnvironment.configured))
    func liveSignInAndRestore() async throws {
        let base = try #require(LiveServerEnvironment.baseURL)
        let password = try #require(LiveServerEnvironment.password)
        let suite = "run.shepherd.mac.livetest.\(UUID().uuidString)"
        let credentials = InMemoryCredentialStore()
        // One instance for both models and for the cleanup at the end: a
        // `UserDefaults` object caches what it wrote, so a domain removed
        // through a *different* instance is written straight back when this
        // one flushes on the way out of the process.
        let defaults = UserDefaults(suiteName: suite)!

        // --- sign-in path -------------------------------------------------
        let model = makeModel(defaults: defaults, credentials: credentials)
        let profile = try model.addRemoteProfile(name: "Live", address: base)
        try await model.signIn(profile: profile, password: password)

        let signedIn = await wait(seconds: 10) { model.store?.connection == .live }
        #expect(
            signedIn,
            """
            sign-in did not reach .live within 10s; \
            connection=\(String(describing: model.store?.connection)) \
            lastError=\(String(describing: model.store?.lastError)) \
            sheet=\(String(describing: model.sheet))
            """)
        // The scratch server may legitimately have no sessions; what matters is
        // that the bootstrap ran, which `.live` and a non-nil settings prove.
        #expect(model.store?.settings != nil)
        #expect(model.activeProfile?.id == profile.id)

        // --- restore path -------------------------------------------------
        // A second model over the *same* defaults suite and the same credential
        // store is exactly what a relaunch is: `init` restores `activeProfile`
        // from UserDefaults and starts nothing, and `restoreActiveProfile()` is
        // the only thing that puts a store behind it.
        let relaunched = makeModel(defaults: defaults, credentials: credentials)
        #expect(relaunched.activeProfile?.id == profile.id)
        #expect(relaunched.store == nil)
        await relaunched.restoreActiveProfile()

        let restored = await wait(seconds: 10) { relaunched.store?.connection == .live }
        #expect(
            restored,
            """
            restoreActiveProfile() did not reach .live within 10s; \
            connection=\(String(describing: relaunched.store?.connection)) \
            lastError=\(String(describing: relaunched.store?.lastError)) \
            sheet=\(String(describing: relaunched.sheet))
            """)
        #expect(relaunched.store?.settings != nil)

        relaunched.teardown()
        model.teardown()
        try? await ProfileSetup.logout(profile: profile, credentials: credentials)

        // After the teardowns, not in a `defer`: both of them `persist()`, so a
        // domain removed earlier would simply be written again on the way out.
        defaults.removePersistentDomain(forName: suite)
        UserDefaults.standard.removeSuite(named: suite)
    }
}
