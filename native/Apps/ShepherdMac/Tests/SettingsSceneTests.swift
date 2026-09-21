import AppKit
import SwiftUI
import ShepherdKit
import Testing

@testable import Shepherd

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

    @Test func availabilityMapsProfilesWithoutNeedingAStore() {
        let local = ServerProfile(name: "Mac", baseURL: URL(string: "http://127.0.0.1:7330")!, mode: .local)
        let remote = ServerProfile(name: "Cloud", baseURL: URL(string: "https://example.invalid")!, mode: .remote)
        #expect(SettingsBackendAvailability.resolve(profile: nil, localState: .stopped) == .noProfile)
        #expect(SettingsBackendAvailability.resolve(profile: remote, localState: .stopped) == .remoteInactive)
        #expect(SettingsBackendAvailability.resolve(profile: local, localState: .stopped) == .localOffline)
        #expect(SettingsBackendAvailability.resolve(profile: local, localState: .running(pid: 42)) == .localActive)
        #expect(SettingsBackendAvailability.resolve(profile: local, localState: .externallyManaged) == .localActive)
        let custom = ServerProfile(name: "Custom", baseURL: URL(string: "http://127.0.0.1:8443")!, mode: .local)
        #expect(SettingsBackendAvailability.resolve(profile: custom, localState: .running(pid: 42),
            endpoint: custom.baseURL) == .localActive)
        #expect(SettingsBackendAvailability.resolve(profile: custom, localState: .stopped) == .remoteInactive)

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

    @Test func registeredSettingsSymbolsResolveOnMacOS() {
        SettingsPaneRegistry.reset()
        SettingsFeature.installScene()
        #expect(SettingsPaneRegistry.panes.count == 6)
        for pane in SettingsPaneRegistry.panes {
            #expect(NSImage(systemSymbolName: pane.systemImage, accessibilityDescription: nil) != nil)
        }
    }
}
