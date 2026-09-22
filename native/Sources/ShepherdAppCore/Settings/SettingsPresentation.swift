import SwiftUI
import Observation
import ShepherdKit

@Observable @MainActor public final class SettingsPresentation {
    public static let shared = SettingsPresentation()
    public var palette = false
    public var openSettingsRequest = 0
    public var requestedPane: String?
    public func requestPane(_ id: String) {
        guard SettingsPaneRegistry.panes.contains(where: { $0.id == id }) else { return }
        requestedPane = id
        openSettingsRequest += 1
    }
}
