import SwiftUI
import Observation
import ShepherdKit

@Observable @MainActor public final class SettingsRepoTextDraft {
    public init() {}

    public var text = ""
    public func submit(_ save: (String, @escaping @MainActor (String) -> Void) -> Void) {
        save(text) { [weak self] in self?.text = $0 }
    }
}
