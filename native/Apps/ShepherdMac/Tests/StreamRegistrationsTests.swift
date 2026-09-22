import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor
@Suite(.serialized)
struct StreamRegistrationsTests {
    init() { resetStreamSeams() }

    @Test func sidebarPlusRoutesThroughTheInstalledComposer() {
        defer { resetStreamSeams() }
        let app = scratchModel()
        defer { app.teardown() }
        StreamRegistrations.installAll(into: app)
        MainWindow.openComposer(app)
        #expect(app.sheet == .newSession)
        #expect(NewSessionSlot.resolution == .slot)
        #expect(NewSessionSlot.content?(app) != nil)
    }

    @Test func isolatedLiveLaunchDisablesWritesBeforeInstallingStreams() throws {
        defer { resetStreamSeams() }
        let launch = IsolatedLaunch(configuration: .init(
            isIsolated: true,
            live: .init(baseURL: "https://integration.invalid", password: "fixture")))
        let app = launch.makeModel()
        defer { app.teardown() }
        // Never start the seed: this checks production setup with fixture credentials only.
        #expect(!app.allowsQueueRecomputation)
        #expect(!app.allowsTerminalInput)
        StreamRegistrations.installAll(into: app)
        let profile = ServerProfile(name: "integration", baseURL: URL(string: "https://integration.invalid")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        app.makeExtensions(store: store)
        let terminal = try #require(app.extension(TerminalController.self))
        #expect(!terminal.model(for: "a").allowsInput)
    }

    @Test func productionPassesInstallAndResetEveryRegistry() {
        defer { resetStreamSeams() }
        let app = scratchModel()
        defer { app.teardown() }
        StreamRegistrations.installScene()
        for lens in [HerdLens.next, .owed, .done] {
            #expect(QueuesPanels.panel(for: lens) != nil)
        }
        StreamRegistrations.installAll(into: app)
        let factories = Set(app.extensionFactories.map(\.key))
        for type in [HerdSignals.self, PlanModel.self, QueuesModel.self, MergeModel.self] as [any AppExtension.Type] {
            #expect(factories.contains(ObjectIdentifier(type)))
        }
        #expect(DetailTabRegistry.tabs.map(\.id).contains("plan"))
        #expect(DetailTabRegistry.tabs.map(\.id).contains("merge"))
        #expect(NewSessionSlot.resolution == .slot)
        #expect(CommandRegistry.commands(in: .session).contains { $0.id == "merge.overview" })
        #expect(SidebarSlot.content != nil)
        #expect(ActionBarSlot.content != nil)
        #expect(WelcomeSlots.localPanel != nil)
        // Poison the closures: with no active model the installed closures already return
        // false, so merely checking false after reset would not test the reset at all.
        PlanSignals.planReviewing = { _ in true }
        SessionSignals.planQuestionsUnanswered = { _ in true }
        SessionSignals.gitMerged = { _ in true }
        SessionSignals.workingBlocked = { ["a": true] }
        SessionSignals.manualStepsOutstanding = { ["a": 1] }
        MergeInputs.git = { _ in ["a": .init(state: .init(known: .open), checks: .init(known: .success), deployConfigured: false)] }
        MergeInputs.reviewing = { _, _ in true }
        MergeInputs.planReviewBlocked = { _, _ in false }
        MergeInputs.terminalEnded = { _, _ in false }
        resetStreamSeams()
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
        #expect(SidebarSlot.content == nil)
        #expect(ActionBarSlot.content == nil)
        #expect(WelcomeSlots.localPanel == nil)
        #expect(!PlanSignals.planReviewing("a"))
        #expect(!SessionSignals.planQuestionsUnanswered("a"))
        #expect(!SessionSignals.gitMerged("a"))
        #expect(SessionSignals.workingBlocked().isEmpty)
        #expect(SessionSignals.manualStepsOutstanding().isEmpty)
        #expect(NewSessionSlot.resolution == .fallback)
        #expect(MergeInputs.git(app).isEmpty)
        #expect(!MergeInputs.reviewing(app, "a"))
        #expect(MergeInputs.planReviewBlocked(app, "a"))
        #expect(MergeInputs.terminalEnded(app, "a"))
        for lens in [HerdLens.next, .owed, .done] {
            #expect(QueuesPanels.panel(for: lens) == nil)
        }
        // A reset must also re-arm the once-only scene pass.
        StreamRegistrations.installScene()
        #expect(QueuesPanels.panel(for: .next) != nil)
    }

    private func settle(until condition: () -> Bool) async -> Bool {
        for _ in 0..<1_000 {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }

    private struct ProbePane: SettingsPane {
        let id = "probe"
        let order = 0
        var title: String { L.t("common_close") }
        var systemImage: String { "gear" }
        func makeView(app: AppModel) -> AnyView { AnyView(EmptyView()) }
    }

    private func scratchModel() -> AppModel {
        // Never a bare `AppModel()` — its default credential store is the real Keychain.
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
    }

}
}
