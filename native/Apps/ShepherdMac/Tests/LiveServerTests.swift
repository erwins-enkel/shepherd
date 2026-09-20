import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// The environment variables that arm `LiveServerTests`. Outside the
/// main-actor suite because `@Test(.enabled(if:))` evaluates its trait from a
/// `Sendable` closure with no actor to hop to.
enum LiveServerEnvironment {
    static var baseURL: String? { value("SHEPHERD_LIVE_BASE_URL") }
    static var password: String? { value("SHEPHERD_LIVE_PASSWORD") }
    /// A pre-minted token, for the smoke test that skips the login round-trip
    /// entirely — `liveSignInAndRestore` still needs a real password.
    static var token: String? { value("SHEPHERD_LIVE_TOKEN") }
    /// Both set and non-empty. An unset pair skips the suite; CI never sets them.
    static var configured: Bool { baseURL != nil && password != nil }
    /// `baseURL` plus a pre-minted token: the gate for
    /// `theSessionListRendersAgainstTheLiveServer`, which never logs in.
    static var tokenConfigured: Bool { baseURL != nil && token != nil }

    /// `xcodebuild` does not reliably forward the invoking shell's environment
    /// into a hosted unit-test bundle; the documented way in is the
    /// `TEST_RUNNER_` prefix, which the runner strips before the process sees
    /// the variable. Reading both spellings means nobody has to remember which
    /// one this toolchain honours.
    private static func value(_ name: String) -> String? {
        let env = ProcessInfo.processInfo.environment
        for candidate in [name, "TEST_RUNNER_\(name)"] {
            if let raw = env[candidate] {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
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

        var model: AppModel?
        var relaunched: AppModel?
        var profile: ServerProfile?
        // Runs even when `signIn`/`#require` below throws: a defaults suite or
        // a live server token left behind by a failed run is exactly the kind
        // of leak this test exists to avoid causing. `await` cannot appear
        // directly in a `defer` body, so the two teardowns and the domain
        // removal — all synchronous — go here; the server-side revoke, which
        // needs `await`, is handled by `revoke()` below on every exit path.
        defer {
            relaunched?.teardown()
            model?.teardown()
            // Not conditioned on success: both teardowns above call `persist()`,
            // so a domain removed earlier would simply be written again on the
            // way out.
            defaults.removePersistentDomain(forName: suite)
            UserDefaults.standard.removeSuite(named: suite)
        }
        func revoke() async {
            guard let profile else { return }
            try? await ProfileSetup.logout(profile: profile, credentials: credentials)
        }

        do {
            // --- sign-in path -----------------------------------------------
            let signedInModel = makeModel(defaults: defaults, credentials: credentials)
            model = signedInModel
            let signedInProfile = try signedInModel.addRemoteProfile(name: "Live", address: base)
            profile = signedInProfile
            try await signedInModel.signIn(profile: signedInProfile, password: password)

            let signedIn = await wait(seconds: 10) { signedInModel.store?.connection == .live }
            #expect(
                signedIn,
                """
                sign-in did not reach .live within 10s; \
                connection=\(String(describing: signedInModel.store?.connection)) \
                lastError=\(String(describing: signedInModel.store?.lastError)) \
                sheet=\(String(describing: signedInModel.sheet))
                """)
            // The scratch server may legitimately have no sessions; what matters
            // is that the bootstrap ran, which `.live` and a non-nil settings
            // prove.
            #expect(signedInModel.store?.settings != nil)
            #expect(signedInModel.activeProfile?.id == signedInProfile.id)

            // --- restore path -------------------------------------------------
            // A second model over the *same* defaults suite and the same
            // credential store is exactly what a relaunch is: `init` restores
            // `activeProfile` from UserDefaults and starts nothing, and
            // `restoreActiveProfile()` is the only thing that puts a store
            // behind it.
            let relaunchedModel = makeModel(defaults: defaults, credentials: credentials)
            relaunched = relaunchedModel
            #expect(relaunchedModel.activeProfile?.id == signedInProfile.id)
            #expect(relaunchedModel.store == nil)
            await relaunchedModel.restoreActiveProfile()

            let restored = await wait(seconds: 10) { relaunchedModel.store?.connection == .live }
            #expect(
                restored,
                """
                restoreActiveProfile() did not reach .live within 10s; \
                connection=\(String(describing: relaunchedModel.store?.connection)) \
                lastError=\(String(describing: relaunchedModel.store?.lastError)) \
                sheet=\(String(describing: relaunchedModel.sheet))
                """)
            #expect(relaunchedModel.store?.settings != nil)
        } catch {
            await revoke()
            throw error
        }
        await revoke()
    }

    /// The other half of the live smoke coverage: a pre-minted token dropped
    /// straight into an in-memory credential store, with no `ProfileSetup.login`
    /// round-trip at all. Gated separately from `liveSignInAndRestore` so an
    /// operator who only has a token — not the operator password — can still
    /// exercise the session list against a real server.
    ///
    /// This never mints anything, so it never revokes anything either: the
    /// token is the caller's, and it is never written to the Keychain, only to
    /// an `InMemoryCredentialStore` that goes away with the test.
    @Test(
        "the session list renders using a pre-minted token, with no login round-trip",
        .enabled(if: LiveServerEnvironment.tokenConfigured))
    func theSessionListRendersAgainstTheLiveServer() async throws {
        let address = try #require(LiveServerEnvironment.baseURL)
        let token = try #require(LiveServerEnvironment.token)

        let suite = "run.shepherd.mac.livetest.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let credentials = InMemoryCredentialStore()
        let model = makeModel(defaults: defaults, credentials: credentials)
        defer {
            model.teardown()
            defaults.removePersistentDomain(forName: suite)
            UserDefaults.standard.removeSuite(named: suite)
        }

        let profile = try model.addRemoteProfile(name: "live", address: address)
        try credentials.save(
            StoredCredential(token: token, tokenId: "live-smoke"), for: profile.credentialKey)

        await model.activate(profile)
        let store = try #require(model.store, "activation produced no store")

        // start() bootstraps on its own task, so poll rather than assume. 30 s:
        // a cold tailnet hop plus a bootstrap is slow, and a flake here would
        // be read as a broken app.
        let live = await wait(seconds: 30) { store.connection == .live }
        #expect(
            live,
            "connection is \(store.connection); lastError \(String(describing: store.lastError))")
        #expect(store.settings != nil, "the bootstrap delivered no settings")
        // "The list renders": every row the sidebar would draw carries the two
        // fields it draws with. A live server may legitimately hold zero
        // sessions, so emptiness is reported, not asserted.
        #expect(store.sessions.allSatisfy { !$0.id.isEmpty && !$0.desig.isEmpty })
        // The host is redacted. `address` is the operator's own server — a tailnet name or a
        // LAN address — and this line goes to a test log that is attached to CI runs and pasted
        // into PRs. The count is the evidence; which machine served it is already known to
        // whoever set `SHEPHERD_LIVE_BASE_URL`, and to nobody else.
        let scheme = URL(string: address)?.scheme ?? "unknown"
        print("live smoke: \(store.sessions.count) session(s) from a \(scheme) server")
    }
}
