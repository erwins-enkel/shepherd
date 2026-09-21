import SwiftUI
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
@Suite(.serialized) @MainActor
struct SettingsSceneTests {
    private struct Pane: SettingsPane {
        let id: String
        let order: Int
        var title: String { L.t("common_close") }
        var systemImage: String { "gear" }
        func makeView(app: AppModel) -> AnyView { AnyView(EmptyView()) }
    }

    @Test func anEmptyRegistryResolvesToThePlaceholder() {
        SettingsPaneRegistry.reset()
        #expect(SettingsPaneRegistry.panes.isEmpty)
        #expect(SettingsPaneRegistry.resolution == .placeholder)
    }

    @Test func panesSortByOrderThenID() {
        SettingsPaneRegistry.reset()
        SettingsPaneRegistry.register(Pane(id: "workspace", order: 10))
        SettingsPaneRegistry.register(Pane(id: "about", order: 10))
        SettingsPaneRegistry.register(Pane(id: "general", order: 0))
        #expect(SettingsPaneRegistry.panes.map(\.id) == ["general", "about", "workspace"])
        #expect(SettingsPaneRegistry.resolution == .panes)
    }

    @Test func registrationIsIdempotentPerID() {
        SettingsPaneRegistry.reset()
        SettingsPaneRegistry.register(Pane(id: "general", order: 0))
        SettingsPaneRegistry.register(Pane(id: "general", order: 7))
        #expect(SettingsPaneRegistry.panes.count == 1)
        #expect(SettingsPaneRegistry.panes[0].order == 7)
    }


    @Test func invalidPaneRequestsDoNotConsumeOrAdvancePresentation() {
        defer { resetStreamSeams() }
        SettingsPaneRegistry.reset()
        SettingsPaneRegistry.register(Pane(id: "general", order: 0))
        SettingsPresentation.shared.requestedPane = nil
        SettingsPresentation.shared.openSettingsRequest = 0
        SettingsPresentation.shared.requestPane("missing")
        #expect(SettingsPresentation.shared.requestedPane == nil)
        #expect(SettingsPresentation.shared.openSettingsRequest == 0)
        SettingsPresentation.shared.requestPane("general")
        #expect(SettingsPresentation.shared.requestedPane == "general")
        #expect(SettingsPresentation.shared.openSettingsRequest == 1)
        SettingsPresentation.shared.requestPane("general")
        #expect(SettingsPresentation.shared.requestedPane == "general")
        #expect(SettingsPresentation.shared.openSettingsRequest == 2)
        SettingsPresentation.shared.requestedPane = nil
    }

}
}
