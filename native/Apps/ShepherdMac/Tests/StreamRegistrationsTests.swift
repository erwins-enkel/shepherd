import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

@MainActor
@Suite(.serialized)
struct StreamRegistrationsTests {
    init() { resetStreamSeams() }

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
        for type in [HerdSignals.self, PlanModel.self, QueuesModel.self] as [any AppExtension.Type] {
            #expect(factories.contains(ObjectIdentifier(type)))
        }
        #expect(DetailTabRegistry.tabs.map(\.id).contains("plan"))
        #expect(SidebarSlot.content != nil)
        #expect(ActionBarSlot.content != nil)
        #expect(WelcomeSlots.localPanel != nil)
        resetStreamSeams()
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
        #expect(SidebarSlot.content == nil)
        #expect(ActionBarSlot.content == nil)
        #expect(WelcomeSlots.localPanel == nil)
        #expect(!PlanSignals.planReviewing("a"))
        #expect(!SessionSignals.planQuestionsUnanswered("a"))
        for lens in [HerdLens.next, .owed, .done] {
            #expect(QueuesPanels.panel(for: lens) == nil)
        }
        // A reset must also re-arm the once-only scene pass.
        StreamRegistrations.installScene()
        #expect(QueuesPanels.panel(for: .next) != nil)
    }

    private struct ProbePane: SettingsPane {
        let id = "probe"
        let order = 0
        var title: String { L.t("common_close") }
        var systemImage: String { "gear" }
        func makeView(app: AppModel) -> AnyView { AnyView(EmptyView()) }
    }

    @Test func sharedResetClearsBothSceneRegistries() {
        CommandRegistry.register(.init(
            id: "probe", menu: .session, order: 0, titleKey: "common_close"
        ) { _ in })
        SettingsPaneRegistry.register(ProbePane())
        #expect(CommandRegistry.commands(in: .session).count == 1)
        #expect(SettingsPaneRegistry.panes.count == 1)

        resetStreamSeams()

        #expect(MenuCommand.Menu.allCases.allSatisfy { CommandRegistry.commands(in: $0).isEmpty })
        #expect(SettingsPaneRegistry.panes.isEmpty)
    }

    private func scratchModel() -> AppModel {
        // Never a bare `AppModel()` — its default credential store is the real Keychain.
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    @Test func sceneInstallersRunOnceBeforeEveryModelPass() {
        var events: [String] = []
        let passes = StreamRegistrations.Installation(
            scene: { events.append("scene") },
            model: { _ in
                #expect(events.filter { $0 == "scene" }.count == 1)
                #expect(events.first == "scene")
                events.append("model")
            })

        passes.installScene()
        passes.installScene()
        let app = scratchModel()
        passes.installAll(into: app)
        passes.installScene()
        passes.installAll(into: app)

        #expect(events == ["scene", "model", "model"])
    }

    @Test func modelPassCannotRunBeforeSceneInstallers() {
        var events: [String] = []
        let passes = StreamRegistrations.Installation(
            scene: { events.append("scene") },
            model: { _ in
                #expect(events == ["scene"])
                events.append("model")
            })

        passes.installAll(into: scratchModel())
        passes.installScene()

        #expect(events == ["scene", "model"])
    }

    /// Late writes are unsupported: these non-observable registries cannot invalidate a scene
    /// already built from its early reads. A later dictionary entry is not scene registration.
    @Test func modelOnlyRegistrationMissesTheSceneTimeRead() {
        let passes = StreamRegistrations.Installation(
            scene: {},
            model: { _ in
                CommandRegistry.register(.init(
                    id: "late", menu: .session, order: 0, titleKey: "common_close"
                ) { _ in })
                SettingsPaneRegistry.register(ProbePane())
            })

        passes.installScene()
        let sceneCommands = CommandRegistry.commands(in: .session)
        let scenePanes = SettingsPaneRegistry.panes
        passes.installAll(into: scratchModel())

        #expect(sceneCommands.isEmpty)
        #expect(scenePanes.isEmpty)
        #expect(CommandRegistry.commands(in: .session).map(\.id) == ["late"])
        #expect(SettingsPaneRegistry.panes.map(\.id) == ["probe"])
        resetStreamSeams()
    }
}
