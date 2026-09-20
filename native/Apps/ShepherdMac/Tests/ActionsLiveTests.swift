import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// The environment gate for `ActionsLiveTests`. Outside the main-actor suite, like
/// `LiveServerEnvironment` itself, because `@Test(.enabled(if:))` evaluates its trait from a
/// `Sendable` closure with no actor to hop to.
private enum ActionsLiveGate {
    /// Armed by either pair of variables. Spelled out once so both tests carry the same trait.
    static var armed: Bool {
        LiveServerEnvironment.configured || LiveServerEnvironment.tokenConfigured
    }
}

/// The action bar's half of the live smoke coverage: the recap snapshot this stream added, and
/// the bar it derives for a real herd.
///
/// Gated exactly like `LiveServerTests` and `SidebarLiveTests` — `LiveServerEnvironment` reads
/// both the plain and the `TEST_RUNNER_`-prefixed spellings — so CI, which has no tailnet and no
/// server, skips the suite wholesale. Either arming pair works: `SHEPHERD_LIVE_BASE_URL` +
/// `SHEPHERD_LIVE_PASSWORD` signs in for real and revokes the token it minted on the way out, or
/// `SHEPHERD_LIVE_BASE_URL` + `SHEPHERD_LIVE_TOKEN` drops a pre-minted token straight into an
/// in-memory credential store and revokes nothing, because it minted nothing.
///
/// **Read-only.** It decodes `GET /api/recaps` and derives the bar's availability for real
/// sessions, and it issues *no* write command — a live relaunch would discard somebody's
/// worktree, a live rename would rewrite their branch, and a live ready-toggle would put
/// unfinished work in the merge train. Every destructive path is proven against the contract
/// stub (`test/contract/actions.test.ts`) and the fake client (`ShepherdClientActionsTests`)
/// instead.
///
/// Nothing here touches the login Keychain (`InMemoryCredentialStore` only) or the
/// `run.shepherd.mac` defaults domain, so an operator's saved profiles and tokens are untouched.
@MainActor
struct ActionsLiveTests {
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
                StoredCredential(token: token, tokenId: "live-actions"), for: profile.credentialKey)
        } else {
            let password = try #require(LiveServerEnvironment.password)
            // Under the UI-test prefix, never `Shepherd for Mac (…)`: a token this suite mints
            // must be tellable apart from — and never collide with — an operator's real one.
            // No sweep: `sweepPriorTokensNamed` stays nil, so nothing already on the server is
            // revoked, only what this run itself creates.
            try await ProfileSetup.login(
                profile: profile, password: password, credentials: credentials,
                tokenName: ProfileSetup.tokenName(prefix: "Shepherd UI test ("))
            minted = true
        }

        let store = try SessionStore(profile: profile, credentials: credentials)
        return (
            store,
            {
                store.stop()
                // Only ever the token this test minted: a pre-minted one belongs to the caller,
                // and no sweep by name runs here, so no other token on the server is touched.
                if minted {
                    try? await ProfileSetup.logout(profile: profile, credentials: credentials)
                }
            }
        )
    }

    @Test(
        "the recap snapshot decodes against the real server", .enabled(if: ActionsLiveGate.armed))
    func theRecapSnapshotDecodesAgainstTheRealServer() async throws {
        let live = try await liveStore()
        do {
            let recaps = try await live.store.client.recaps()
            // Reaching here already proved the decode — every field the map's value schema marks
            // required would have thrown on a truncated body. Assert one invariant anyway so an
            // empty body still fails if the route ever stops answering a map keyed by session id.
            for (id, recap) in recaps {
                #expect(!id.isEmpty)
                #expect(recap.sessionId == id || !recap.sessionId.isEmpty)
            }
            print("live actions: \(recaps.count) recap(s)")
        } catch {
            await live.done()
            throw error
        }
        await live.done()
    }

    @Test("the bar derives actions for the live herd", .enabled(if: ActionsLiveGate.armed))
    func theBarDerivesActionsForTheLiveHerd() async throws {
        let live = try await liveStore()
        let store = live.store
        do {
            try await store.bootstrap()
            let model = ActionsModel(
                reads: .live(store.client), now: { Int(Date().timeIntervalSince1970 * 1_000) })
            await model.refresh()
            #expect(!store.sessions.isEmpty, "the live server should have sessions")

            var derived = 0
            for session in store.sessions where session.status.known != .archived {
                let actions = model.actions(for: session)
                derived += 1
                #expect(
                    actions.contains(.rename) && actions.contains(.amend),
                    "every live session can be renamed and amended")
                if session.terminal == true {
                    #expect(!actions.contains(.relaunch), "a clean terminal is never relaunchable")
                    #expect(!actions.contains(.stop), "a clean terminal is never stoppable")
                }
            }
            print("live actions: derived the bar for \(derived) active session(s)")
        } catch {
            await live.done()
            throw error
        }
        await live.done()
    }
}
