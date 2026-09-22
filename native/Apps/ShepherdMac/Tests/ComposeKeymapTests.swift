import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor @Suite struct ComposeKeymapTests {
    private func composer() -> ComposeModel {
        ComposeModel(defaults: UserDefaults(suiteName: "ComposeKeymapTests.\(UUID())")!,
            repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: ["main"]) },
                loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: true, localExists: true) },
                repair: { _, branch in .init(branch: branch) }),
            loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
            loadEpics: { _ in .init(epics: [], subIssues: []) })
    }

    private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        try #require(predicate())
    }

    @Test func installerFillsOnlyContentAndCanRestoreFallback() {
        let previous = NewSessionSlot.content
        let previousActions = ActionBarSlot.content
        ComposeStream.resetActionsForTesting()
        defer {
            NewSessionSlot.content = previous
            ActionBarSlot.content = previousActions
            ComposeStream.resetActionsForTesting()
        }
        let suite = "ComposeInstallTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        ComposeStream.install(app)
        #expect(NewSessionSlot.resolution == .slot)
        #expect(ActionBarSlot.resolution == .slot)
        ActionBarSlot.content = nil // A preceding stream reassigns this on a repeated install pass.
        ComposeStream.install(app)
        #expect(ActionBarSlot.resolution == .slot)
        NewSessionSlot.content = nil
        #expect(NewSessionSlot.resolution == .fallback)
    }

    @Test func installationRecapturesTheActionBarAfterSharedSeamReset() throws {
        resetStreamSeams()
        defer { resetStreamSeams() }
        let suite = "ComposeReinstallTests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        defer { app.teardown() }
        let store = try SessionStore(profile: .init(name: "fixture", baseURL: URL(string: "https://compose.invalid")!, mode: .remote),
                                     credentials: InMemoryCredentialStore())
        defer { store.stop() }
        let session = PreviewData.session(id: "fixture")
        var oldRenders = 0, newRenders = 0
        ActionBarSlot.content = { _, _, _ in oldRenders += 1; return AnyView(EmptyView()) }
        ComposeStream.install(app)
        ComposeStream.install(app)
        _ = ActionBarSlot.content?(session, store, app)
        #expect(oldRenders == 1)
        resetStreamSeams() // No composer-specific reset call should be necessary.
        ActionBarSlot.content = { _, _, _ in newRenders += 1; return AnyView(EmptyView()) }
        ComposeStream.install(app)
        _ = ActionBarSlot.content?(session, store, app)
        #expect(oldRenders == 1)
        #expect(newRenders == 1)
        if case .slot = NewSessionSheet.resolveBody(app: app, extras: NewSessionExtras()) {} else {
            Issue.record("The new-session presentation must resolve the composer slot")
        }
        resetStreamSeams()
        #expect(NewSessionSlot.resolution == .fallback)
        #expect(ActionBarSlot.resolution == .fallback)
    }

}
}
