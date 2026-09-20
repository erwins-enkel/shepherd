import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// The environment gate for `SidebarLiveTests`. Outside the main-actor suite, like
/// `LiveServerEnvironment` itself, because `@Test(.enabled(if:))` evaluates its trait from a
/// `Sendable` closure with no actor to hop to.
private enum SidebarLiveGate {
    /// Armed by either pair of variables. Spelled out once so both tests carry the same trait.
    static var armed: Bool {
        LiveServerEnvironment.configured || LiveServerEnvironment.tokenConfigured
    }
}

/// The sidebar's half of the live smoke coverage: the four snapshot reads this stream added, and
/// the groups the sidebar builds out of a real herd.
///
/// Gated exactly like `LiveServerTests` — `LiveServerEnvironment` reads both the plain and the
/// `TEST_RUNNER_`-prefixed spellings — so CI, which has no tailnet and no server, skips the suite
/// wholesale. Either arming pair works: `SHEPHERD_LIVE_BASE_URL` + `SHEPHERD_LIVE_PASSWORD` signs
/// in for real and revokes the token it minted on the way out, or `SHEPHERD_LIVE_BASE_URL` +
/// `SHEPHERD_LIVE_TOKEN` drops a pre-minted token straight into an in-memory credential store and
/// revokes nothing, because it minted nothing.
///
/// Nothing here touches the login Keychain (`InMemoryCredentialStore` only) or the
/// `run.shepherd.mac` defaults domain, so an operator's saved profiles and tokens are untouched.
@MainActor
struct SidebarLiveTests {
    /// A store wired to the live server, plus the teardown that gives back whatever this test
    /// minted. Every exit path runs `done()` — a token left behind by a failed run is exactly the
    /// kind of leak a live test must not cause.
    private func liveStore() async throws -> (store: SessionStore, done: () async -> Void) {
        let raw = try #require(LiveServerEnvironment.baseURL)
        // Through the app's own parser, not `URL(string:)`: it strips the path, so a base URL
        // written with a trailing slash cannot turn every request into `//api/…` — a path the
        // server does not treat as public and answers with 401, sign-in included.
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        let profile = try ServerProfile(
            name: "live", baseURL: url, mode: .remote, credentialKey: "live"
        ).validated()

        var minted = false
        if let token = LiveServerEnvironment.token {
            try credentials.save(
                StoredCredential(token: token, tokenId: "live-sidebar"), for: profile.credentialKey)
        } else {
            let password = try #require(LiveServerEnvironment.password)
            try await ProfileSetup.login(
                profile: profile, password: password, credentials: credentials)
            minted = true
        }

        let store = try SessionStore(profile: profile, credentials: credentials)
        return (
            store,
            {
                store.stop()
                // Only ever the token this test minted: a pre-minted one belongs to the caller, and
                // no sweep by name runs here, so no other token on the server is touched.
                if minted {
                    try? await ProfileSetup.logout(profile: profile, credentials: credentials)
                }
            }
        )
    }

    @Test("the four sidebar reads decode against the real server", .enabled(if: SidebarLiveGate.armed))
    func theFourSidebarReadsDecodeAgainstTheRealServer() async throws {
        let live = try await liveStore()
        do {
            let client = live.store.client
            _ = try await client.workingBlocked()
            _ = try await client.holds()
            _ = try await client.blocks()
            let usage = try await client.usage()
            // Reaching here already proved the decode — every field above is required, so a
            // truncated body would have thrown — and the window, when the server has one, has to
            // carry a percentage the meter can draw.
            if let window = usage.limits.session5h {
                #expect(window.pct >= 0 && window.pct <= 100)
            }
            #expect(usage.limits.subscriptionOnly == true || usage.limits.subscriptionOnly == false)
        } catch {
            await live.done()
            throw error
        }
        await live.done()
    }

    @Test("the sidebar renders groups for the live herd", .enabled(if: SidebarLiveGate.armed))
    func theSidebarRendersGroupsForTheLiveHerd() async throws {
        let live = try await liveStore()
        let store = live.store
        do {
            try await store.bootstrap()
            let model = SidebarModel(
                reads: .live(store.client), now: { Int(Date().timeIntervalSince1970 * 1_000) })
            await model.refresh()
            model.install(sessions: store.sessions)

            let active = store.sessions.filter { $0.status.known != .archived }
            #expect(!store.sessions.isEmpty, "the live server should have sessions")
            #expect(!model.groups.isEmpty)
            #expect(model.tallies.total == active.count)
            print("live sidebar: \(model.groups.count) group(s) over \(active.count) session(s)")
        } catch {
            await live.done()
            throw error
        }
        await live.done()
    }
}
