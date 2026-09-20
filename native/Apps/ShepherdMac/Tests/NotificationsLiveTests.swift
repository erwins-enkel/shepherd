import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// Arms `NotificationsLiveTests`.
///
/// Outside the main-actor suite because `@Test(.enabled(if:))` evaluates its trait from a
/// `Sendable` closure with no actor to hop to — the same reason `LiveServerEnvironment` sits at
/// file scope in `LiveServerTests.swift`.
///
/// A base URL plus *either* credential is enough: `SHEPHERD_LIVE_TOKEN` skips the login round
/// trip, and `SHEPHERD_LIVE_PASSWORD` makes the suite mint its own token and give it back again.
/// Gating on the token alone — as an earlier draft did — would let a password-only operator run
/// the suite green without either test ever executing.
private enum NotificationsLiveGate {
    static var armed: Bool {
        LiveServerEnvironment.baseURL != nil
            && (LiveServerEnvironment.token != nil || LiveServerEnvironment.password != nil)
    }
}

/// The notification model, checked against a *real* Shepherd server.
///
/// Skipped unless the environment arms it, so CI — which has no tailnet — never runs it. It posts
/// nothing to macOS: the model is built on `FakeNotificationCenter`, so `requestAuthorization`
/// never reaches `UNUserNotificationCenter` and no permission alert can appear. The only thing
/// that touches the real server is the read-only bootstrap (and, with a password, the token mint
/// and its matching revoke). Nothing here creates, mutates, interrupts or deletes a session.
///
/// It is also Keychain-free and `UserDefaults.standard`-free: an `InMemoryCredentialStore` holds
/// the token and the settings live in a private suite that is removed again on every exit path.
@MainActor
struct NotificationsLiveTests {
    /// What the body of a live test is handed. The model is built on the seam initializer, so it
    /// has no store behind it: `setWindowFocused` therefore forwards *no* presence frame to the
    /// server, which is what keeps this suite strictly read-only.
    private struct Live {
        let store: SessionStore
        let center: FakeNotificationCenter
        let model: NotificationsModel
    }

    /// Signs in (or adopts a pre-minted token), bootstraps, runs `body`, and always gives back
    /// whatever it took: a token this suite minted is revoked through `ProfileSetup.logout` on
    /// every exit path, including a failing assertion, and the private defaults suite is removed.
    private func withLive(
        _ body: @MainActor (Live) async throws -> Void
    ) async throws {
        let raw = try #require(LiveServerEnvironment.baseURL, "SHEPHERD_LIVE_BASE_URL is unset")
        // Through the app's own normaliser rather than `URL(string:)`: a trailing slash on the
        // raw value makes every kit request path `//api/…`, which the server answers 401.
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        let profile = ServerProfile(
            name: "live-notify", baseURL: url, mode: .remote,
            credentialKey: "live-notify.\(UUID().uuidString)")
        let suite = "run.shepherd.mac.notifylive.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))

        // Only ever true for a token this run minted. The operator's own saved profile and token
        // are never read, never written and never revoked.
        var minted = false
        func giveBack() async {
            if minted {
                try? await ProfileSetup.logout(profile: profile, credentials: credentials)
            }
            // Through the same instance that wrote it: a `UserDefaults` object caches its own
            // writes, so a domain removed through a different instance comes straight back.
            defaults.removePersistentDomain(forName: suite)
            UserDefaults.standard.removeSuite(named: suite)
        }

        do {
            if let token = LiveServerEnvironment.token {
                try credentials.save(
                    StoredCredential(token: token, tokenId: "live-notify"),
                    for: profile.credentialKey)
            } else {
                let password = try #require(
                    LiveServerEnvironment.password, "SHEPHERD_LIVE_PASSWORD is unset")
                // A name of its own, so a token this suite leaves behind after a crash is
                // obvious in the operator's token list and can never be mistaken for the Mac
                // app's real one. No sweep is requested, so nothing existing is revoked.
                try await ProfileSetup.login(
                    profile: profile, password: password, credentials: credentials,
                    tokenName: ProfileSetup.tokenName(prefix: "Shepherd UI test (", hostName: "notifications-\(UUID().uuidString)"))
                minted = true
            }

            // `bootstrap()` only — never `start()`. One read of sessions, settings and repos,
            // with no event loop and no reconnect behind it.
            let audit = ReadOnlyRequestAudit()
            defer { #expect(audit.counts.reads > 0); #expect(audit.counts.rejected == 0) }
            let store = try SessionStore(client: ShepherdClient(profile: profile, credentials: credentials, readOnlyAudit: audit))
            try await store.bootstrap()

            let center = FakeNotificationCenter()
            let model = NotificationsModel(
                center: center,
                settingsStore: NotificationSettingsStore(defaults: defaults),
                profileID: UUID(),
                now: { Int(Date().timeIntervalSince1970 * 1_000) },
                subjectFor: { [weak store] id in store?.session(id: id)?.name },
                select: { _ in })
            try await body(Live(store: store, center: center, model: model))
        } catch {
            await giveBack()
            throw error
        }
        await giveBack()
    }

    /// The Dock badge, derived from the herd that is actually out there. Proves the count rule
    /// against real `SessionStatus` values rather than fixtures — including the statuses this
    /// build has never seen, which a live server is the only source of.
    @Test(
        "the badge counts the live herd's attention sessions",
        .enabled(if: NotificationsLiveGate.armed))
    func theBadgeCountsTheLiveHerdsAttentionSessions() async throws {
        try await withLive { live in
            await live.model.setWindowFocused(false)
            await live.model.updateBadge(sessions: live.store.sessions)

            let expected = Set(
                live.store.sessions
                    .filter { $0.status.known != .archived }
                    .filter { $0.status.known == .blocked || $0.readyToMerge }
                    .map(\.id))
            #expect(live.center.badge == expected.count)
            #expect(!live.store.sessions.isEmpty, "the live server should have sessions")
        }
    }

    /// Copy and gate, exercised against a real session's name. The frame is synthesised locally
    /// and handed straight to `handle(_:)`; nothing is asked of the server to produce it, and
    /// nothing is posted to macOS, because `FakeNotificationCenter` is the only centre in play.
    @Test(
        "a real block frame would produce a real banner",
        .enabled(if: NotificationsLiveGate.armed))
    func aRealBlockFrameWouldProduceARealBanner() async throws {
        try await withLive { live in
            await live.model.setWindowFocused(false)
            // Authorization on the fake is granted, so this exercises the gate and the copy
            // without asking macOS for anything.
            await live.model.requestAuthorization()

            let session = try #require(
                live.store.sessions.first(where: { $0.status.known != .archived }),
                "the live server should have a non-archived session")
            let block = BlockReason(shape: .init(value1: .awaitingInput), options: [], tail: [])
            await live.model.handle(.sessionBlock(.init(id: session.id, block: block)))

            #expect(live.center.posted.count == 1)
            #expect(live.center.posted.first?.title.contains(session.name) == true)
            #expect(live.center.posted.first?.sessionID == session.id)
        }
    }
}
