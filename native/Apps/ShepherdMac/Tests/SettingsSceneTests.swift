import AppKit
import SwiftUI
import ShepherdKit
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@Suite(.serialized) @MainActor
struct SettingsSceneTests {
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

    @Test func registeredSettingsSymbolsResolveOnMacOS() {
        SettingsPaneRegistry.reset()
        SettingsFeature.installScene()
        #expect(SettingsPaneRegistry.panes.count == 6)
        for pane in SettingsPaneRegistry.panes {
            #expect(NSImage(systemSymbolName: pane.systemImage, accessibilityDescription: nil) != nil)
        }
    }
}
}
