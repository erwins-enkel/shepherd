import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
/// Serialized: `ActionBarSlot` is per-process state, and `resetStreamSeams()` in `init` is what
/// keeps the fallback suites honest.
@MainActor
@Suite(.serialized)
struct ActionBarTests {
    init() { resetStreamSeams() }

    @Test func relaunchOverridesOnlyEditedFields() {
        let session = PreviewData.session()
        let inherited = RelaunchOptionsView.request(session: session, repo: session.repoPath,
            branch: session.baseBranch, prompt: session.prompt)
        #expect(inherited.repoPath == nil && inherited.baseBranch == nil && inherited.prompt == nil)
        let changed = RelaunchOptionsView.request(session: session, repo: "/new", branch: "develop", prompt: "New task")
        #expect(changed.repoPath == "/new" && changed.baseBranch == "develop" && changed.prompt == "New task")
        #expect(changed.agentProvider == nil)
    }

    @Test func theSlotIsEmptyUntilTheStreamInstallsItself() {
        #expect(ActionBarSlot.resolution == .fallback)
        let defaults = Self.scratchDefaults()
        ActionsStream.install(
            AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults)))
        #expect(ActionBarSlot.resolution == .slot)
    }

    @Test func installingTwiceRegistersOneExtension() {
        let defaults = Self.scratchDefaults()
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        ActionsStream.install(app)
        ActionsStream.install(app)
        #expect(app.extensionFactories.count == 1)
    }

    @Test func intentMapsRelaunchToConfirmationOnlyAndNeverToExecution() {
        #expect(ActionBarView.intent(for: .relaunch) == .confirmRelaunch)
        #expect(ActionBarView.intent(for: .rename) == .presentSheet(.rename))
        #expect(ActionBarView.intent(for: .amend) == .presentSheet(.amend))
        #expect(ActionBarView.intent(for: .stop) == .execute)
        #expect(ActionBarView.intent(for: .resume) == .execute)
        #expect(ActionBarView.intent(for: .toggleReady) == .execute)
        #expect(ActionBarView.intent(for: .regenerateRecap) == .execute)
    }

    @Test func isCurrentDropsACompletionAfterTheOperatorSelectedAnotherSession() async throws {
        let defaults = Self.scratchDefaults()
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let profile = try app.addRemoteProfile(
            name: "action-bar-one", address: "https://action-bar-one.example.ts.net")
        await app.activate(profile)
        let store = try #require(app.store)
        app.selectedSessionID = "s1"

        #expect(ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: store, app: app))

        app.selectedSessionID = "s2"
        #expect(
            !ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: store, app: app),
            "a completion for a session the operator moved off must be dropped")
    }

    @Test func isCurrentDropsACompletionAfterAProfileSwitch() async throws {
        let defaults = Self.scratchDefaults()
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let profile = try app.addRemoteProfile(
            name: "action-bar-two", address: "https://action-bar-two.example.ts.net")
        await app.activate(profile)
        let activeStore = try #require(app.store)
        app.selectedSessionID = "s1"
        #expect(
            ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: activeStore, app: app))

        // The command went to a DIFFERENT store instance — the operator switched profiles while
        // it was in flight, even though the id it names is still selected under the new one.
        let otherClient = try ShepherdClient(
            profile: ServerProfile(
                name: "other", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local,
                credentialKey: "action-bar-other"),
            credentials: InMemoryCredentialStore())
        let otherStore = SessionStore(client: otherClient)
        #expect(
            !ActionBarView.isCurrent(session: PreviewData.session(id: "s1"), store: otherStore, app: app),
            "a completion for a store the operator switched away from must be dropped")
    }

    /// Relaunch's looser guard, which has to tell two "the selection moved" cases apart: the
    /// archive its own success caused (`AppModel.reconcileSelection` answers a vanished session
    /// with `nil`), and the operator deliberately navigating to another session.
    @Test func relaunchIsCurrentAcceptsTheArchivesNilSelectionButNotAnExplicitMove() async throws {
        let defaults = Self.scratchDefaults()
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let profile = try app.addRemoteProfile(
            name: "action-bar-relaunch", address: "https://action-bar-relaunch.example.ts.net")
        await app.activate(profile)
        let store = try #require(app.store)
        let session = PreviewData.session(id: "s1")
        app.selectedSessionID = "s1"

        #expect(ActionBarView.relaunchIsCurrent(session: session, store: store, app: app))

        // The archive path: an archiving relaunch removes `s1`, and `reconcileSelection` clears
        // the selection. That footprint is still "current" — dropping it here would make an
        // archiving relaunch's own success unreachable.
        app.selectedSessionID = nil
        #expect(
            ActionBarView.relaunchIsCurrent(session: session, store: store, app: app),
            "a nil selection is the archive's own footprint and must stay current")

        // The operator went somewhere else while the relaunch was in flight. A failure notice
        // must not land under session B, and a success must not yank them back to A.
        app.selectedSessionID = "s2"
        #expect(
            !ActionBarView.relaunchIsCurrent(session: session, store: store, app: app),
            "an explicit move to another session must drop the relaunch's completion")
    }

    @Test func relaunchIsCurrentDropsACompletionAfterAProfileSwitch() async throws {
        let defaults = Self.scratchDefaults()
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let profile = try app.addRemoteProfile(
            name: "action-bar-relaunch-two",
            address: "https://action-bar-relaunch-two.example.ts.net")
        await app.activate(profile)
        let activeStore = try #require(app.store)
        app.selectedSessionID = "s1"
        #expect(
            ActionBarView.relaunchIsCurrent(
                session: PreviewData.session(id: "s1"), store: activeStore, app: app))

        let otherClient = try ShepherdClient(
            profile: ServerProfile(
                name: "other", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local,
                credentialKey: "action-bar-relaunch-other"),
            credentials: InMemoryCredentialStore())
        let otherStore = SessionStore(client: otherClient)
        #expect(
            !ActionBarView.relaunchIsCurrent(
                session: PreviewData.session(id: "s1"), store: otherStore, app: app),
            "a relaunch completion for a store the operator switched away from must be dropped")
    }

    /// A throwaway suite so the test never reads or writes the operator's own profiles. Pair it
    /// with `InMemoryCredentialStore()` at every call site: `AppModel.init` defaults `credentials`
    /// to `KeychainCredentialStore()`, and that is the unattended-run stall this plan's "No
    /// Keychain prompts" constraint exists to prevent. Every existing app test does the same.
    private static func scratchDefaults() -> UserDefaults {
        UserDefaults(suiteName: "run.shepherd.mac.actiontests.\(UUID().uuidString)")!
    }
}
}
